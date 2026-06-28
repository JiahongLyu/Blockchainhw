const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

// 部署顺序：先部署 ERC20 代币与 ERC721 徽章，再部署众筹主合约（注入两者地址），
// 最后把代币 / 徽章的铸造权（minter）授予众筹合约，使捐赠时可自动发放奖励。
module.exports = buildModule("CrowdfundingModule", (m) => {
  const token = m.contract("BackerToken");
  const badge = m.contract("EarlyBirdBadge");

  const crowdfunding = m.contract("Crowdfunding", [token, badge]);

  m.call(token, "setMinter", [crowdfunding]);
  m.call(badge, "setMinter", [crowdfunding]);

  return { token, badge, crowdfunding };
});
