// 自定义 Hardhat 命令行任务：无需前端即可在终端与众筹合约交互。
// 部署后会在 ignition/deployments/chain-<id>/deployed_addresses.json 中找到合约地址。
const STATE = ["进行中", "成功", "失败"];

async function getContract(hre) {
  const net = await hre.ethers.provider.getNetwork();
  const file = require("path").join(
    __dirname,
    `../ignition/deployments/chain-${net.chainId}/deployed_addresses.json`
  );
  const addrs = require(file);
  const address = addrs["CrowdfundingModule#Crowdfunding"];
  return hre.ethers.getContractAt("Crowdfunding", address);
}

// 列出所有项目
task("cf:list", "列出所有众筹项目").setAction(async (_args, hre) => {
  const cf = await getContract(hre);
  const ps = await cf.getAllProjects();
  if (ps.length === 0) return console.log("（暂无项目）");
  for (const p of ps) {
    console.log(
      `#${p.id} ${p.name} | ${STATE[Number(p.state)]} | ` +
        `${hre.ethers.formatEther(p.totalRaised)}/${hre.ethers.formatEther(p.goal)} ETH | ` +
        `里程碑 ${p.milestonesReleased}/${p.milestoneCount}` +
        `${p.requireVote ? " | 治理投票" : ""}`
    );
  }
});

// 查看单个项目详情
task("cf:info", "查看项目详情")
  .addPositionalParam("id", "项目 ID")
  .setAction(async (args, hre) => {
    const cf = await getContract(hre);
    const p = await cf.getProject(args.id);
    console.log(`#${p.id} ${p.name}\n  ${p.description}`);
    console.log(`  状态: ${STATE[Number(p.state)]}`);
    console.log(`  目标: ${hre.ethers.formatEther(p.goal)} ETH  已筹: ${hre.ethers.formatEther(p.totalRaised)} ETH`);
    console.log(`  已释放: ${hre.ethers.formatEther(p.released)} ETH  里程碑: ${p.milestonesReleased}/${p.milestoneCount}`);
    const [d, a, r] = await cf.getDonors(args.id);
    d.forEach((x, i) => console.log(`    ${r[i] > 0 ? "🏅#" + r[i] : "  "} ${x} — ${hre.ethers.formatEther(a[i])} ETH`));
  });

// 创建项目： npx hardhat cf:create --name "X" --desc "Y" --goal 10 --minutes 60 --milestones 40,30,30 --vote
task("cf:create", "创建一个众筹项目")
  .addParam("name", "项目名称")
  .addOptionalParam("desc", "项目描述", "")
  .addParam("goal", "目标金额(ETH)")
  .addOptionalParam("minutes", "持续分钟", "60")
  .addOptionalParam("milestones", "里程碑比例,逗号分隔(如 40,30,30)", "")
  .addFlag("vote", "里程碑放款需捐赠者投票治理")
  .setAction(async (args, hre) => {
    const cf = await getContract(hre);
    const ms = args.milestones ? args.milestones.split(",").map((x) => parseInt(x.trim())) : [];
    const tx = await cf.createProject(
      args.name,
      args.desc,
      hre.ethers.parseEther(args.goal),
      parseInt(args.minutes) * 60,
      ms,
      args.vote
    );
    const rc = await tx.wait();
    const count = await cf.getProjectCount();
    console.log(`✅ 已创建项目 #${count - 1n}  (tx: ${rc.hash})`);
  });

// 捐赠： npx hardhat cf:donate --id 0 --amount 1 [--account 1]
task("cf:donate", "向项目捐赠")
  .addParam("id", "项目 ID")
  .addParam("amount", "捐赠金额(ETH)")
  .addOptionalParam("account", "使用第几个签名账户", "0")
  .setAction(async (args, hre) => {
    const signers = await hre.ethers.getSigners();
    const signer = signers[parseInt(args.account)];
    const cf = (await getContract(hre)).connect(signer);
    const tx = await cf.donate(args.id, { value: hre.ethers.parseEther(args.amount) });
    await tx.wait();
    console.log(`✅ ${signer.address} 向 #${args.id} 捐赠 ${args.amount} ETH`);
  });

// 结束项目： npx hardhat cf:finalize --id 0
task("cf:finalize", "结算项目")
  .addParam("id", "项目 ID")
  .setAction(async (args, hre) => {
    const cf = await getContract(hre);
    await (await cf.finalize(args.id)).wait();
    const p = await cf.getProject(args.id);
    console.log(`✅ #${args.id} 已结算：${STATE[Number(p.state)]}`);
  });

module.exports = {};
