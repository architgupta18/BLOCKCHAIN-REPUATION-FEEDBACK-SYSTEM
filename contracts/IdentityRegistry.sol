// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./StakeRegistry.sol";
import "./interfaces/IIdentityRegistry.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title IdentityRegistry
/// @notice Implements the "adjustable identity cost" design: a user becomes
/// eligible to rate others either by locking a refundable stake in
/// StakeRegistry, or by presenting a signature from a trusted off-chain
/// credential issuer (e.g. a KYC provider or university SSO bridge),
/// without needing to reveal what that credential actually says on-chain.
/// Either path (or both) sets the same on-chain eligibility flag that
/// ReputationEngine checks before accepting a rating commitment.
contract IdentityRegistry is IIdentityRegistry {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    enum IdentityStatus {
        None,
        StakeBacked,
        CredentialBacked,
        Both
    }

    StakeRegistry public immutable stakeRegistry;
    address public owner;
    address public credentialIssuer;

    mapping(address => IdentityStatus) public statusOf;
    mapping(bytes32 => bool) public usedCredentialHashes;

    event Registered(address indexed user, IdentityStatus status);
    event CredentialRegistered(address indexed user, uint256 expiry);
    event CredentialIssuerUpdated(address indexed issuer);
    event IdentityRevoked(address indexed user);

    modifier onlyOwner() {
        require(msg.sender == owner, "IdentityRegistry: not owner");
        _;
    }

    constructor(address _stakeRegistry, address _credentialIssuer) {
        owner = msg.sender;
        stakeRegistry = StakeRegistry(_stakeRegistry);
        credentialIssuer = _credentialIssuer;
    }

    function setCredentialIssuer(address issuer) external onlyOwner {
        credentialIssuer = issuer;
        emit CredentialIssuerUpdated(issuer);
    }

    /// @notice Register using a refundable stake. Caller must already have
    /// deposited at least StakeRegistry.MIN_STAKE via StakeRegistry.deposit(),
    /// and must not have an in-progress withdrawal request.
    function registerWithStake() external {
        require(stakeRegistry.isAboveMinStake(msg.sender), "IdentityRegistry: insufficient stake");
        require(!stakeRegistry.hasPendingWithdrawal(msg.sender), "IdentityRegistry: pending withdrawal");
        IdentityStatus current = statusOf[msg.sender];
        IdentityStatus newStatus = (current == IdentityStatus.CredentialBacked || current == IdentityStatus.Both)
            ? IdentityStatus.Both
            : IdentityStatus.StakeBacked;
        statusOf[msg.sender] = newStatus;
        emit Registered(msg.sender, newStatus);
    }

    /// @notice Register using a signed credential instead of capital.
    /// @param expiry Unix timestamp after which the signature is no longer valid.
    /// @param signature ECDSA signature by `credentialIssuer` over
    /// keccak256(abi.encodePacked(msg.sender, expiry, address(this), block.chainid)),
    /// as an Ethereum signed message (EIP-191). Off-chain issuance helper:
    /// scripts/issueCredential.js.
    function registerWithCredential(uint256 expiry, bytes calldata signature) external {
        require(credentialIssuer != address(0), "IdentityRegistry: issuer not configured");
        require(block.timestamp <= expiry, "IdentityRegistry: credential expired");

        bytes32 messageHash = keccak256(abi.encodePacked(msg.sender, expiry, address(this), block.chainid));
        require(!usedCredentialHashes[messageHash], "IdentityRegistry: credential already used");

        bytes32 ethSignedHash = messageHash.toEthSignedMessageHash();
        address signer = ethSignedHash.recover(signature);
        require(signer == credentialIssuer, "IdentityRegistry: invalid credential signature");

        usedCredentialHashes[messageHash] = true;

        IdentityStatus current = statusOf[msg.sender];
        IdentityStatus newStatus = (current == IdentityStatus.StakeBacked || current == IdentityStatus.Both)
            ? IdentityStatus.Both
            : IdentityStatus.CredentialBacked;
        statusOf[msg.sender] = newStatus;

        emit CredentialRegistered(msg.sender, expiry);
        emit Registered(msg.sender, newStatus);
    }

    /// @notice Governance/admin can forcibly revoke an identity (e.g. after
    /// off-chain Sybil-graph monitoring flags an account — see
    /// docs/future-work.md for the monitoring side, which is not implemented
    /// in this repository).
    function revoke(address user) external onlyOwner {
        statusOf[user] = IdentityStatus.None;
        emit IdentityRevoked(user);
    }

    function isEligibleRater(address user) external view override returns (bool) {
        return statusOf[user] != IdentityStatus.None;
    }
}
