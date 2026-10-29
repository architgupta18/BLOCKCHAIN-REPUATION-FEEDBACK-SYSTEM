# Zero-knowledge proof component — honest status

The project report and presentation describe a privacy-preserving reveal
path: a rater proves, via a zero-knowledge proof, that they hold a valid
stake- or credential-backed identity and that their rating is within range,
**without** their address appearing on-chain.

This document states plainly what exists in this repository for that
feature and what does not, so nobody mistakes the interface for the real
thing.

## What IS implemented here

- `contracts/interfaces/IZKVerifier.sol` — the on-chain interface
  `ReputationEngine` calls (`verifyRatingProof(proof, publicSignals)`).
- `contracts/mocks/MockZKVerifier.sol` — a test double that implements that
  interface and returns a hardcoded boolean. It performs **no cryptographic
  verification of any kind**.
- `ReputationEngine.revealRatingViaProof(...)` — a real, working Solidity
  function that calls whatever `IZKVerifier` is configured and, if it
  returns `true`, applies the rating using the same scoring logic as the
  commit-reveal path. This function, and its interaction with
  `MockZKVerifier`, is covered by passing automated tests
  (`test/ReputationEngine.test.js`, "ZK-gated reveal path").

## What is NOT implemented here

- No circom circuit has been written.
- No trusted setup (powers-of-tau ceremony, circuit-specific setup) has been
  performed.
- No real Groth16/Plonk verifier contract exists — `MockZKVerifier` is not
  a stand-in for one in any cryptographic sense; it just always says yes
  (or no, if `setShouldVerify(false)` is called).
- There is no snark witness generation, proof generation, or proof
  encoding/decoding logic anywhere in this repo.
- `circom` is not installed in the development environment this repo was
  built in, and setting up and auditing a real circuit was explicitly
  treated as out of scope for this working model, not something quietly
  skipped.

## Why the interface exists anyway

Designing `IZKVerifier` and wiring `revealRatingViaProof` through it means
the rest of the system (scoring, decay, events) already works correctly
with a real verifier dropped in later — the integration seam is tested now,
so swapping `MockZKVerifier` for a generated verifier contract (e.g. via
`snarkjs zkey export solidityverifier`) should not require touching
`ReputationEngine.sol` at all, only the deployment wiring.

## What a real implementation would need

1. A circom circuit proving: (a) knowledge of a secret linking the prover
   to an address that `IdentityRegistry.isEligibleRater` returns `true`
   for, (b) a committed rating value in `[1, 5]`, without revealing which
   address.
2. A trusted setup for that circuit (Groth16) or use of a universal setup
   scheme (Plonk) to avoid a per-circuit ceremony.
3. A generated Solidity verifier contract implementing `IZKVerifier`.
4. A client-side proof generation step (snarkjs + the circuit's WASM/zkey)
   before calling `revealRatingViaProof`.
5. A nullifier scheme in the public signals so the same rater can't reveal
   the same commitment twice through the proof path (the commit-reveal path
   already gets this for free from `Commitment.revealed`; the proof path as
   written does not yet enforce an equivalent check and would need one
   before production use).

None of the above is present in this repository today.
