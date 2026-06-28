# ChainFund · 基于区块链的去中心化众筹系统

> 代码仓库：https://github.com/JiahongLyu/Blockchainhw

参考 petshop 实验，使用 **Hardhat + ethers.js + MetaMask** 完成智能合约编写、本地链部署与前端展示。在核心众筹功能之上，强化了链上（智能合约）深度。

## 一、核心功能

- **项目创建**：名称、描述、目标金额、持续时长（及可选里程碑、是否启用投票治理），合约分配自增唯一 ID。
- **资金捐赠**：向进行中的项目捐款，记录每位捐赠者地址与累计金额并更新总额。
- **基于时间结束**：到期后任何人可调用 `finalize` 结算。
- **结果判断**：达标 → 发起人提款；未达标 → 捐赠者退款。
- **项目展示**：进行中 / 已结束项目的完整信息、捐赠者列表、链上动态。

## 二、加分项（全部实现，重点在链上）

1. **里程碑分期释放**：按"目标完成度 + 发起人标记"在项目进行中分批释放资金。
2. **早鸟奖励**：前 10 名捐赠者记录排名，并获**早鸟徽章 NFT** 与额外代币。
3. **捐赠者治理（DAO）**：里程碑放款前，捐赠者按出资权重链上投票，过半通过方可放款。
4. **奖励代币（ERC-20）**：捐赠自动获得 BACK 感谢代币（1 BACK/ETH，早鸟 +20%）。
5. **早鸟徽章（ERC-721）**：链上唯一的 NFT 徽章。
6. **重入攻击演示与防御**：攻击合约 + 测试验证 CEI + 重入锁有效（呼应 lab8）。
7. **工具链**：自定义 Hardhat CLI 任务 + Gas 用量报告。

## 三、里程碑与"全额退款"的冲突解决 ⭐

里程碑允许发起人在项目进行中分批提走资金，与"失败后全额退款"冲突。解决方案是「**未释放部分按比例全额退款**」：

```
可退 = 捐赠额 × (totalRaised − released) / totalRaised
```

无里程碑时 `released≡0`，自然退化为全额退款。详见《实验报告.md》第六节（含守恒性证明）。

## 四、合约结构

```
contracts/
  Crowdfunding.sol            # 主合约：项目/捐赠/里程碑/治理/退款
  BackerToken.sol            # ERC-20 奖励代币（自实现）
  EarlyBirdBadge.sol         # ERC-721 早鸟徽章（自实现）
  attack/ReentrancyAttacker.sol  # 重入攻击演示（仅测试用）
ignition/modules/Crowdfunding.js   # 多合约有序部署 + minter 接线
tasks/crowdfunding.js              # 自定义 Hardhat CLI 任务
test/Crowdfunding.test.js          # 17 个单元测试（全部通过）
src/                               # 前端（含深色模式 / 链上动态流 / 投票 UI）
```

## 五、运行步骤

```bash
npm install                              # 1. 安装依赖
npx hardhat test                         # 2. 运行测试
REPORT_GAS=true npx hardhat test         # 2b.（可选）带 Gas 报告
npx hardhat node                         # 3. 启动本地链（新终端保持运行）
npx hardhat ignition deploy ignition/modules/Crowdfunding.js --network localhost --reset  # 4. 部署
npm run dev                              # 5. 启动前端
```

或一键启动：`bash start.sh`。

MetaMask 连接 `http://127.0.0.1:8545`（Chain ID 31337），导入 `hardhat node` 输出的测试私钥即可操作。
使用 Ganache 时部署改为 `--network ganache`（7545）。

## 六、命令行交互（自定义任务）

```bash
npx hardhat cf:create --name "开源钱包" --goal 10 --minutes 60 --milestones 40,30,30 --vote --network localhost
npx hardhat cf:donate --id 0 --amount 4 --account 1 --network localhost
npx hardhat cf:list   --network localhost
npx hardhat cf:info 0 --network localhost
npx hardhat cf:finalize --id 0 --network localhost
```

## 七、主要合约接口

| 函数 | 说明 |
| --- | --- |
| `createProject(name, desc, goal, duration, milestonePercents[], requireVote)` | 创建项目 |
| `donate(id) payable` | 捐款，自动发放 BACK 代币与早鸟徽章 |
| `finalize(id)` | 到期结算 |
| `proposeMilestone(id)` / `voteOnMilestone(id, support)` | 治理：发起放款提案 / 按权重投票 |
| `releaseMilestone(id)` | 释放里程碑（治理项目需提案通过） |
| `withdraw(id)` | 成功后提取（全部 / 超额） |
| `refund(id)` | 失败后退回未释放部分 |
| `getAllProjects / getProject / getDonors / getMilestones / getProposal / refundableOf / isNextMilestoneUnlocked` | 视图查询 |
