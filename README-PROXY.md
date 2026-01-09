# 代理服务器使用说明

## 为什么需要代理服务器？

浏览器的 WebSocket API **不支持自定义请求头**，而智谱 AI 的 GLM-Realtime API 要求通过 `Authorization` 请求头传递 API Key。

代理服务器在服务器端（Node.js）运行，可以：
- ✅ 设置自定义请求头（Authorization）
- ✅ 正确传递 API Key
- ✅ 转发 WebSocket 消息

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动代理服务器

```bash
npm start
```

服务器会在 `http://localhost:3000` 启动。

1. **配置 API Key**：复制 `.env.example` 为 `.env` 并填入 API Key
2. 启动代理服务器：`npm start`
3. 打开 `index.html`
4. 点击"开始学习模式"

## 工作原理

```
浏览器 (前端)
    ↓ WebSocket (ws://localhost:3000/proxy)
代理服务器 (Node.js + .env)
    ↓ WebSocket + Authorization 头 (wss://open.bigmodel.cn/...)
智谱 AI 服务器
```

## 故障排除

### 问题：无法连接到代理服务器

**解决方案**：
1. 确保代理服务器正在运行：`npm start`
2. 检查端口 3000 是否被占用
3. 确保前端页面通过 `http://localhost:8000` 访问（不是 `file://`）

### 问题：代理服务器连接失败

**可能原因**：
1. API Key 无效或过期
2. 网络连接问题
3. 智谱 AI 服务暂时不可用

**解决方案**：
- 检查控制台日志
- 验证 API Key 是否正确
- 检查网络连接

### 问题：CORS 错误

如果遇到 CORS 错误，确保：
1. 前端页面通过 HTTP 服务器访问（不是直接打开文件）
2. 使用 `python -m http.server 8000` 或 `npx http-server -p 8000`

## 安全提示

⚠️ **重要**：代理服务器仅用于开发测试。生产环境应该：
- 在服务器端验证 API Key
- 使用 HTTPS
- 添加身份验证
- 限制访问来源

## 自定义配置

可以修改 `proxy-server.js` 中的配置：

```javascript
const PORT = 3000;  // 修改端口
```

## 依赖

- `ws`: WebSocket 库（Node.js）

安装：`npm install ws`
