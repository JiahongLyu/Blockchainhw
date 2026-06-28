const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("Crowdfunding", function () {
  let cf, token, badge, creator, a, b, c;
  const DAY = 24 * 60 * 60;
  const E = (n) => ethers.parseEther(String(n));

  beforeEach(async function () {
    [creator, a, b, c] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("BackerToken")).deploy();
    badge = await (await ethers.getContractFactory("EarlyBirdBadge")).deploy();
    cf = await (await ethers.getContractFactory("Crowdfunding")).deploy(
      token.target,
      badge.target
    );
    await token.setMinter(cf.target);
    await badge.setMinter(cf.target);
  });

  async function newProject(goalEth = "10", duration = DAY, milestones = [], requireVote = false) {
    const tx = await cf.createProject("Test Project", "desc", E(goalEth), duration, milestones, requireVote);
    await tx.wait();
    return (await cf.getProjectCount()) - 1n;
  }

  // ---------------- 项目创建 ----------------
  describe("项目创建", function () {
    it("创建项目并分配自增唯一 ID", async function () {
      expect(await newProject()).to.equal(0n);
      expect(await newProject()).to.equal(1n);
      const p = await cf.getProject(0);
      expect(p.name).to.equal("Test Project");
      expect(p.goal).to.equal(E(10));
      expect(p.state).to.equal(0n);
    });

    it("校验参数：名称/目标/时长/里程碑合计/投票需里程碑", async function () {
      await expect(cf.createProject("", "d", E(1), DAY, [], false)).to.be.revertedWith("name required");
      await expect(cf.createProject("x", "d", 0, DAY, [], false)).to.be.revertedWith("goal must be > 0");
      await expect(cf.createProject("x", "d", E(1), DAY, [40, 40], false)).to.be.revertedWith("milestones must sum to 100");
      await expect(cf.createProject("x", "d", E(1), DAY, [], true)).to.be.revertedWith("vote needs milestones");
    });

    it("发出 ProjectCreated 事件", async function () {
      await expect(cf.createProject("N", "D", E(5), DAY, [50, 50], false))
        .to.emit(cf, "ProjectCreated")
        .withArgs(0, creator.address, "N", E(5), anyValue, 2, false);
    });
  });

  // ---------------- 捐赠、早鸟、代币、徽章 ----------------
  describe("捐赠 / 早鸟 / 奖励代币 / 徽章 NFT", function () {
    it("累计捐赠、记录捐赠者并更新总额", async function () {
      const id = await newProject();
      await cf.connect(a).donate(id, { value: E(3) });
      await cf.connect(a).donate(id, { value: E(2) });
      await cf.connect(b).donate(id, { value: E(1) });
      const p = await cf.getProject(id);
      expect(p.totalRaised).to.equal(E(6));
      expect(p.donorCount).to.equal(2n);
      const [donors, amounts, ranks] = await cf.getDonors(id);
      expect(donors).to.deep.equal([a.address, b.address]);
      expect(amounts[0]).to.equal(E(5));
      expect(ranks[0]).to.equal(1n);
    });

    it("捐赠铸造 BACK 奖励代币，早鸟额外 +20%", async function () {
      const id = await newProject("100");
      await cf.connect(a).donate(id, { value: E(1) }); // 早鸟 → 1 + 20% = 1.2
      expect(await token.balanceOf(a.address)).to.equal(E("1.2"));
    });

    it("前 10 名为早鸟并获徽章 NFT，第 11 名无早鸟、无徽章", async function () {
      const id = await newProject("100");
      const signers = await ethers.getSigners();
      for (let i = 0; i < 11; i++) {
        await cf.connect(signers[i]).donate(id, { value: E(1) });
      }
      expect(await cf.earlyBirdRank(id, signers[9].address)).to.equal(10n);
      expect(await cf.earlyBirdRank(id, signers[10].address)).to.equal(0n);
      // 第 11 名只得基础代币 1.0，无 +20%
      expect(await token.balanceOf(signers[10].address)).to.equal(E("1"));
      // 仅前 10 名各获一枚徽章
      expect(await badge.totalSupply()).to.equal(10n);
      expect(await badge.balanceOf(signers[0].address)).to.equal(1n);
      expect(await badge.balanceOf(signers[10].address)).to.equal(0n);
      expect(await badge.ownerOf(1)).to.equal(signers[0].address);
      expect(await badge.tokenURI(1)).to.contain("Early Bird");
    });

    it("拒绝 0 捐赠与对过期项目捐赠", async function () {
      const id = await newProject();
      await expect(cf.connect(a).donate(id, { value: 0 })).to.be.revertedWith("donation must be > 0");
      await time.increase(DAY + 1);
      await expect(cf.connect(a).donate(id, { value: E(1) })).to.be.revertedWith("deadline passed");
    });
  });

  // ---------------- 结束逻辑 ----------------
  describe("基于时间的结束", function () {
    it("到期前不能 finalize，到期后未达标 → Failed", async function () {
      const id = await newProject();
      await expect(cf.finalize(id)).to.be.revertedWith("not yet ended");
      await time.increase(DAY + 1);
      await cf.finalize(id);
      expect((await cf.getProject(id)).state).to.equal(2n);
    });

    it("达标后 → Successful，不能重复 finalize", async function () {
      const id = await newProject("5");
      await cf.connect(a).donate(id, { value: E(6) });
      await time.increase(DAY + 1);
      await cf.finalize(id);
      expect((await cf.getProject(id)).state).to.equal(1n);
      await expect(cf.finalize(id)).to.be.revertedWith("already finalized");
    });
  });

  // ---------------- 无里程碑 ----------------
  describe("无里程碑项目", function () {
    it("成功后发起人一次性提走全部资金", async function () {
      const id = await newProject("5");
      await cf.connect(a).donate(id, { value: E(6) });
      await time.increase(DAY + 1);
      await cf.finalize(id);
      await expect(cf.connect(creator).withdraw(id)).to.changeEtherBalance(creator, E(6));
      await expect(cf.connect(creator).withdraw(id)).to.be.revertedWith("nothing to withdraw");
    });

    it("失败后捐赠者全额退款（released=0 退化为全额）", async function () {
      const id = await newProject("100");
      await cf.connect(a).donate(id, { value: E(2) });
      await time.increase(DAY + 1);
      await cf.finalize(id);
      expect(await cf.refundableOf(id, a.address)).to.equal(E(2));
      await expect(cf.connect(a).refund(id)).to.changeEtherBalance(a, E(2));
      await expect(cf.connect(a).refund(id)).to.be.revertedWith("nothing to refund");
    });
  });

  // ---------------- 里程碑（无投票） ----------------
  describe("里程碑分期释放（完成度 + 发起人标记）", function () {
    it("进行中按目标完成度逐级释放，仅发起人可释放", async function () {
      const id = await newProject("10", DAY, [40, 30, 30]);
      await cf.connect(a).donate(id, { value: E(3) });
      expect(await cf.isNextMilestoneUnlocked(id)).to.equal(false);
      await expect(cf.connect(creator).releaseMilestone(id)).to.be.revertedWith("funding threshold not reached");
      await cf.connect(a).donate(id, { value: E(1) }); // 到 40%
      await expect(cf.connect(a).releaseMilestone(id)).to.be.revertedWith("only creator");
      await expect(cf.connect(creator).releaseMilestone(id)).to.changeEtherBalance(creator, E(4));
      await cf.connect(b).donate(id, { value: E(3) }); // 到 70%
      await expect(cf.connect(creator).releaseMilestone(id)).to.changeEtherBalance(creator, E(3));
      const p = await cf.getProject(id);
      expect(p.released).to.equal(E(7));
      expect(p.milestonesReleased).to.equal(2n);
    });

    it("成功后释放全部里程碑并提取超额", async function () {
      const id = await newProject("10", DAY, [40, 30, 30]);
      await cf.connect(a).donate(id, { value: E(12) });
      await time.increase(DAY + 1);
      await cf.finalize(id);
      await expect(cf.connect(creator).releaseMilestone(id)).to.changeEtherBalance(creator, E(4));
      await expect(cf.connect(creator).releaseMilestone(id)).to.changeEtherBalance(creator, E(3));
      await expect(cf.connect(creator).releaseMilestone(id)).to.changeEtherBalance(creator, E(3));
      await expect(cf.connect(creator).releaseMilestone(id)).to.be.revertedWith("all milestones released");
      await expect(cf.connect(creator).withdraw(id)).to.changeEtherBalance(creator, E(2));
    });
  });

  // ---------------- 冲突解决：失败后按未释放比例退款 ----------------
  describe("冲突解决：失败后未释放部分按比例退款", function () {
    it("已释放里程碑后失败，捐赠者按未释放比例退款", async function () {
      const id = await newProject("10", DAY, [40, 30, 30]);
      await cf.connect(a).donate(id, { value: E(4) });
      await cf.connect(b).donate(id, { value: E(2) });
      await cf.connect(creator).releaseMilestone(id); // 释放 4
      await time.increase(DAY + 1);
      await cf.finalize(id);
      expect((await cf.getProject(id)).state).to.equal(2n);
      // 未释放 = 2，比例 1/3
      expect(await cf.refundableOf(id, a.address)).to.equal(E(4) / 3n);
      expect(await cf.refundableOf(id, b.address)).to.equal(E(2) / 3n);
      await expect(cf.connect(a).refund(id)).to.changeEtherBalance(a, E(4) / 3n);
      await expect(cf.connect(b).refund(id)).to.changeEtherBalance(b, E(2) / 3n);
    });
  });

  // ---------------- 治理投票（DAO） ----------------
  describe("捐赠者治理投票（DAO）", function () {
    it("治理项目：提案 + 过半投票后方可放款", async function () {
      const id = await newProject("10", DAY, [50, 50], true);
      await cf.connect(a).donate(id, { value: E(6) });
      await cf.connect(b).donate(id, { value: E(4) }); // 共 10

      // 未提案不能放款
      await expect(cf.connect(creator).releaseMilestone(id)).to.be.revertedWith("no proposal");

      // 仅发起人能提案
      await expect(cf.connect(a).proposeMilestone(id)).to.be.revertedWith("only creator");
      await cf.connect(creator).proposeMilestone(id);

      // 非捐赠者不能投票；重复投票被拒
      await expect(cf.connect(c).voteOnMilestone(id, true)).to.be.revertedWith("not a donor");
      await cf.connect(a).voteOnMilestone(id, true); // 权重 6
      await expect(cf.connect(a).voteOnMilestone(id, true)).to.be.revertedWith("already voted");

      // 6*2=12 > 10 → 通过
      expect(await cf.isProposalApproved(id)).to.equal(true);
      await expect(cf.connect(creator).releaseMilestone(id)).to.changeEtherBalance(creator, E(5));
      expect((await cf.getProject(id)).milestonesReleased).to.equal(1n);
    });

    it("治理项目：赞成权重未过半则放款被拒", async function () {
      const id = await newProject("10", DAY, [50, 50], true);
      await cf.connect(a).donate(id, { value: E(6) });
      await cf.connect(b).donate(id, { value: E(4) });
      await cf.connect(creator).proposeMilestone(id);
      await cf.connect(b).voteOnMilestone(id, true); // 仅 4，4*2=8 不> 10
      expect(await cf.isProposalApproved(id)).to.equal(false);
      await expect(cf.connect(creator).releaseMilestone(id)).to.be.revertedWith("vote not passed");
    });
  });

  // ---------------- 安全：重入攻击防御 ----------------
  describe("安全：重入攻击防御", function () {
    it("攻击者无法通过重入重复取款", async function () {
      const id = await newProject("100"); // 注定失败
      const Attacker = await ethers.getContractFactory("ReentrancyAttacker");
      const atk = await Attacker.deploy(cf.target);
      await atk.donateTo(id, { value: E(2) });

      await time.increase(DAY + 1);
      await cf.finalize(id);

      await atk.attack();

      // 攻击者至多取回自己应得的 2 ETH，且确实尝试过重入
      expect(await ethers.provider.getBalance(atk.target)).to.equal(E(2));
      expect(await atk.reentryCount()).to.be.greaterThan(0n);
      // 合约已被掏空到 0，无超额损失
      expect(await ethers.provider.getBalance(cf.target)).to.equal(0n);
    });
  });
});
