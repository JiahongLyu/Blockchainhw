// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IBackerToken {
    function mint(address to, uint256 amount) external;
}

interface IEarlyBirdBadge {
    function mint(address to, string calldata uri) external returns (uint256);
}

/// @title 基于区块链的众筹系统（Crowdfunding）
/// @author 期末大作业
/// @notice 功能：项目创建、资金捐赠、基于时间的结束、成功提款与失败退款；
///         加分项：
///           (1) 简化版里程碑——基于"目标完成度"且需"发起人标记/捐赠者治理投票"的分期释放；
///           (2) 早鸟奖励——前 N 名捐赠者记录排名、铸造早鸟徽章 NFT 并获额外代币；
///           (3) 捐赠者治理（DAO）——里程碑放款前由捐赠者按出资权重链上投票，过半通过方可放款；
///           (4) 奖励代币——捐赠自动获得 ERC-20 感谢代币（BACK）。
///
/// @dev    冲突解决：里程碑允许发起人在项目进行中分批提走资金，与"失败后全额退款"冲突。
///         故退款规则调整为「未释放部分按比例全额退款」：
///             可退 = 捐赠额 × (totalRaised − released) / totalRaised
///         无里程碑时 released 恒为 0，自然退化为全额退款。
contract Crowdfunding {
    // ------------------------------------------------------------------
    // 数据结构
    // ------------------------------------------------------------------

    enum State {
        Active, // 0 进行中
        Successful, // 1 已结束：达到或超过目标
        Failed // 2 已结束：未达目标
    }

    struct Project {
        uint256 id;
        address payable creator;
        string name;
        string description;
        uint256 goal;
        uint256 deadline;
        uint256 totalRaised;
        uint256 released; // 已释放给发起人的累计金额
        State state;
        uint256 donorCount;
        uint8 milestoneCount;
        uint8 milestonesReleased;
        bool requireVote; // 是否启用捐赠者治理投票
    }

    /// @notice 里程碑放款提案（治理项目使用）
    struct Proposal {
        bool active;
        uint8 milestoneIndex; // 针对哪个里程碑
        uint256 yesWeight; // 赞成的出资权重之和
        uint256 noWeight; // 反对的出资权重之和
        uint256 createdAt;
    }

    uint256 public constant EARLY_BIRD_LIMIT = 10; // 早鸟名额
    uint256 public constant EARLY_BIRD_BONUS_BP = 2000; // 早鸟额外代币 +20%（基点）

    IBackerToken public immutable rewardToken; // ERC-20 奖励代币
    IEarlyBirdBadge public immutable earlyBirdBadge; // ERC-721 早鸟徽章

    Project[] private projects;

    mapping(uint256 => address[]) private donorList;
    mapping(uint256 => mapping(address => uint256)) public contributions;
    mapping(uint256 => mapping(address => uint256)) public earlyBirdRank; // 1-based，0 表示非早鸟
    mapping(uint256 => uint8[]) private milestones;

    // 治理：每个项目当前的里程碑提案
    mapping(uint256 => Proposal) private proposals;
    // projectId => milestoneIndex => voter => 是否已投票
    mapping(uint256 => mapping(uint8 => mapping(address => bool))) public hasVoted;

    bool private locked; // 重入锁

    // ------------------------------------------------------------------
    // 事件
    // ------------------------------------------------------------------

    event ProjectCreated(
        uint256 indexed id,
        address indexed creator,
        string name,
        uint256 goal,
        uint256 deadline,
        uint8 milestoneCount,
        bool requireVote
    );
    event Donated(
        uint256 indexed id,
        address indexed donor,
        uint256 amount,
        uint256 earlyBirdRank,
        uint256 rewardMinted
    );
    event ProjectFinalized(uint256 indexed id, State state, uint256 totalRaised);
    event MilestoneProposed(uint256 indexed id, uint8 indexed milestoneIndex, address proposer);
    event Voted(uint256 indexed id, uint8 indexed milestoneIndex, address indexed voter, bool support, uint256 weight);
    event MilestoneReleased(uint256 indexed id, uint256 indexed milestoneIndex, uint256 amount);
    event FundsWithdrawn(uint256 indexed id, uint256 amount);
    event Refunded(uint256 indexed id, address indexed donor, uint256 amount);

    // ------------------------------------------------------------------
    // 修饰器
    // ------------------------------------------------------------------

    modifier exists(uint256 id) {
        require(id < projects.length, "project not found");
        _;
    }

    modifier noReentrant() {
        require(!locked, "reentrant call");
        locked = true;
        _;
        locked = false;
    }

    constructor(address token, address badge) {
        rewardToken = IBackerToken(token);
        earlyBirdBadge = IEarlyBirdBadge(badge);
    }

    // ------------------------------------------------------------------
    // 1. 项目创建
    // ------------------------------------------------------------------

    /// @param milestonePercents 里程碑比例（占目标，合计 100），空数组表示成功后一次性提款
    /// @param requireVote       true 则里程碑放款需捐赠者治理投票过半
    function createProject(
        string calldata name,
        string calldata description,
        uint256 goal,
        uint256 durationSeconds,
        uint8[] calldata milestonePercents,
        bool requireVote
    ) external returns (uint256) {
        require(bytes(name).length > 0, "name required");
        require(goal > 0, "goal must be > 0");
        require(durationSeconds > 0, "duration must be > 0");
        require(milestonePercents.length <= 255, "too many milestones");

        if (milestonePercents.length > 0) {
            uint256 sum;
            for (uint256 i = 0; i < milestonePercents.length; i++) {
                require(milestonePercents[i] > 0, "milestone % must be > 0");
                sum += milestonePercents[i];
            }
            require(sum == 100, "milestones must sum to 100");
        } else {
            require(!requireVote, "vote needs milestones");
        }

        uint256 id = projects.length;
        projects.push(
            Project({
                id: id,
                creator: payable(msg.sender),
                name: name,
                description: description,
                goal: goal,
                deadline: block.timestamp + durationSeconds,
                totalRaised: 0,
                released: 0,
                state: State.Active,
                donorCount: 0,
                milestoneCount: uint8(milestonePercents.length),
                milestonesReleased: 0,
                requireVote: requireVote
            })
        );
        milestones[id] = milestonePercents;

        emit ProjectCreated(
            id,
            msg.sender,
            name,
            goal,
            projects[id].deadline,
            uint8(milestonePercents.length),
            requireVote
        );
        return id;
    }

    // ------------------------------------------------------------------
    // 2. 资金捐赠（同时发放奖励代币与早鸟徽章）
    // ------------------------------------------------------------------

    function donate(uint256 id) external payable exists(id) {
        Project storage p = projects[id];
        require(p.state == State.Active, "project not active");
        require(block.timestamp < p.deadline, "deadline passed");
        require(msg.value > 0, "donation must be > 0");

        uint256 rank = earlyBirdRank[id][msg.sender];
        bool newEarlyBird = false;
        if (contributions[id][msg.sender] == 0) {
            donorList[id].push(msg.sender);
            p.donorCount += 1;
            if (p.donorCount <= EARLY_BIRD_LIMIT) {
                rank = p.donorCount;
                earlyBirdRank[id][msg.sender] = rank;
                newEarlyBird = true;
            }
        }

        // 先完成本合约状态更新（Checks-Effects-Interactions）
        contributions[id][msg.sender] += msg.value;
        p.totalRaised += msg.value;

        // 奖励代币：基础 1 BACK / ETH；早鸟额外 +20%
        uint256 reward = msg.value;
        if (rank > 0) {
            reward += (msg.value * EARLY_BIRD_BONUS_BP) / 10000;
        }
        rewardToken.mint(msg.sender, reward);

        // 早鸟徽章 NFT：每位早鸟在首次捐赠时铸造一枚
        if (newEarlyBird) {
            earlyBirdBadge.mint(
                msg.sender,
                _badgeURI(id, rank)
            );
        }

        emit Donated(id, msg.sender, msg.value, rank, reward);
    }

    // ------------------------------------------------------------------
    // 3. 基于时间的结束
    // ------------------------------------------------------------------

    function finalize(uint256 id) external exists(id) {
        Project storage p = projects[id];
        require(p.state == State.Active, "already finalized");
        require(block.timestamp >= p.deadline, "not yet ended");

        p.state = p.totalRaised >= p.goal ? State.Successful : State.Failed;
        emit ProjectFinalized(id, p.state, p.totalRaised);
    }

    // ------------------------------------------------------------------
    // 4. 里程碑治理：提案 + 投票
    // ------------------------------------------------------------------

    /// @notice 治理项目中，发起人在下一里程碑达到目标完成度后发起放款提案，供捐赠者投票。
    function proposeMilestone(uint256 id) external exists(id) {
        Project storage p = projects[id];
        require(p.requireVote, "voting disabled");
        require(msg.sender == p.creator, "only creator");
        require(p.state != State.Failed, "project failed");
        uint8 idx = p.milestonesReleased;
        require(idx < p.milestoneCount, "all milestones released");
        require(_fundingThresholdReached(id, idx), "funding threshold not reached");
        require(!proposals[id].active, "proposal in progress");

        proposals[id] = Proposal({
            active: true,
            milestoneIndex: idx,
            yesWeight: 0,
            noWeight: 0,
            createdAt: block.timestamp
        });
        emit MilestoneProposed(id, idx, msg.sender);
    }

    /// @notice 捐赠者按出资权重对当前里程碑提案投票（每个里程碑每人一票）。
    function voteOnMilestone(uint256 id, bool support) external exists(id) {
        Proposal storage pr = proposals[id];
        require(pr.active, "no active proposal");
        uint256 weight = contributions[id][msg.sender];
        require(weight > 0, "not a donor");
        require(!hasVoted[id][pr.milestoneIndex][msg.sender], "already voted");

        hasVoted[id][pr.milestoneIndex][msg.sender] = true;
        if (support) {
            pr.yesWeight += weight;
        } else {
            pr.noWeight += weight;
        }
        emit Voted(id, pr.milestoneIndex, msg.sender, support, weight);
    }

    /// @notice 当前提案是否已获通过（赞成权重 > 总筹集额的一半）。
    function isProposalApproved(uint256 id) public view exists(id) returns (bool) {
        Proposal storage pr = proposals[id];
        if (!pr.active) return false;
        return pr.yesWeight * 2 > projects[id].totalRaised;
    }

    // ------------------------------------------------------------------
    // 5. 里程碑分期释放
    // ------------------------------------------------------------------

    /// @notice 发起人释放下一阶段里程碑资金。
    ///         - 普通项目：满足"目标完成度达标 + 发起人调用（=标记完成）"即可；
    ///         - 治理项目：还需存在已通过的放款提案（捐赠者投票过半）。
    function releaseMilestone(uint256 id) external exists(id) noReentrant {
        Project storage p = projects[id];
        require(msg.sender == p.creator, "only creator");
        require(p.milestoneCount > 0, "no milestones");
        require(p.state != State.Failed, "project failed");

        uint8 idx = p.milestonesReleased;
        require(idx < p.milestoneCount, "all milestones released");
        require(_fundingThresholdReached(id, idx), "funding threshold not reached");

        if (p.requireVote) {
            Proposal storage pr = proposals[id];
            require(pr.active && pr.milestoneIndex == idx, "no proposal");
            require(pr.yesWeight * 2 > p.totalRaised, "vote not passed");
            pr.active = false; // 关闭提案
        }

        uint8[] storage ms = milestones[id];
        uint256 amount = (p.goal * ms[idx]) / 100;
        uint256 remaining = p.totalRaised - p.released;
        if (amount > remaining) amount = remaining;
        require(amount > 0, "nothing to release");

        p.milestonesReleased = idx + 1;
        p.released += amount;
        emit MilestoneReleased(id, idx, amount);

        (bool ok, ) = p.creator.call{value: amount}("");
        require(ok, "transfer failed");
    }

    // ------------------------------------------------------------------
    // 6. 发起人提款（成功后）
    // ------------------------------------------------------------------

    function withdraw(uint256 id) external exists(id) noReentrant {
        Project storage p = projects[id];
        require(p.state == State.Successful, "project not successful");
        require(msg.sender == p.creator, "only creator");
        if (p.milestoneCount > 0) {
            require(p.milestonesReleased == p.milestoneCount, "release milestones first");
        }

        uint256 amount = p.totalRaised - p.released;
        require(amount > 0, "nothing to withdraw");
        p.released += amount;
        emit FundsWithdrawn(id, amount);

        (bool ok, ) = p.creator.call{value: amount}("");
        require(ok, "transfer failed");
    }

    // ------------------------------------------------------------------
    // 7. 捐赠者退款（失败后，按未释放部分比例退还）
    // ------------------------------------------------------------------

    function refund(uint256 id) external exists(id) noReentrant {
        Project storage p = projects[id];
        require(p.state == State.Failed, "project not failed");

        uint256 contributed = contributions[id][msg.sender];
        require(contributed > 0, "nothing to refund");

        uint256 unreleased = p.totalRaised - p.released;
        uint256 amount = (contributed * unreleased) / p.totalRaised;

        contributions[id][msg.sender] = 0; // 先清零，防重入
        require(amount > 0, "nothing to refund after releases");

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "refund failed");

        emit Refunded(id, msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // 内部工具
    // ------------------------------------------------------------------

    function _fundingThresholdReached(uint256 id, uint8 idx) internal view returns (bool) {
        uint8[] storage ms = milestones[id];
        uint256 cumulativePercent;
        for (uint256 i = 0; i <= idx; i++) {
            cumulativePercent += ms[i];
        }
        return projects[id].totalRaised * 100 >= projects[id].goal * cumulativePercent;
    }

    function _badgeURI(uint256 id, uint256 rank) internal pure returns (string memory) {
        return string(
            abi.encodePacked(
                "ChainFund Early Bird #",
                _toString(rank),
                " @project",
                _toString(id)
            )
        );
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 temp = v;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (v != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(buffer);
    }

    // ------------------------------------------------------------------
    // 视图函数
    // ------------------------------------------------------------------

    function getProjectCount() external view returns (uint256) {
        return projects.length;
    }

    function getProject(uint256 id) external view exists(id) returns (Project memory) {
        return projects[id];
    }

    function getAllProjects() external view returns (Project[] memory) {
        return projects;
    }

    function getDonors(uint256 id)
        external
        view
        exists(id)
        returns (address[] memory donors, uint256[] memory amounts, uint256[] memory ranks)
    {
        address[] storage list = donorList[id];
        donors = new address[](list.length);
        amounts = new uint256[](list.length);
        ranks = new uint256[](list.length);
        for (uint256 i = 0; i < list.length; i++) {
            donors[i] = list[i];
            amounts[i] = contributions[id][list[i]];
            ranks[i] = earlyBirdRank[id][list[i]];
        }
    }

    function getMilestones(uint256 id)
        external
        view
        exists(id)
        returns (uint8[] memory percents, uint8 releasedCount)
    {
        return (milestones[id], projects[id].milestonesReleased);
    }

    function isNextMilestoneUnlocked(uint256 id) external view exists(id) returns (bool) {
        Project storage p = projects[id];
        if (p.milestoneCount == 0 || p.state == State.Failed) return false;
        uint8 idx = p.milestonesReleased;
        if (idx >= p.milestoneCount) return false;
        return _fundingThresholdReached(id, idx);
    }

    /// @notice 返回当前里程碑提案信息（供前端展示投票进度）。
    function getProposal(uint256 id)
        external
        view
        exists(id)
        returns (bool active, uint8 milestoneIndex, uint256 yesWeight, uint256 noWeight, bool approved)
    {
        Proposal storage pr = proposals[id];
        return (pr.active, pr.milestoneIndex, pr.yesWeight, pr.noWeight, isProposalApproved(id));
    }

    function refundableOf(uint256 id, address donor) external view exists(id) returns (uint256) {
        Project storage p = projects[id];
        uint256 contributed = contributions[id][donor];
        if (contributed == 0 || p.totalRaised == 0) return 0;
        uint256 unreleased = p.totalRaised - p.released;
        return (contributed * unreleased) / p.totalRaised;
    }
}
