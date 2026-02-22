/**
 * Configuration for BankrMonitor
 * Doppler contract addresses on Base (chain 8453) from official Deployments
 * @see https://github.com/whetstoneresearch/doppler/blob/main/Deployments.json
 */
export const BASE_CHAIN_ID = 8453;

export const DOPPLER_CONTRACTS_BASE = {
  UniswapV4Initializer: "0x53b4c21a6cb61d64f636abbfa6e8e90e6558e8ad",
  UniswapV4MulticurveInitializer: "0x65de470da664a5be139a5d812be5fda0d76cc951",
  UniswapV4ScheduledMulticurveInitializer: "0xa36715da46ddf4a769f3290f49af58bf8132ed8e",
  DecayMulticurveInitializer: "0xd59ce43e53d69f190e15d9822fb4540dccc91178",
  RehypeDopplerHook: "0x97cad5684fb7cc2bed9a9b5ebfba67138f4f2503",
  DecayMulticurveInitializerHook: "0xbb7784a4d481184283ed89619a3e3ed143e1adc0",
  UniswapV4MulticurveInitializerHook: "0x892d3c2b4abeaaf67d52a7b29783e2161b7cad40",
  UniswapV4ScheduledMulticurveInitializerHook: "0x3e342a06f9592459d75721d6956b570f02ef2dc0",
};
