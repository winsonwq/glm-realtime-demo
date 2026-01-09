// GLM-Realtime WebSocket 代理服务器
// 用于解决浏览器 WebSocket 无法设置自定义请求头的问题

require('dotenv').config();
const http = require('http');
const WebSocket = require('ws');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = 3000;

// API Key 配置
// 优先级：环境变量 > .env 文件
const API_KEY = process.env.API_KEY;

if (!API_KEY || API_KEY === 'your_api_key_here') {
    console.error('❌ 错误: 未配置 API Key');
    console.error('请设置环境变量 API_KEY 或修改 proxy-server.js 中的默认值');
    process.exit(1);
}

console.log('✅ 使用 API Key:', API_KEY.substring(0, 20) + '...');

// 创建 HTTP 服务器
const server = http.createServer();

// 创建 WebSocket 服务器
const wss = new WebSocket.Server({ 
    server,
    path: '/proxy'
});

wss.on('connection', (clientWs, req) => {
    console.log('客户端连接:', req.url);
    
    // 使用配置的 API Key（从环境变量或代码中）
    // 连接到智谱 AI 的 WebSocket 服务
    // 使用 Authorization 请求头传递 API Key
    const headers = {
        'Authorization': API_KEY
    };
    
    const targetUrl = 'wss://open.bigmodel.cn/api/paas/v4/realtime';
    console.log('正在连接到:', targetUrl);
    
    const serverWs = new WebSocket(targetUrl, {
        headers: headers
    });
    
    let messageCount = 0;
    let messageQueue = []; // 消息队列，用于缓存服务器连接建立前的消息
    
    // 转发客户端消息到服务器
    clientWs.on('message', (data, isBinary) => {
        messageCount++;
        
        // 解析消息以便记录
        if (!isBinary) {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'input_audio_buffer.append') {
                    // 每100个音频消息打印一次
                    if (messageCount % 100 === 0) {
                        console.log(`📤 收到客户端音频数据 (${messageCount} 条)`);
                    }
                } else {
                    console.log(`📤 收到客户端消息: ${msg.type}`);
                }
            } catch (e) {
                // 不是 JSON，直接转发
            }
        }
        
        if (serverWs.readyState === WebSocket.OPEN) {
            // 服务器已连接，直接转发
            serverWs.send(data, { binary: isBinary });
        } else if (serverWs.readyState === WebSocket.CONNECTING) {
            // 服务器正在连接，缓存消息
            messageQueue.push({ data, isBinary });
            if (messageQueue.length === 1) {
                console.log("⏳ 服务器连接中，缓存消息...");
            }
        } else {
            console.warn("⚠️ 服务器 WebSocket 未连接，状态:", serverWs.readyState);
        }
    });
    
    // 转发服务器消息到客户端
    serverWs.on('message', (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) {
            if (!isBinary) {
                try {
                    const msg = JSON.parse(data.toString());
                    // 记录重要事件
                    if (msg.type && (
                        msg.type.includes('speech') || 
                        msg.type.includes('response') || 
                        msg.type === 'error'
                    )) {
                        console.log(`📥 收到服务器消息: ${msg.type}`);
                    }
                } catch (e) {
                    // 不是 JSON，直接转发
                }
            }
            
            // 保持原始格式转发
            clientWs.send(data, { binary: isBinary });
        }
    });
    
    // 处理服务器连接打开
    serverWs.on('open', () => {
        console.log('✅ 已连接到智谱 AI 服务器');
        
        // 发送缓存的消息
        if (messageQueue.length > 0) {
            console.log(`📤 发送 ${messageQueue.length} 条缓存的消息到服务器`);
            messageQueue.forEach(({ data, isBinary }) => {
                serverWs.send(data, { binary: isBinary });
            });
            messageQueue = [];
            console.log('✅ 缓存消息已全部发送');
        }
    });
    
    // 处理服务器错误
    serverWs.on('error', (error) => {
        console.error('服务器 WebSocket 错误:', error);
        console.error('错误详情:', error.message);
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(1011, '服务器连接错误: ' + error.message);
        } else if (clientWs.readyState === WebSocket.CONNECTING) {
            clientWs.close(1011, '服务器连接错误: ' + error.message);
        }
    });
    
    // 处理客户端错误
    clientWs.on('error', (error) => {
        console.error('客户端 WebSocket 错误:', error);
    });
    
    // 处理服务器关闭
    serverWs.on('close', (code, reason) => {
        console.log('服务器连接关闭:', code, reason.toString());
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(code, reason);
        }
    });
    
    // 处理客户端关闭
    clientWs.on('close', () => {
        console.log('客户端连接关闭');
        if (serverWs.readyState === WebSocket.OPEN) {
            serverWs.close();
        }
    });
    
    // 处理客户端错误
    clientWs.on('error', (error) => {
        console.error('客户端 WebSocket 错误:', error);
    });
});

// 提供静态文件服务，让用户可以直接访问 http://localhost:3000
server.on('request', (req, res) => {
    const parsedUrl = url.parse(req.url);
    let pathname = parsedUrl.pathname;

    // 根路径重定向到 index.html
    if (pathname === '/') {
        res.writeHead(302, { 'Location': '/index.html' });
        res.end();
        return;
    }

    if (pathname === '/index.html') {
        const filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading index.html');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
        return;
    }

    // 其他路径返回 404
    if (!req.url.startsWith('/proxy')) {
        res.writeHead(404);
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`代理服务器运行在 http://localhost:${PORT}`);
    console.log(`WebSocket 代理路径: ws://localhost:${PORT}/proxy`);
    console.log(`API Key 已配置（从环境变量或代码中读取）`);
});
