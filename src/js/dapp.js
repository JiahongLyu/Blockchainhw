import { ethers } from "./ethers.min.js";

const State = { 0: "进行中", 1: "成功", 2: "失败" };
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const ERC721_ABI = ["function balanceOf(address) view returns (uint256)"];

const DApp = {
  provider: null, signer: null, account: null, contract: null,
  token: null, badge: null, feed: [], _seen: new Set(), _busy: false, _inited: false,

  init: async function () {
    if (DApp._inited) return; // 防止重复初始化导致事件监听被注册多次
    DApp._inited = true;
    DApp.initTheme();
    if (!window.ethereum) { alert("请先安装 MetaMask！"); return; }
    DApp.provider = new ethers.BrowserProvider(window.ethereum);
    await window.ethereum.request({ method: "eth_requestAccounts" });
    DApp.signer = await DApp.provider.getSigner();
    DApp.account = (await DApp.signer.getAddress()).toLowerCase();
    document.getElementById("account").textContent =
      DApp.account.slice(0, 6) + "…" + DApp.account.slice(-4);
    window.ethereum.on("accountsChanged", () => location.reload());
    window.ethereum.on("chainChanged", () => location.reload());

    await DApp.initContract();
    DApp.bindEvents();
    await DApp.render();
    await DApp.loadHistory();
    DApp.subscribe();
  },

  initContract: async function () {
    const artifact = await fetch("Crowdfunding.sol/Crowdfunding.json").then((r) => r.json());
    const network = await DApp.provider.getNetwork();
    const chainId = network.chainId.toString();
    const deployed = await fetch(`chain-${chainId}/deployed_addresses.json`).then((r) => {
      if (!r.ok) throw new Error("找不到部署地址，请先部署合约");
      return r.json();
    });
    const address = deployed["CrowdfundingModule#Crowdfunding"];
    DApp.contract = new ethers.Contract(address, artifact.abi, DApp.provider);
    // 奖励代币 / 早鸟徽章（只读）
    try {
      const tokenAddr = await DApp.contract.rewardToken();
      const badgeAddr = await DApp.contract.earlyBirdBadge();
      DApp.token = new ethers.Contract(tokenAddr, ERC20_ABI, DApp.provider);
      DApp.badge = new ethers.Contract(badgeAddr, ERC721_ABI, DApp.provider);
    } catch (e) { console.warn("token/badge 读取失败", e); }
  },

  bindEvents: function () {
    document.getElementById("createForm").addEventListener("submit", DApp.handleCreate);
    document.getElementById("refreshBtn").addEventListener("click", () => DApp.render());
    document.getElementById("themeBtn").addEventListener("click", DApp.toggleTheme);
  },

  // ---------- 主题 ----------
  initTheme: function () {
    const saved = localStorage.getItem("cf-theme") || "light";
    document.documentElement.dataset.theme = saved;
    const btn = document.getElementById("themeBtn");
    if (btn) btn.textContent = saved === "dark" ? "☀️" : "🌙";
  },
  toggleTheme: function () {
    const cur = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = cur;
    localStorage.setItem("cf-theme", cur);
    document.getElementById("themeBtn").textContent = cur === "dark" ? "☀️" : "🌙";
  },

  // ---------- 钱包奖励展示 ----------
  refreshWallet: async function () {
    try {
      if (DApp.token) {
        const bal = await DApp.token.balanceOf(DApp.account);
        document.getElementById("backBal").textContent = (+ethers.formatEther(bal)).toFixed(2);
      }
      if (DApp.badge) {
        const n = await DApp.badge.balanceOf(DApp.account);
        document.getElementById("badgeBal").textContent = n.toString();
      }
    } catch (e) { /* ignore */ }
  },

  // ---------- 渲染 ----------
  // 带重入保护：并发调用时排队，避免事件密集触发时重复绘制卡片
  render: async function () {
    if (DApp._rendering) { DApp._renderQueued = true; return; }
    DApp._rendering = true;
    try {
      const projects = await DApp.contract.getAllProjects();
      const template = document.getElementById("cardTemplate");
      document.getElementById("emptyHint").style.display = projects.length === 0 ? "block" : "none";

      let active = 0, raised = 0n, donors = 0n;
      for (const p of projects) {
        if (Number(p.state) === 0) active++;
        raised += p.totalRaised; donors += p.donorCount;
      }
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set("statProjects", projects.length);
      set("statActive", active);
      set("statRaised", (+ethers.formatEther(raised)).toFixed(2));
      set("statDonors", donors.toString());

      // 先在内存碎片里构建所有卡片，最后一次性替换，避免中途被并发清空/追加
      const frag = document.createDocumentFragment();
      for (let i = projects.length - 1; i >= 0; i--) {
        const card = document.importNode(template.content, true);
        await DApp.fillCard(card, projects[i]);
        frag.appendChild(card);
      }
      const row = document.getElementById("projectsRow");
      row.innerHTML = "";
      row.appendChild(frag);
      await DApp.refreshWallet();
    } finally {
      DApp._rendering = false;
      if (DApp._renderQueued) { DApp._renderQueued = false; DApp.render(); }
    }
  },

  // 事件密集时合并多次重绘
  scheduleRender: function () {
    clearTimeout(DApp._renderTimer);
    DApp._renderTimer = setTimeout(() => DApp.render(), 250);
  },

  fillCard: async function (card, p) {
    const id = Number(p.id);
    const goal = p.goal, raised = p.totalRaised, released = p.released;
    const state = Number(p.state);
    const milestoneCount = Number(p.milestoneCount);
    const milestonesReleased = Number(p.milestonesReleased);
    const requireVote = p.requireVote;
    const pct = goal > 0n ? Math.min(100, Number((raised * 100n) / goal)) : 0;

    card.querySelector(".p-name").textContent = p.name;
    card.querySelector(".p-desc").textContent = p.description;
    if (requireVote) card.querySelector(".p-gov-tag").style.display = "inline-block";

    const badge = card.querySelector(".p-state");
    badge.textContent = State[state];
    badge.classList.add("st-" + state);

    const bar = card.querySelector(".p-bar");
    bar.style.width = pct + "%"; bar.textContent = pct + "%";
    if (state === 1) bar.classList.add("bg-success");

    card.querySelector(".p-raised").textContent = "已筹 " + ethers.formatEther(raised) + " ETH";
    card.querySelector(".p-goal").textContent = "目标 " + ethers.formatEther(goal) + " ETH";

    const deadline = Number(p.deadline) * 1000, now = Date.now();
    const timeEl = card.querySelector(".p-time");
    if (state !== 0) timeEl.textContent = "已结束";
    else if (deadline <= now) timeEl.textContent = "已到期，等待结算";
    else timeEl.textContent = "剩余 " + DApp.fmtDuration(deadline - now);

    // 里程碑
    const msEl = card.querySelector(".p-milestones");
    if (milestoneCount > 0) {
      const [percents] = await DApp.contract.getMilestones(id);
      msEl.innerHTML =
        '<span class="small text-muted">里程碑（占目标）：</span>' +
        percents.map((m, idx) =>
          `<span class="milestone-pill ${idx < milestonesReleased ? "done" : ""}">${idx < milestonesReleased ? "✓ " : ""}${m}%</span>`
        ).join("") +
        `<div class="small text-muted mt-1">已释放 ${ethers.formatEther(released)} / ${ethers.formatEther(raised)} ETH</div>`;
    }

    // 捐赠者
    const [donors, amounts, ranks] = await DApp.contract.getDonors(id);
    const donorsBox = card.querySelector(".p-donors");
    donorsBox.innerHTML = donors.length === 0
      ? '<span class="text-muted small">暂无捐赠</span>'
      : donors.map((d, k) => {
          const rank = Number(ranks[k]);
          const tag = rank > 0 ? `<span class="badge-eb">🏅第${rank}位早鸟</span>` : `<span>👤</span>`;
          return `<div class="donor-row"><span class="addr">${tag} ${d.slice(0, 10)}…</span><span>${ethers.formatEther(amounts[k])} ETH</span></div>`;
        }).join("");
    card.querySelector(".p-donors-toggle").addEventListener("click", () => {
      donorsBox.style.display = donorsBox.style.display === "none" ? "block" : "none";
    });

    // ---------- 按钮 / 治理 ----------
    const isCreator = p.creator.toLowerCase() === DApp.account;
    const myContribution = await DApp.contract.contributions(id, DApp.account);
    const expired = deadline <= now;
    const donateGroup = card.querySelector(".p-donate-group");
    const btnFinalize = card.querySelector(".btn-finalize");
    const btnPropose = card.querySelector(".btn-propose");
    const btnRelease = card.querySelector(".btn-release");
    const btnWithdraw = card.querySelector(".btn-withdraw");
    const btnRefund = card.querySelector(".btn-refund");

    if (state === 0 && !expired) {
      const amountInput = card.querySelector(".p-amount");
      card.querySelector(".btn-donate").addEventListener("click", () => DApp.handleDonate(id, amountInput));
    } else donateGroup.style.display = "none";

    if (state === 0 && expired) {
      btnFinalize.style.display = "block";
      btnFinalize.addEventListener("click", () => DApp.send((c) => c.finalize(id)));
    }

    // 里程碑 / 治理
    if (milestoneCount > 0 && state !== 2 && milestonesReleased < milestoneCount) {
      const unlocked = await DApp.contract.isNextMilestoneUnlocked(id);
      if (requireVote) {
        await DApp.renderGovernance(card, id, p, isCreator, myContribution, unlocked, milestonesReleased, milestoneCount, btnPropose, btnRelease);
      } else if (isCreator && unlocked) {
        btnRelease.style.display = "block";
        btnRelease.textContent = `释放里程碑 ${milestonesReleased + 1}/${milestoneCount}`;
        btnRelease.addEventListener("click", () => DApp.send((c) => c.releaseMilestone(id)));
      }
    }

    // 提取
    if (isCreator && state === 1) {
      const noMs = milestoneCount === 0 && released < raised;
      const msSurplus = milestoneCount > 0 && milestonesReleased === milestoneCount && released < raised;
      if (noMs || msSurplus) {
        btnWithdraw.style.display = "block";
        btnWithdraw.textContent = noMs ? "提取全部资金" : `提取超额 ${ethers.formatEther(raised - released)} ETH`;
        btnWithdraw.addEventListener("click", () => DApp.send((c) => c.withdraw(id)));
      }
    }

    // 退款
    if (state === 2 && myContribution > 0n) {
      const refundable = await DApp.contract.refundableOf(id, DApp.account);
      btnRefund.style.display = "block";
      if (refundable > 0n) {
        btnRefund.textContent = `申请退款 ${ethers.formatEther(refundable)} ETH`;
        btnRefund.addEventListener("click", () => DApp.send((c) => c.refund(id)));
      } else {
        btnRefund.disabled = true; btnRefund.textContent = "无可退款（已全部释放）";
      }
    }
  },

  // ---------- 治理 UI ----------
  renderGovernance: async function (card, id, p, isCreator, myContribution, unlocked, msReleased, msCount, btnPropose, btnRelease) {
    const govEl = card.querySelector(".p-gov");
    const [active, mIndex, yes, no, approved] = await DApp.contract.getProposal(id);

    if (!active) {
      if (isCreator && unlocked) {
        btnPropose.style.display = "block";
        btnPropose.textContent = `发起里程碑 ${msReleased + 1} 放款提案`;
        btnPropose.addEventListener("click", () => DApp.send((c) => c.proposeMilestone(id)));
      } else {
        govEl.innerHTML = `<div class="gov-box"><div class="ttl">🗳️ 治理项目</div><div class="small text-muted mt-1">${unlocked ? "等待发起人发起放款提案" : "筹款达到下一里程碑比例后可发起提案"}</div></div>`;
      }
      return;
    }

    // 有进行中的提案：展示票数进度
    const total = p.totalRaised;
    const yesPct = total > 0n ? Number((yes * 100n) / total) : 0;
    const noPct = total > 0n ? Number((no * 100n) / total) : 0;
    govEl.innerHTML =
      `<div class="gov-box">
        <div class="ttl">🗳️ 里程碑 ${Number(mIndex) + 1} 放款提案投票</div>
        <div class="vote-bar"><div class="yes" style="width:${yesPct}%"></div></div>
        <div class="vote-meta"><span>✅ 赞成 ${ethers.formatEther(yes)} ETH (${yesPct}%)</span><span>❌ ${ethers.formatEther(no)} ETH</span></div>
        <div class="small mt-1 ${approved ? "text-success" : "text-muted"}">${approved ? "✓ 已过半，可放款" : "需赞成权重 > 总筹集额一半"}</div>
        <div class="d-flex gap-2 mt-2 p-vote-btns"></div>
      </div>`;

    const voteBtns = govEl.querySelector(".p-vote-btns");
    const hasVoted = await DApp.contract.hasVoted(id, mIndex, DApp.account);
    if (myContribution > 0n && !hasVoted) {
      voteBtns.innerHTML = `<button class="btn btn-sm btn-vy flex-fill">✅ 赞成</button><button class="btn btn-sm btn-vn flex-fill">❌ 反对</button>`;
      voteBtns.children[0].addEventListener("click", () => DApp.send((c) => c.voteOnMilestone(id, true)));
      voteBtns.children[1].addEventListener("click", () => DApp.send((c) => c.voteOnMilestone(id, false)));
    } else if (hasVoted) {
      voteBtns.innerHTML = `<span class="small text-muted">你已投票</span>`;
    }

    if (isCreator && approved) {
      btnRelease.style.display = "block";
      btnRelease.textContent = `放款里程碑 ${msReleased + 1}/${msCount}（提案已通过）`;
      btnRelease.addEventListener("click", () => DApp.send((c) => c.releaseMilestone(id)));
    }
  },

  // ---------- 链上事件动态 ----------
  loadHistory: async function () {
    try {
      const latest = await DApp.provider.getBlockNumber();
      const from = Math.max(0, latest - 5000);
      const logs = await DApp.contract.queryFilter("*", from, latest);
      DApp.feed = [];
      for (const log of logs.slice(-40)) DApp.pushFeed(log, false);
      DApp.renderFeed();
    } catch (e) { console.warn("历史事件加载失败", e); }
  },

  subscribe: function () {
    const names = ["ProjectCreated", "Donated", "MilestoneProposed", "Voted", "MilestoneReleased", "FundsWithdrawn", "Refunded", "ProjectFinalized"];
    for (const n of names) {
      try {
        DApp.contract.on(n, (...args) => {
          const ev = args[args.length - 1];
          DApp.pushFeed(ev.log || ev, true);
          DApp.renderFeed();
          DApp.scheduleRender();
        });
      } catch (e) { /* ignore */ }
    }
  },

  pushFeed: function (log, prepend) {
    // 按 交易哈希 + 日志序号 去重，避免同一条链上事件被重复推送
    const key = log.transactionHash
      ? log.transactionHash + ":" + (log.index ?? log.logIndex ?? "0")
      : null;
    if (key && DApp._seen.has(key)) return;
    let parsed;
    try { parsed = DApp.contract.interface.parseLog(log); } catch { return; }
    if (!parsed) return;
    const item = DApp.describeEvent(parsed);
    if (!item) return;
    if (key) DApp._seen.add(key);
    if (prepend) DApp.feed.unshift(item); else DApp.feed.push(item);
    if (DApp.feed.length > 50) DApp.feed.pop();
  },

  describeEvent: function (ev) {
    const a = ev.args;
    const short = (x) => (typeof x === "string" && x.startsWith("0x") ? x.slice(0, 6) + "…" + x.slice(-4) : x);
    const eth = (x) => ethers.formatEther(x) + " ETH";
    const map = {
      ProjectCreated: () => ({ ic: "🚀", bg: "#eef2ff", txt: `新项目 #${a.id} 「${a.name}」`, sub: `by ${short(a.creator)}` }),
      Donated: () => ({ ic: "💰", bg: "#ecfdf5", txt: `捐赠 ${eth(a.amount)} → #${a.id}${a.earlyBirdRank > 0 ? ` 🏅#${a.earlyBirdRank}` : ""}`, sub: short(a.donor) }),
      MilestoneProposed: () => ({ ic: "🗳️", bg: "#fdf2ff", txt: `发起里程碑 ${Number(a.milestoneIndex) + 1} 放款提案 (#${a.id})`, sub: short(a.proposer) }),
      Voted: () => ({ ic: a.support ? "✅" : "❌", bg: "#f1f5f9", txt: `投票${a.support ? "赞成" : "反对"} 权重 ${eth(a.weight)} (#${a.id})`, sub: short(a.voter) }),
      MilestoneReleased: () => ({ ic: "🎯", bg: "#eef2ff", txt: `释放里程碑 ${Number(a.milestoneIndex) + 1}：${eth(a.amount)} (#${a.id})`, sub: "" }),
      FundsWithdrawn: () => ({ ic: "🏦", bg: "#ecfdf5", txt: `发起人提取 ${eth(a.amount)} (#${a.id})`, sub: "" }),
      Refunded: () => ({ ic: "↩️", bg: "#fef2f2", txt: `退款 ${eth(a.amount)} (#${a.id})`, sub: short(a.donor) }),
      ProjectFinalized: () => ({ ic: "🏁", bg: "#f1f5f9", txt: `项目 #${a.id} 结算：${State[Number(a.state)]}`, sub: "" }),
    };
    return map[ev.name] ? map[ev.name]() : null;
  },

  renderFeed: function () {
    const el = document.getElementById("activityFeed");
    if (DApp.feed.length === 0) { el.innerHTML = '<div class="feed-empty">暂无链上动态</div>'; return; }
    el.innerHTML = DApp.feed.map((it) =>
      `<div class="feed-item"><div class="feed-ic" style="background:${it.bg}">${it.ic}</div><div><div class="txt">${it.txt}</div>${it.sub ? `<div class="sub">${it.sub}</div>` : ""}</div></div>`
    ).join("");
  },

  // ---------- 交互 ----------
  handleCreate: async function (e) {
    e.preventDefault();
    const name = document.getElementById("f-name").value.trim();
    const desc = document.getElementById("f-desc").value.trim();
    const goal = ethers.parseEther(document.getElementById("f-goal").value);
    const duration = parseInt(document.getElementById("f-duration").value) * 60;
    const msRaw = document.getElementById("f-milestones").value.trim();
    const requireVote = document.getElementById("f-vote").checked;
    let milestones = [];
    if (msRaw) {
      milestones = msRaw.split(",").map((x) => parseInt(x.trim()));
      if (milestones.reduce((a, b) => a + b, 0) !== 100) { alert("里程碑比例之和必须为 100"); return; }
    }
    if (requireVote && milestones.length === 0) { alert("启用投票治理需要先设置里程碑"); return; }
    if (DApp._busy) return;
    DApp._busy = true;
    try {
      const tx = await DApp.contract.connect(DApp.signer).createProject(name, desc, goal, duration, milestones, requireVote);
      await tx.wait();
      e.target.reset();
      await DApp.render();
    } catch (err) { DApp.err(err); }
    finally { DApp._busy = false; }
  },

  handleDonate: async function (id, amountInput) {
    const amount = amountInput.value;
    if (!amount || Number(amount) <= 0) { alert("请输入捐赠金额"); return; }
    await DApp.send((c) => c.donate(id, { value: ethers.parseEther(amount) }));
  },

  send: async function (fn) {
    if (DApp._busy) return; // 防止重复提交导致多笔交易
    DApp._busy = true;
    try {
      const tx = await fn(DApp.contract.connect(DApp.signer));
      await tx.wait();
      await DApp.render();
    } catch (err) { DApp.err(err); }
    finally { DApp._busy = false; }
  },

  fmtDuration: function (ms) {
    const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d} 天 ${h} 小时`;
    if (h > 0) return `${h} 小时 ${m} 分`;
    return `${m} 分钟`;
  },

  err: function (err) {
    console.error(err);
    alert("操作失败：" + (err.shortMessage || err.reason || err.message));
  },
};

export { DApp };
