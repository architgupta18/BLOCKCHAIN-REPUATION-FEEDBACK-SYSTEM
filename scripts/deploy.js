const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Deploys StakeRegistry, IdentityRegistry, MockZKVerifier, and
 * ReputationEngine, wires up permissions between them, and writes the
 * resulting addresses to deployments/<network>.json.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js --network hardhat
 *   npx hardhat run scripts/deploy.js --network sepolia   (requires
 *     SEPOLIA_RPC_URL and PRIVATE_KEY env vars; no deployment has actually
 *     been made to Sepolia from this repo yet, see README "Status")
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const credentialIssuer = process.env.CREDENTIAL_ISSUER_ADDRESS || deployer.address;

  const StakeRegistry = await ethers.getContractFactory("StakeRegistry");
  const stakeRegistry = await StakeRegistry.deploy();
  await stakeRegistry.waitForDeployment();
  console.log("StakeRegistry deployed to:", await stakeRegistry.getAddress());

  const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
  const identityRegistry = await IdentityRegistry.deploy(await stakeRegistry.getAddress(), credentialIssuer);
  await identityRegistry.waitForDeployment();
  console.log("IdentityRegistry deployed to:", await identityRegistry.getAddress());

  // Allow IdentityRegistry to be used as a slasher if/when future logic
  // calls stakeRegistry.slash() on provably bad raters. Not exercised by
  // any current function, but wired up so it's ready for that extension.
  await stakeRegistry.setSlasher(await identityRegistry.getAddress(), true);
  console.log("Authorized IdentityRegistry as a StakeRegistry slasher");

  const MockZKVerifier = await ethers.getContractFactory("MockZKVerifier");
  const mockZKVerifier = await MockZKVerifier.deploy(true);
  await mockZKVerifier.waitForDeployment();
  console.log("MockZKVerifier deployed to:", await mockZKVerifier.getAddress());
  console.log(
    "  NOTE: MockZKVerifier is a non-cryptographic test double. Replace it before any real deployment. See docs/zk-proof-status.md."
  );

  const ReputationEngine = await ethers.getContractFactory("ReputationEngine");
  const reputationEngine = await ReputationEngine.deploy(
    await identityRegistry.getAddress(),
    await mockZKVerifier.getAddress()
  );
  await reputationEngine.waitForDeployment();
  console.log("ReputationEngine deployed to:", await reputationEngine.getAddress());

  const network = await ethers.provider.getNetwork();
  const output = {
    network: network.name,
    chainId: Number(network.chainId),
    deployedAt: new Date().toISOString(),
    contracts: {
      StakeRegistry: await stakeRegistry.getAddress(),
      IdentityRegistry: await identityRegistry.getAddress(),
      MockZKVerifier: await mockZKVerifier.getAddress(),
      ReputationEngine: await reputationEngine.getAddress(),
    },
    credentialIssuer,
  };

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `${network.name || network.chainId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log("Wrote deployment addresses to", outPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
