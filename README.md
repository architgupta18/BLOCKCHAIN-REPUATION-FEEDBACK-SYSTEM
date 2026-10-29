# ChainTrust — Blockchain-Based Decentralized Trust and Reputation System

A working Solidity implementation of the capstone project *"Blockchain-Based
Decentralized Trust and Reputation System with Sybil Resistance and Rater
Privacy"* (IILM University, B.Tech CSE, Batch 3CSE18).

**Team:** Archit Gupta (2410030035), Ayush Kumar (2410030036), Sahitya
Mishra (2410030037), Keshav Khandelwal (2410030049)
**Guide:** Ankita Maurya

---

## Status at a glance

| Component | Status |
|---|---|
| Stake-based identity (refundable, timelocked) | ✅ Implemented + tested |
| Credential-based identity (signed attestation) | ✅ Implemented + tested |
| Commit-reveal rating protocol | ✅ Implemented + tested |
| Per-context reputation score with exponential decay | ✅ Implemented + tested |
| Exportable signed reputation credential | ✅ Implemented + tested (on-chain snapshot + off-chain sign/verify scripts) |
| ZK-gated private reveal path (interface + integration) | ✅ Interface + mock verifier implemented and tested |
| Real ZK circuit (circom/snarkjs, proving rater eligibility privately) | ❌ **Not implemented** — see [`docs/zk-proof-status.md`](docs/zk-proof-status.md) |
| Graph-based off-chain Sybil monitoring service | ❌ **Not implemented** — see [`docs/future-work.md`](docs/future-work.md) |
| React/Express/Postgres application layers | ❌ Not built here — this repo is the blockchain layer only |

This status table is the whole point of this README existing: nothing
below should be read as claiming more than what's in the table.

---

## What this actually is

Four Solidity contracts plus two off-chain Node scripts, with a 34-test
Hardhat suite covering the main flows:

- **`StakeRegistry.sol`** — holds refundable ETH stakes. Deposit, request a
  timelocked withdrawal (3 days), withdraw, or get slashed by an authorized
  slasher contract.
- **`IdentityRegistry.sol`** — the "adjustable identity cost" mechanism.
  A user becomes eligible to rate others either by locking
  `StakeRegistry.MIN_STAKE` (0.01 ETH) or by presenting an ECDSA signature
  from a trusted off-chain credential issuer. Either path (or both) sets
  the same on-chain eligibility flag.
- **`ReputationEngine.sol`** — commit-reveal ratings
  (`commitRating` → wait out the commit window → `revealRating` with the
  original salt), a per-context reputation score computed as a
  scaled-integer exponential moving average with time-based decay, an
  optional ZK-gated reveal path (`revealRatingViaProof`), and an on-chain
  credential-snapshot function (`issueCredentialSnapshot`).
- **`contracts/mocks/MockZKVerifier.sol`** — a clearly-labeled test double
  so the ZK-gated code path can be exercised without a real circuit.
- **`scripts/issueCredential.js`** / **`scripts/verifyCredential.js`** — a
  real, working off-chain pair: one calls the contract, signs the result,
  and writes a portable JSON credential; the other verifies that
  credential's signature **completely offline**, with no RPC/blockchain
  access, using only `ethers.js`.

## Why it's built this way (mapping back to the report)

- **Decentralized reputation trilemma** (generalizable / trustless /
  Sybil-resistant — pick two): this system picks trustless + Sybil-resistant
  by gating rating rights behind stake-or-credential, at the cost of not
  being fully permissionless for strangers with zero capital and no
  credential.
- **Adjustable identity cost**: `IdentityRegistry` literally offers the two
  alternative costs (capital via `StakeRegistry`, or a credential
  signature) side by side.
- **Rater privacy via commit-reveal**: a rating's value can't be read from
  the mempool before it's revealed, preventing copy/front-running attacks
  on the *value*. Note this does **not** hide *who* rated whom — the
  reveal transaction is still sent by the rater's address. Hiding the
  rater's identity entirely is what the ZK-gated path is for, and that
  path's cryptography is not implemented (see the status table above).
- **Per-context decaying reputation**: `ReputationEngine` keys scores by
  `(subject, context)` so a reputation built as a "seller" doesn't
  automatically vouch for someone as a "code reviewer," and old ratings
  lose weight over time via the decay function.
- **Exportable credential**: the on-chain snapshot plus off-chain
  sign/verify scripts let a third-party platform accept a reputation score
  without needing its own RPC connection to this chain — it just checks an
  ECDSA signature.

## Architecture

```
Rater                         Subject
  |                              ^
  | 1. commitRating(hash)        |
  v                              |
+-----------------------------------------------+
|              ReputationEngine.sol              |
|  commit-reveal -> scaled EMA score -> decay    |
+-----------------------------------------------+
        ^ isEligibleRater()            |
        |                              | issueCredentialSnapshot()
+--------------------+         +------------------------+
| IdentityRegistry.sol|         |  (off-chain) attester  |
| stake OR credential |         |  scripts/issueCredential.js
+--------------------+         |  -> signs -> JSON file  |
        ^                       +------------------------+
        | isAboveMinStake()              |
        |                                v
+--------------------+         scripts/verifyCredential.js
|  StakeRegistry.sol  |         (offline signature check)
+--------------------+
```

## Project layout

```
contracts/
  StakeRegistry.sol
  IdentityRegistry.sol
  ReputationEngine.sol
  interfaces/
    IIdentityRegistry.sol
    IZKVerifier.sol
  mocks/
    MockZKVerifier.sol
scripts/
  deploy.js
  issueCredential.js
  verifyCredential.js
  credentialHash.js
test/
  StakeRegistry.test.js
  IdentityRegistry.test.js
  ReputationEngine.test.js
docs/
  zk-proof-status.md
  future-work.md
hardhat.config.js
```

## Setup

Requires Node.js 18+ and npm.

```bash
npm install
npx hardhat compile
npx hardhat test
```

You should see all tests pass (34 at time of writing) covering staking,
withdrawal timelocks, slashing, stake- and credential-based identity
registration (including signature/expiry/replay checks), the full
commit-reveal rating lifecycle, the EMA scoring math, exponential decay,
the ZK-gated path against the mock verifier, and the credential snapshot
event.

## Running a local deployment

```bash
# terminal 1
npx hardhat node

# terminal 2
npx hardhat run scripts/deploy.js --network localhost
```

This deploys `StakeRegistry`, `IdentityRegistry`, `MockZKVerifier`, and
`ReputationEngine`, authorizes `IdentityRegistry` as a `StakeRegistry`
slasher, and writes the resulting addresses to
`deployments/localhost.json` (git-ignored — it's a local run artifact).

## Trying the exportable credential flow yourself

After deploying locally and getting at least one rater to commit+reveal a
rating for some subject/context (see the commit-reveal usage below, or
adapt the flow used in `test/ReputationEngine.test.js`):

```bash
REPUTATION_ENGINE_ADDRESS=<address from deployments/localhost.json> \
SUBJECT_ADDRESS=<the rated address> \
CONTEXT_LABEL="marketplace-seller" \
npx hardhat run scripts/issueCredential.js --network localhost
```

This prints the signed credential JSON and writes it under `credentials/`
(also git-ignored). Then verify it with zero blockchain access:

```bash
node scripts/verifyCredential.js credentials/<the-file>.json <expected-attester-address>
```

The script recomputes the payload hash, recovers the signer from the
signature, and reports whether it matches — tampering with any field in
the JSON (try editing the score) invalidates the signature, as you'd
expect.

## Using the commit-reveal rating flow

```js
// 1. Rater becomes eligible by staking:
await stakeRegistry.connect(rater).deposit({ value: ethers.parseEther("0.01") });
await identityRegistry.connect(rater).registerWithStake();

// 2. Rater commits a hidden rating for (subject, context):
const context = ethers.keccak256(ethers.toUtf8Bytes("marketplace-seller"));
const salt = ethers.encodeBytes32String("some-random-salt");
const ratingValue = 5; // 1..5
const commitHash = ethers.keccak256(
  ethers.solidityPacked(
    ["address", "bytes32", "address", "uint256", "bytes32"],
    [subject.address, context, rater.address, ratingValue, salt]
  )
);
await reputationEngine.connect(rater).commitRating(subject.address, context, commitHash);

// 3. Wait out the 1-day commit window, then reveal with the original value+salt:
await reputationEngine.connect(rater).revealRating(subject.address, context, ratingValue, salt);

// 4. Read the resulting (decay-adjusted) score at any time:
const score = await reputationEngine.currentScore(subject.address, context);
```

Scores are scaled by `SCALE = 10000` (so `10000` == a perfect 5-star
running average, `2000` == a 1-star average); see the NatSpec comments in
`ReputationEngine.sol` for the exact EMA and decay formulas.

## Deploying to Sepolia

`hardhat.config.js` already defines a `sepolia` network entry matching the
report's stated deployment target, but **no deployment to Sepolia has
actually been made from this repository** — treat the network entry as
ready-to-use scaffolding, not a claim that live contracts exist.

```bash
export SEPOLIA_RPC_URL="<your RPC URL>"
export PRIVATE_KEY="<deployer private key, 0x-prefixed>"
npx hardhat run scripts/deploy.js --network sepolia
```

## Known gaps (read before assuming more is implemented than is)

- The ZK-proof component is an interface + mock only — see
  [`docs/zk-proof-status.md`](docs/zk-proof-status.md) for the full
  breakdown of what would still need to be built.
- The off-chain graph-based Sybil-monitoring service described in the
  report is not implemented — see
  [`docs/future-work.md`](docs/future-work.md).
- No frontend or backend indexing service is included; this repo is the
  blockchain layer only.
- Contracts use simple single-owner admin control, not a multisig/DAO/
  timelock — fine for a capstone demo, not for a real-value deployment.

## License

MIT — see [`LICENSE`](LICENSE).
