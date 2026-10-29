const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("StakeRegistry", function () {
  let stakeRegistry, owner, alice, bob, slasherStub;

  beforeEach(async function () {
    [owner, alice, bob, slasherStub] = await ethers.getSigners();
    const StakeRegistry = await ethers.getContractFactory("StakeRegistry");
    stakeRegistry = await StakeRegistry.deploy();
    await stakeRegistry.waitForDeployment();
  });

  it("accepts a deposit and tracks the balance", async function () {
    await stakeRegistry.connect(alice).deposit({ value: ethers.parseEther("0.02") });
    expect(await stakeRegistry.stakeOf(alice.address)).to.equal(ethers.parseEther("0.02"));
    expect(await stakeRegistry.isAboveMinStake(alice.address)).to.equal(true);
  });

  it("rejects a zero-value deposit", async function () {
    await expect(stakeRegistry.connect(alice).deposit({ value: 0 })).to.be.revertedWith(
      "StakeRegistry: zero deposit"
    );
  });

  it("reports isAboveMinStake correctly below the threshold", async function () {
    await stakeRegistry.connect(alice).deposit({ value: ethers.parseEther("0.005") });
    expect(await stakeRegistry.isAboveMinStake(alice.address)).to.equal(false);
  });

  it("enforces the withdrawal timelock", async function () {
    await stakeRegistry.connect(alice).deposit({ value: ethers.parseEther("0.02") });
    await stakeRegistry.connect(alice).requestWithdrawal();

    await expect(stakeRegistry.connect(alice).withdraw()).to.be.revertedWith(
      "StakeRegistry: delay not elapsed"
    );

    await time.increase(3 * 24 * 60 * 60 + 1);

    const before = await ethers.provider.getBalance(alice.address);
    const tx = await stakeRegistry.connect(alice).withdraw();
    const receipt = await tx.wait();
    const gasCost = receipt.gasUsed * receipt.gasPrice;
    const after = await ethers.provider.getBalance(alice.address);

    expect(after).to.equal(before + ethers.parseEther("0.02") - gasCost);
    expect(await stakeRegistry.stakeOf(alice.address)).to.equal(0);
  });

  it("blocks new deposits while a withdrawal is pending", async function () {
    await stakeRegistry.connect(alice).deposit({ value: ethers.parseEther("0.02") });
    await stakeRegistry.connect(alice).requestWithdrawal();
    await expect(
      stakeRegistry.connect(alice).deposit({ value: ethers.parseEther("0.01") })
    ).to.be.revertedWith("StakeRegistry: pending withdrawal, cancel first");
  });

  it("allows cancelling a withdrawal request", async function () {
    await stakeRegistry.connect(alice).deposit({ value: ethers.parseEther("0.02") });
    await stakeRegistry.connect(alice).requestWithdrawal();
    await stakeRegistry.connect(alice).cancelWithdrawalRequest();
    expect(await stakeRegistry.hasPendingWithdrawal(alice.address)).to.equal(false);
    // deposits should work again
    await stakeRegistry.connect(alice).deposit({ value: ethers.parseEther("0.01") });
  });

  it("only allows an authorized slasher to slash stake", async function () {
    await stakeRegistry.connect(alice).deposit({ value: ethers.parseEther("0.02") });

    await expect(
      stakeRegistry.connect(bob).slash(alice.address, ethers.parseEther("0.01"), "bad behavior")
    ).to.be.revertedWith("StakeRegistry: not an authorized slasher");

    await stakeRegistry.connect(owner).setSlasher(slasherStub.address, true);
    await stakeRegistry.connect(slasherStub).slash(alice.address, ethers.parseEther("0.01"), "bad behavior");

    expect(await stakeRegistry.stakeOf(alice.address)).to.equal(ethers.parseEther("0.01"));
  });

  it("caps the slash amount at the user's current balance", async function () {
    await stakeRegistry.connect(alice).deposit({ value: ethers.parseEther("0.01") });
    await stakeRegistry.connect(owner).setSlasher(slasherStub.address, true);
    await stakeRegistry.connect(slasherStub).slash(alice.address, ethers.parseEther("5"), "overslash attempt");
    expect(await stakeRegistry.stakeOf(alice.address)).to.equal(0);
  });
});
