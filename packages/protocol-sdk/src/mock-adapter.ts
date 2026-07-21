import { reflectionFee } from "./safe-client.js";
import { detachedDeepFreeze } from "./immutable.js";
import {
  CEDRA_TESTNET_CHAIN_ID,
  type Address,
  type CedraReadAdapter,
  type FaucetStatus,
  type LpEpochTerminalDustSnapshot,
  type PoolSnapshot,
  type PortfolioSnapshot,
  type ProtocolSnapshot,
  type SwapQuote,
} from "./types.js";

export interface MockReadState {
  readonly portfolio: PortfolioSnapshot;
  readonly protocol: ProtocolSnapshot;
  readonly faucetTrfl: FaucetStatus;
  readonly faucetTusd: FaucetStatus;
  readonly lpEpochTerminalDust?: ReadonlyMap<bigint, Omit<LpEpochTerminalDustSnapshot, "epoch" | "ledgerVersion">>;
}

/** Deterministic in-memory read adapter for UI development and tests. */
export class MockCedraReadAdapter implements CedraReadAdapter {
  private readonly state: MockReadState;

  public constructor(state: MockReadState) {
    // Test fixtures are caller-owned mutable JavaScript values despite their
    // readonly TypeScript surface. Never retain their aliases.
    this.state = structuredClone(state);
  }

  public async getPortfolio(_account: Address): Promise<PortfolioSnapshot> {
    return detachedDeepFreeze(this.state.portfolio);
  }

  public async getProtocol(): Promise<ProtocolSnapshot> {
    return detachedDeepFreeze(this.state.protocol);
  }

  public async getPool(): Promise<PoolSnapshot> {
    return detachedDeepFreeze(this.state.protocol.pool);
  }

  public async getLpEpochTerminalDust(epoch: bigint): Promise<LpEpochTerminalDustSnapshot> {
    const dust = this.state.lpEpochTerminalDust?.get(epoch);
    return detachedDeepFreeze({
      epoch,
      terminalRoundingBaseUnits: dust?.terminalRoundingBaseUnits ?? 0n,
      retiredResidueMagnified: dust?.retiredResidueMagnified ?? 0n,
      ledgerVersion: this.state.protocol.ledgerVersion,
    });
  }

  public async getFaucetStatus(
    _account: Address,
    asset: "tRFL" | "tUSD",
  ): Promise<FaucetStatus> {
    return detachedDeepFreeze(asset === "tRFL" ? this.state.faucetTrfl : this.state.faucetTusd);
  }

  public async quoteSwap(input: {
    readonly direction: "buy" | "sell";
    readonly grossAmount: bigint;
    readonly slippageBps: bigint;
    readonly deadlineUnixSeconds: bigint;
  }): Promise<SwapQuote> {
    input = Object.freeze(structuredClone(input));
    const pool = this.state.protocol.pool;
    // A sell pays reflection from tRFL input; a buy pays it from the tRFL
    // output. The tUSD buy input reaches the pool unchanged before AMM fee.
    const feeBps = this.state.protocol.reflectionFeeBps ?? 100n;
    const inputReflection = input.direction === "sell" ? reflectionFee(input.grossAmount, feeBps) : 0n;
    const reserveInput = input.grossAmount - inputReflection;
    const invariantInput = (reserveInput * (10_000n - 30n)) / 10_000n;
    const ammFee = reserveInput - invariantInput;
    const inputReserve = input.direction === "sell" ? pool.trflReserve : pool.tusdReserve;
    const outputReserve = input.direction === "sell" ? pool.tusdReserve : pool.trflReserve;
    const grossPoolOutput = (invariantInput * outputReserve) / (inputReserve + invariantInput);
    const netUserReceipt = input.direction === "buy"
      ? grossPoolOutput - reflectionFee(grossPoolOutput, feeBps)
      : grossPoolOutput;
    const minimumNetUserReceipt = (netUserReceipt * (10_000n - input.slippageBps)) / 10_000n;
    const priceImpactBps = inputReserve === 0n
      ? 0n
      : (invariantInput * 10_000n) / (inputReserve + invariantInput);
    return detachedDeepFreeze({
      direction: input.direction,
      grossAmount: input.grossAmount,
      slippageBps: input.slippageBps,
      reflectionFee: input.direction === "buy" ? reflectionFee(grossPoolOutput, feeBps) : inputReflection,
      ammFee,
      netReserveInput: reserveInput,
      grossPoolOutput,
      netUserReceipt,
      minimumNetUserReceipt,
      priceImpactBps,
      deadlineUnixSeconds: input.deadlineUnixSeconds,
      context: {
        chainId: CEDRA_TESTNET_CHAIN_ID,
        ledgerVersion: pool.ledgerVersion,
        deploymentId: "mock-reflection-pilot",
        packageVersion: this.state.protocol.packageVersion,
        inputReserve,
        outputReserve,
        reflectionFeeBps: feeBps,
        ammFeeBps: 30n,
        maximumGrossSwap: pool.maximumGrossSwap,
        maximumReserveBps: pool.maximumReserveBps,
      },
    });
  }
}
