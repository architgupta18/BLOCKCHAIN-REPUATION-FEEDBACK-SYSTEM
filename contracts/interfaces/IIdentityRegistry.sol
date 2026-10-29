// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal interface ReputationEngine needs from IdentityRegistry.
interface IIdentityRegistry {
    /// @return true if `user` currently holds an active identity (stake-backed,
    /// credential-backed, or both) and is therefore allowed to rate others.
    function isEligibleRater(address user) external view returns (bool);
}
