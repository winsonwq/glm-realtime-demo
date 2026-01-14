// 豆包实时语音模型 WebSocket 代理服务器
// 用于解决浏览器 WebSocket 无法设置自定义请求头的问题

require('dotenv').config();
const http = require('http');
const WebSocket = require('ws');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = 3001;

// API Key 配置 - 从环境变量读取
const DOUBAO_APP_ID = process.env.DOUBAO_APP_ID;
const DOUBAO_ACCESS_KEY = process.env.DOUBAO_ACCESS_KEY;
const DOUBAO_SECRET_KEY = process.env.DOUBAO_SECRET_KEY;

if (!DOUBAO_APP_ID || !DOUBAO_ACCESS_KEY || !DOUBAO_SECRET_KEY) {
    console.error('❌ 错误: 未配置豆包 API Key');
    console.error('请在 .env 文件中设置以下环境变量:');
    console.error('  - DOUBAO_APP_ID');
    console.error('  - DOUBAO_ACCESS_KEY');
    console.error('  - DOUBAO_SECRET_KEY');
    process.exit(1);
}

console.log('✅ 豆包 API Key 已配置');
console.log('📋 App ID:', DOUBAO_APP_ID);

// 创建 HTTP 服务器
const server = http.createServer();

// 创建 WebSocket 服务器
const wss = new WebSocket.Server({ 
    server,
    path: '/doubao-proxy'
});

// 消息类型定义
const MESSAGE_TYPES = {
    FULL_CLIENT_REQUEST: 0b0001,
    FULL_SERVER_RESPONSE: 0b1001,
    AUDIO_ONLY_REQUEST: 0b0010,
    AUDIO_ONLY_RESPONSE: 0b1011,
    ERROR_INFO: 0b1111
};

// 事件 ID 定义
const EVENT_IDS = {
    START_CONNECTION: 1,
    FINISH_CONNECTION: 2,
    START_SESSION: 100,
    FINISH_SESSION: 102,
    TASK_REQUEST: 200,
    CONNECTION_STARTED: 50,
    CONNECTION_FAILED: 51,
    CONNECTION_FINISHED: 52,
    SESSION_STARTED: 150,
    SESSION_FINISHED: 152,
    SESSION_FAILED: 153,
    TTS_RESPONSE: 352,
    ASR_INFO: 450,
    ASR_RESPONSE: 451,
    ASR_ENDED: 459,
    CHAT_RESPONSE: 550,
    CHAT_ENDED: 559
};

// 编码豆包二进制协议消息
// 根据 Python 参考代码，字段顺序应该是：[Sequence] -> [eventId] -> [sessionId] -> payload size -> payload
function encodeMessage(messageType, messageTypeFlags, payload, eventId = null, sessionId = null, sequence = null, errorCode = null, useCompression = true) {
    // Protocol Version (4 bits) + Header Size (4 bits)
    const protocolVersion = 0b0001;
    const headerSize = 0b0001;
    const headerByte1 = (protocolVersion << 4) | headerSize; // 0x11
    
    // Message Type (4 bits) + Message Type Specific Flags (4 bits)
    const headerByte2 = (messageType << 4) | messageTypeFlags;
    
    // Serialization Method (4 bits) + Compression Type (4 bits)
    const isAudioOnly = messageType === MESSAGE_TYPES.AUDIO_ONLY_REQUEST;
    const serializationMethod = isAudioOnly ? 0b0000 : 0b0001; // NO_SERIALIZATION or JSON
    const compressionType = useCompression ? 0b0001 : 0b0000; // GZIP or NO_COMPRESSION
    const headerByte3 = (serializationMethod << 4) | compressionType;
    
    const headerByte4 = 0x00; // Reserved
    
    const bodyParts = [];
    
    // 1. sequence (如果有标志位 0b0001 或 0b0010)
    if (sequence !== null) {
        const buf = Buffer.alloc(4);
        buf.writeUInt32BE(sequence);
        bodyParts.push(buf);
    }

    // 2. eventId (如果有标志位 0b0100)
    if (eventId !== null) {
        const buf = Buffer.alloc(4);
        buf.writeUInt32BE(eventId);
        bodyParts.push(buf);
    }
    
    // 3. sessionId (根据 Python 代码，在 StartSession 和 TaskRequest 中紧跟在 EventId 后)
    // 注意：StartConnection 不需要 sessionId
    if (sessionId !== null) {
        const sessionIdBuf = Buffer.from(sessionId, 'utf8');
        const sizeBuf = Buffer.alloc(4);
        sizeBuf.writeInt32BE(sessionIdBuf.length);
        bodyParts.push(sizeBuf);
        bodyParts.push(sessionIdBuf);
    }
    
    // 4. Payload 处理
    let payloadBuf;
    if (Buffer.isBuffer(payload)) {
        payloadBuf = useCompression ? zlib.gzipSync(payload) : payload;
    } else {
        const jsonBuf = Buffer.from(JSON.stringify(payload), 'utf8');
        payloadBuf = useCompression ? zlib.gzipSync(jsonBuf) : jsonBuf;
    }
    
    // 5. Payload size (4 bytes)
    const payloadSizeBuf = Buffer.alloc(4);
    payloadSizeBuf.writeUInt32BE(payloadBuf.length);
    bodyParts.push(payloadSizeBuf);
    
    // 6. Payload data
    bodyParts.push(payloadBuf);
    
    // 组合
    const result = Buffer.alloc(4 + bodyParts.reduce((sum, b) => sum + b.length, 0));
    let offset = 0;
    result[offset++] = headerByte1;
    result[offset++] = headerByte2;
    result[offset++] = headerByte3;
    result[offset++] = headerByte4;
    for (const part of bodyParts) {
        part.copy(result, offset);
        offset += part.length;
    }
    return result;
}

// 解码豆包二进制协议消息
// 根据 Python 参考代码，服务器响应的格式：
// SERVER_FULL_RESPONSE/SERVER_ACK: [sequence?] [event?] sessionId_size sessionId payload_size payload
// SERVER_ERROR_RESPONSE: code payload_size payload
function decodeMessage(buffer) {
    if (buffer.length < 8) return null;
    
    // 解析 Header
    const protocolVersion = (buffer[0] >> 4) & 0x0F;
    const headerSize = buffer[0] & 0x0F;
    const messageType = (buffer[1] >> 4) & 0x0F;
    const flags = buffer[1] & 0x0F;
    const serializationMethod = (buffer[2] >> 4) & 0x0F;
    const compressionType = buffer[2] & 0x0F;
    const reserved = buffer[3];
    
    let offset = headerSize * 4;  // Header 大小（通常是 4 字节）
    let errorCode = null;
    let sequence = null;
    let eventId = null;
    let sessionId = null;
    let payload = null;
    let payloadData = null;
    
    // 根据消息类型解析
    // SERVER_ACK (0b1011) 和 FULL_SERVER_RESPONSE (0b1001) 使用相同的格式
    if (messageType === MESSAGE_TYPES.FULL_SERVER_RESPONSE || messageType === 0b1011) {  // SERVER_ACK
        // SERVER_FULL_RESPONSE、SERVER_ACK 或 AUDIO_ONLY_RESPONSE
        // 顺序：sequence? -> event? -> sessionId_size -> sessionId -> payload_size -> payload
        
        // 1. sequence (如果有 NEG_SEQUENCE flag)
        if (flags & 0b0010) {  // NEG_SEQUENCE
            sequence = buffer.readUInt32BE(offset);  // unsigned
            offset += 4;
        }
        
        // 2. eventId (如果有 MSG_WITH_EVENT flag)
        if (flags & 0b0100) {  // MSG_WITH_EVENT
            eventId = buffer.readUInt32BE(offset);  // unsigned
            offset += 4;
        }
        
        // 3. sessionId (总是存在，但 size 可能是 0)
        const sessionIdSize = buffer.readInt32BE(offset);  // **signed**
        offset += 4;
        if (sessionIdSize > 0) {
            sessionId = buffer.slice(offset, offset + sessionIdSize).toString('utf8');
            offset += sessionIdSize;
        }
        
        // 4. payload size
        const payloadSize = buffer.readUInt32BE(offset);  // unsigned
        offset += 4;
        
        // 5. payload
        payload = buffer.slice(offset, offset + payloadSize);
        
    } else if (messageType === MESSAGE_TYPES.ERROR_INFO) {  // SERVER_ERROR_RESPONSE
        // SERVER_ERROR_RESPONSE
        // 顺序：code -> payload_size -> payload
        
        // 1. error code
        errorCode = buffer.readUInt32BE(offset);  // unsigned
        offset += 4;
        
        // 2. payload size
        const payloadSize = buffer.readUInt32BE(offset);  // unsigned
        offset += 4;
        
        // 3. payload
        payload = buffer.slice(offset, offset + payloadSize);
    } else {
        // 其他消息类型，尝试通用解析
        console.warn('⚠️ 未知的消息类型:', messageType);
        return null;
    }
    
    // 解压缩和反序列化 payload
    if (payload && payload.length > 0) {
        try {
            // 解压缩（如果需要）
            let decompressedPayload = payload;
            if (compressionType === 0b0001) {  // GZIP
                try {
                    decompressedPayload = zlib.gunzipSync(payload);
                } catch (gzipError) {
                    console.warn('⚠️ GZIP 解压缩失败，使用原始数据:', gzipError.message);
                    decompressedPayload = payload;
                }
            }
            
            // 反序列化
            if (serializationMethod === 0b0001) {  // JSON
                try {
                    const payloadStr = decompressedPayload.toString('utf8');
                    payloadData = JSON.parse(payloadStr);
                } catch (jsonError) {
                    // 如果不是有效的 JSON，作为字符串返回
                    payloadData = decompressedPayload.toString('utf8');
                }
            } else if (serializationMethod === 0b0000) {  // NO_SERIALIZATION
                // 二进制数据（如音频）
                payloadData = decompressedPayload;
            } else {
                // 其他格式，作为字符串返回
                payloadData = decompressedPayload.toString('utf8');
            }
        } catch (e) {
            console.warn('⚠️ Payload 解析失败:', e.message);
            payloadData = payload;
        }
    }
    
    return {
        messageType,
        flags,
        errorCode,
        sequence,
        eventId,
        sessionId,
        payload: payloadData,
        rawPayload: payload,
        serializationMethod,
        compressionType
    };
}

wss.on('connection', (clientWs, req) => {
    console.log('客户端连接:', req.url);
    
    const connectId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const targetUrl = 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue';
    
    // 使用基本的请求头（不包含签名，先测试）
    const headers = {
        'X-Api-App-ID': DOUBAO_APP_ID,
        'X-Api-Access-Key': DOUBAO_ACCESS_KEY,
        'X-Api-Resource-Id': 'volc.speech.dialog',
        'X-Api-App-Key': 'PlgvMymc7f3tQnJ6',
        'X-Api-Connect-Id': connectId
    };
    
    console.log('正在连接到豆包服务器:', targetUrl);
    console.log('Connect ID:', connectId);
    console.log('请求头:', JSON.stringify(headers, null, 2));
    
    const serverWs = new WebSocket(targetUrl, { headers });
    
    let messageCount = 0;
    let messageQueue = [];
    let sessionId = null;
    let currentSequence = 0;
    let connectionEstablished = false;
    let currentSystemMessage = null;
    let currentModel = null;
    let pendingSystemMessage = null;
    let pendingModel = null;
    let connectionStartTime = Date.now();
    let lastMessageTime = null;
    
    // 跟踪连接状态
    console.log('📊 连接状态跟踪已启动');
    const statusInterval = setInterval(() => {
        const elapsed = Date.now() - connectionStartTime;
        console.log(`📊 连接状态 (${elapsed}ms):`);
        console.log(`  - serverWs.readyState: ${serverWs.readyState} (${serverWs.readyState === WebSocket.OPEN ? 'OPEN' : serverWs.readyState === WebSocket.CONNECTING ? 'CONNECTING' : serverWs.readyState === WebSocket.CLOSING ? 'CLOSING' : 'CLOSED'})`);
        console.log(`  - connectionEstablished: ${connectionEstablished}`);
        console.log(`  - sessionId: ${sessionId}`);
        console.log(`  - messageCount: ${messageCount}`);
        console.log(`  - lastMessageTime: ${lastMessageTime ? Date.now() - lastMessageTime + 'ms ago' : 'never'}`);
    }, 2000);
    
    // 清理定时器
    const cleanup = () => {
        if (statusInterval) {
            clearInterval(statusInterval);
        }
    };
    
    serverWs.on('close', cleanup);
    clientWs.on('close', cleanup);
    
    function sendStartConnection() {
        if (serverWs.readyState !== WebSocket.OPEN) {
            console.error('❌ 无法发送 StartConnection: WebSocket 未打开, readyState:', serverWs.readyState);
            return;
        }
        
        const msg = encodeMessage(
            MESSAGE_TYPES.FULL_CLIENT_REQUEST,
            0b0100,  // flags: 有 eventId
            {},
            EVENT_IDS.START_CONNECTION,
            null,
            null,
            null,
            true  // 使用 GZIP 压缩
        );
        
        console.log('📤 发送 StartConnection');
        console.log('  - 消息长度:', msg.length, '字节');
        console.log('  - 前 32 字节:', Array.from(msg.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' '));
        console.log('  - messageType:', MESSAGE_TYPES.FULL_CLIENT_REQUEST, '(FULL_CLIENT_REQUEST)');
        console.log('  - flags: 0b0100 (有 eventId)');
        console.log('  - eventId:', EVENT_IDS.START_CONNECTION, '(START_CONNECTION)');
        console.log('  - payload:', JSON.stringify({}), '(已压缩)');
        
        try {
            serverWs.send(msg);
            console.log('✅ StartConnection 已发送');
        } catch (error) {
            console.error('❌ 发送 StartConnection 失败:', error);
        }
    }
    
    function sendStartSession(systemMessage, model = 'O2.0') {
        const sessionConfig = {
            asr: {
                extra: {
                    end_smooth_window_ms: 1500,
                    enable_custom_vad: false,
                    enable_asr_twopass: false
                }
            },
            tts: {
                speaker: 'zh_female_vv_jupiter_bigtts', // 切换到标准女声测试
                audio_config: {
                    channel: 1,
                    format: 'pcm_s16le', // 明确指定 PCM 格式
                    sample_rate: 24000
                }
            },
            dialog: {
                model: model, // 注入模型版本
                bot_name: '豆包',
                system_role: systemMessage,
                instructions: systemMessage, // 同时发送 instructions 以防万一
                speaking_style: '',
                dialog_id: '',
                extra: {
                    strict_audit: false,
                    input_mod: 'audio', // 参考代码使用 'audio'
                    recv_timeout: 10
                }
            }
        };
        
        const msg = encodeMessage(
            MESSAGE_TYPES.FULL_CLIENT_REQUEST,
            0b0100,  // 修复：仅使用官方 hasEvent 标志 (0b0100)
            sessionConfig,
            EVENT_IDS.START_SESSION,
            sessionId,
            null,
            null,
            true
        );
        
        console.log('📤 发送 StartSession (eventId: 100)');
        console.log('  - Config:', JSON.stringify(sessionConfig, null, 2));
        serverWs.send(msg);
    }

    function sendTextTaskRequest(text) {
        if (!sessionId) return;
        
        // 尝试多种可能的字段名以提高兼容性
        const payload = {
            text: text,
            input_text: text,
            input_mod: 'text',
            input_mode: 'text'
        };
        
        const msg = encodeMessage(
            MESSAGE_TYPES.FULL_CLIENT_REQUEST,
            0b0100,  // hasEvent
            payload,
            EVENT_IDS.TASK_REQUEST,
            sessionId,
            null,
            null,
            true
        );
        
        console.log('📤 发送文字 TaskRequest (eventId: 200)');
        serverWs.send(msg);
    }

    function sendTaskRequest(audioData, isLast = false) {
        if (!sessionId) return;
        
        // 确保是 Buffer
        const audioBuffer = Buffer.isBuffer(audioData) ? audioData : Buffer.from(audioData);
        
        const msg = encodeMessage(
            MESSAGE_TYPES.AUDIO_ONLY_REQUEST,
            0b0100,  // 修复：仅使用官方 hasEvent 标志 (0b0100)
            audioBuffer,
            EVENT_IDS.TASK_REQUEST,
            sessionId,
            null,
            null,
            true
        );
        
        serverWs.send(msg);
        messageCount++;
    }

    function sendFinishSession() {
        const msg = encodeMessage(
            MESSAGE_TYPES.FULL_CLIENT_REQUEST,
            0b0100,  // 修复：仅使用官方 hasEvent 标志 (0b0100)
            {},
            EVENT_IDS.FINISH_SESSION,
            sessionId,
            null,
            null,
            true
        );
        console.log('📤 发送 FinishSession (eventId: 102)');
        serverWs.send(msg);
    }
    
    function sendFinishConnection() {
        const msg = encodeMessage(
            MESSAGE_TYPES.FULL_CLIENT_REQUEST,
            0b0100,  // flags: 有 eventId
            {},
            EVENT_IDS.FINISH_CONNECTION,
            null,
            null,
            null,
            true  // 使用 GZIP 压缩
        );
        console.log('📤 发送 FinishConnection');
        serverWs.send(msg);
    }
    
    clientWs.on('message', (data, isBinary) => {
        if (isBinary) {
            // 二进制音频数据
            if (serverWs.readyState === WebSocket.OPEN && sessionId) {
                sendTaskRequest(data, false);
            } else if (serverWs.readyState === WebSocket.OPEN && !sessionId) {
                console.warn('⚠️ 收到音频数据但会话未启动，状态: serverWs.readyState=', serverWs.readyState, ', connectionEstablished=', connectionEstablished, ', sessionId=', sessionId);
                // 会话还未启动，缓存音频数据
                messageQueue.push({ type: 'audio', data });
            } else if (serverWs.readyState === WebSocket.CONNECTING) {
                console.log('⏳ 服务器连接中，缓存音频数据');
                messageQueue.push({ type: 'audio', data });
            } else {
                console.warn('⚠️ 服务器未连接，无法发送音频数据，状态:', serverWs.readyState);
            }
        } else {
            try {
                const msg = JSON.parse(data.toString());
                
                if (msg.type === 'start_session') {
                    console.log('📥 收到开始会话请求');
                    sessionId = msg.sessionId || `session_${Date.now()}`;
                    pendingSystemMessage = msg.systemMessage || '你是一个友好的AI助手';
                    pendingModel = msg.model || 'O2.0';
                    
                    // 记录当前会话的配置
                    currentSystemMessage = pendingSystemMessage;
                    currentModel = pendingModel;
                    
                    if (serverWs.readyState === WebSocket.OPEN && connectionEstablished) {
                        console.log('✅ 连接已建立，发送 StartSession');
                        sendStartSession(pendingSystemMessage, pendingModel);
                        pendingSystemMessage = null;
                        pendingModel = null;
                    } else if (serverWs.readyState === WebSocket.OPEN) {
                        console.log('⏳ 等待 ConnectionStarted，缓存请求');
                        messageQueue.push({ type: 'session', sessionId, systemMessage: pendingSystemMessage, model: pendingModel });
                    } else {
                        console.warn('⚠️ 服务器未连接，无法启动会话，状态:', serverWs.readyState);
                    }
                } else if (msg.type === 'audio_data') {
                    // 音频数据 (base64 格式，旧版兼容)
                    if (serverWs.readyState === WebSocket.OPEN && sessionId) {
                        const audioBuffer = Buffer.from(msg.data, 'base64');
                        sendTaskRequest(audioBuffer, msg.isLast || false);
                    } else if (serverWs.readyState === WebSocket.CONNECTING) {
                        messageQueue.push({ type: 'audio_base64', data: msg.data, isLast: msg.isLast });
                    }
                } else if (msg.type === 'finish_session') {
                    sendFinishSession();
                } else if (msg.type === 'finish_connection') {
                    sendFinishConnection();
                } else if (msg.type === 'text_input') {
                    sendTextTaskRequest(msg.text);
                }
            } catch (e) {
                console.error('解析客户端消息错误:', e);
            }
        }
    });
    
    serverWs.on('message', (data) => {
        lastMessageTime = Date.now();
        const buffer = Buffer.from(data);
        console.log('📥 收到服务器消息, 长度:', buffer.length);
        console.log('📥 消息前 20 字节:', Array.from(buffer.slice(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' '));
        
        // 快速检查消息类型
        if (buffer.length >= 2) {
            const messageType = (buffer[1] >> 4) & 0x0F;
            const messageTypeName = 
                messageType === 0b1011 ? '(SERVER_ACK - 可能是音频)' :
                messageType === MESSAGE_TYPES.AUDIO_ONLY_RESPONSE ? '(AUDIO_ONLY_RESPONSE)' :
                messageType === MESSAGE_TYPES.FULL_SERVER_RESPONSE ? '(FULL_SERVER_RESPONSE)' :
                messageType === MESSAGE_TYPES.ERROR_INFO ? '(ERROR_INFO)' : '(OTHER)';
            console.log('📥 消息类型 (快速检查):', messageType, messageTypeName);
            
            // 如果是音频响应，特别标记
            if (messageType === 0b1011 || messageType === MESSAGE_TYPES.AUDIO_ONLY_RESPONSE) {
                console.log('🎵 检测到可能的音频响应消息！');
            }
        }
        
        const decoded = decodeMessage(buffer);
        
        if (!decoded) {
            console.warn('⚠️ 无法解析服务器消息');
            console.warn('⚠️ 原始数据:', Buffer.from(data).toString('hex').substring(0, 100));
            return;
        }
        
        console.log('📥 解析结果:');
        const messageTypeName = 
            decoded.messageType === MESSAGE_TYPES.ERROR_INFO ? 'ERROR_INFO' :
            decoded.messageType === MESSAGE_TYPES.FULL_SERVER_RESPONSE ? 'FULL_SERVER_RESPONSE' :
            decoded.messageType === 0b1011 ? 'SERVER_ACK' :
            decoded.messageType === MESSAGE_TYPES.AUDIO_ONLY_RESPONSE ? 'AUDIO_ONLY_RESPONSE' :
            'OTHER';
        console.log('  - messageType:', decoded.messageType, `(${messageTypeName})`);
        console.log('  - flags:', decoded.flags.toString(2).padStart(4, '0'));
        console.log('  - eventId:', decoded.eventId, decoded.eventId === EVENT_IDS.TTS_RESPONSE ? '(TTS_RESPONSE)' : '');
        console.log('  - sessionId:', decoded.sessionId);
        console.log('  - errorCode:', decoded.errorCode);
        console.log('  - sequence:', decoded.sequence);
        console.log('  - compressionType:', decoded.compressionType);
        console.log('  - serializationMethod:', decoded.serializationMethod);
        
        // 详细输出 payload
        if (decoded.payload) {
            if (Buffer.isBuffer(decoded.payload)) {
                console.log('  - payload (Buffer):', decoded.payload.length, '字节');
            } else if (typeof decoded.payload === 'object') {
                console.log('  - payload (JSON):', JSON.stringify(decoded.payload, null, 2).substring(0, 200));
            } else {
                console.log('  - payload (raw):', String(decoded.payload).substring(0, 200));
            }
        } else {
            console.log('  - payload: null 或空');
        }
        
        // 自动检测并转发所有二进制音频数据
        if (decoded.serializationMethod === 0b0000 && Buffer.isBuffer(decoded.payload)) {
            console.log('🎵 检测到二进制数据包 (NO_SERIALIZATION)，尝试作为音频转发...');
            console.log('  - 数据采样 (前10字节):', decoded.payload.slice(0, 10).toString('hex'));
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(decoded.payload, { binary: true });
                console.log('✅ 音频数据已转发到客户端, 大小:', decoded.payload.length);
            }
            if (decoded.messageType === 0b1011) return;
        }
        
        // 如果是 SERVER_ACK 且 payload 是 Buffer，特别标记
        if (decoded.messageType === 0b1011 && Buffer.isBuffer(decoded.payload)) {
            console.log('🎵 检测到 SERVER_ACK 音频消息！');
        }
        
        // 处理错误消息（ERROR_INFO 类型的消息）
        if (decoded.messageType === MESSAGE_TYPES.ERROR_INFO) {
            console.error('❌ 收到错误消息 (ERROR_INFO)');
            let errorMessage = '未知错误';
            
            if (decoded.payload) {
                if (typeof decoded.payload === 'object') {
                    errorMessage = decoded.payload.error || decoded.payload.message || decoded.payload.code || JSON.stringify(decoded.payload);
                } else {
                    errorMessage = String(decoded.payload);
                }
            } else if (decoded.errorCode) {
                errorMessage = `错误代码: ${decoded.errorCode}`;
            }
            
            console.error('❌ 错误详情:');
            console.error('  - 错误消息:', errorMessage);
            console.error('  - 错误代码:', decoded.errorCode);
            console.error('  - 完整 payload:', JSON.stringify(decoded.payload, null, 2));
            
            if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ 
                    type: 'error', 
                    error: `服务器错误: ${errorMessage}`,
                    details: decoded.payload
                }));
            }
            
            // 不立即关闭连接，让服务器决定
            return;
        }
        
        // 处理 SERVER_ACK 类型的消息（TTS 音频数据）
        // 根据 Python 参考代码，TTS 音频是通过 SERVER_ACK (0b1011) 发送的，payload_msg 是 bytes
        if (decoded.messageType === 0b1011) {  // SERVER_ACK
            console.log('📥 收到 SERVER_ACK 消息');
            console.log('  - messageType:', decoded.messageType, '(SERVER_ACK)');
            console.log('  - compressionType:', decoded.compressionType);
            console.log('  - serializationMethod:', decoded.serializationMethod);
            console.log('  - eventId:', decoded.eventId);
            console.log('  - payload 类型:', typeof decoded.payload);
            console.log('  - payload 是 Buffer:', Buffer.isBuffer(decoded.payload));
            console.log('  - rawPayload 大小:', decoded.rawPayload?.length || 0);
            
            // 检查是否是音频数据
            // 根据 Python 代码：if response['message_type'] == 'SERVER_ACK' and isinstance(response.get('payload_msg'), bytes)
            // payload_msg 是 bytes 类型，说明 serializationMethod 应该是 NO_SERIALIZATION (0b0000)
            let audioData = null;
            
            if (Buffer.isBuffer(decoded.payload)) {
                // payload 已经是 Buffer（音频数据）
                audioData = decoded.payload;
                console.log('🔊 使用 payload (Buffer), 大小:', audioData.length);
            } else if (Buffer.isBuffer(decoded.rawPayload)) {
                // 使用 rawPayload（可能还需要解压缩）
                audioData = decoded.rawPayload;
                if (decoded.compressionType === 0b0001) {  // GZIP
                    try {
                        audioData = zlib.gunzipSync(decoded.rawPayload);
                        console.log('🔊 音频数据已解压缩, 原始大小:', decoded.rawPayload.length, '解压后:', audioData.length);
                    } catch (gzipError) {
                        console.error('⚠️ TTS 音频解压缩失败:', gzipError.message);
                        audioData = decoded.rawPayload;
                    }
                }
                console.log('🔊 使用 rawPayload, 大小:', audioData.length);
            }
            
            if (audioData && audioData.length > 0) {
                console.log('🔊 收到 SERVER_ACK (TTS 音频数据), 大小:', audioData.length, '字节');
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(audioData, { binary: true });
                    console.log('✅ TTS 音频数据已发送到客户端, 大小:', audioData.length);
                } else {
                    console.warn('⚠️ 客户端 WebSocket 未打开, 无法发送音频数据');
                }
                return;
            } else {
                // SERVER_ACK 但 payload 不是 bytes，可能是其他类型的 ACK
                console.log('📥 收到 SERVER_ACK (非音频), payload 类型:', typeof decoded.payload);
                // 继续处理，可能是有 eventId 的其他消息
            }
        }
        
        // 处理 AUDIO_ONLY_RESPONSE 类型的消息（备用，可能也用这种方式发送音频）
        if (decoded.messageType === MESSAGE_TYPES.AUDIO_ONLY_RESPONSE) {
            console.log('🔊 收到 AUDIO_ONLY_RESPONSE (TTS 音频数据)');
            console.log('  - messageType:', decoded.messageType, '(AUDIO_ONLY_RESPONSE)');
            console.log('  - compressionType:', decoded.compressionType);
            console.log('  - serializationMethod:', decoded.serializationMethod);
            console.log('  - rawPayload 大小:', decoded.rawPayload?.length || 0);
            console.log('  - payloadData 类型:', typeof decoded.payload);
            
            if (clientWs.readyState === WebSocket.OPEN) {
                // TTS 音频数据
                let audioData;
                
                if (Buffer.isBuffer(decoded.payload)) {
                    // payloadData 已经是解压后的音频数据
                    audioData = decoded.payload;
                    console.log('🔊 使用 payloadData (Buffer), 大小:', audioData.length);
                } else if (Buffer.isBuffer(decoded.rawPayload)) {
                    // 使用 rawPayload，需要解压缩
                    audioData = decoded.rawPayload;
                    if (decoded.compressionType === 0b0001) {  // GZIP
                        try {
                            audioData = zlib.gunzipSync(decoded.rawPayload);
                            console.log('🔊 音频数据已解压缩, 原始大小:', decoded.rawPayload.length, '解压后:', audioData.length);
                        } catch (gzipError) {
                            console.error('⚠️ TTS 音频解压缩失败:', gzipError.message);
                            audioData = decoded.rawPayload;
                        }
                    }
                } else {
                    console.error('⚠️ TTS 音频数据格式错误');
                    return;
                }
                
                if (audioData && audioData.length > 0) {
                    clientWs.send(audioData, { binary: true });
                    console.log('✅ TTS 音频数据已发送到客户端, 大小:', audioData.length);
                } else {
                    console.warn('⚠️ TTS 音频数据为空');
                }
            }
            return;
        }
        
        // 如果没有 eventId，可能是其他类型的消息
        if (decoded.eventId === null) {
            console.warn('⚠️ 收到没有 eventId 的消息');
            console.warn('  - messageType:', decoded.messageType);
            console.warn('  - flags:', decoded.flags.toString(2).padStart(4, '0'));
            console.warn('  - compressionType:', decoded.compressionType);
            console.warn('  - serializationMethod:', decoded.serializationMethod);
            console.warn('  - rawPayload 大小:', decoded.rawPayload?.length || 0);
            
            // 如果是 AUDIO_ONLY_RESPONSE 但没有 eventId，可能是音频数据
            if (decoded.messageType === MESSAGE_TYPES.AUDIO_ONLY_RESPONSE) {
                console.log('🎵 检测到 AUDIO_ONLY_RESPONSE 但没有 eventId，可能是音频数据');
                // 已经在上面处理了，这里不需要重复处理
            } else if (decoded.payload) {
                console.warn('⚠️ payload:', typeof decoded.payload === 'object' ? JSON.stringify(decoded.payload).substring(0, 200) : String(decoded.payload).substring(0, 200));
            }
            return;
        }
        
        switch (decoded.eventId) {
            case EVENT_IDS.CONNECTION_STARTED:
                console.log('✅ 连接已建立 (ConnectionStarted)');
                connectionEstablished = true;
                
                if (pendingSystemMessage) {
                    console.log('📤 发送 StartSession');
                    // 确保在 CONNECTION_STARTED 时也更新当前配置
                    currentSystemMessage = pendingSystemMessage;
                    currentModel = pendingModel || 'O2.0';
                    
                    sendStartSession(pendingSystemMessage, pendingModel || 'O2.0');
                    pendingSystemMessage = null;
                    pendingModel = null;
                }
                
                if (messageQueue.length > 0) {
                    console.log(`📤 处理 ${messageQueue.length} 条缓存消息`);
                    const queueCopy = [...messageQueue];
                    messageQueue = [];
                    
                    queueCopy.forEach(item => {
                        if (item.type === 'session') {
                            sendStartSession(item.systemMessage, item.model);
                        } else if (item.type === 'audio_base64') {
                            const audioBuffer = Buffer.from(item.data, 'base64');
                            sendTaskRequest(audioBuffer, item.isLast || false);
                        } else if (item.type === 'audio') {
                            // 二进制音频数据，但会话还未启动，需要重新缓存
                            messageQueue.push(item);
                        }
                    });
                }
                break;
                
            case EVENT_IDS.CONNECTION_FAILED:
                console.error('❌ 连接失败:', decoded.payload?.error);
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({ type: 'error', error: decoded.payload?.error || '连接失败' }));
                }
                break;
                
            case EVENT_IDS.SESSION_STARTED:
                console.log('✅ 会话已启动 (SessionStarted)');
                sessionId = decoded.sessionId || sessionId;
                console.log('📋 Session ID:', sessionId);
                console.log('📋 Dialog ID:', decoded.payload?.dialog_id);
                
                // 会话启动后，处理所有缓存的音频数据
                if (messageQueue.length > 0) {
                    console.log(`📤 会话已启动，发送 ${messageQueue.length} 条缓存的音频数据`);
                    const queueCopy = [...messageQueue];
                    messageQueue = [];
                    
                    queueCopy.forEach(item => {
                        if (item.type === 'audio') {
                            sendTaskRequest(item.data, false);
                        } else if (item.type === 'audio_base64') {
                            const audioBuffer = Buffer.from(item.data, 'base64');
                            sendTaskRequest(audioBuffer, item.isLast || false);
                        }
                    });
                }
                
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                        type: 'session_started',
                        session_id: sessionId,
                        dialog_id: decoded.payload?.dialog_id,
                        // 添加调试信息，告知客户端注入了什么
                        debug_config: {
                            model: currentModel || 'unknown',
                            system_role: currentSystemMessage || 'unknown'
                        }
                    }));
                }
                break;
                
            case EVENT_IDS.SESSION_FAILED:
                console.error('❌ 会话失败:', decoded.payload?.error);
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({ type: 'error', error: decoded.payload?.error || '会话失败' }));
                }
                break;
                
            case EVENT_IDS.ASR_INFO:
                console.log('🎤 用户开始说话');
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({ type: 'speech_started', question_id: decoded.payload?.question_id }));
                }
                break;
                
            case EVENT_IDS.ASR_RESPONSE:
                console.log('📝 ASR 识别结果:', decoded.payload?.results?.[0]?.text);
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({ type: 'asr_response', results: decoded.payload?.results }));
                }
                break;
                
            case EVENT_IDS.ASR_ENDED:
                console.log('✅ 用户说话结束');
                break;
                
            case EVENT_IDS.TTS_RESPONSE:
                console.log('🔊 收到 TTS 音频数据');
                console.log('  - messageType:', decoded.messageType);
                console.log('  - compressionType:', decoded.compressionType);
                console.log('  - serializationMethod:', decoded.serializationMethod);
                console.log('  - rawPayload 大小:', decoded.rawPayload?.length || 0);
                console.log('  - payloadData 类型:', typeof decoded.payload);
                
                if (clientWs.readyState === WebSocket.OPEN) {
                    // TTS 音频数据已经在 decodeMessage 中解压缩和解析
                    // 如果 payloadData 是 Buffer，直接使用；否则使用 rawPayload
                    let audioData;
                    
                    if (Buffer.isBuffer(decoded.payload)) {
                        // payloadData 已经是解压后的音频数据
                        audioData = decoded.payload;
                        console.log('🔊 使用 payloadData (Buffer), 大小:', audioData.length);
                    } else if (Buffer.isBuffer(decoded.rawPayload)) {
                        // 使用 rawPayload，需要解压缩
                        audioData = decoded.rawPayload;
                        if (decoded.compressionType === 0b0001) {  // GZIP
                            try {
                                audioData = zlib.gunzipSync(decoded.rawPayload);
                                console.log('🔊 音频数据已解压缩, 原始大小:', decoded.rawPayload.length, '解压后:', audioData.length);
                            } catch (gzipError) {
                                console.error('⚠️ TTS 音频解压缩失败:', gzipError.message);
                                audioData = decoded.rawPayload;
                            }
                        }
                    } else {
                        console.error('⚠️ TTS 音频数据格式错误');
                        return;
                    }
                    
                    if (audioData && audioData.length > 0) {
                        clientWs.send(audioData, { binary: true });
                        console.log('✅ TTS 音频数据已发送到客户端, 大小:', audioData.length);
                    } else {
                        console.warn('⚠️ TTS 音频数据为空');
                    }
                }
                break;
                
            case EVENT_IDS.CHAT_RESPONSE:
                console.log('🤖 AI 回复:', decoded.payload?.content);
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                        type: 'chat_response',
                        content: decoded.payload?.content,
                        question_id: decoded.payload?.question_id,
                        reply_id: decoded.payload?.reply_id
                    }));
                }
                break;
                
            case EVENT_IDS.CHAT_ENDED:
                console.log('✅ AI 回复结束');
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                        type: 'chat_ended',
                        question_id: decoded.payload?.question_id,
                        reply_id: decoded.payload?.reply_id
                    }));
                }
                break;
                
            case EVENT_IDS.SESSION_FINISHED:
                console.log('✅ 会话已结束');
                break;
                
            case EVENT_IDS.CONNECTION_FINISHED:
                console.log('✅ 连接已结束');
                break;
        }
    });
    
    serverWs.on('open', () => {
        console.log('✅ 已连接到豆包服务器');
        console.log('📋 serverWs.readyState:', serverWs.readyState);
        console.log('📋 serverWs.protocol:', serverWs.protocol);
        console.log('📋 serverWs.extensions:', serverWs.extensions);
        console.log('📋 连接 URL:', serverWs.url);
        console.log('⏳ 立即发送 StartConnection...');
        
        // 设置一个超时，如果 5 秒内没有收到响应，记录警告
        const responseTimeout = setTimeout(() => {
            if (!connectionEstablished) {
                console.warn('⚠️ 连接建立后 5 秒内未收到服务器响应');
            }
        }, 5000);
        
        // 立即发送 StartConnection
        sendStartConnection();
    });
    
    serverWs.on('error', (error) => {
        console.error('❌ 豆包服务器 WebSocket 错误:');
        console.error('  - 错误消息:', error.message);
        console.error('  - 错误代码:', error.code);
        console.error('  - 错误详情:', error);
        console.error('  - 堆栈:', error.stack);
        if (clientWs && clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'error', error: `服务器连接错误: ${error.message}` }));
        }
    });
    
    serverWs.on('close', (code, reason) => {
        console.log('❌ 豆包服务器连接关闭');
        console.log('  关闭代码:', code);
        console.log('  关闭原因:', reason.toString());
        console.log('  调试信息:');
        console.log('    - serverWs.readyState =', serverWs.readyState);
        console.log('    - clientWs.readyState =', clientWs?.readyState);
        console.log('    - connectionEstablished =', connectionEstablished);
        console.log('    - sessionId =', sessionId);
        console.log('    - messageQueue.length =', messageQueue.length);
        console.log('    - messageCount =', messageCount);
        
        // 常见的关闭代码含义
        const closeCodeMeanings = {
            1000: '正常关闭',
            1001: '端点离开',
            1002: '协议错误',
            1003: '数据类型错误',
            1006: '异常关闭（未收到关闭帧）',
            1007: '数据格式错误',
            1008: '策略违规',
            1009: '消息过大',
            1010: '扩展协商失败',
            1011: '服务器错误'
        };
        console.log('  关闭代码含义:', closeCodeMeanings[code] || '未知');
        
        if (clientWs && clientWs.readyState === WebSocket.OPEN) {
            // 1006 是异常关闭码，不能用于 close() 调用，改用 1000
            const closeCode = (code === 1006 || code <= 0) ? 1000 : code;
            console.log('  关闭客户端连接, code:', closeCode);
            try {
                clientWs.send(JSON.stringify({ 
                    type: 'error', 
                    error: `服务器连接关闭: ${closeCodeMeanings[code] || `代码 ${code}`} - ${reason.toString()}` 
                }));
                clientWs.close(closeCode, 'Server connection closed');
            } catch (e) {
                console.error('关闭客户端连接失败:', e.message);
            }
        }
    });
    
    clientWs.on('error', (error) => {
        console.error('客户端 WebSocket 错误:', error);
    });
    
    clientWs.on('close', () => {
        console.log('客户端连接关闭');
        if (serverWs.readyState === WebSocket.OPEN) {
            sendFinishSession();
            setTimeout(() => {
                sendFinishConnection();
                serverWs.close();
            }, 100);
        }
    });
});

server.on('request', (req, res) => {
    const parsedUrl = url.parse(req.url);
    let pathname = parsedUrl.pathname;

    if (req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
    }

    if (pathname === '/') {
        res.writeHead(302, { 'Location': '/doubao-index.html' });
        res.end();
        return;
    }

    if (pathname === '/doubao-index.html') {
        const filePath = path.join(__dirname, 'doubao-index.html');
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading doubao-index.html');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
        return;
    }

    if (!req.url.startsWith('/doubao-proxy')) {
        res.writeHead(404);
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`豆包代理服务器运行在 http://localhost:${PORT}`);
    console.log(`WebSocket 代理路径: ws://localhost:${PORT}/doubao-proxy`);
    console.log(`访问前端: http://localhost:${PORT}/doubao-index.html`);
});
