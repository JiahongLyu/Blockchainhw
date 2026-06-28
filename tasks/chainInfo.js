// 添加自定义任务，用于显示当前链的账户状态以及最新区块的信息
task("chain-info", "show balance and lastest block").setAction(async (args, hre) => {
    // 获取账户信息
    const accounts = await hre.ethers.getSigners();
    console.log("=== Accounts ===");
    for (const account of accounts) {
        const balance = await hre.ethers.provider.getBalance(account.address);
        console.log(`${account.address}  balance: ${hre.ethers.formatEther(balance)} ETH`);
    }

    // 获取当前区块高度
    const blockNumber = await hre.ethers.provider.getBlockNumber();
    console.log(`\n=== Block height ===\n${blockNumber}`);

    // 获取最新区块信息
    const block = await hre.ethers.provider.getBlock(blockNumber);
    console.log(`\n=== Latest block ===`);
    console.log(block);
});


///导出
module.exports = {};
