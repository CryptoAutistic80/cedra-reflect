import type {
  InputViewFunctionJsonData,
  LedgerInfo,
  LedgerVersionArg,
} from "@cedra-labs/ts-sdk";
import type { ProtocolModuleAddresses } from "./cedra-draft-encoder.js";
import type {
  Address,
  CedraReadAdapter,
  CedraTestnetChainId,
  FaucetStatus,
  LpEpochTerminalDustSnapshot,
  PoolSnapshot,
  PortfolioSnapshot,
  ProtocolAddresses,
  ProtocolSnapshot,
  ProtocolLifecycle,
  SwapQuote,
} from "./types.js";
import { CEDRA_TESTNET_CHAIN_ID } from "./types.js";
import { detachedDeepFreeze } from "./immutable.js";

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const U256_MAX = (1n << 256n) - 1n;
const BPS_DENOMINATOR = 10_000n;
const LEDGER_TIMESTAMP_MICROSECONDS = 1_000_000n;

type LedgerHeader = Pick<LedgerInfo, "chain_id" | "ledger_version" | "ledger_timestamp">;

/**
 * The only official-SDK capabilities used by this adapter. Supplying a client
 * is explicit: this module never discovers a network, endpoint, wallet, or key.
 */
export interface FinalizedCedraViewClient {
  getLedgerInfo(): Promise<LedgerHeader>;
  viewJson(args: {
    readonly payload: InputViewFunctionJsonData;
    readonly options: LedgerVersionArg;
  }): Promise<unknown[]>;
}

/** Immutable release identity and object bindings copied from the approved manifest. */
export interface FinalizedProtocolManifest {
  readonly networkLabel: "cedra-testnet";
  readonly chainId: CedraTestnetChainId;
  readonly deploymentId: string;
  readonly packageVersion: string;
  readonly finalizedLedgerVersion: bigint;
  readonly packages: ProtocolModuleAddresses;
  readonly addresses: ProtocolAddresses & {
    /** Canonical tRFL custody store recorded in the approved release manifest. */
    readonly poolRflReserveStore: Address;
    /** Canonical tUSD quote reserve recorded in the approved release manifest. */
    readonly poolUsdReserveStore: Address;
  };
}

export class ManifestIdentityMismatchError extends Error {
  public constructor(field: string, expected: string, observed: string) {
    super(`Finalized deployment identity mismatch for ${field}: expected ${expected}, observed ${observed}`);
    this.name = "ManifestIdentityMismatchError";
  }
}

export class MalformedMoveViewError extends Error {
  public constructor(functionId: string, detail: string) {
    super(`Malformed Move view ${functionId}: ${detail}`);
    this.name = "MalformedMoveViewError";
  }
}

interface PinnedLedger {
  readonly chainId: CedraTestnetChainId;
  readonly version: bigint;
  readonly timestampUnixSeconds: bigint;
}

interface ValidatedIdentity extends PinnedLedger {
  readonly packageVersion: string;
}

function canonicalAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new TypeError(`${field} must be a 0x-prefixed hexadecimal address`);
  }
  const digits = value.slice(2).replace(/^0+/, "").toLowerCase() || "0";
  if (digits.length > 64) {
    throw new RangeError(`${field} exceeds a 32-byte address`);
  }
  return `0x${digits}`;
}

function nonzeroAddress(value: Address, field: string): Address {
  const canonical = canonicalAddress(value, field);
  if (canonical === "0x0") {
    throw new TypeError(`${field} must not be the zero address`);
  }
  return canonical;
}

function objectAddress(value: unknown, functionId: string): Address {
  if (typeof value === "string") {
    return canonicalAddress(value, functionId);
  }
  if (typeof value === "object" && value !== null && "inner" in value) {
    return canonicalAddress((value as { readonly inner: unknown }).inner, functionId);
  }
  throw new MalformedMoveViewError(functionId, "expected an object address");
}

function unsigned(value: unknown, bits: 8 | 64 | 128 | 256, functionId: string): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    parsed = BigInt(value);
  } else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    parsed = BigInt(value);
  } else {
    throw new MalformedMoveViewError(functionId, `expected a decimal u${bits}`);
  }
  const maximum = bits === 8 ? 255n : bits === 64 ? U64_MAX : bits === 128 ? U128_MAX : U256_MAX;
  if (parsed < 0n || parsed > maximum) {
    throw new MalformedMoveViewError(functionId, `value is outside u${bits}`);
  }
  return parsed;
}

function boolean(value: unknown, functionId: string): boolean {
  if (typeof value !== "boolean") {
    throw new MalformedMoveViewError(functionId, "expected a boolean");
  }
  return value;
}

function lifecycle(value: unknown, functionId: string): ProtocolLifecycle {
  const code = unsigned(value, 8, functionId);
  if (code === 0n) return "CONFIGURING";
  if (code === 1n) return "LIVE";
  if (code === 2n) return "CLOSED";
  throw new MalformedMoveViewError(functionId, "expected lifecycle code 0, 1, or 2");
}

function utf8Vector(value: unknown, functionId: string): string {
  let bytes: Uint8Array;
  if (typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    const hex = value.slice(2);
    bytes = Uint8Array.from({ length: hex.length / 2 }, (_, index) => (
      Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
    ));
  } else if (Array.isArray(value) && value.every((item) => (
    typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255
  ))) {
    bytes = Uint8Array.from(value as number[]);
  } else {
    throw new MalformedMoveViewError(functionId, "expected vector<u8> as hex or byte array");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MalformedMoveViewError(functionId, "vector<u8> is not valid UTF-8");
  }
}

function assertManifest(manifest: FinalizedProtocolManifest): void {
  if (manifest.networkLabel !== "cedra-testnet") {
    throw new TypeError("finalized manifest networkLabel must be cedra-testnet");
  }
  if (manifest.chainId !== CEDRA_TESTNET_CHAIN_ID) {
    throw new TypeError("finalized manifest chainId must be Cedra Testnet chain 2");
  }
  if (manifest.deploymentId.length === 0) {
    throw new TypeError("manifest deploymentId must not be empty");
  }
  if (!/^testnet-v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(manifest.packageVersion)) {
    throw new TypeError("manifest packageVersion must be testnet-vMAJOR.MINOR.PATCH");
  }
  if (unsigned(manifest.finalizedLedgerVersion, 64, "manifest.finalizedLedgerVersion") === 0n) {
    throw new TypeError("manifest finalizedLedgerVersion must be greater than zero");
  }
  const core = nonzeroAddress(manifest.packages.reflectionCore, "manifest.packages.reflectionCore");
  const assets = nonzeroAddress(manifest.packages.testAssets, "manifest.packages.testAssets");
  const amm = nonzeroAddress(manifest.packages.testAmm, "manifest.packages.testAmm");
  if (new Set([core, assets, amm]).size !== 3) {
    throw new TypeError("manifest package publishers must be distinct");
  }
  nonzeroAddress(manifest.addresses.tokenMetadata, "manifest.addresses.tokenMetadata");
  nonzeroAddress(manifest.addresses.mockUsdMetadata, "manifest.addresses.mockUsdMetadata");
  nonzeroAddress(manifest.addresses.rewardVault, "manifest.addresses.rewardVault");
  nonzeroAddress(manifest.addresses.distributionVault, "manifest.addresses.distributionVault");
  const pool = nonzeroAddress(manifest.addresses.pool, "manifest.addresses.pool");
  const rflReserve = nonzeroAddress(
    manifest.addresses.poolRflReserveStore,
    "manifest.addresses.poolRflReserveStore",
  );
  const usdReserve = nonzeroAddress(
    manifest.addresses.poolUsdReserveStore,
    "manifest.addresses.poolUsdReserveStore",
  );
  if (rflReserve === usdReserve) {
    throw new TypeError("manifest pool reserve stores must be distinct");
  }
  if (pool !== amm) {
    throw new TypeError("manifest pool address must equal the immutable test-AMM publisher address");
  }
}

function expectSameAddress(field: string, expected: Address, observed: Address): void {
  const canonicalExpected = canonicalAddress(expected, field);
  if (canonicalExpected !== observed) {
    throw new ManifestIdentityMismatchError(field, canonicalExpected, observed);
  }
}

function copyManifest(manifest: FinalizedProtocolManifest): FinalizedProtocolManifest {
  return Object.freeze({
    networkLabel: manifest.networkLabel,
    chainId: manifest.chainId,
    deploymentId: manifest.deploymentId,
    packageVersion: manifest.packageVersion,
    finalizedLedgerVersion: manifest.finalizedLedgerVersion,
    packages: Object.freeze({
      reflectionCore: nonzeroAddress(manifest.packages.reflectionCore, "manifest.packages.reflectionCore"),
      testAssets: nonzeroAddress(manifest.packages.testAssets, "manifest.packages.testAssets"),
      testAmm: nonzeroAddress(manifest.packages.testAmm, "manifest.packages.testAmm"),
    }),
    addresses: Object.freeze({
      tokenMetadata: nonzeroAddress(manifest.addresses.tokenMetadata, "manifest.addresses.tokenMetadata"),
      mockUsdMetadata: nonzeroAddress(manifest.addresses.mockUsdMetadata, "manifest.addresses.mockUsdMetadata"),
      rewardVault: nonzeroAddress(manifest.addresses.rewardVault, "manifest.addresses.rewardVault"),
      distributionVault: nonzeroAddress(manifest.addresses.distributionVault, "manifest.addresses.distributionVault"),
      pool: nonzeroAddress(manifest.addresses.pool, "manifest.addresses.pool"),
      poolRflReserveStore: nonzeroAddress(
        manifest.addresses.poolRflReserveStore,
        "manifest.addresses.poolRflReserveStore",
      ),
      poolUsdReserveStore: nonzeroAddress(
        manifest.addresses.poolUsdReserveStore,
        "manifest.addresses.poolUsdReserveStore",
      ),
    }),
  });
}

/**
 * Read-only production adapter for the immutable Testnet package set.
 * Every public operation selects one committed ledger header and pins all of
 * its Move views to that exact version before returning a snapshot.
 */
export class FinalizedCedraReadAdapter implements CedraReadAdapter {
  private readonly client: FinalizedCedraViewClient;
  private readonly manifest: FinalizedProtocolManifest;

  public constructor(
    client: FinalizedCedraViewClient,
    manifest: FinalizedProtocolManifest,
  ) {
    assertManifest(manifest);
    this.client = client;
    this.manifest = copyManifest(manifest);
  }

  public async getPortfolio(account: Address): Promise<PortfolioSnapshot> {
    const canonicalAccount = nonzeroAddress(account, "account");
    const identity = await this.pinAndValidateIdentity();
    const core = this.manifest.packages.reflectionCore;
    const [global, raw, pending, effective, registered, position] = await Promise.all([
      this.tuple(identity.version, core, "reflection_token", "global_accounting", [], 6),
      this.scalar(identity.version, core, "reflection_token", "raw_balance", [canonicalAccount]),
      this.scalar(identity.version, core, "reflection_token", "pending_rewards", [canonicalAccount]),
      this.scalar(identity.version, core, "reflection_token", "effective_balance", [canonicalAccount]),
      this.scalar(identity.version, core, "reflection_token", "wallet_is_registered", [canonicalAccount]),
      this.tuple(identity.version, core, "reflection_token", "wallet_position_accounting", [canonicalAccount], 3),
    ]);
    const rawTrfl = unsigned(raw, 64, `${core}::reflection_token::raw_balance`);
    const isRegistered = boolean(registered, `${core}::reflection_token::wallet_is_registered`);
    boolean(position[0], `${core}::reflection_token::wallet_position_accounting`);
    unsigned(position[1], 256, `${core}::reflection_token::wallet_position_accounting`);
    return detachedDeepFreeze({
      account: canonicalAccount,
      effectiveTrfl: unsigned(effective, 64, `${core}::reflection_token::effective_balance`),
      rawTrfl,
      pendingReflections: unsigned(pending, 64, `${core}::reflection_token::pending_rewards`),
      lifetimeClaimed: unsigned(position[2], 256, `${core}::reflection_token::wallet_position_accounting`),
      eligibleSupply: unsigned(global[2], 128, `${core}::reflection_token::global_accounting`),
      holderShares: isRegistered ? rawTrfl : 0n,
      ledgerVersion: identity.version,
    });
  }

  public async getProtocol(): Promise<ProtocolSnapshot> {
    const identity = await this.pinAndValidateIdentity();
    const core = this.manifest.packages.reflectionCore;
    const [automatic, lifecycleRaw, feeBpsRaw, holders, global, vaultBalance, liability, pool] = await Promise.all([
      this.scalar(identity.version, core, "reflection_token", "automatic_materialization_enabled", []),
      this.scalar(identity.version, core, "reflection_token", "launch_state", []),
      this.scalar(identity.version, core, "reflection_token", "reflection_fee_bps", []),
      this.scalar(identity.version, core, "reflection_token", "registered_wallet_count", []),
      this.tuple(identity.version, core, "reflection_token", "global_accounting", [], 6),
      this.scalar(identity.version, core, "reflection_token", "reward_vault_balance", []),
      this.scalar(identity.version, core, "reflection_token", "aggregate_indexed_liability", []),
      this.readPoolAt(identity.version),
    ]);
    const protocolLifecycle = lifecycle(lifecycleRaw, `${core}::reflection_token::launch_state`);
    const reflectionFeeBps = unsigned(feeBpsRaw, 64, `${core}::reflection_token::reflection_fee_bps`);
    if (reflectionFeeBps > 500n) {
      throw new MalformedMoveViewError(`${core}::reflection_token::reflection_fee_bps`, "fee exceeds the immutable v0.2 creation bound");
    }
    if (pool.lifecycle !== protocolLifecycle) {
      throw new MalformedMoveViewError(`${core}::reflection_token::launch_state`, "core and pool lifecycles disagree");
    }
    return detachedDeepFreeze({
      lifecycle: protocolLifecycle,
      reflectionFeeBps,
      automaticMaterialization: boolean(automatic, `${core}::reflection_token::automatic_materialization_enabled`),
      eligibleHolders: unsigned(holders, 64, `${core}::reflection_token::registered_wallet_count`),
      eligibleSupply: unsigned(global[2], 128, `${core}::reflection_token::global_accounting`),
      rewardVaultBalance: unsigned(vaultBalance, 64, `${core}::reflection_token::reward_vault_balance`),
      reflectionLiability: unsigned(liability, 256, `${core}::reflection_token::aggregate_indexed_liability`),
      lifetimeSwapFees: unsigned(global[4], 256, `${core}::reflection_token::global_accounting`),
      lifetimeMaterialized: unsigned(global[5], 256, `${core}::reflection_token::global_accounting`),
      currentIndex: unsigned(global[0], 256, `${core}::reflection_token::global_accounting`),
      indexRemainder: unsigned(global[1], 256, `${core}::reflection_token::global_accounting`),
      pool,
      claimsPaused: false,
      faucetPaused: false,
      packageVersion: identity.packageVersion,
      ledgerVersion: identity.version,
    });
  }

  public async getPool(): Promise<PoolSnapshot> {
    const identity = await this.pinAndValidateIdentity();
    return detachedDeepFreeze(await this.readPoolAt(identity.version));
  }

  public async getLpEpochTerminalDust(epoch: bigint): Promise<LpEpochTerminalDustSnapshot> {
    if (typeof epoch !== "bigint") throw new TypeError("LP epoch must be a bigint");
    if (epoch <= 0n || epoch > U64_MAX) throw new RangeError("LP epoch must be positive and fit Move u64");
    const epochId = epoch;
    const identity = await this.pinAndValidateIdentity();
    const amm = this.manifest.packages.testAmm;
    const functionId = `${amm}::pool::lp_epoch_terminal_dust`;
    const dust = await this.tuple(
      identity.version,
      amm,
      "pool",
      "lp_epoch_terminal_dust",
      [epochId.toString()],
      2,
    );
    return detachedDeepFreeze({
      epoch: epochId,
      terminalRoundingBaseUnits: unsigned(dust[0], 128, functionId),
      retiredResidueMagnified: unsigned(dust[1], 256, functionId),
      ledgerVersion: identity.version,
    });
  }

  public async getFaucetStatus(account: Address, asset: "tRFL" | "tUSD"): Promise<FaucetStatus> {
    if (asset !== "tRFL" && asset !== "tUSD") {
      throw new TypeError("asset must be tRFL or tUSD");
    }
    const canonicalAccount = nonzeroAddress(account, "account");
    const identity = await this.pinAndValidateIdentity();
    const assets = this.manifest.packages.testAssets;
    const core = this.manifest.packages.reflectionCore;
    const [configuration, lastClaim, distributionBalance] = await Promise.all([
      this.tuple(identity.version, assets, "test_faucet", "configuration", [], 3),
      this.tuple(identity.version, assets, "test_faucet", "last_claim", [canonicalAccount, asset === "tRFL"], 2),
      asset === "tRFL"
        ? this.scalar(identity.version, core, "reflection_token", "distribution_vault_balance", [])
        : Promise.resolve(U64_MAX),
    ]);
    const grantAmount = unsigned(configuration[asset === "tRFL" ? 0 : 1], 64, `${assets}::test_faucet::configuration`);
    const cooldown = unsigned(configuration[2], 64, `${assets}::test_faucet::configuration`);
    const hasClaimed = boolean(lastClaim[0], `${assets}::test_faucet::last_claim`);
    const previousClaim = unsigned(lastClaim[1], 64, `${assets}::test_faucet::last_claim`);
    const cooldownEndsAtUnixSeconds = hasClaimed ? previousClaim + cooldown : 0n;
    if (cooldownEndsAtUnixSeconds > U64_MAX) {
      throw new MalformedMoveViewError(
        `${assets}::test_faucet::configuration`,
        "previous claim plus cooldown exceeds the u64 timestamp domain",
      );
    }
    const hasInventory = unsigned(distributionBalance, 64, `${core}::reflection_token::distribution_vault_balance`) >= grantAmount;
    return detachedDeepFreeze({
      asset,
      account: canonicalAccount,
      grantAmount,
      cooldownEndsAtUnixSeconds,
      canClaim: (asset === "tUSD" || hasInventory)
        && (!hasClaimed || (
          identity.timestampUnixSeconds >= previousClaim
          && identity.timestampUnixSeconds >= cooldownEndsAtUnixSeconds
        )),
    });
  }

  public async quoteSwap(input: {
    readonly direction: "buy" | "sell";
    readonly grossAmount: bigint;
    readonly slippageBps: bigint;
    readonly deadlineUnixSeconds: bigint;
  }): Promise<SwapQuote> {
    input = Object.freeze(structuredClone(input));
    if (input.direction !== "buy" && input.direction !== "sell") {
      throw new TypeError("quote direction must be buy or sell");
    }
    if (input.grossAmount === 0n) {
      throw new RangeError("grossAmount must be greater than zero");
    }
    unsigned(input.grossAmount, 64, "quote.grossAmount");
    unsigned(input.slippageBps, 64, "quote.slippageBps");
    unsigned(input.deadlineUnixSeconds, 64, "quote.deadlineUnixSeconds");
    if (input.slippageBps > BPS_DENOMINATOR) {
      throw new RangeError("slippageBps must not exceed 10,000");
    }
    const identity = await this.pinAndValidateIdentity();
    if (input.deadlineUnixSeconds <= identity.timestampUnixSeconds) {
      throw new RangeError("quote deadline must be later than the pinned ledger timestamp");
    }
    const amm = this.manifest.packages.testAmm;
    const core = this.manifest.packages.reflectionCore;
    const [quote, reserves, limits, feeBpsRaw] = await Promise.all([
      this.tuple(
        identity.version,
        amm,
        "pool",
        input.direction === "sell" ? "quote_sell" : "quote_buy",
        [input.grossAmount.toString()],
        3,
      ),
      this.tuple(identity.version, amm, "pool", "reserves_view", [], 2),
      this.tuple(identity.version, amm, "pool", "limits", [], 3),
      this.scalar(identity.version, core, "reflection_token", "reflection_fee_bps", []),
    ]);
    const functionId = `${amm}::pool::${input.direction === "sell" ? "quote_sell" : "quote_buy"}`;
    const firstOutput = unsigned(quote[0], 64, functionId);
    const reflectionFee = unsigned(quote[1], 64, functionId);
    const ammFee = unsigned(quote[2], 64, functionId);
    const reflectionFeeBps = unsigned(
      feeBpsRaw,
      64,
      `${core}::reflection_token::reflection_fee_bps`,
    );
    const ammFeeBps = unsigned(limits[0], 64, `${amm}::pool::limits`);
    const maximumReserveBps = unsigned(limits[1], 64, `${amm}::pool::limits`);
    const maximumGrossSwap = unsigned(limits[2], 64, `${amm}::pool::limits`);
    if (
      reflectionFeeBps > 500n
      || ammFeeBps > 100n
      || maximumReserveBps === 0n
      || maximumReserveBps > BPS_DENOMINATOR
      || maximumGrossSwap === 0n
    ) {
      throw new MalformedMoveViewError(`${amm}::pool::limits`, "fee or swap limit is outside the immutable contract policy");
    }
    const netReserveInput = input.direction === "sell"
      ? input.grossAmount - reflectionFee
      : input.grossAmount;
    if (netReserveInput < 0n || ammFee > netReserveInput) {
      throw new MalformedMoveViewError(functionId, "fee tuple exceeds its associated input");
    }
    const grossPoolOutput = input.direction === "buy" ? firstOutput + reflectionFee : firstOutput;
    if (grossPoolOutput > U64_MAX) {
      throw new MalformedMoveViewError(functionId, "gross pool output exceeds u64");
    }
    const netUserReceipt = firstOutput;
    const invariantInput = netReserveInput - ammFee;
    const inputReserve = unsigned(
      reserves[input.direction === "sell" ? 0 : 1],
      64,
      `${amm}::pool::reserves_view`,
    );
    const outputReserve = unsigned(
      reserves[input.direction === "sell" ? 1 : 0],
      64,
      `${amm}::pool::reserves_view`,
    );
    if (inputReserve === 0n || outputReserve === 0n || firstOutput === 0n) {
      throw new MalformedMoveViewError(functionId, "quote requires non-zero reserves and output");
    }
    if (
      input.grossAmount > maximumGrossSwap
      || input.grossAmount * BPS_DENOMINATOR > inputReserve * maximumReserveBps
    ) {
      throw new MalformedMoveViewError(functionId, "quote input exceeds the finalized on-chain swap limits");
    }
    const expectedAmmFee = netReserveInput
      - (netReserveInput * (BPS_DENOMINATOR - ammFeeBps)) / BPS_DENOMINATOR;
    const expectedGrossPoolOutput = (outputReserve * invariantInput) / (inputReserve + invariantInput);
    const expectedReflectionFee = input.direction === "sell"
      ? (input.grossAmount * reflectionFeeBps) / BPS_DENOMINATOR
      : (expectedGrossPoolOutput * reflectionFeeBps) / BPS_DENOMINATOR;
    if (
      ammFee !== expectedAmmFee
      || reflectionFee !== expectedReflectionFee
      || grossPoolOutput !== expectedGrossPoolOutput
    ) {
      throw new MalformedMoveViewError(functionId, "quote tuple disagrees with finalized fee and constant-product arithmetic");
    }
    return detachedDeepFreeze({
      direction: input.direction,
      grossAmount: input.grossAmount,
      slippageBps: input.slippageBps,
      reflectionFee,
      ammFee,
      netReserveInput,
      grossPoolOutput,
      netUserReceipt,
      minimumNetUserReceipt: (netUserReceipt * (BPS_DENOMINATOR - input.slippageBps)) / BPS_DENOMINATOR,
      // Constant-product execution-price impact relative to the pre-swap spot
      // price. This is bounded below 10,000 bps for every valid quote.
      priceImpactBps: (invariantInput * BPS_DENOMINATOR) / (inputReserve + invariantInput),
      deadlineUnixSeconds: input.deadlineUnixSeconds,
      context: {
        chainId: identity.chainId,
        ledgerVersion: identity.version,
        deploymentId: this.manifest.deploymentId,
        packageVersion: identity.packageVersion,
        inputReserve,
        outputReserve,
        reflectionFeeBps,
        ammFeeBps,
        maximumGrossSwap,
        maximumReserveBps,
      },
    });
  }

  private async pinAndValidateIdentity(): Promise<ValidatedIdentity> {
    const ledger = await this.pinLedger();
    const core = this.manifest.packages.reflectionCore;
    const assets = this.manifest.packages.testAssets;
    const [
      stateObject,
      deployment,
      network,
      release,
      token,
      reward,
      distribution,
      mockUsd,
      poolRflReserve,
      poolUsdReserve,
      boundUsdReserve,
    ] = await Promise.all([
      this.scalar(ledger.version, core, "reflection_registry", "state_object", []),
      this.scalar(ledger.version, core, "reflection_registry", "deployment_id", []),
      this.scalar(ledger.version, core, "reflection_registry", "network_label", []),
      this.tuple(ledger.version, core, "reflection_registry", "release_version", [], 3),
      this.scalar(ledger.version, core, "reflection_token", "metadata", []),
      this.scalar(ledger.version, core, "reflection_token", "reward_vault", []),
      this.scalar(ledger.version, core, "reflection_token", "distribution_vault", []),
      this.scalar(ledger.version, assets, "mock_usd", "metadata", []),
      this.scalar(ledger.version, this.manifest.packages.testAmm, "pool", "rfl_reserve_store", []),
      this.scalar(ledger.version, this.manifest.packages.testAmm, "pool", "usd_reserve_store", []),
      this.scalar(ledger.version, assets, "mock_usd", "pool_reserve", []),
    ]);
    expectSameAddress("packages.reflectionCore", core, canonicalAddress(stateObject, `${core}::reflection_registry::state_object`));
    this.expectText("deploymentId", this.manifest.deploymentId, utf8Vector(deployment, `${core}::reflection_registry::deployment_id`));
    this.expectText("networkLabel", this.manifest.networkLabel, utf8Vector(network, `${core}::reflection_registry::network_label`));
    const packageVersion = `testnet-v${unsigned(release[0], 64, `${core}::reflection_registry::release_version`)}.${unsigned(release[1], 64, `${core}::reflection_registry::release_version`)}.${unsigned(release[2], 64, `${core}::reflection_registry::release_version`)}`;
    this.expectText("packageVersion", this.manifest.packageVersion, packageVersion);
    expectSameAddress("addresses.tokenMetadata", this.manifest.addresses.tokenMetadata, objectAddress(token, `${core}::reflection_token::metadata`));
    expectSameAddress("addresses.rewardVault", this.manifest.addresses.rewardVault, objectAddress(reward, `${core}::reflection_token::reward_vault`));
    expectSameAddress("addresses.distributionVault", this.manifest.addresses.distributionVault, objectAddress(distribution, `${core}::reflection_token::distribution_vault`));
    expectSameAddress("addresses.mockUsdMetadata", this.manifest.addresses.mockUsdMetadata, objectAddress(mockUsd, `${assets}::mock_usd::metadata`));
    const observedRflReserve = objectAddress(
      poolRflReserve,
      `${this.manifest.packages.testAmm}::pool::rfl_reserve_store`,
    );
    const observedPoolUsdReserve = objectAddress(
      poolUsdReserve,
      `${this.manifest.packages.testAmm}::pool::usd_reserve_store`,
    );
    const observedBoundUsdReserve = canonicalAddress(
      boundUsdReserve,
      `${assets}::mock_usd::pool_reserve`,
    );
    expectSameAddress(
      "addresses.poolRflReserveStore",
      this.manifest.addresses.poolRflReserveStore,
      observedRflReserve,
    );
    expectSameAddress(
      "addresses.poolUsdReserveStore",
      this.manifest.addresses.poolUsdReserveStore,
      observedPoolUsdReserve,
    );
    expectSameAddress(
      "addresses.poolUsdReserveStore/mock_usd.pool_reserve",
      this.manifest.addresses.poolUsdReserveStore,
      observedBoundUsdReserve,
    );
    // PoolState lives at the immutable test-AMM publisher; constructor validation
    // binds that publisher to manifest.addresses.pool, while every pool view is
    // addressed through that exact package identifier.
    return { ...ledger, packageVersion };
  }

  private async pinLedger(): Promise<PinnedLedger> {
    const header = await this.client.getLedgerInfo();
    const chainId = unsigned(header.chain_id, 64, "ledger_info::chain_id");
    if (chainId !== BigInt(this.manifest.chainId)) {
      throw new ManifestIdentityMismatchError(
        "chainId",
        this.manifest.chainId.toString(),
        chainId.toString(),
      );
    }
    const version = unsigned(header.ledger_version, 64, "ledger_info::ledger_version");
    const timestamp = unsigned(header.ledger_timestamp, 64, "ledger_info::ledger_timestamp");
    if (version < this.manifest.finalizedLedgerVersion) {
      throw new ManifestIdentityMismatchError(
        "finalizedLedgerVersion",
        this.manifest.finalizedLedgerVersion.toString(),
        version.toString(),
      );
    }
    return {
      chainId: CEDRA_TESTNET_CHAIN_ID,
      version,
      timestampUnixSeconds: timestamp / LEDGER_TIMESTAMP_MICROSECONDS,
    };
  }

  private async readPoolAt(ledgerVersion: bigint): Promise<PoolSnapshot> {
    const amm = this.manifest.packages.testAmm;
    const [reserves, limits, liquidity, lifecycleRaw] = await Promise.all([
      this.tuple(ledgerVersion, amm, "pool", "reserves_view", [], 2),
      this.tuple(ledgerVersion, amm, "pool", "limits", [], 3),
      this.tuple(ledgerVersion, amm, "pool", "liquidity_limits", [], 3),
      this.scalar(ledgerVersion, amm, "pool", "lifecycle", []),
    ]);
    const poolLifecycle = lifecycle(lifecycleRaw, `${amm}::pool::lifecycle`);
    const ammFeeBps = unsigned(limits[0], 64, `${amm}::pool::limits`);
    const maximumReserveBps = unsigned(limits[1], 64, `${amm}::pool::limits`);
    const maximumGrossSwap = unsigned(limits[2], 64, `${amm}::pool::limits`);
    const maximumRflContribution = unsigned(liquidity[0], 64, `${amm}::pool::liquidity_limits`);
    const maximumTusdContribution = unsigned(liquidity[1], 64, `${amm}::pool::liquidity_limits`);
    const maximumNonFinalWithdrawalShareBps = unsigned(liquidity[2], 64, `${amm}::pool::liquidity_limits`);
    if (
      ammFeeBps > 100n
      || maximumReserveBps === 0n
      || maximumReserveBps > BPS_DENOMINATOR
      || maximumGrossSwap === 0n
      || maximumRflContribution === 0n
      || maximumTusdContribution === 0n
      || maximumNonFinalWithdrawalShareBps === 0n
      || maximumNonFinalWithdrawalShareBps > BPS_DENOMINATOR
    ) {
      throw new MalformedMoveViewError(`${amm}::pool::limits`, "pool limit state is outside the immutable contract policy");
    }
    return {
      lifecycle: poolLifecycle,
      trflReserve: unsigned(reserves[0], 64, `${amm}::pool::reserves_view`),
      tusdReserve: unsigned(reserves[1], 64, `${amm}::pool::reserves_view`),
      swapsPaused: poolLifecycle !== "LIVE",
      maximumGrossSwap,
      maximumReserveBps,
      maximumRflContribution,
      maximumTusdContribution,
      maximumNonFinalWithdrawalShareBps,
      ledgerVersion,
    };
  }

  private expectText(field: string, expected: string, observed: string): void {
    if (expected !== observed) {
      throw new ManifestIdentityMismatchError(field, expected, observed);
    }
  }

  private async scalar(
    ledgerVersion: bigint,
    publisher: Address,
    moduleName: string,
    functionName: string,
    functionArguments: readonly unknown[],
  ): Promise<unknown> {
    const values = await this.view(ledgerVersion, publisher, moduleName, functionName, functionArguments);
    const functionId = `${publisher}::${moduleName}::${functionName}`;
    if (values.length !== 1) {
      throw new MalformedMoveViewError(functionId, `expected 1 return value, received ${values.length}`);
    }
    return values[0];
  }

  private async tuple(
    ledgerVersion: bigint,
    publisher: Address,
    moduleName: string,
    functionName: string,
    functionArguments: readonly unknown[],
    length: number,
  ): Promise<unknown[]> {
    const values = await this.view(ledgerVersion, publisher, moduleName, functionName, functionArguments);
    const functionId = `${publisher}::${moduleName}::${functionName}`;
    if (values.length !== length) {
      throw new MalformedMoveViewError(functionId, `expected ${length} return values, received ${values.length}`);
    }
    return values;
  }

  private async view(
    ledgerVersion: bigint,
    publisher: Address,
    moduleName: string,
    functionName: string,
    functionArguments: readonly unknown[],
  ): Promise<unknown[]> {
    const functionId = `${publisher}::${moduleName}::${functionName}`;
    return this.client.viewJson({
      payload: {
        function: functionId as InputViewFunctionJsonData["function"],
        typeArguments: [],
        functionArguments: [...functionArguments] as NonNullable<InputViewFunctionJsonData["functionArguments"]>,
      },
      options: { ledgerVersion },
    });
  }
}
