import {
  type Address,
  type CedraReadAdapter,
  type CedraWriteAdapter,
  type FaucetStatus,
  type PoolSnapshot,
  type PortfolioSnapshot,
  type ProtocolClientOptions,
  type ProtocolSnapshot,
  type OperationalAdminScope,
  type SubmittedTransaction,
  type SwapDirection,
  type SwapQuote,
  type TransactionDraft,
} from "./types.js";

export const TESTNET_NO_VALUE_WARNING =
  "TESTNET ASSET — NO MONETARY VALUE — STATE AND ADDRESSES MAY CHANGE";

const BPS_DENOMINATOR = 10_000n;
const MAX_REFLECTION_FEE_BPS = 100n;
const MAX_U64 = (1n << 64n) - 1n;
const MAX_U128 = (1n << 128n) - 1n;

export interface AddLiquidityDraftInput {
  readonly maxRfl: bigint;
  readonly maxUsd: bigint;
  readonly minLpShares: bigint;
  readonly deadlineUnixSeconds: bigint;
}

export interface RemoveLiquidityDraftInput {
  readonly shares: bigint;
  readonly minRfl: bigint;
  readonly minUsd: bigint;
  readonly deadlineUnixSeconds: bigint;
}

export interface ConfigureLiquidityLimitsDraftInput {
  readonly maxRfl: bigint;
  readonly maxUsd: bigint;
  readonly maxWithdrawalShareBps: bigint;
}

export class StateChangingCallsDisabledError extends Error {
  public constructor() {
    super(
      "State-changing calls are disabled. Inject an explicitly approved CedraWriteAdapter in the release application; this client never discovers a wallet or RPC writer by itself.",
    );
    this.name = "StateChangingCallsDisabledError";
  }
}

export function reflectionFee(grossAmount: bigint, feeBps = 100n): bigint {
  if (grossAmount < 0n || feeBps < 0n || feeBps > MAX_REFLECTION_FEE_BPS) {
    throw new RangeError("gross amount must be non-negative and fee must be between 0 and 100 basis points");
  }
  return (grossAmount * feeBps) / BPS_DENOMINATOR;
}

function defaultNowUnixSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1_000));
}

function assertUnsigned(value: bigint, maximum: bigint, label: string): void {
  if (value < 0n || value > maximum) {
    throw new RangeError(`${label} must fit the on-chain unsigned integer type`);
  }
}

function assertPositive(value: bigint, maximum: bigint, label: string): void {
  if (value <= 0n || value > maximum) {
    throw new RangeError(`${label} must be positive and fit the on-chain unsigned integer type`);
  }
}

function assertFutureDeadline(deadlineUnixSeconds: bigint, nowUnixSeconds: bigint): void {
  assertUnsigned(deadlineUnixSeconds, MAX_U64, "deadline");
  if (deadlineUnixSeconds <= nowUnixSeconds) {
    throw new RangeError("transaction deadline must be in the future");
  }
}

function assertNonZeroAddress(address: Address, label: string): void {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(address) || /^0x0+$/.test(address)) {
    throw new TypeError(`${label} must be a non-zero Cedra account address`);
  }
}

/**
 * Read operations require an injected adapter. Transaction drafts are safe,
 * pure descriptions. Submission is impossible until a caller deliberately
 * supplies a writer, so imports and dashboard rendering cannot move assets.
 */
export class ReflectionPilotClient {
  private readonly writer: CedraWriteAdapter | undefined;
  private readonly nowUnixSeconds: () => bigint;

  public constructor(
    private readonly reader: CedraReadAdapter,
    options: ProtocolClientOptions = {},
  ) {
    this.writer = options.writer;
    this.nowUnixSeconds = options.nowUnixSeconds ?? defaultNowUnixSeconds;
  }

  public getPortfolio(account: Address): Promise<PortfolioSnapshot> {
    return this.reader.getPortfolio(account);
  }

  public getProtocol(): Promise<ProtocolSnapshot> {
    return this.reader.getProtocol();
  }

  public getPool(): Promise<PoolSnapshot> {
    return this.reader.getPool();
  }

  public getFaucetStatus(account: Address, asset: "tRFL" | "tUSD"): Promise<FaucetStatus> {
    return this.reader.getFaucetStatus(account, asset);
  }

  public quoteSwap(input: {
    readonly direction: SwapDirection;
    readonly grossAmount: bigint;
    readonly slippageBps: bigint;
    readonly deadlineUnixSeconds: bigint;
  }): Promise<SwapQuote> {
    if (input.grossAmount <= 0n) {
      throw new RangeError("swap amount must be positive");
    }
    if (input.slippageBps < 0n || input.slippageBps > BPS_DENOMINATOR) {
      throw new RangeError("slippage must be between 0 and 10,000 basis points");
    }
    if (input.deadlineUnixSeconds <= this.nowUnixSeconds()) {
      throw new RangeError("swap deadline must be in the future");
    }
    return this.reader.quoteSwap(input);
  }

  public createFaucetClaimDraft(asset: "tRFL" | "tUSD"): TransactionDraft {
    return this.createDraft(
      "faucet_claim",
      asset === "tRFL"
        ? "test_assets::test_faucet::claim_trfl"
        : "test_assets::test_faucet::claim_tusd",
      [],
    );
  }

  public createRewardClaimDraft(amount: bigint): TransactionDraft {
    if (amount <= 0n) {
      throw new RangeError("claim amount must be positive");
    }
    return this.createDraft("claim_rewards", "reflection_core::reflection_token::claim", [amount]);
  }

  public createRewardClaimAllDraft(): TransactionDraft {
    return this.createDraft("claim_rewards", "reflection_core::reflection_token::claim_all", []);
  }

  public createSwapDraft(input: {
    readonly quote: SwapQuote;
  }): TransactionDraft {
    const { quote } = input;
    return this.createDraft(
      "swap",
      quote.direction === "buy" ? "test_amm::pool::buy_trfl" : "test_amm::pool::sell_trfl",
      [quote.grossAmount, quote.minimumNetUserReceipt, quote.deadlineUnixSeconds],
      quote.deadlineUnixSeconds,
    );
  }

  /** Build the signer-authenticated `pool::add_liquidity` call. */
  public createAddLiquidityDraft(input: AddLiquidityDraftInput): TransactionDraft {
    assertPositive(input.maxRfl, MAX_U64, "maximum tRFL contribution");
    assertPositive(input.maxUsd, MAX_U64, "maximum tUSD contribution");
    assertUnsigned(input.minLpShares, MAX_U128, "minimum LP shares");
    assertFutureDeadline(input.deadlineUnixSeconds, this.nowUnixSeconds());
    return this.createDraft(
      "add_liquidity",
      "test_amm::pool::add_liquidity",
      [input.maxRfl, input.maxUsd, input.minLpShares, input.deadlineUnixSeconds],
      input.deadlineUnixSeconds,
    );
  }

  /** Build the signer-authenticated `pool::remove_liquidity` call. */
  public createRemoveLiquidityDraft(input: RemoveLiquidityDraftInput): TransactionDraft {
    assertPositive(input.shares, MAX_U128, "LP shares");
    assertUnsigned(input.minRfl, MAX_U64, "minimum tRFL output");
    assertUnsigned(input.minUsd, MAX_U64, "minimum tUSD output");
    assertFutureDeadline(input.deadlineUnixSeconds, this.nowUnixSeconds());
    return this.createDraft(
      "remove_liquidity",
      "test_amm::pool::remove_liquidity",
      [input.shares, input.minRfl, input.minUsd, input.deadlineUnixSeconds],
      input.deadlineUnixSeconds,
    );
  }

  /** LP shares are module-accounted; the signer is the implicit sender. */
  public createTransferLpSharesDraft(recipient: Address, shares: bigint): TransactionDraft {
    assertNonZeroAddress(recipient, "LP share recipient");
    assertPositive(shares, MAX_U128, "LP shares");
    return this.createDraft(
      "transfer_lp_shares",
      "test_amm::pool::transfer_lp_shares",
      [recipient, shares],
    );
  }

  /** `amount === 0n` deliberately means claim all pending rewards in the epoch. */
  public createLpRewardClaimDraft(epoch: bigint, amount: bigint): TransactionDraft {
    assertPositive(epoch, MAX_U64, "LP reward epoch");
    assertUnsigned(amount, MAX_U64, "LP reward claim amount");
    return this.createDraft(
      "claim_lp_rewards",
      "test_amm::pool::claim_lp_rewards",
      [epoch, amount],
    );
  }

  public createCheckpointLpRewardsDraft(): TransactionDraft {
    return this.createDraft(
      "checkpoint_lp_rewards",
      "test_amm::pool::checkpoint_lp_rewards",
      [],
    );
  }

  public createConfigureLiquidityLimitsDraft(input: ConfigureLiquidityLimitsDraftInput): TransactionDraft {
    assertPositive(input.maxRfl, MAX_U64, "maximum tRFL contribution");
    assertPositive(input.maxUsd, MAX_U64, "maximum tUSD contribution");
    if (input.maxWithdrawalShareBps <= 0n || input.maxWithdrawalShareBps > BPS_DENOMINATOR) {
      throw new RangeError("maximum non-final LP withdrawal share must be between 1 and 10,000 basis points");
    }
    return this.createDraft(
      "configure_liquidity_limits",
      "test_amm::pool::configure_liquidity_limits",
      [input.maxRfl, input.maxUsd, input.maxWithdrawalShareBps],
    );
  }

  public createSetFaucetPausedDraft(paused: boolean): TransactionDraft {
    return this.createDraft(
      "set_faucet_paused",
      "test_assets::test_faucet::set_paused",
      [paused],
    );
  }

  /** Publisher-signed, evented handoff of routine controls to a separate key. */
  public createOperationalAdminHandoffDraft(
    scope: OperationalAdminScope,
    operationalAdmin: Address,
  ): TransactionDraft {
    assertNonZeroAddress(operationalAdmin, "operational admin");
    const functionId = scope === "reflection-core"
      ? "reflection_core::reflection_token::set_operational_admin"
      : scope === "test-assets"
        ? "test_assets::test_faucet::set_operational_admin"
        : "test_amm::pool::set_operational_admin";
    return this.createDraft(
      "set_operational_admin",
      functionId,
      [operationalAdmin],
    );
  }

  public async submit(draft: TransactionDraft): Promise<SubmittedTransaction> {
    if (this.writer === undefined) {
      throw new StateChangingCallsDisabledError();
    }
    return this.writer.submit(draft);
  }

  private createDraft(
    kind: TransactionDraft["kind"],
    functionId: string,
    args: readonly TransactionDraft["arguments"][number][],
    expirationUnixSeconds = this.nowUnixSeconds() + 15n * 60n,
  ): TransactionDraft {
    return {
      kind,
      functionId,
      arguments: args,
      expirationUnixSeconds,
      warning: TESTNET_NO_VALUE_WARNING,
    };
  }
}
