#!/usr/bin/env node
const fs = require("fs");
const { ethers } = require("ethers");
const { hashCredentialPayload } = require("./credentialHash");

/**
 * Verifies a portable reputation credential produced by issueCredential.js
 * completely offline — no RPC endpoint, no blockchain access, just the
 * JSON file and plain ECDSA signature recovery. This is the counterpart
 * that makes the credential "exportable": a third-party platform that has
 * never heard of this dApp's chain can still check who signed it.
 *
 * It verifies the SIGNATURE is valid for the payload and tells you which
 * address signed it. It is the caller's responsibility to separately decide
 * whether they TRUST that attester address (exactly like checking who
 * signed a TLS certificate) — this script does not maintain a trust list.
 *
 * Usage: node scripts/verifyCredential.js <path-to-credential.json> [expectedAttesterAddress]
 */
function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node scripts/verifyCredential.js <path-to-credential.json> [expectedAttesterAddress]");
    process.exit(1);
  }

  const expectedAttester = process.argv[3];

  const raw = fs.readFileSync(filePath, "utf8");
  const credential = JSON.parse(raw);

  const { payload, attester, signature } = credential;
  if (!payload || !attester || !signature) {
    console.error("Malformed credential file: expected { payload, attester, signature }");
    process.exit(1);
  }

  const messageHash = hashCredentialPayload(payload);
  const recovered = ethers.verifyMessage(ethers.getBytes(messageHash), signature);

  const signatureValid = recovered.toLowerCase() === attester.toLowerCase();

  console.log("Credential payload:");
  console.log(JSON.stringify(payload, null, 2));
  console.log("\nClaimed attester: ", attester);
  console.log("Recovered signer: ", recovered);
  console.log("Signature valid:  ", signatureValid);

  if (!signatureValid) {
    console.error("\nFAILED: signature does not match the claimed attester address.");
    process.exit(1);
  }

  if (expectedAttester) {
    const matchesExpected = recovered.toLowerCase() === expectedAttester.toLowerCase();
    console.log("Matches expected trusted attester:", matchesExpected);
    if (!matchesExpected) {
      console.error("\nFAILED: credential is validly signed, but NOT by the attester you told this script to trust.");
      process.exit(1);
    }
  }

  console.log("\nOK: credential signature verified.");
}

main();
