import type {
  Address,
  FaucetStatus,
  MockReadState,
  PortfolioSnapshot,
  ProtocolSnapshot,
} from "../packages/protocol-sdk/src/index.js";
import type { EventBase, ObservedAccountingSnapshot } from "../packages/indexer/src/index.js";

export const TEST_ACCOUNT = "0xalice" as Address;
export const TEST_BOB = "0xbob" as Address;
export const CORE_REWARD_VAULT = "0xreward" as Address;
export const DISTRIBUTION_VAULT = "0xdistribution" as Address;
export const CUSTODY_RESERVE = "0xreserve" as Address;
export const LP_REWARD_VAULT = "0xlpvault1" as Address;

export function baseEvent(overrides: Partial<EventBase> = {}): EventBase {
  return {
    id: "event-0",
    txHash: "0xtx0",
    ledgerVersion: 1n,
    eventIndex: 0,
    timestampUnixMilliseconds: 1_700_000_000_000n,
    source: "fixture",
    ...overrides,
  };
}

export function portfolioFixture(): PortfolioSnapshot {
  return {
    account: TEST_ACCOUNT,
    effectiveTrfl: 1_010n,
    rawTrfl: 1_000n,
    pendingReflections: 10n,
    lifetimeClaimed: 20n,
    eligibleSupply: 1_000_000n,
    holderShares: 1_000n,
    ledgerVersion: 10n,
  };
}

export function protocolFixture(): ProtocolSnapshot {
  return {
    eligibleHolders: 1n,
    eligibleSupply: 1_000_000n,
    rewardVaultBalance: 10n,
    reflectionLiability: 10n,
    lifetimeSwapFees: 10n,
    lifetimeMaterialized: 0n,
    currentIndex: 10n,
    indexRemainder: 0n,
    pool: {
      trflReserve: 100_990n,
      tusdReserve: 99_020n,
      swapsPaused: false,
      maximumGrossSwap: 10_000n,
      maximumReserveBps: 500n,
      maximumRflContribution: 100_000_000_000n,
      maximumTusdContribution: 100_000_000_000n,
      maximumNonFinalWithdrawalShareBps: 10_000n,
      ledgerVersion: 10n,
    },
    claimsPaused: false,
    packageVersion: "testnet-v1",
    ledgerVersion: 10n,
  };
}

function faucet(asset: "tRFL" | "tUSD"): FaucetStatus {
  return {
    asset,
    account: TEST_ACCOUNT,
    grantAmount: asset === "tRFL" ? 100n : 1_000n,
    cooldownEndsAtUnixSeconds: 1_800_000_000n,
    canClaim: true,
  };
}

export function mockReadState(): MockReadState {
  return {
    portfolio: portfolioFixture(),
    protocol: protocolFixture(),
    faucetTrfl: faucet("tRFL"),
    faucetTusd: faucet("tUSD"),
  };
}

export function observationFixture(): ObservedAccountingSnapshot {
  return {
    ledgerVersion: 2n,
    rewardVault: CORE_REWARD_VAULT,
    rewardVaultBalance: 0n,
    reflectionLiability: 0n,
    currentIndex: 0n,
    indexRemainder: 0n,
    eligibleSupply: 0n,
    aggregateCorrection: 0n,
    unallocatedFees: 0n,
    roundingReserve: 0n,
    lifetimeSwapFees: 0n,
    lifetimeMaterialized: 0n,
    lifetimeCustodyRouted: 0n,
    custodyAdapterId: 1n,
    custodyReserveStore: CUSTODY_RESERVE,
    custodyReserveBalance: 0n,
    custodyShares: 0n,
    custodyCorrection: 0n,
    custodyClaimed: 0n,
    custodyPendingRewards: 0n,
    custodyActiveRouteEpoch: 1n,
    custodyActiveLpRewardVault: LP_REWARD_VAULT,
    trflReserve: 0n,
    tusdReserve: 0n,
    maximumRflContribution: 100_000_000_000n,
    maximumTusdContribution: 100_000_000_000n,
    maximumNonFinalWithdrawalShareBps: 10_000n,
    activeLpEpoch: null,
    lpEpochs: [],
    positions: [],
    packageVersion: "testnet-v1",
    swapsPaused: false,
    claimsPaused: false,
    poolPaused: false,
    liquidityPaused: false,
    lpClaimsPaused: false,
    shutdownMode: false,
    poolSeeded: false,
    coreOperationalAdmin: "0xcafe",
    faucetOperationalAdmin: "0xbabe",
    ammOperationalAdmin: "0xdead",
  };
}
