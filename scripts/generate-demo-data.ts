import {
  EventIndexer,
  InMemoryIndexerStore,
  encodeSnapshot,
  type ProtocolEvent,
} from "../packages/indexer/src/index.js";

const event: ProtocolEvent = {
  id: "demo-initialized",
  txHash: "0xdemo",
  ledgerVersion: 1n,
  eventIndex: 0,
  timestampUnixMilliseconds: 1_700_000_000_000n,
  source: "fixture",
  type: "ProtocolInitialized",
  deploymentId: "reflection-pilot-001",
  networkLabel: "cedra-testnet",
  tokenMetadata: "0x1000",
  automaticMaterialization: false,
  feeBps: 100n,
  initialIndex: 0n,
  packageVersion: "testnet-v0.1.0",
  rewardVault: "0x1001",
  distributionVault: "0x1002",
  protocolExclusionSlots: 2n,
};

const store = new InMemoryIndexerStore();
const indexer = new EventIndexer(store);
await indexer.process([event]);
const snapshot = await indexer.snapshot(1_700_000_000_001n);
console.log(encodeSnapshot(snapshot));
