const { ethers } = require("ethers");

/**
 * Deterministically hashes a reputation-credential payload so it can be
 * signed by an attester (scripts/issueCredential.js) and the signature later
 * checked by anyone holding only the JSON file (scripts/verifyCredential.js)
 * — no RPC/blockchain access required for either signing-hash step.
 */
function hashCredentialPayload(payload) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    coder.encode(
      ["address", "uint256", "address", "bytes32", "uint256", "uint256", "uint256", "uint256"],
      [
        payload.reputationEngine,
        payload.chainId,
        payload.subject,
        payload.context,
        payload.score,
        payload.ratingCount,
        payload.timestamp,
        payload.nonce,
      ]
    )
  );
}

module.exports = { hashCredentialPayload };
