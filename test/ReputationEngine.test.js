const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const CONTEXT = ethers.keccak256(ethers.toUtf8Bytes("marketplace-seller"));
const SCALE = 10000n;

function commitHashFor(subject, context, rater, ratingValue, salt) {
  return ethers.keccak256(
    ethers.solidityPacked(
      ["address", "bytes32", "address", "uint256", "bytes32"],
      [subject, context, rater, ratingValue, salt]
    )
  );
}

describe("ReputationEngine", function () {
  let stakeRegistry, identityRegistry, reputationEngine, mockVerifier;
  let owner, subject, rater1, rater2, outsider, issuer;

  async function registerViaStake(signer) {
    await stakeRegistry.connect(signer).deposit({ value: ethers.parseEther("0.02") });
    await identityRegistry.connect(signer).registerWithStake();
  }

  beforeEach(async function () {
    [owner, subject, rater1, rater2, outsider, issuer] = await ethers.getSigners();

    const StakeRegistry = await ethers.getContractFactory("StakeRegistry");
    stakeRegistry = await StakeRegistry.deploy();
    await stakeRegistry.waitForDeployment();

    const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
    identityRegistry = await IdentityRegistry.deploy(await stakeRegistry.getAddress(), issuer.address);
    await identityRegistry.waitForDeployment();

    const MockZKVerifier = await ethers.getContractFactory("MockZKVerifier");
    mockVerifier = await MockZKVerifier.deploy(true);
    await mockVerifier.waitForDeployment();

    const ReputationEngine = await ethers.getContractFactory("ReputationEngine");
    reputationEngine = await ReputationEngine.deploy(
      await identityRegistry.getAddress(),
      await mockVerifier.getAddress()
    );
    await reputationEngine.waitForDeployment();

    await registerViaStake(rater1);
    await registerViaStake(rater2);
  });

  describe("commit-reveal flow", function () {
    it("rejects a commit from a non-eligible rater", async function () {
      const salt = ethers.encodeBytes32String("salt1");
      const hash = commitHashFor(subject.address, CONTEXT, outsider.address, 5, salt);
      await expect(
        reputationEngine.connect(outsider).commitRating(subject.address, CONTEXT, hash)
      ).to.be.revertedWith("ReputationEngine: rater not eligible");
    });

    it("rejects a rater trying to rate themselves", async function () {
      const salt = ethers.encodeBytes32String("salt1");
      const hash = commitHashFor(rater1.address, CONTEXT, rater1.address, 5, salt);
      await expect(
        reputationEngine.connect(rater1).commitRating(rater1.address, CONTEXT, hash)
      ).to.be.revertedWith("ReputationEngine: cannot rate self");
    });

    it("rejects revealing before the commit window has elapsed", async function () {
      const salt = ethers.encodeBytes32String("salt1");
      const hash = commitHashFor(subject.address, CONTEXT, rater1.address, 5, salt);
      await reputationEngine.connect(rater1).commitRating(subject.address, CONTEXT, hash);

      await expect(
        reputationEngine.connect(rater1).revealRating(subject.address, CONTEXT, 5, salt)
      ).to.be.revertedWith("ReputationEngine: commit window not over yet");
    });

    it("rejects a reveal whose value/salt don't match the commitment", async function () {
      const salt = ethers.encodeBytes32String("salt1");
      const hash = commitHashFor(subject.address, CONTEXT, rater1.address, 5, salt);
      await reputationEngine.connect(rater1).commitRating(subject.address, CONTEXT, hash);
      await time.increase(24 * 60 * 60 + 1);

      await expect(
        reputationEngine.connect(rater1).revealRating(subject.address, CONTEXT, 4, salt)
      ).to.be.revertedWith("ReputationEngine: hash mismatch");
    });

    it("rejects revealing after the reveal window has expired", async function () {
      const salt = ethers.encodeBytes32String("salt1");
      const hash = commitHashFor(subject.address, CONTEXT, rater1.address, 5, salt);
      await reputationEngine.connect(rater1).commitRating(subject.address, CONTEXT, hash);
      await time.increase(2 * 24 * 60 * 60 + 2 * 24 * 60 * 60); // way past commit+reveal window

      await expect(
        reputationEngine.connect(rater1).revealRating(subject.address, CONTEXT, 5, salt)
      ).to.be.revertedWith("ReputationEngine: reveal window expired");
    });

    it("accepts a valid commit + reveal and sets the first score to the normalized rating", async function () {
      const salt = ethers.encodeBytes32String("salt1");
      const hash = commitHashFor(subject.address, CONTEXT, rater1.address, 5, salt);
      await reputationEngine.connect(rater1).commitRating(subject.address, CONTEXT, hash);
      await time.increase(24 * 60 * 60 + 1);

      await expect(reputationEngine.connect(rater1).revealRating(subject.address, CONTEXT, 5, salt))
        .to.emit(reputationEngine, "RatingRevealed")
        .withArgs(subject.address, CONTEXT, rater1.address, 5, SCALE); // 5/5 stars -> full SCALE

      expect(await reputationEngine.currentScore(subject.address, CONTEXT)).to.equal(SCALE);
      expect(await reputationEngine.ratingCount(subject.address, CONTEXT)).to.equal(1);
    });

    it("rejects revealing the same commitment twice", async function () {
      const salt = ethers.encodeBytes32String("salt1");
      const hash = commitHashFor(subject.address, CONTEXT, rater1.address, 5, salt);
      await reputationEngine.connect(rater1).commitRating(subject.address, CONTEXT, hash);
      await time.increase(24 * 60 * 60 + 1);
      await reputationEngine.connect(rater1).revealRating(subject.address, CONTEXT, 5, salt);

      await expect(
        reputationEngine.connect(rater1).revealRating(subject.address, CONTEXT, 5, salt)
      ).to.be.revertedWith("ReputationEngine: already revealed");
    });

    it("blends a second rating into the running score using the EMA weight", async function () {
      // First rating: 5 stars -> score = SCALE (10000)
      let salt = ethers.encodeBytes32String("salt1");
      let hash = commitHashFor(subject.address, CONTEXT, rater1.address, 5, salt);
      await reputationEngine.connect(rater1).commitRating(subject.address, CONTEXT, hash);
      await time.increase(24 * 60 * 60 + 1);
      await reputationEngine.connect(rater1).revealRating(subject.address, CONTEXT, 5, salt);

      // Second rating from a different rater: 1 star -> ratingScaled = 2000
      // newScore = (10000 * (10000-2000) + 2000*2000) / 10000 = (80,000,000 + 4,000,000)/10000 = 8400
      salt = ethers.encodeBytes32String("salt2");
      hash = commitHashFor(subject.address, CONTEXT, rater2.address, 1, salt);
      await reputationEngine.connect(rater2).commitRating(subject.address, CONTEXT, hash);
      await time.increase(24 * 60 * 60 + 1);
      await reputationEngine.connect(rater2).revealRating(subject.address, CONTEXT, 1, salt);

      expect(await reputationEngine.currentScore(subject.address, CONTEXT)).to.equal(8400n);
      expect(await reputationEngine.ratingCount(subject.address, CONTEXT)).to.equal(2);
    });

    it("allows a rater to commit again for the same subject/context after their cycle finishes", async function () {
      let salt = ethers.encodeBytes32String("salt1");
      let hash = commitHashFor(subject.address, CONTEXT, rater1.address, 5, salt);
      await reputationEngine.connect(rater1).commitRating(subject.address, CONTEXT, hash);
      await time.increase(24 * 60 * 60 + 1);
      await reputationEngine.connect(rater1).revealRating(subject.address, CONTEXT, 5, salt);

      // same rater rates again later
      salt = ethers.encodeBytes32String("salt3");
      hash = commitHashFor(subject.address, CONTEXT, rater1.address, 3, salt);
      await expect(reputationEngine.connect(rater1).commitRating(subject.address, CONTEXT, hash)).to.not.be
        .reverted;
    });
  });

  describe("exponential decay", function () {
    it("decays a stale score when read via currentScore", async function () {
      const salt = ethers.encodeBytes32String("salt1");
      const hash = commitHashFor(subject.address, CONTEXT, rater1.address, 5, salt);
      await reputationEngine.connect(rater1).commitRating(subject.address, CONTEXT, hash);
      await time.increase(24 * 60 * 60 + 1);
      await reputationEngine.connect(rater1).revealRating(subject.address, CONTEXT, 5, salt);

      expect(await reputationEngine.currentScore(subject.address, CONTEXT)).to.equal(SCALE);

      // advance 2 full decay periods (30 days each) with no new ratings
      await time.increase(60 * 24 * 60 * 60 + 1);

      // expected: 10000 -> *0.95 -> 9500 -> *0.95 -> 9025 (integer division per period)
      const decayed = await reputationEngine.currentScore(subject.address, CONTEXT);
      expect(decayed).to.equal(9025n);
      expect(decayed).to.be.lessThan(SCALE);
    });

    it("does not decay a score that was updated within the current period", async function () {
      const salt = ethers.encodeBytes32String("salt1");
      const hash = commitHashFor(subject.address, CONTEXT, rater1.address, 5, salt);
      await reputationEngine.connect(rater1).commitRating(subject.address, CONTEXT, hash);
      await time.increase(24 * 60 * 60 + 1);
      await reputationEngine.connect(rater1).revealRating(subject.address, CONTEXT, 5, salt);

      await time.increase(60 * 60); // only 1 hour, far less than DECAY_PERIOD
      expect(await reputationEngine.currentScore(subject.address, CONTEXT)).to.equal(SCALE);
    });
  });

  describe("ZK-gated reveal path", function () {
    it("rejects the proof path when no verifier is configured", async function () {
      const ReputationEngine = await ethers.getContractFactory("ReputationEngine");
      const engineNoVerifier = await ReputationEngine.deploy(await identityRegistry.getAddress(), ethers.ZeroAddress);
      await engineNoVerifier.waitForDeployment();

      await expect(
        engineNoVerifier.revealRatingViaProof(subject.address, CONTEXT, 5, "0x", [])
      ).to.be.revertedWith("ReputationEngine: zk verifier not configured");
    });

    it("rejects an invalid proof (mock verifier returns false)", async function () {
      await mockVerifier.setShouldVerify(false);
      await expect(
        reputationEngine.revealRatingViaProof(subject.address, CONTEXT, 5, "0x", [])
      ).to.be.revertedWith("ReputationEngine: invalid proof");
    });

    it("accepts a rating through the proof path when the mock verifier approves it", async function () {
      await expect(reputationEngine.revealRatingViaProof(subject.address, CONTEXT, 4, "0x", []))
        .to.emit(reputationEngine, "RatingRevealedViaProof")
        .withArgs(subject.address, CONTEXT, 8000n); // 4/5 stars -> 8000

      expect(await reputationEngine.currentScore(subject.address, CONTEXT)).to.equal(8000n);
    });
  });

  describe("credential snapshot export", function () {
    it("emits a CredentialIssued event with the current decayed score", async function () {
      const salt = ethers.encodeBytes32String("salt1");
      const hash = commitHashFor(subject.address, CONTEXT, rater1.address, 5, salt);
      await reputationEngine.connect(rater1).commitRating(subject.address, CONTEXT, hash);
      await time.increase(24 * 60 * 60 + 1);
      await reputationEngine.connect(rater1).revealRating(subject.address, CONTEXT, 5, salt);

      await expect(reputationEngine.issueCredentialSnapshot(subject.address, CONTEXT)).to.emit(
        reputationEngine,
        "CredentialIssued"
      );
    });

    it("returns a zero score snapshot for a subject with no ratings", async function () {
      const tx = await reputationEngine.issueCredentialSnapshot(subject.address, CONTEXT);
      const receipt = await tx.wait();
      const event = receipt.logs
        .map((l) => {
          try {
            return reputationEngine.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e && e.name === "CredentialIssued");
      expect(event.args.score).to.equal(0n);
      expect(event.args.ratingCount).to.equal(0n);
    });
  });
});
