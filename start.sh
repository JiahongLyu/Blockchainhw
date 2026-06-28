#!/usr/bin/env bash
# 一键启动：本地链 + 部署合约 + 前端
# 用法：在 crowdfunding 目录下执行  bash start.sh
set -e
cd "$(dirname "$0")"

echo "==> [1/4] 安装依赖（已装会自动跳过）"
npm install

echo "==> [2/4] 启动本地链（后台，日志见 node.log）"
npx hardhat node > node.log 2>&1 &
NODE_PID=$!
echo "    hardhat node PID=$NODE_PID，等待启动..."
# 等待 8545 端口就绪
for i in $(seq 1 30); do
  if curl -s http://127.0.0.1:8545 -X POST -H 'content-type:application/json' \
     --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' | grep -q result; then
    echo "    本地链已就绪 ✅"; break
  fi
  sleep 1
done

echo "==> [3/4] 部署合约到本地链"
npx hardhat ignition deploy ignition/modules/Crowdfunding.js --network localhost --reset

echo "==> [4/4] 启动前端（浏览器会自动打开 http://localhost:3000）"
echo "    关闭时按 Ctrl+C，然后运行： kill $NODE_PID  停止本地链"
echo "    ⚠️ 测试私钥见 node.log 顶部的 Account 列表，导入 MetaMask 使用"
npm run dev
