// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title EarlyBirdBadge (EBADGE) — 早鸟徽章 NFT
/// @notice 一个从零实现、符合 ERC-721 核心接口的最小 NFT。每个项目前 10 名捐赠者
///         自动获得一枚独一无二的早鸟徽章。仅授权的 minter（众筹合约）可铸造。
/// @dev    自实现以展示对 ERC-721 标准（ownerOf / balanceOf / transferFrom / tokenURI / 事件 /
///         supportsInterface）的理解，不依赖 OpenZeppelin。使用 _mint（非 safeMint）避免回调，
///         防止铸造过程引入重入风险。
contract EarlyBirdBadge {
    string public constant name = "ChainFund Early Bird Badge";
    string public constant symbol = "EBADGE";

    address public owner;
    address public minter;
    uint256 public totalSupply; // 同时用作自增 tokenId

    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    mapping(uint256 => string) private _tokenURIs;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event MinterChanged(address indexed newMinter);

    constructor() {
        owner = msg.sender;
        minter = msg.sender;
    }

    function setMinter(address newMinter) external {
        require(msg.sender == owner, "only owner");
        require(newMinter != address(0), "zero minter");
        minter = newMinter;
        emit MinterChanged(newMinter);
    }

    /// @notice 仅 minter 可铸造，返回新 tokenId。
    function mint(address to, string calldata uri) external returns (uint256) {
        require(msg.sender == minter, "only minter");
        require(to != address(0), "mint to zero");
        uint256 tokenId = ++totalSupply; // 从 1 开始
        ownerOf[tokenId] = to;
        unchecked {
            balanceOf[to] += 1;
        }
        _tokenURIs[tokenId] = uri;
        emit Transfer(address(0), to, tokenId);
        return tokenId;
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(ownerOf[tokenId] != address(0), "nonexistent token");
        return _tokenURIs[tokenId];
    }

    function approve(address to, uint256 tokenId) external {
        address holder = ownerOf[tokenId];
        require(holder != address(0), "nonexistent token");
        require(
            msg.sender == holder || isApprovedForAll[holder][msg.sender],
            "not authorized"
        );
        getApproved[tokenId] = to;
        emit Approval(holder, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(ownerOf[tokenId] == from, "wrong from");
        require(to != address(0), "transfer to zero");
        require(
            msg.sender == from ||
                getApproved[tokenId] == msg.sender ||
                isApprovedForAll[from][msg.sender],
            "not authorized"
        );
        delete getApproved[tokenId];
        unchecked {
            balanceOf[from] -= 1;
            balanceOf[to] += 1;
        }
        ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    /// @notice ERC-165：声明支持 ERC-721 与 ERC-721 Metadata 接口。
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == 0x01ffc9a7 || // ERC-165
            interfaceId == 0x80ac58cd || // ERC-721
            interfaceId == 0x5b5e139f; // ERC-721 Metadata
    }
}
