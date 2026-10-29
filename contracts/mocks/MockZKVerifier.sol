// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IZKVerifier.sol";

/// @notice TEST-ONLY stub implementing IZKVerifier. It performs NO
/// cryptographic verification whatsoever — it just returns a boolean flag
/// the test/deployer sets. It exists solely so the ZK-gated code path in
/// ReputationEngine (revealRatingViaProof) can be exercised in the automated
/// test suite and demoed end-to-end. See IZKVerifier.sol and
/// docs/zk-proof-status.md for the honest status of the ZK component.
///
/// DO NOT deploy this contract to a live network as the production verifier.
contract MockZKVerifier is IZKVerifier {
    bool public shouldVerify;
    address public owner;

    event ShouldVerifyUpdated(bool shouldVerify);

    constructor(bool _shouldVerify) {
        shouldVerify = _shouldVerify;
        owner = msg.sender;
    }

    function setShouldVerify(bool _shouldVerify) external {
        require(msg.sender == owner, "MockZKVerifier: not owner");
        shouldVerify = _shouldVerify;
        emit ShouldVerifyUpdated(_shouldVerify);
    }

    function verifyRatingProof(bytes calldata, uint256[] calldata) external view override returns (bool) {
        return shouldVerify;
    }
}
