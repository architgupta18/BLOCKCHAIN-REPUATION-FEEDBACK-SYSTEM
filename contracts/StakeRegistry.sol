// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title StakeRegistry
/// @notice Holds refundable ETH stakes that back a user's identity in
/// IdentityRegistry. Implements the "adjustable identity cost" idea: anyone
/// can gain rating rights by locking up MIN_STAKE instead of needing a
/// credential. Withdrawals go through a timelock so a user cannot stake,
/// misbehave, and immediately exit before being slashed.
contract StakeRegistry {
    address public owner;
    uint256 public constant MIN_STAKE = 0.01 ether;
    uint256 public constant WITHDRAWAL_DELAY = 3 days;

    mapping(address => uint256) public stakeOf;
    mapping(address => uint256) public withdrawalRequestedAt;
    mapping(address => bool) public authorizedSlashers;

    event StakeDeposited(address indexed user, uint256 amount, uint256 newTotal);
    event WithdrawalRequested(address indexed user, uint256 availableAt);
    event WithdrawalCancelled(address indexed user);
    event StakeWithdrawn(address indexed user, uint256 amount);
    event StakeSlashed(address indexed user, uint256 amount, address indexed slasher, string reason);
    event SlasherAuthorized(address indexed slasher, bool authorized);

    modifier onlyOwner() {
        require(msg.sender == owner, "StakeRegistry: not owner");
        _;
    }

    modifier onlySlasher() {
        require(authorizedSlashers[msg.sender], "StakeRegistry: not an authorized slasher");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice Authorize (or revoke) a contract — typically IdentityRegistry
    /// or a governance module — to slash misbehaving stakers.
    function setSlasher(address slasher, bool authorized) external onlyOwner {
        authorizedSlashers[slasher] = authorized;
        emit SlasherAuthorized(slasher, authorized);
    }

    function deposit() external payable {
        require(msg.value > 0, "StakeRegistry: zero deposit");
        require(withdrawalRequestedAt[msg.sender] == 0, "StakeRegistry: pending withdrawal, cancel first");
        stakeOf[msg.sender] += msg.value;
        emit StakeDeposited(msg.sender, msg.value, stakeOf[msg.sender]);
    }

    function requestWithdrawal() external {
        require(stakeOf[msg.sender] > 0, "StakeRegistry: no stake");
        require(withdrawalRequestedAt[msg.sender] == 0, "StakeRegistry: already requested");
        withdrawalRequestedAt[msg.sender] = block.timestamp;
        emit WithdrawalRequested(msg.sender, block.timestamp + WITHDRAWAL_DELAY);
    }

    function cancelWithdrawalRequest() external {
        require(withdrawalRequestedAt[msg.sender] != 0, "StakeRegistry: no pending request");
        withdrawalRequestedAt[msg.sender] = 0;
        emit WithdrawalCancelled(msg.sender);
    }

    function withdraw() external {
        uint256 requestedAt = withdrawalRequestedAt[msg.sender];
        require(requestedAt != 0, "StakeRegistry: no withdrawal requested");
        require(block.timestamp >= requestedAt + WITHDRAWAL_DELAY, "StakeRegistry: delay not elapsed");
        uint256 amount = stakeOf[msg.sender];
        require(amount > 0, "StakeRegistry: nothing to withdraw");
        stakeOf[msg.sender] = 0;
        withdrawalRequestedAt[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "StakeRegistry: transfer failed");
        emit StakeWithdrawn(msg.sender, amount);
    }

    /// @notice Slash part (or all) of a misbehaving staker's balance. The
    /// slashed ETH simply stays in this contract (burned from the user's
    /// perspective) — distributing it to reporters/treasury is a governance
    /// decision left out of this working model, see docs/future-work.md.
    function slash(address user, uint256 amount, string calldata reason) external onlySlasher {
        uint256 bal = stakeOf[user];
        uint256 slashAmount = amount > bal ? bal : amount;
        stakeOf[user] = bal - slashAmount;
        emit StakeSlashed(user, slashAmount, msg.sender, reason);
    }

    function isAboveMinStake(address user) external view returns (bool) {
        return stakeOf[user] >= MIN_STAKE;
    }

    function hasPendingWithdrawal(address user) external view returns (bool) {
        return withdrawalRequestedAt[user] != 0;
    }
}
