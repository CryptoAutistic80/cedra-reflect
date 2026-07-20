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
  feeBps: 100n,
  initialIndex: 0n,
  packageVersion: "testnet-v0.1.0",
  rewardVault: "0xreward",
  distributionVault: "0xdistribution",
};

const store = new InMemoryIndexerStore();
const indexer = new EventIndexer(store);
await indexer.process([event]);
const snapshot = await indexer.snapshot(1_700_000_000_001n);
console.log(encodeSnapshot(snapshot));
