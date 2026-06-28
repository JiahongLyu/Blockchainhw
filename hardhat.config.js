require("@nomicfoundation/hardhat-toolbox");
require("./tasks/chainInfo");
require("./tasks/crowdfunding");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    // 连接本地 Ganache（默认端口 7545）；不填则用 Hardhat 内置节点
    ganache: {
      url: "http://127.0.0.1:7545",
    },
  },
  // 运行测试时打印各函数 gas 用量： REPORT_GAS=true npx hardhat test
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "ETH",
    excludeContracts: ["ReentrancyAttacker"],
  },
};
