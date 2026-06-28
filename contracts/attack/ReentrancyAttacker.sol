// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ICrowdfunding {
    function donate(uint256 id) external payable;
    function refund(uint256 id) external;
}

/// @title ReentrancyAttacker — 重入攻击演示合约
/// @notice 模拟"实验八 以太坊智能合约攻击"中的重入攻击：在收到退款的 receive 回调里，
///         趁众筹合约尚未完成记账时再次调用 refund，试图重复取款掏空合约。
/// @dev    众筹合约的 refund 采用 Checks-Effects-Interactions（先将 contributions 清零再转账）
///         并加 noReentrant 互斥锁，因此本攻击会被阻断——再入的 refund 要么命中重入锁回滚、
///         要么因余额已清零而无利可图。配套测试断言攻击者最终至多取回自己应得的份额。
contract ReentrancyAttacker {
    ICrowdfunding public immutable cf;
    uint256 public projectId;
    uint256 public reentryCount;
    bool private attacking;

    constructor(address _cf) {
        cf = ICrowdfunding(_cf);
    }

    /// @notice 以攻击者身份向项目捐款。
    function donateTo(uint256 id) external payable {
        projectId = id;
        cf.donate{value: msg.value}(id);
    }

    /// @notice 发起攻击：调用退款，并在回调中尝试重入。
    function attack() external {
        attacking = true;
        cf.refund(projectId);
        attacking = false;
    }

    /// @notice 收到退款时触发，尝试再次调用 refund（重入）。
    receive() external payable {
        if (attacking && reentryCount < 5) {
            reentryCount++;
            // 用 try/catch 吞掉被防御机制拒绝的再入调用，避免整笔交易直接回滚
            try cf.refund(projectId) {
                // 若这里成功，说明防御失效（不应发生）
            } catch {
                // 预期路径：被重入锁或"已清零"逻辑拒绝
            }
        }
    }

    function balance() external view returns (uint256) {
        return address(this).balance;
    }
}
