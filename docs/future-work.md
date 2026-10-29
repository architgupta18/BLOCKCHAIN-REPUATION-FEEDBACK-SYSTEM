# Known gaps and future work

This file lists, honestly, what the project design describes that this
working model does not implement, beyond the ZK component already covered
in `docs/zk-proof-status.md`.

## Graph-based Sybil monitoring (not implemented)

The design calls for an off-chain background service that watches the
rater→subject interaction graph (who rates whom, how often, in what
clusters) as a secondary Sybil defense layered on top of the on-chain
stake/credential gate. This repository emits the on-chain events such a
service would consume (`RatingCommitted`, `RatingRevealed`,
`RatingRevealedViaProof`, `Registered`), but no graph-construction,
clustering, or anomaly-scoring logic exists in this codebase. Building that
service (e.g. a Node.js worker that indexes these events into a graph store
and flags suspicious clusters for `IdentityRegistry.revoke()`) is future
work.

## Slashed-stake destination

`StakeRegistry.slash()` reduces the misbehaving user's recorded balance,
but the ETH itself simply remains in the contract — there is no treasury,
reporter-reward, or burn mechanism for it. A governance decision on where
slashed funds should go (reward the reporter? fund a treasury? burn via
sending to a dead address?) was left out of this working model.

## EIP-712 typed-data signing for credentials

`scripts/issueCredential.js` / `scripts/verifyCredential.js` sign a
keccak256 hash of the credential payload using plain EIP-191
(`personal_sign`)-style signing. A production version should likely switch
to EIP-712 typed data so wallets can display a human-readable signing
prompt instead of an opaque hash. The verification logic would need to
change accordingly.

## Full-stack web app (React/Express/Postgres layers)

The project report describes a four-layer architecture: Presentation
(React + Vite), Web3 (MetaMask + Ethers.js), Blockchain (this repo's
contracts), and Backend (Node/Express + PostgreSQL/Supabase for off-chain
indexing and the attestation service). This repository implements only the
Blockchain layer plus the two off-chain scripts needed to demonstrate the
exportable-credential flow end-to-end. The frontend and backend service
layers are not built here.

## Governance / upgradeability

Contracts here use a simple single-owner (`onlyOwner`) pattern for
administrative functions (setting the credential issuer, authorizing
slashers, revoking identities, setting the ZK verifier). There is no
multisig, timelock, or DAO governance layer, and none of the contracts are
upgradeable (no proxy pattern). Both would be reasonable additions before
any real-value deployment.

## Reputation-weighted rating influence

Currently every eligible rater's vote is weighted identically
(`DEFAULT_WEIGHT` in `ReputationEngine`). A more advanced design could
weight a rater's influence on someone else's score by the rater's own
reputation, which is hinted at in the literature review but not specified
precisely enough in the report to implement unambiguously here.
