const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("IdentityRegistry", function () {
  let stakeRegistry, identityRegistry, owner, alice, bob, issuer;

  beforeEach(async function () {
    [owner, alice, bob, issuer] = await ethers.getSigners();

    const StakeRegistry = await ethers.getContractFactory("StakeRegistry");
    stakeRegistry = await StakeRegistry.deploy();
    await stakeRegistry.waitForDeployment();

    const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
    identityRegistry = await IdentityRegistry.deploy(await stakeRegistry.getAddress(), issuer.address);
    await identityRegistry.waitForDeployment();
  });

  describe("stake-backed registration", function () {
    it("rejects registration below the minimum stake", async function () {
      await stakeRegistry.connect(alice).deposit({ value: ethers.parseEther("0.005") });
      await expect(identityRegistry.connect(alice).registerWithStake()).to.be.revertedWith(
        "IdentityRegistry: insufficient stake"
      );
    });

    it("grants StakeBacked status once MIN_STAKE is deposited", async function () {
      await stakeRegistry.connect(alice).deposit({ value: ethers.parseEther("0.02") });
      await identityRegistry.connect(alice).registerWithStake();

      expect(await identityRegistry.statusOf(alice.address)).to.equal(1); // StakeBacked
      expect(await identityRegistry.isEligibleRater(alice.address)).to.equal(true);
    });

    it("blocks registration while a withdrawal is pending", async function () {
      await stakeRegistry.connect(alice).deposit({ value: ethers.parseEther("0.02") });
      await stakeRegistry.connect(alice).requestWithdrawal();
      await expect(identityRegistry.connect(alice).registerWithStake()).to.be.revertedWith(
        "IdentityRegistry: pending withdrawal"
      );
    });
  });

  describe("credential-backed registration", function () {
    async function signCredential(signer, user, expiry, contractAddress, chainId) {
      const messageHash = ethers.keccak256(
        ethers.solidityPacked(
          ["address", "uint256", "address", "uint256"],
          [user, expiry, contractAddress, chainId]
        )
      );
      return signer.signMessage(ethers.getBytes(messageHash));
    }

    it("grants CredentialBacked status for a validly signed credential", async function () {
      const network = await ethers.provider.getNetwork();
      const expiry = Math.floor(Date.now() / 1000) + 3600;
      const sig = await signCredential(
        issuer,
        bob.address,
        expiry,
        await identityRegistry.getAddress(),
        network.chainId
      );

      await identityRegistry.connect(bob).registerWithCredential(expiry, sig);

      expect(await identityRegistry.statusOf(bob.address)).to.equal(2); // CredentialBacked
      expect(await identityRegistry.isEligibleRater(bob.address)).to.equal(true);
    });

    it("rejects a signature from a non-issuer address", async function () {
      const network = await ethers.provider.getNetwork();
      const expiry = Math.floor(Date.now() / 1000) + 3600;
      const sig = await signCredential(
        alice, // not the configured issuer
        bob.address,
        expiry,
        await identityRegistry.getAddress(),
        network.chainId
      );

      await expect(identityRegistry.connect(bob).registerWithCredential(expiry, sig)).to.be.revertedWith(
        "IdentityRegistry: invalid credential signature"
      );
    });

    it("rejects an expired credential", async function () {
      const network = await ethers.provider.getNetwork();
      const expiry = Math.floor(Date.now() / 1000) - 10;
      const sig = await signCredential(
        issuer,
        bob.address,
        expiry,
        await identityRegistry.getAddress(),
        network.chainId
      );

      await expect(identityRegistry.connect(bob).registerWithCredential(expiry, sig)).to.be.revertedWith(
        "IdentityRegistry: credential expired"
      );
    });

    it("rejects replaying the same credential signature twice", async function () {
      const network = await ethers.provider.getNetwork();
      const expiry = Math.floor(Date.now() / 1000) + 3600;
      const sig = await signCredential(
        issuer,
        bob.address,
        expiry,
        await identityRegistry.getAddress(),
        network.chainId
      );

      await identityRegistry.connect(bob).registerWithCredential(expiry, sig);
      await expect(identityRegistry.connect(bob).registerWithCredential(expiry, sig)).to.be.revertedWith(
        "IdentityRegistry: credential already used"
      );
    });

    it("upgrades status to Both when a stake-backed user also registers a credential", async function () {
      await stakeRegistry.connect(alice).deposit({ value: ethers.parseEther("0.02") });
      await identityRegistry.connect(alice).registerWithStake();

      const network = await ethers.provider.getNetwork();
      const expiry = Math.floor(Date.now() / 1000) + 3600;
      const sig = await signCredential(
        issuer,
        alice.address,
        expiry,
        await identityRegistry.getAddress(),
        network.chainId
      );
      await identityRegistry.connect(alice).registerWithCredential(expiry, sig);

      expect(await identityRegistry.statusOf(alice.address)).to.equal(3); // Both
    });
  });

  describe("revocation", function () {
    it("allows the owner to revoke an identity", async function () {
      await stakeRegistry.connect(alice).deposit({ value: ethers.parseEther("0.02") });
      await identityRegistry.connect(alice).registerWithStake();
      await identityRegistry.connect(owner).revoke(alice.address);
      expect(await identityRegistry.isEligibleRater(alice.address)).to.equal(false);
    });

    it("rejects revocation from a non-owner", async function () {
      await stakeRegistry.connect(alice).deposit({ value: ethers.parseEther("0.02") });
      await identityRegistry.connect(alice).registerWithStake();
      await expect(identityRegistry.connect(bob).revoke(alice.address)).to.be.revertedWith(
        "IdentityRegistry: not owner"
      );
    });
  });
});
