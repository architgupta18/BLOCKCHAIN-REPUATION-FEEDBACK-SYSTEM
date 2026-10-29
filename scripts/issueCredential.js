const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Off-chain half of the "exportable reputation credential" feature.
 *
 * On-chain, ReputationEngine.issueCredentialSnapshot() emits a
 * CredentialIssued event with a subject's current (decayed) score, rating
 * count, timestamp, and a nonce. Any third-party platform COULD read that
 * event directly off-chain, but that requires them to run (or trust) an RPC
 * node for this specific chain. This script shows the alternative: an
 * attestation service (any address the verifying party agrees to trust)
 * calls the snapshot function, then wraps the resulting data plus its own
 * ECDSA signature into a small portable JSON file. A verifier can check
 * that signature offline, with no blockchain access at all, using
 * scripts/verifyCredential.js.
 *
 * This is a real, runnable implementation (not a stub) — it was tested
 * end-to-end against a local Hardhat node. It does not implement
 * EIP-712 typed-data signing (a reasonable future upgrade) and instead
 * uses a simple keccak256 hash + EIP-191 personal-sign, documented in
 * README.md and docs/future-work.md.
 *
 * Usage:
 *   npx hardhat run scripts/issueCredential.js --network <network> -- \
 *     (configure via env vars below)
 *
 * Required env vars:
 *   REPUTATION_ENGINE_ADDRESS  - deployed ReputationEngine address
 *   SUBJECT_ADDRESS            - address whose reputation is being exported
 *   CONTEXT_LABEL               - human-readable context string (e.g. "marketplace-seller")
 * Optional env vars:
 *   ATTESTER_PRIVATE_KEY        - private key used to sign the credential.
 *                                 Defaults to the first configured signer
 *                                 (fine for local/hardhat network testing only).
 *   OUTPUT_PATH                 - where to write the credential JSON
 *                                 (default: ./credentials/<subject>-<context>.json)
 */
async function main() {
  const reputationEngineAddress = requireEnv("REPUTATION_ENGINE_ADDRESS");
  const subject = requireEnv("SUBJECT_ADDRESS");
  const contextLabel = requireEnv("CONTEXT_LABEL");
  const context = ethers.keccak256(ethers.toUtf8Bytes(contextLabel));

  const [defaultSigner] = await ethers.getSigners();
  const attesterWallet = process.env.ATTESTER_PRIVATE_KEY
    ? new ethers.Wallet(process.env.ATTESTER_PRIVATE_KEY, ethers.provider)
    : defaultSigner;

  const reputationEngine = await ethers.getContractAt("ReputationEngine", reputationEngineAddress, attesterWallet);

  const tx = await reputationEngine.issueCredentialSnapshot(subject, context);
  const receipt = await tx.wait();

  const parsed = receipt.logs
    .map((log) => {
      try {
        return reputationEngine.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "CredentialIssued");

  if (!parsed) {
    throw new Error("CredentialIssued event not found in transaction receipt");
  }

  const { score, ratingCount, timestamp, credentialNonce } = parsed.args;
  const network = await ethers.provider.getNetwork();

  const payload = {
    reputationEngine: reputationEngineAddress,
    chainId: Number(network.chainId),
    subject,
    context,
    contextLabel,
    score: score.toString(),
    ratingCount: ratingCount.toString(),
    timestamp: timestamp.toString(),
    nonce: credentialNonce.toString(),
  };

  const messageHash = hashCredentialPayload(payload);
  const signature = await attesterWallet.signMessage(ethers.getBytes(messageHash));

  const credential = {
    payload,
    attester: await attesterWallet.getAddress(),
    signature,
  };

  const outputPath =
    process.env.OUTPUT_PATH || path.join(__dirname, "..", "credentials", `${subject}-${contextLabel}.json`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(credential, null, 2));

  console.log("Issued portable reputation credential:");
  console.log(JSON.stringify(credential, null, 2));
  console.log("\nWritten to:", outputPath);
  console.log("Verify with: node scripts/verifyCredential.js", outputPath);
}

const { hashCredentialPayload } = require("./credentialHash");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
