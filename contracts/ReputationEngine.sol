// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IIdentityRegistry.sol";
import "./interfaces/IZKVerifier.sol";

/// @title ReputationEngine
/// @notice Implements:
///  1. A commit-reveal rating protocol so a rating's value can't be copied
///     or front-run by watching the mempool.
///  2. A per-context reputation score with exponential decay, computed with
///     scaled-integer (fixed-point) arithmetic since Solidity has no floats:
///     R_n = R_(n-1) * (1 - w) + w * f_n
///  3. An optional ZK-gated reveal path (revealRatingViaProof) that lets a
///     rating be accepted without the rater's address appearing on-chain,
///     IF a real verifier implementing IZKVerifier is wired in. This
///     repository wires in only MockZKVerifier — see IZKVerifier.sol and
///     docs/zk-proof-status.md for the honest status of that component.
///  4. An on-chain half of an "exportable reputation credential": anyone
///     can snapshot a subject's current (decayed) score into a
///     CredentialIssued event; scripts/issueCredential.js shows the
///     off-chain half that wraps that data in a portable, signed JSON
///     credential a third-party platform could verify without needing its
///     own RPC access to this contract.
///
/// Sybil defense note: per the project design, graph-based monitoring of the
/// rater/subject interaction graph is meant to run off-chain as a secondary
/// defense alongside the on-chain stake/credential gate. That monitoring
/// service is NOT implemented in this repository (see docs/future-work.md);
/// this contract only emits the events (RatingCommitted/RatingRevealed) such
/// a service would consume as its data source.
contract ReputationEngine {
    uint256 public constant SCALE = 1e4; // fixed-point scale: SCALE == 1.0
    uint256 public constant DEFAULT_WEIGHT = 2000; // w = 0.20 per accepted rating
    uint256 public constant COMMIT_WINDOW = 1 days;
    uint256 public constant REVEAL_WINDOW = 1 days;
    uint256 public constant DECAY_PERIOD = 30 days;
    uint256 public constant DECAY_FACTOR_BPS = 9500; // keep 95% of score per elapsed period
    uint256 public constant MAX_DECAY_PERIODS = 24; // gas-safety cap (~2 years)

    IIdentityRegistry public immutable identityRegistry;
    IZKVerifier public zkVerifier; // address(0) disables the ZK-gated path
    address public owner;

    struct Commitment {
        bytes32 commitHash;
        uint256 commitTime;
        bool revealed;
    }

    struct ContextScore {
        uint256 score; // scaled by SCALE, normalized to a 0..SCALE (0..1-star..5-star) range
        uint256 lastUpdate;
        uint256 ratingCount;
    }

    // subject => context => rater => commitment
    mapping(address => mapping(bytes32 => mapping(address => Commitment))) public commitments;
    // subject => context => score state
    mapping(address => mapping(bytes32 => ContextScore)) public scores;

    uint256 public credentialNonceCounter;

    event RatingCommitted(address indexed subject, bytes32 indexed context, address indexed rater, bytes32 commitHash);
    event RatingRevealed(address indexed subject, bytes32 indexed context, address indexed rater, uint256 ratingValue, uint256 newScore);
    event RatingRevealedViaProof(address indexed subject, bytes32 indexed context, uint256 newScore);
    event CredentialIssued(address indexed subject, bytes32 indexed context, uint256 score, uint256 ratingCount, uint256 timestamp, uint256 credentialNonce);
    event ZKVerifierUpdated(address indexed newVerifier);

    modifier onlyOwner() {
        require(msg.sender == owner, "ReputationEngine: not owner");
        _;
    }

    constructor(address _identityRegistry, address _zkVerifier) {
        owner = msg.sender;
        identityRegistry = IIdentityRegistry(_identityRegistry);
        zkVerifier = IZKVerifier(_zkVerifier);
    }

    function setZKVerifier(address _zkVerifier) external onlyOwner {
        zkVerifier = IZKVerifier(_zkVerifier);
        emit ZKVerifierUpdated(_zkVerifier);
    }

    // ---------------------------------------------------------------------
    // Commit-reveal path
    // ---------------------------------------------------------------------

    /// @param commitHash keccak256(abi.encodePacked(subject, context, msg.sender, ratingValue, salt))
    function commitRating(address subject, bytes32 context, bytes32 commitHash) external {
        require(subject != msg.sender, "ReputationEngine: cannot rate self");
        require(identityRegistry.isEligibleRater(msg.sender), "ReputationEngine: rater not eligible");

        Commitment storage c = commitments[subject][context][msg.sender];
        bool previousCycleFinished = c.commitTime == 0 ||
            c.revealed ||
            block.timestamp > c.commitTime + COMMIT_WINDOW + REVEAL_WINDOW;
        require(previousCycleFinished, "ReputationEngine: previous commitment still pending");

        commitments[subject][context][msg.sender] = Commitment({
            commitHash: commitHash,
            commitTime: block.timestamp,
            revealed: false
        });
        emit RatingCommitted(subject, context, msg.sender, commitHash);
    }

    function revealRating(address subject, bytes32 context, uint256 ratingValue, bytes32 salt) external {
        require(ratingValue >= 1 && ratingValue <= 5, "ReputationEngine: rating out of range");

        Commitment storage c = commitments[subject][context][msg.sender];
        require(c.commitTime != 0, "ReputationEngine: no commitment found");
        require(!c.revealed, "ReputationEngine: already revealed");
        require(block.timestamp >= c.commitTime + COMMIT_WINDOW, "ReputationEngine: commit window not over yet");
        require(block.timestamp <= c.commitTime + COMMIT_WINDOW + REVEAL_WINDOW, "ReputationEngine: reveal window expired");

        bytes32 expected = keccak256(abi.encodePacked(subject, context, msg.sender, ratingValue, salt));
        require(expected == c.commitHash, "ReputationEngine: hash mismatch");

        c.revealed = true;
        uint256 newScore = _applyRating(subject, context, ratingValue);
        emit RatingRevealed(subject, context, msg.sender, ratingValue, newScore);
    }

    // ---------------------------------------------------------------------
    // ZK-gated path (interface-level only; see class-level NatSpec above)
    // ---------------------------------------------------------------------

    function revealRatingViaProof(
        address subject,
        bytes32 context,
        uint256 ratingValue,
        bytes calldata proof,
        uint256[] calldata publicSignals
    ) external {
        require(address(zkVerifier) != address(0), "ReputationEngine: zk verifier not configured");
        require(ratingValue >= 1 && ratingValue <= 5, "ReputationEngine: rating out of range");

        bool ok = zkVerifier.verifyRatingProof(proof, publicSignals);
        require(ok, "ReputationEngine: invalid proof");

        uint256 newScore = _applyRating(subject, context, ratingValue);
        emit RatingRevealedViaProof(subject, context, newScore);
    }

    // ---------------------------------------------------------------------
    // Scoring (scaled-integer EMA with exponential decay)
    // ---------------------------------------------------------------------

    function _applyRating(address subject, bytes32 context, uint256 ratingValue) internal returns (uint256) {
        ContextScore storage s = scores[subject][context];
        uint256 decayed = _decayedScore(s.score, s.lastUpdate);
        uint256 ratingScaled = (ratingValue * SCALE) / 5; // normalize 1..5 stars to 0..SCALE

        uint256 newScore;
        if (s.ratingCount == 0) {
            newScore = ratingScaled;
        } else {
            // R_n = R_(n-1) * (1 - w) + w * f_n, fixed-point with SCALE denominator
            newScore = (decayed * (SCALE - DEFAULT_WEIGHT) + ratingScaled * DEFAULT_WEIGHT) / SCALE;
        }

        s.score = newScore;
        s.lastUpdate = block.timestamp;
        s.ratingCount += 1;
        return newScore;
    }

    /// @dev Applies DECAY_FACTOR_BPS per fully elapsed DECAY_PERIOD since the
    /// last update, capped at MAX_DECAY_PERIODS iterations for gas safety.
    /// This is a straightforward discrete approximation of exponential decay
    /// (not a closed-form exponent), documented here rather than overstated.
    function _decayedScore(uint256 rawScore, uint256 lastUpdate) internal view returns (uint256) {
        if (rawScore == 0 || lastUpdate == 0 || block.timestamp <= lastUpdate) {
            return rawScore;
        }
        uint256 elapsed = block.timestamp - lastUpdate;
        uint256 periods = elapsed / DECAY_PERIOD;
        if (periods == 0) {
            return rawScore;
        }
        if (periods > MAX_DECAY_PERIODS) {
            periods = MAX_DECAY_PERIODS;
        }
        uint256 decayed = rawScore;
        for (uint256 i = 0; i < periods; i++) {
            decayed = (decayed * DECAY_FACTOR_BPS) / SCALE;
        }
        return decayed;
    }

    /// @notice View the subject's current score for a context, with decay
    /// applied as of "now" even if no new rating has triggered a write.
    function currentScore(address subject, bytes32 context) external view returns (uint256) {
        ContextScore memory s = scores[subject][context];
        return _decayedScore(s.score, s.lastUpdate);
    }

    function ratingCount(address subject, bytes32 context) external view returns (uint256) {
        return scores[subject][context].ratingCount;
    }

    // ---------------------------------------------------------------------
    // Exportable credential (on-chain snapshot half)
    // ---------------------------------------------------------------------

    /// @notice Emits a timestamped, nonce-tagged snapshot of a subject's
    /// current decayed score for a context. scripts/issueCredential.js
    /// reads this event off-chain and wraps it in a signed, portable JSON
    /// credential that a third-party platform can verify via ECDSA without
    /// needing RPC access to this chain.
    function issueCredentialSnapshot(address subject, bytes32 context)
        external
        returns (uint256 score, uint256 count, uint256 timestamp, uint256 nonce)
    {
        ContextScore memory s = scores[subject][context];
        score = _decayedScore(s.score, s.lastUpdate);
        count = s.ratingCount;
        timestamp = block.timestamp;
        nonce = ++credentialNonceCounter;
        emit CredentialIssued(subject, context, score, count, timestamp, nonce);
    }
}
