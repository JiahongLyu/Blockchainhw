// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title BackerToken (BACK) — 众筹感谢/治理奖励代币
/// @notice 一个从零实现、符合 ERC-20 接口的最小代币。捐赠者每捐 1 ETH 获得 1 BACK，
///         早鸟额外获得 20% 奖励。仅授权的 minter（众筹合约）可铸造。
/// @dev    自实现以展示对 ERC-20 标准（balanceOf / transfer / approve / transferFrom / 事件）的理解，
///         不依赖 OpenZeppelin。
contract BackerToken {
    string public constant name = "Backer Reward Token";
    string public constant symbol = "BACK";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public owner; // 部署者，可设置 minter
    address public minter; // 被授权铸造者（众筹合约）

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MinterChanged(address indexed newMinter);

    constructor() {
        owner = msg.sender;
        minter = msg.sender; // 部署后由 owner 改为众筹合约
    }

    /// @notice 将铸造权转交给众筹合约（部署接线时调用）。
    function setMinter(address newMinter) external {
        require(msg.sender == owner, "only owner");
        require(newMinter != address(0), "zero minter");
        minter = newMinter;
        emit MinterChanged(newMinter);
    }

    /// @notice 仅 minter 可铸造奖励代币。
    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "only minter");
        require(to != address(0), "mint to zero");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "insufficient allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "transfer to zero");
        require(balanceOf[from] >= amount, "insufficient balance");
        unchecked {
            balanceOf[from] -= amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}
