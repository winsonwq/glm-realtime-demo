# AI 学习助教 - 实时语音交互 Demo

> **参考文档**: [智谱 AI GLM-Realtime 官方文档](https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-realtime)

这是一个基于智谱 AI **GLM-Realtime** 的实时语音交互原型，完全按照[官方文档](https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-realtime)实现，支持实时语音输入输出和打断功能。

## 功能特性

- 🎤 **实时语音输入**：使用浏览器麦克风采集音频（16kHz PCM16）
- 🔊 **实时语音输出**：播放 AI 返回的音频响应（24kHz PCM）
- ⚡ **打断功能**：支持在 AI 说话时随时打断（Server VAD 模式）
- 📊 **音量可视化**：实时显示麦克风输入音量
- 🎨 **现代化 UI**：美观的渐变界面设计
- ✅ **完全符合官方 API 规范**：按照 GLM-Realtime 文档实现

## 快速开始 🚀

### 一键启动（推荐）

```bash
# 方式一：使用启动脚本（Mac/Linux）
./start.sh

# 方式二：手动启动
npm install
npm start
```

然后：
1. 访问 `http://localhost:3000`
2. 点击"开始学习模式"

## 使用方法

### ⚠️ 重要：认证问题

由于浏览器 WebSocket API **不支持自定义请求头**，而官方 API 要求通过 `Authorization` 请求头传递 API Key，因此有两种解决方案：

### 方案一：使用代理服务器（推荐 ✅）

这是**推荐的方式**，API Key 在服务器端配置，前端无需暴露 API Key。

1. **配置 API Key**：
   - 复制 `.env.example` 为 `.env`
   - 在 `.env` 中填入你的 `API_KEY`

2. **安装依赖**：
```bash
npm install
```

3. **启动代理服务器**：
```bash
npm start
# 或
node proxy-server.js
# 或使用启动脚本
./start.sh
```

代理服务器会在 `http://localhost:3000` 运行。

4. **打开前端页面**：
   - 使用本地服务器运行 `index.html`（Python: `python -m http.server 8000`）
   - 或直接在浏览器中打开 `index.html`

5. 点击"开始学习模式"按钮即可

### API Key 配置

API Key 现在通过环境变量或 `.env` 文件进行配置，更加安全。

**配置步骤：**

1. 将项目根目录下的 `.env.example` 文件重命名为 `.env`：
   ```bash
   cp .env.example .env
   ```
2. 编辑 `.env` 文件，填入您的 API Key：
   ```text
   API_KEY=your_api_key_here
   ```

**其他配置方式：**

**使用环境变量**（推荐，更安全）
```bash
# Linux/Mac
export API_KEY=your_api_key_here
npm start

# Windows (PowerShell)
$env:API_KEY="your_api_key_here"
npm start

# 或一行命令
API_KEY=your_api_key_here npm start
```

### 使用本地服务器运行前端（推荐）

由于浏览器安全限制，建议使用本地服务器运行前端：

```bash
# Python 3
python -m http.server 8000

# 或 Node.js
npx http-server -p 8000
```

然后访问 `http://localhost:8000/index.html`

## 技术实现

### 核心技术栈

- **WebSocket**：与智谱 AI GLM-Realtime API 实时通信
- **Web Audio API**：音频采集和处理
- **PCM16 编码**：输入音频格式（16kHz, 单声道, 16位）
- **PCM 编码**：输出音频格式（24kHz, 单声道, 16位）
- **Base64 编码**：音频数据传输

### API 配置

根据官方文档，当前实现使用：

- **模型**：`glm-realtime`（默认，也可使用 `glm-realtime-flash` 或 `glm-realtime-air`）
- **VAD 模式**：`server_vad`（服务器端语音活动检测）
- **输入格式**：`pcm16`（16kHz, 单声道, 16位）
- **输出格式**：`pcm`（24kHz, 单声道, 16位）
- **音色**：`tongtong`（默认女声）
- **通话模式**：`audio`（音频通话）

### 关键功能

1. **音频采集**：使用 `getUserMedia` 获取麦克风输入，通过 `ScriptProcessorNode` 处理音频流
2. **音频转换**：将 Float32 音频数据转换为 Int16 PCM 格式
3. **音频播放**：接收 Base64 编码的 24kHz PCM 数据，转换为 AudioBuffer 后播放
4. **打断机制**：监听 `input_audio_buffer.speech_started` 事件，自动停止当前播放

### 事件处理

代码实现了完整的服务器事件处理：

- `session.created` / `session.updated`：会话创建/更新
- `input_audio_buffer.speech_started`：用户开始说话（触发打断）
- `input_audio_buffer.speech_stopped`：用户停止说话
- `response.audio.delta`：接收音频流
- `response.audio_transcript.delta`：接收文本转录
- `response.text.delta`：接收文本响应
- `error`：错误处理

## 注意事项

### 重要提示

1. **认证方式**：
   - API Key 已在代理服务器中配置，前端无需输入
   - 代理服务器解决了浏览器 WebSocket 无法设置自定义请求头的限制
   - 如需修改 API Key，请编辑 `proxy-server.js` 或使用环境变量

2. **HTTPS 要求**：需要 HTTPS 环境或 localhost 才能访问麦克风

3. **浏览器兼容性**：
   - Chrome/Edge（推荐，完全支持）
   - Firefox（支持）
   - Safari（部分功能可能受限）

4. **音频格式**：
   - 输入：16kHz PCM16（单声道，16位）
   - 输出：24kHz PCM（单声道，16位）

### 已知限制和解决方案

- **问题**：浏览器 WebSocket API 不支持自定义请求头，无法直接传递 `Authorization` 头
- **解决方案**：使用提供的代理服务器（`proxy-server.js`），在服务器端设置正确的请求头
- **代理服务器**：运行在 `localhost:3000`，转发 WebSocket 连接并添加认证头

## 参考文档

- [GLM-Realtime 官方文档](https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-realtime)
- [智谱 AI 开放平台](https://open.bigmodel.cn/)

## 开发说明

这是一个完全按照官方文档实现的演示，包含：

- ✅ 完整的会话配置（`session.update`）
- ✅ 正确的音频格式处理
- ✅ 完整的服务器事件处理
- ✅ 打断功能实现
- ✅ 错误处理和资源清理

### 生产环境建议

实际生产环境还需要：

- 完善的错误处理和重连机制
- API Key 安全存储（不应暴露在前端）
- 使用服务器代理处理认证
- 更完善的日志和监控
- 音频质量优化
