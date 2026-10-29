require("@nomicfoundation/hardhat-toolbox");

/**
 * Hardhat configuration for the ChainTrust reputation system.
 *
 * Network notes:
 * - `hardhat`: in-process network used for the full automated test suite.
 * - `sepolia`: included to match the project report's stated deployment
 *   target (Ethereum Sepolia testnet). It is only usable if SEPOLIA_RPC_URL
 *   and PRIVATE_KEY are supplied as environment variables; no real deployment
 *   has been made from this repository, so no live contract addresses exist
 *   yet. See README.md "Status" section.
 */
module.exports = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {},
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
};
