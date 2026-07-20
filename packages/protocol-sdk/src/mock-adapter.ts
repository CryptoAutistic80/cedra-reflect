import { reflectionFee } from "./safe-client.js";
import {
  type Address,
  type CedraReadAdapter,
  type FaucetStatus,
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
}

/** Deterministic in-memory read adapter for UI development and tests. */
export class MockCedraReadAdapter implements CedraReadAdapter {
  public constructor(private readonly state: MockReadState) {}

  public async getPortfolio(_account: Address): Promise<PortfolioSnapshot> {
    return this.state.portfolio;
  }

  public async getProtocol(): Promise<ProtocolSnapshot> {
    return this.state.protocol;
  }

  public async getPool(): Promise<PoolSnapshot> {
    return this.state.protocol.pool;
  }

  public async getFaucetStatus(
    _account: Address,
    asset: "tRFL" | "tUSD",
  ): Promise<FaucetStatus> {
    return asset === "tRFL" ? this.state.faucetTrfl : this.state.faucetTusd;
  }

  public async quoteSwap(input: {
    readonly direction: "buy" | "sell";
    readonly grossAmount: bigint;
    readonly slippageBps: bigint;
    readonly deadlineUnixSeconds: bigint;
  }): Promise<SwapQuote> {
    const pool = this.state.protocol.pool;
    // A sell pays reflection from tRFL input; a buy pays it from the tRFL
    // output. The tUSD buy input reaches the pool unchanged before AMM fee.
    const inputReflection = input.direction === "sell" ? reflectionFee(input.grossAmount) : 0n;
    const reserveInput = input.grossAmount - inputReflection;
    const invariantInput = (reserveInput * (10_000n - 30n)) / 10_000n;
    const ammFee = reserveInput - invariantInput;
    const inputReserve = input.direction === "sell" ? pool.trflReserve : pool.tusdReserve;
    const outputReserve = input.direction === "sell" ? pool.tusdReserve : pool.trflReserve;
    const grossPoolOutput = (invariantInput * outputReserve) / (inputReserve + invariantInput);
    const netUserReceipt = input.direction === "buy"
      ? grossPoolOutput - reflectionFee(grossPoolOutput)
      : grossPoolOutput;
    const minimumNetUserReceipt = (netUserReceipt * (10_000n - input.slippageBps)) / 10_000n;
    const priceImpactBps = inputReserve === 0n ? 0n : (invariantInput * 10_000n) / inputReserve;
    return {
      direction: input.direction,
      grossAmount: input.grossAmount,
      reflectionFee: input.direction === "buy" ? reflectionFee(grossPoolOutput) : inputReflection,
      ammFee,
      netReserveInput: reserveInput,
      grossPoolOutput,
      netUserReceipt,
      minimumNetUserReceipt,
      priceImpactBps,
      deadlineUnixSeconds: input.deadlineUnixSeconds,
    };
  }
}
