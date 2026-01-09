#!/bin/bash

# GLM-Realtime Demo 启动脚本

echo "🚀 启动 GLM-Realtime Demo"
echo ""

# 检查 Node.js 是否安装
if ! command -v node &> /dev/null; then
    echo "❌ 错误: 未安装 Node.js"
    echo "请访问 https://nodejs.org/ 安装 Node.js"
    exit 1
fi

# 检查依赖是否安装
if [ ! -d "node_modules" ]; then
    echo "📦 安装依赖..."
    npm install
    echo ""
fi

# 启动代理服务器
echo "🔌 启动代理服务器 (端口 3000)..."
echo "   前端页面请访问: http://localhost:8000/index.html"
echo "   或直接打开 index.html 文件"
echo ""
echo "按 Ctrl+C 停止服务器"
echo ""

node proxy-server.js
