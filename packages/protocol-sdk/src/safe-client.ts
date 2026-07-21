import {
  CEDRA_TESTNET_CHAIN_ID,
  type Address,
  type CedraReadAdapter,
  type CedraWriteAdapter,
  type FaucetStatus,
  type LpEpochTerminalDustSnapshot,
  type PoolSnapshot,
  type PortfolioSnapshot,
  type ProtocolClientOptions,
  type ProtocolSnapshot,
  type OperationalAdminScope,
  type SubmittedTransaction,
  type SwapDirection,
  type SwapQuote,
  type VerifiedSwapQuote,
  type TransactionDraft,
} from "./types.js";
import { assertCedraTransactionDraft } from "./cedra-draft-encoder.js";
import { detachedDeepFreeze } from "./immutable.js";

export const TESTNET_NO_VALUE_WARNING =
  "TESTNET ASSET — NO MONETARY VALUE — STATE AND ADDRESSES MAY CHANGE";

const BPS_DENOMINATOR = 10_000n;
const MAX_REFLECTION_FEE_BPS = 100n;
const MAX_U64 = (1n << 64n) - 1n;
const MAX_U128 = (1n << 128n) - 1n;
const MAX_U256 = (1n << 256n) - 1n;

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

export interface BootstrapLiquidityDraftInput {
  readonly rflAmount: bigint;
  readonly usdAmount: bigint;
  readonly minLpShares: bigint;
}

export class StateChangingCallsDisabledError extends Error {
  public constructor() {
    super(
      "State-changing calls are disabled. Inject an explicitly approved CedraWriteAdapter in the release application; this client never discovers a wallet or RPC writer by itself.",
    );
    this.name = "StateChangingCallsDisabledError";
  }
}

export class MultiAgentSubmissionRequiredError extends Error {
  public constructor() {
    super(
      "This draft requires ordered secondary signers. Use the build/simulate-only CedraReleaseClient and an independently reviewed signing ceremony; the generic writer cannot submit it.",
    );
    this.name = "MultiAgentSubmissionRequiredError";
  }
}

export class UnverifiedSwapQuoteError extends Error {
  public constructor(detail: string) {
    super(`Swap draft refused: ${detail}`);
    this.name = "UnverifiedSwapQuoteError";
  }
}

export class UnverifiedSwapDraftError extends Error {
  public constructor(detail: string) {
    super(`Swap submission refused: ${detail}`);
    this.name = "UnverifiedSwapDraftError";
  }
}

export function reflectionFee(grossAmount: bigint, feeBps = 100n): bigint {
  if (typeof grossAmount !== "bigint" || typeof feeBps !== "bigint") {
    throw new TypeError("gross amount and fee must be bigint base units");
  }
  if (grossAmount < 0n || grossAmount > MAX_U64 || feeBps < 0n || feeBps > MAX_REFLECTION_FEE_BPS) {
    throw new RangeError("gross amount must be non-negative and fee must be between 0 and 100 basis points");
  }
  return (grossAmount * feeBps) / BPS_DENOMINATOR;
}

function defaultNowUnixSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1_000));
}

function assertUnsigned(value: unknown, maximum: bigint, label: string): asserts value is bigint {
  if (typeof value !== "bigint") {
    throw new TypeError(`${label} must be a bigint base-unit value`);
  }
  if (value < 0n || value > maximum) {
    throw new RangeError(`${label} must fit the on-chain unsigned integer type`);
  }
}

function assertPositive(value: unknown, maximum: bigint, label: string): asserts value is bigint {
  if (typeof value !== "bigint") {
    throw new TypeError(`${label} must be a bigint base-unit value`);
  }
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

function assertNonZeroAddress(address: unknown, label: string): asserts address is Address {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(address) || /^0x0+$/.test(address)) {
    throw new TypeError(`${label} must be a non-zero Cedra account address`);
  }
}

function canonicalAddressKey(address: unknown): string {
  assertNonZeroAddress(address, "signer address");
  return address.slice(2).replace(/^0+/, "").toLowerCase();
}

function assertDistinctAddresses(addresses: readonly unknown[], label: string): void {
  if (new Set(addresses.map(canonicalAddressKey)).size !== addresses.length) {
    throw new TypeError(`${label} must use distinct Cedra accounts`);
  }
}

function assertFaucetAsset(asset: unknown): asserts asset is "tRFL" | "tUSD" {
  if (asset !== "tRFL" && asset !== "tUSD") {
    throw new TypeError("faucet asset must be tRFL or tUSD");
  }
}

function assertSwapDirection(direction: unknown): asserts direction is SwapDirection {
  if (direction !== "buy" && direction !== "sell") {
    throw new TypeError("swap direction must be buy or sell");
  }
}

/** Validate and independently reproduce every executable quote amount. */
function assertSwapQuote(quote: unknown, nowUnixSeconds: bigint): asserts quote is SwapQuote {
  if (typeof quote !== "object" || quote === null || Array.isArray(quote)) {
    throw new TypeError("swap quote must be an object");
  }
  const candidate = quote as Partial<SwapQuote>;
  assertSwapDirection(candidate.direction);
  assertPositive(candidate.grossAmount, MAX_U64, "quote gross amount");
  assertUnsigned(candidate.slippageBps, MAX_U64, "quote slippage");
  assertUnsigned(candidate.reflectionFee, MAX_U64, "quote reflection fee");
  assertUnsigned(candidate.ammFee, MAX_U64, "quote AMM fee");
  assertPositive(candidate.netReserveInput, MAX_U64, "quote net reserve input");
  assertPositive(candidate.grossPoolOutput, MAX_U64, "quote gross pool output");
  assertPositive(candidate.netUserReceipt, MAX_U64, "quote net user receipt");
  assertUnsigned(candidate.minimumNetUserReceipt, MAX_U64, "quote minimum receipt");
  assertUnsigned(candidate.priceImpactBps, MAX_U64, "quote price impact");
  assertUnsigned(candidate.deadlineUnixSeconds, MAX_U64, "quote deadline");
  assertFutureDeadline(candidate.deadlineUnixSeconds, nowUnixSeconds);
  if (candidate.slippageBps > BPS_DENOMINATOR) {
    throw new RangeError("quote slippage cannot exceed 10,000 basis points");
  }
  if (typeof candidate.context !== "object" || candidate.context === null || Array.isArray(candidate.context)) {
    throw new TypeError("swap quote requires finalized arithmetic provenance");
  }
  const context = candidate.context;
  if (context.chainId !== CEDRA_TESTNET_CHAIN_ID) {
    throw new TypeError("swap quote provenance must be Cedra Testnet chain 2");
  }
  assertPositive(context.ledgerVersion, MAX_U64, "quote ledger version");
  if (
    typeof context.deploymentId !== "string"
    || context.deploymentId.length === 0
    || context.deploymentId.length > 512
    || typeof context.packageVersion !== "string"
    || !/^testnet-v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(context.packageVersion)
  ) {
    throw new TypeError("swap quote provenance requires bounded deployment and package identities");
  }
  assertPositive(context.inputReserve, MAX_U64, "quote input reserve");
  assertPositive(context.outputReserve, MAX_U64, "quote output reserve");
  assertUnsigned(context.reflectionFeeBps, MAX_U64, "quote reflection fee rate");
  assertUnsigned(context.ammFeeBps, MAX_U64, "quote AMM fee rate");
  assertPositive(context.maximumGrossSwap, MAX_U64, "quote maximum gross swap");
  assertPositive(context.maximumReserveBps, MAX_U64, "quote maximum reserve share");
  if (
    context.reflectionFeeBps > MAX_REFLECTION_FEE_BPS
    || context.ammFeeBps > 100n
    || context.maximumReserveBps > BPS_DENOMINATOR
  ) {
    throw new RangeError("swap quote fee or reserve-limit provenance exceeds the contract policy");
  }
  if (
    candidate.grossAmount > context.maximumGrossSwap
    || candidate.grossAmount * BPS_DENOMINATOR > context.inputReserve * context.maximumReserveBps
  ) {
    throw new RangeError("swap quote exceeds the pinned gross or reserve-share limit");
  }

  const expectedSellReflection = (candidate.grossAmount * context.reflectionFeeBps) / BPS_DENOMINATOR;
  const expectedReserveInput = candidate.direction === "sell"
    ? candidate.grossAmount - expectedSellReflection
    : candidate.grossAmount;
  const invariantInput = (expectedReserveInput * (BPS_DENOMINATOR - context.ammFeeBps)) / BPS_DENOMINATOR;
  const expectedAmmFee = expectedReserveInput - invariantInput;
  const expectedGrossOutput = (context.outputReserve * invariantInput) / (context.inputReserve + invariantInput);
  const expectedReflectionFee = candidate.direction === "sell"
    ? expectedSellReflection
    : (expectedGrossOutput * context.reflectionFeeBps) / BPS_DENOMINATOR;
  const expectedReceipt = candidate.direction === "buy"
    ? expectedGrossOutput - expectedReflectionFee
    : expectedGrossOutput;
  const expectedMinimum = (expectedReceipt * (BPS_DENOMINATOR - candidate.slippageBps)) / BPS_DENOMINATOR;
  const expectedImpact = (invariantInput * BPS_DENOMINATOR) / (context.inputReserve + invariantInput);
  if (
    expectedReserveInput <= 0n
    || expectedReceipt <= 0n
    || candidate.netReserveInput !== expectedReserveInput
    || candidate.ammFee !== expectedAmmFee
    || candidate.grossPoolOutput !== expectedGrossOutput
    || candidate.reflectionFee !== expectedReflectionFee
    || candidate.netUserReceipt !== expectedReceipt
    || candidate.minimumNetUserReceipt !== expectedMinimum
    || candidate.priceImpactBps !== expectedImpact
  ) {
    throw new RangeError("swap quote disagrees with pinned fee, constant-product, slippage, or rounding arithmetic");
  }
}

function swapQuoteFingerprint(quote: SwapQuote): string {
  return JSON.stringify([
    quote.direction,
    quote.grossAmount.toString(),
    quote.slippageBps.toString(),
    quote.reflectionFee.toString(),
    quote.ammFee.toString(),
    quote.netReserveInput.toString(),
    quote.grossPoolOutput.toString(),
    quote.netUserReceipt.toString(),
    quote.minimumNetUserReceipt.toString(),
    quote.priceImpactBps.toString(),
    quote.deadlineUnixSeconds.toString(),
    quote.context.chainId,
    quote.context.ledgerVersion.toString(),
    quote.context.deploymentId,
    quote.context.packageVersion,
    quote.context.inputReserve.toString(),
    quote.context.outputReserve.toString(),
    quote.context.reflectionFeeBps.toString(),
    quote.context.ammFeeBps.toString(),
    quote.context.maximumGrossSwap.toString(),
    quote.context.maximumReserveBps.toString(),
  ]);
}

function detachedFrozenSwapQuote(quote: SwapQuote): VerifiedSwapQuote {
  return detachedDeepFreeze(quote) as VerifiedSwapQuote;
}

function transactionDraftFingerprint(draft: TransactionDraft): string {
  return JSON.stringify([
    draft.kind,
    draft.functionId,
    draft.arguments.map((argument) => typeof argument === "bigint" ? argument.toString() : argument),
    draft.secondarySignerAddresses,
    draft.expirationUnixSeconds.toString(),
    draft.warning,
  ]);
}

function detachedFrozenDraft(draft: TransactionDraft): TransactionDraft {
  return Object.freeze({
    ...draft,
    arguments: Object.freeze([...draft.arguments]),
    secondarySignerAddresses: Object.freeze([...draft.secondarySignerAddresses]),
  });
}

/**
 * Read operations require an injected adapter. Transaction drafts are safe,
 * pure descriptions. Submission is impossible until a caller deliberately
 * supplies a writer, so imports and dashboard rendering cannot move assets.
 */
export class ReflectionPilotClient {
  private readonly writer: CedraWriteAdapter | undefined;
  private readonly nowUnixSeconds: () => bigint;
  private readonly verifiedSwapQuotes = new WeakMap<VerifiedSwapQuote, string>();
  private readonly verifiedSwapDrafts = new WeakMap<TransactionDraft, string>();

  public constructor(
    private readonly reader: CedraReadAdapter,
    options: ProtocolClientOptions = {},
  ) {
    this.writer = options.writer;
    this.nowUnixSeconds = options.nowUnixSeconds ?? defaultNowUnixSeconds;
  }

  public async getPortfolio(account: Address): Promise<PortfolioSnapshot> {
    assertNonZeroAddress(account, "portfolio account");
    return detachedDeepFreeze(await this.reader.getPortfolio(account));
  }

  public async getProtocol(): Promise<ProtocolSnapshot> {
    return detachedDeepFreeze(await this.reader.getProtocol());
  }

  public async getPool(): Promise<PoolSnapshot> {
    return detachedDeepFreeze(await this.reader.getPool());
  }

  public async getLpEpochTerminalDust(epoch: bigint): Promise<LpEpochTerminalDustSnapshot> {
    assertPositive(epoch, MAX_U64, "LP epoch");
    const observed = structuredClone(await this.reader.getLpEpochTerminalDust(epoch));
    if (typeof observed !== "object" || observed === null || observed.epoch !== epoch) {
      throw new TypeError("LP terminal-dust adapter returned a result for a different epoch");
    }
    assertUnsigned(observed.terminalRoundingBaseUnits, MAX_U128, "terminal LP rounding base units");
    assertUnsigned(observed.retiredResidueMagnified, MAX_U256, "retired LP residue magnified units");
    assertPositive(observed.ledgerVersion, MAX_U64, "LP terminal-dust ledger version");
    return detachedDeepFreeze(observed);
  }

  public async getFaucetStatus(account: Address, asset: "tRFL" | "tUSD"): Promise<FaucetStatus> {
    assertNonZeroAddress(account, "faucet account");
    assertFaucetAsset(asset);
    return detachedDeepFreeze(await this.reader.getFaucetStatus(account, asset));
  }

  public async quoteSwap(input: {
    readonly direction: SwapDirection;
    readonly grossAmount: bigint;
    readonly slippageBps: bigint;
    readonly deadlineUnixSeconds: bigint;
  }): Promise<VerifiedSwapQuote> {
    input = Object.freeze(structuredClone(input));
    assertSwapDirection(input.direction);
    assertPositive(input.grossAmount, MAX_U64, "swap amount");
    assertUnsigned(input.slippageBps, MAX_U64, "slippage");
    if (input.slippageBps < 0n || input.slippageBps > BPS_DENOMINATOR) {
      throw new RangeError("slippage must be between 0 and 10,000 basis points");
    }
    assertFutureDeadline(input.deadlineUnixSeconds, this.currentTime());
    const quote = structuredClone(await this.reader.quoteSwap(input));
    assertSwapQuote(quote, this.currentTime());
    if (
      quote.direction !== input.direction
      || quote.grossAmount !== input.grossAmount
      || quote.slippageBps !== input.slippageBps
      || quote.deadlineUnixSeconds !== input.deadlineUnixSeconds
    ) {
      throw new TypeError("read adapter returned a quote for different declared inputs");
    }
    const verified = detachedFrozenSwapQuote(quote);
    this.verifiedSwapQuotes.set(verified, swapQuoteFingerprint(verified));
    return verified;
  }

  public createFaucetClaimDraft(asset: "tRFL" | "tUSD"): TransactionDraft {
    assertFaucetAsset(asset);
    return this.createDraft(
      "faucet_claim",
      asset === "tRFL"
        ? "test_assets::test_faucet::claim_trfl"
        : "test_assets::test_faucet::claim_tusd",
      [],
    );
  }

  public createRewardClaimDraft(amount: bigint): TransactionDraft {
    assertPositive(amount, MAX_U64, "claim amount");
    return this.createDraft("claim_rewards", "reflection_core::reflection_token::claim", [amount]);
  }

  public createRewardClaimAllDraft(): TransactionDraft {
    return this.createDraft("claim_rewards", "reflection_core::reflection_token::claim_all", []);
  }

  public createSwapDraft(input: {
    readonly quote: VerifiedSwapQuote;
  }): TransactionDraft {
    const { quote } = input;
    const expectedFingerprint = this.verifiedSwapQuotes.get(quote);
    if (expectedFingerprint === undefined) {
      throw new UnverifiedSwapQuoteError("quote was not issued by this client from a finalized read");
    }
    assertSwapQuote(quote, this.currentTime());
    if (swapQuoteFingerprint(quote) !== expectedFingerprint) {
      throw new UnverifiedSwapQuoteError("issued quote was mutated after verification");
    }
    const draft = detachedFrozenDraft(this.createDraft(
      "swap",
      quote.direction === "buy" ? "test_amm::pool::buy_trfl" : "test_amm::pool::sell_trfl",
      [quote.grossAmount, quote.minimumNetUserReceipt, quote.deadlineUnixSeconds],
      quote.deadlineUnixSeconds,
    ));
    this.verifiedSwapDrafts.set(draft, transactionDraftFingerprint(draft));
    return draft;
  }

  /** Fetch, verify, freeze, and bind one quote directly into its draft. */
  public async quoteAndCreateSwapDraft(input: {
    readonly direction: SwapDirection;
    readonly grossAmount: bigint;
    readonly slippageBps: bigint;
    readonly deadlineUnixSeconds: bigint;
  }): Promise<Readonly<{ quote: VerifiedSwapQuote; draft: TransactionDraft }>> {
    const quote = await this.quoteSwap(input);
    return Object.freeze({ quote, draft: this.createSwapDraft({ quote }) });
  }

  /** Build the signer-authenticated `pool::add_liquidity` call. */
  public createAddLiquidityDraft(input: AddLiquidityDraftInput): TransactionDraft {
    assertPositive(input.maxRfl, MAX_U64, "maximum tRFL contribution");
    assertPositive(input.maxUsd, MAX_U64, "maximum tUSD contribution");
    assertUnsigned(input.minLpShares, MAX_U128, "minimum LP shares");
    assertFutureDeadline(input.deadlineUnixSeconds, this.currentTime());
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
    assertFutureDeadline(input.deadlineUnixSeconds, this.currentTime());
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
    if (typeof paused !== "boolean") throw new TypeError("faucet pause state must be a boolean");
    return this.createDraft(
      "set_faucet_paused",
      "test_assets::test_faucet::set_paused",
      [paused],
    );
  }

  /**
   * Publisher-primary, operations-secondary handoff. The operations address is
   * authenticated by Cedra's multi-agent envelope and is therefore omitted
   * from the Move payload arguments for all three package scopes.
   */
  public createOperationalAdminHandoffDraft(
    scope: OperationalAdminScope,
    operationalAdmin: Address,
  ): TransactionDraft {
    if (scope !== "reflection-core" && scope !== "test-assets" && scope !== "test-amm") {
      throw new TypeError("operational admin scope must be reflection-core, test-assets, or test-amm");
    }
    assertNonZeroAddress(operationalAdmin, "operational admin");
    const functionId = scope === "reflection-core"
      ? "reflection_core::reflection_token::set_operational_admin"
      : scope === "test-assets"
        ? "test_assets::test_faucet::set_operational_admin"
        : "test_amm::pool::set_operational_admin";
    return this.createDraft(
      "set_operational_admin",
      functionId,
      [],
      undefined,
      [operationalAdmin],
    );
  }

  /**
   * Preferred atomic authority handoff. Core is the primary signer; asset and
   * AMM publishers plus the proposed operations account are ordered Cedra
   * secondary signers. Individual package setters are recovery-only.
   */
  public createAllOperationalAdminHandoffDraft(
    assetsPublisher: Address,
    ammPublisher: Address,
    operationalAdmin: Address,
  ): TransactionDraft {
    assertDistinctAddresses(
      [assetsPublisher, ammPublisher, operationalAdmin],
      "Atomic operational handoff signers",
    );
    return this.createDraft(
      "set_all_operational_admin",
      "test_amm::pool::set_all_operational_admin",
      [],
      undefined,
      [assetsPublisher, ammPublisher, operationalAdmin],
    );
  }

  /** First canonical reserve bootstrap; beneficiary consent is authenticated. */
  public createSeedLiquidityDraft(
    ammPublisher: Address,
    beneficiary: Address,
    input: BootstrapLiquidityDraftInput,
  ): TransactionDraft {
    return this.createBootstrapLiquidityDraft("seed_liquidity", ammPublisher, beneficiary, input);
  }

  /** Fresh epoch bootstrap after final exit; beneficiary consent is authenticated. */
  public createReseedLiquidityDraft(
    ammPublisher: Address,
    beneficiary: Address,
    input: BootstrapLiquidityDraftInput,
  ): TransactionDraft {
    return this.createBootstrapLiquidityDraft("reseed_liquidity", ammPublisher, beneficiary, input);
  }

  public async submit(draft: TransactionDraft): Promise<SubmittedTransaction> {
    assertCedraTransactionDraft(draft);
    if (draft.kind === "swap") {
      const fingerprint = this.verifiedSwapDrafts.get(draft);
      if (fingerprint === undefined || fingerprint !== transactionDraftFingerprint(draft)) {
        throw new UnverifiedSwapDraftError("draft was not issued intact from this client's verified quote path");
      }
      if (draft.expirationUnixSeconds <= this.currentTime()) {
        throw new RangeError("swap draft has expired");
      }
    }
    if (draft.kind === "set_operational_admin" || draft.secondarySignerAddresses.length > 0) {
      throw new MultiAgentSubmissionRequiredError();
    }
    if (this.writer === undefined) {
      throw new StateChangingCallsDisabledError();
    }
    return this.writer.submit(draft);
  }

  private createDraft(
    kind: TransactionDraft["kind"],
    functionId: string,
    args: readonly TransactionDraft["arguments"][number][],
    expirationUnixSeconds?: bigint,
    secondarySignerAddresses: readonly Address[] = [],
  ): TransactionDraft {
    const expiration = expirationUnixSeconds ?? this.defaultExpiration();
    assertUnsigned(expiration, MAX_U64, "transaction expiration");
    if (expiration <= 0n) throw new RangeError("transaction expiration must be positive");
    const draft: TransactionDraft = {
      kind,
      functionId,
      arguments: args,
      secondarySignerAddresses,
      expirationUnixSeconds: expiration,
      warning: TESTNET_NO_VALUE_WARNING,
    };
    assertCedraTransactionDraft(draft);
    return draft;
  }

  private createBootstrapLiquidityDraft(
    kind: "seed_liquidity" | "reseed_liquidity",
    ammPublisher: Address,
    beneficiary: Address,
    input: BootstrapLiquidityDraftInput,
  ): TransactionDraft {
    assertDistinctAddresses([ammPublisher, beneficiary], "Bootstrap liquidity signers");
    assertPositive(input.rflAmount, MAX_U64, "bootstrap tRFL amount");
    assertPositive(input.usdAmount, MAX_U64, "bootstrap tUSD amount");
    assertUnsigned(input.minLpShares, MAX_U128, "minimum bootstrap LP shares");
    return this.createDraft(
      kind,
      `test_amm::pool::${kind}`,
      [input.rflAmount, input.usdAmount, input.minLpShares],
      undefined,
      [ammPublisher, beneficiary],
    );
  }

  private currentTime(): bigint {
    const now = this.nowUnixSeconds();
    assertUnsigned(now, MAX_U64, "current Unix time");
    return now;
  }

  private defaultExpiration(): bigint {
    const now = this.currentTime();
    const lifetime = 15n * 60n;
    if (now > MAX_U64 - lifetime) {
      throw new RangeError("default transaction expiration exceeds the Move u64 timestamp domain");
    }
    return now + lifetime;
  }
}
