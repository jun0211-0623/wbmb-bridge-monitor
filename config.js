module.exports = {
  BRIDGE_ADDRESS:
    process.env.BRIDGE_ADDRESS || "0xA825da99869C2a090585216c86D6312801Bd74d5",
  WBMB_ADDRESS:
    process.env.WBMB_ADDRESS || "0xd26681ee39d67DEAbf13dab2584ED83995628093",
  FYUSD_ADDRESS:
    process.env.FYUSD_ADDRESS || "0x97eb8d68877FB91d1994498b57A0c8B96dD8728A",
  DEX_ADDRESS:
    process.env.DEX_ADDRESS || "0x56B7655A73d00cD65C31daadce3C9D253e24da38",
  RPC_URL: process.env.RPC_URL || "https://sepolia.base.org",
  PORT: process.env.PORT || 3000,
};
