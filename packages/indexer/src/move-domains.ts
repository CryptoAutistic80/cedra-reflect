import type { ProtocolEvent, ProtocolProjection } from "./types.js";

export const MOVE_U8_MAX = (1n << 8n) - 1n;
export const MOVE_U64_MAX = (1n << 64n) - 1n;
export const MOVE_U128_MAX = (1n << 128n) - 1n;
export const MOVE_U256_MAX = (1n << 256n) - 1n;

export function isMoveUnsigned(value: unknown, bits: 8 | 64 | 128 | 256): value is bigint {
  if (typeof value !== "bigint" || value < 0n) return false;
  const maximum = bits === 8
    ? MOVE_U8_MAX
    : bits === 64
      ? MOVE_U64_MAX
      : bits === 128
        ? MOVE_U128_MAX
        : MOVE_U256_MAX;
  return value <= maximum;
}

export function isMoveSignedU256(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= -MOVE_U256_MAX && value <= MOVE_U256_MAX;
}

export function assertMoveUnsigned(value: unknown, bits: 8 | 64 | 128 | 256, label: string): asserts value is bigint {
  if (!isMoveUnsigned(value, bits)) throw new RangeError(`${label} must fit Move u${bits}`);
}

export function assertMoveSignedU256(value: unknown, label: string): asserts value is bigint {
  if (!isMoveSignedU256(value)) throw new RangeError(`${label} must fit Move SignedU256 magnitude`);
}

/** Checked arithmetic matching native Move u256 abort semantics. */
export function checkedMoveU256Add(left: bigint, right: bigint, label: string): bigint {
  assertMoveUnsigned(left, 256, `${label} left operand`);
  assertMoveUnsigned(right, 256, `${label} right operand`);
  const result = left + right;
  assertMoveUnsigned(result, 256, label);
  return result;
}

export function checkedMoveU256Subtract(left: bigint, right: bigint, label: string): bigint {
  assertMoveUnsigned(left, 256, `${label} left operand`);
  assertMoveUnsigned(right, 256, `${label} right operand`);
  if (left < right) throw new RangeError(`${label} would underflow Move u256`);
  return left - right;
}

export function checkedMoveU256Multiply(left: bigint, right: bigint, label: string): bigint {
  assertMoveUnsigned(left, 256, `${label} left operand`);
  assertMoveUnsigned(right, 256, `${label} right operand`);
  const result = left * right;
  assertMoveUnsigned(result, 256, label);
  return result;
}

/** Applies Move's canonical SignedU256 correction to an unsigned u256 base. */
export function applyMoveSignedU256(base: bigint, correction: bigint, label: string): bigint {
  assertMoveUnsigned(base, 256, `${label} base`);
  assertMoveSignedU256(correction, `${label} correction`);
  return correction < 0n
    ? checkedMoveU256Subtract(base, -correction, label)
    : checkedMoveU256Add(base, correction, label);
}

/** Mirrors reflection_math::add_unsigned for the signed correction wrapper. */
export function checkedMoveSignedU256AddUnsigned(value: bigint, amount: bigint, label: string): bigint {
  assertMoveSignedU256(value, `${label} value`);
  assertMoveUnsigned(amount, 256, `${label} amount`);
  const result = value + amount;
  assertMoveSignedU256(result, label);
  return result;
}

/** Mirrors reflection_math::subtract_unsigned for the signed correction wrapper. */
export function checkedMoveSignedU256SubtractUnsigned(value: bigint, amount: bigint, label: string): bigint {
  assertMoveSignedU256(value, `${label} value`);
  assertMoveUnsigned(amount, 256, `${label} amount`);
  const result = value - amount;
  assertMoveSignedU256(result, label);
  return result;
}

/** Checked ordered accumulation for replayed SignedU256 correction invariants. */
export function checkedMoveSignedU256Add(left: bigint, right: bigint, label: string): bigint {
  assertMoveSignedU256(left, `${label} left operand`);
  assertMoveSignedU256(right, `${label} right operand`);
  const result = left + right;
  assertMoveSignedU256(result, label);
  return result;
}

function assertBase(event: ProtocolEvent): void {
  if (typeof event.id !== "string" || event.id.length === 0 || event.id.length > 512) {
    throw new TypeError("event id must contain 1 to 512 characters");
  }
  if (typeof event.txHash !== "string" || event.txHash.length === 0 || event.txHash.length > 512) {
    throw new TypeError("event transaction hash must contain 1 to 512 characters");
  }
  assertMoveUnsigned(event.ledgerVersion, 64, "event ledger version");
  if (
    typeof event.eventIndex !== "number"
    || !Number.isSafeInteger(event.eventIndex)
    || event.eventIndex < 0
    || BigInt(event.eventIndex) > MOVE_U64_MAX
  ) throw new RangeError("event index must be a non-negative safe Move u64 ordinal");
  assertMoveUnsigned(event.timestampUnixMilliseconds, 64, "event timestamp milliseconds");
  if (event.source !== "chain" && event.source !== "replay" && event.source !== "fixture") {
    throw new TypeError("event source is invalid");
  }
}

/** Runtime trust-boundary validation for every numeric ProtocolEvent field. */
export function assertProtocolEventMoveDomains(event: ProtocolEvent): void {
  assertBase(event);
  switch (event.type) {
    case "ProtocolInitialized":
      assertMoveUnsigned(event.feeBps, 64, "initial fee bps");
      assertMoveUnsigned(event.initialIndex, 256, "initial reflection index");
      assertMoveUnsigned(event.protocolExclusionSlots, 64, "protocol exclusion slots");
      return;
    case "TokenCreated":
      assertMoveUnsigned(event.reflectionFeeBps, 64, "immutable reflection fee bps");
      assertMoveUnsigned(event.totalSupply, 64, "fixed token supply");
      assertMoveUnsigned(event.decimals, 8, "token decimals");
      return;
    case "LaunchSealed":
      assertMoveUnsigned(event.reflectionFeeBps, 64, "launch reflection fee bps");
      assertMoveUnsigned(event.ammFeeBps, 64, "launch AMM fee bps");
      assertMoveUnsigned(event.maximumReserveBps, 64, "launch maximum reserve bps");
      assertMoveUnsigned(event.maximumGrossSwap, 64, "launch maximum gross swap");
      assertMoveUnsigned(event.maximumRflContribution, 64, "launch maximum tRFL liquidity");
      assertMoveUnsigned(event.maximumTusdContribution, 64, "launch maximum tUSD liquidity");
      assertMoveUnsigned(event.maximumNonFinalWithdrawalShareBps, 64, "launch maximum withdrawal share bps");
      assertMoveUnsigned(event.faucetTrflGrant, 64, "launch faucet tRFL grant");
      assertMoveUnsigned(event.faucetTusdGrant, 64, "launch faucet tUSD grant");
      assertMoveUnsigned(event.faucetCooldownSeconds, 64, "launch faucet cooldown");
      assertMoveUnsigned(event.seedRfl, 64, "launch tRFL seed");
      assertMoveUnsigned(event.seedUsd, 64, "launch tUSD seed");
      assertMoveUnsigned(event.initialLpShares, 128, "launch initial LP shares");
      return;
    case "PoolClosed":
      assertMoveUnsigned(event.epoch, 64, "closed pool epoch");
      assertMoveUnsigned(event.lpShares, 128, "closed pool LP shares");
      assertMoveUnsigned(event.rflOutput, 64, "closed pool tRFL output");
      assertMoveUnsigned(event.usdOutput, 64, "closed pool tUSD output");
      assertMoveUnsigned(event.rflReserveAfter, 64, "closed pool tRFL reserve");
      assertMoveUnsigned(event.usdReserveAfter, 64, "closed pool tUSD reserve");
      return;
    case "ProtocolPrimaryStoreExcluded":
      assertMoveUnsigned(event.remainingSlots, 64, "remaining exclusion slots");
      return;
    case "OperationalPrimaryStoreExcluded":
    case "PositionCreated":
      return;
    case "WalletRegistered":
      assertMoveUnsigned(event.registeredWalletCount, 64, "registered wallet count");
      return;
    case "FaucetGrant":
      assertMoveUnsigned(event.amount, 64, "faucet grant amount");
      return;
    case "FaucetConfigured":
      assertMoveUnsigned(event.trflGrant, 64, "faucet tRFL grant");
      assertMoveUnsigned(event.tusdGrant, 64, "faucet tUSD grant");
      assertMoveUnsigned(event.cooldownSeconds, 64, "faucet cooldown");
      return;
    case "PoolReserveBound":
      return;
    case "WalletTransfer":
    case "EligibleBalanceDebited":
    case "EligibleBalanceCredited":
      assertMoveUnsigned(event.amount, 64, `${event.type} amount`);
      return;
    case "SwapExecuted":
      assertMoveUnsigned(event.grossAmount, 64, "swap gross amount");
      assertMoveUnsigned(event.reflectionFee, 64, "swap reflection fee");
      assertMoveUnsigned(event.ammFee, 64, "swap AMM fee");
      assertMoveUnsigned(event.netReserveInput, 64, "swap net reserve input");
      assertMoveUnsigned(event.grossPoolOutput, 64, "swap gross pool output");
      assertMoveUnsigned(event.netUserReceipt, 64, "swap net receipt");
      assertMoveUnsigned(event.trflReserveAfter, 64, "swap tRFL reserve");
      assertMoveUnsigned(event.tusdReserveAfter, 64, "swap tUSD reserve");
      return;
    case "ReflectionFeeCollected":
      assertMoveUnsigned(event.grossAmount, 64, "reflection gross amount");
      assertMoveUnsigned(event.feeAmount, 64, "reflection fee amount");
      assertMoveUnsigned(event.feeBps, 64, "reflection fee bps");
      return;
    case "ReflectionIndexAdvanced":
      assertMoveUnsigned(event.previousIndex, 256, "previous reflection index");
      assertMoveUnsigned(event.newIndex, 256, "new reflection index");
      assertMoveUnsigned(event.indexRemainder, 256, "reflection index remainder");
      assertMoveUnsigned(event.feeAmount, 64, "indexed fee amount");
      assertMoveUnsigned(event.eligibleSupply, 128, "indexed eligible supply");
      return;
    case "RewardsMaterialized":
      if (event.trigger !== undefined) assertMoveUnsigned(BigInt(event.trigger), 8, "materialization trigger");
      assertMoveUnsigned(event.amount, 64, `${event.type} amount`);
      assertMoveUnsigned(event.totalClaimed, 256, `${event.type} total claimed`);
      return;
    case "RewardsClaimed":
      assertMoveUnsigned(event.amount, 64, `${event.type} amount`);
      assertMoveUnsigned(event.totalClaimed, 256, `${event.type} total claimed`);
      return;
    case "CustodyAdapterRegistered":
      assertMoveUnsigned(event.adapterId, 64, "custody adapter id");
      assertMoveUnsigned(event.firstEpoch, 64, "first custody epoch");
      return;
    case "CustodyEpochRouteOpened":
      assertMoveUnsigned(event.adapterId, 64, "custody route adapter id");
      assertMoveUnsigned(event.epoch, 64, "custody route epoch");
      assertMoveUnsigned(event.retiredResidueMagnified, 256, "custody retired residue");
      return;
    case "CustodySharesChanged":
      assertMoveUnsigned(event.amount, 64, "custody share amount");
      assertMoveUnsigned(event.custodyShares, 128, "custody shares");
      assertMoveUnsigned(event.globalShares, 128, "global shares");
      return;
    case "CustodyRewardsRouted":
      assertMoveUnsigned(event.epoch, 64, "custody reward epoch");
      assertMoveUnsigned(event.amount, 64, "custody reward amount");
      assertMoveUnsigned(event.totalRouted, 256, "custody total routed");
      return;
    case "FeeConfigurationChanged":
      assertMoveUnsigned(event.oldFeeBps, 64, "old fee bps");
      assertMoveUnsigned(event.newFeeBps, 64, "new fee bps");
      return;
    case "SwapLimitsChanged":
      assertMoveUnsigned(event.ammFeeBps, 64, "AMM fee bps");
      assertMoveUnsigned(event.maximumGrossSwap, 64, "maximum gross swap");
      assertMoveUnsigned(event.maximumReserveBps, 64, "maximum reserve bps");
      return;
    case "LiquidityLimitsChanged":
      assertMoveUnsigned(event.maximumRflContribution, 64, "maximum tRFL contribution");
      assertMoveUnsigned(event.maximumTusdContribution, 64, "maximum tUSD contribution");
      assertMoveUnsigned(event.maximumNonFinalWithdrawalShareBps, 64, "maximum withdrawal share bps");
      return;
    case "PauseStateChanged":
    case "FaucetPauseChanged":
    case "PoolPauseChanged":
    case "OperationalAdminChanged":
      return;
    case "LiquiditySeeded":
    case "LiquidityAdded":
    case "LiquidityRemoved":
      assertMoveUnsigned(event.epoch, 64, `${event.type} epoch`);
      assertMoveUnsigned(event.trflAmount, 64, `${event.type} tRFL amount`);
      assertMoveUnsigned(event.tusdAmount, 64, `${event.type} tUSD amount`);
      assertMoveUnsigned(event.lpShares, 128, `${event.type} LP shares`);
      assertMoveUnsigned(event.trflReserveAfter, 64, `${event.type} tRFL reserve`);
      assertMoveUnsigned(event.tusdReserveAfter, 64, `${event.type} tUSD reserve`);
      return;
    case "LpEpochOpened":
    case "LpEpochStatusChanged":
      assertMoveUnsigned(event.epoch, 64, `${event.type} epoch`);
      return;
    case "LpSharesChanged":
      assertMoveUnsigned(event.epoch, 64, "LP share epoch");
      assertMoveUnsigned(event.amount, 128, "LP share amount");
      assertMoveUnsigned(event.ownerShares, 128, "LP owner shares");
      assertMoveUnsigned(event.totalShares, 128, "LP total shares");
      return;
    case "LpSharesTransferred":
      assertMoveUnsigned(event.epoch, 64, "LP transfer epoch");
      assertMoveUnsigned(event.amount, 128, "LP transfer amount");
      return;
    case "LpRewardIndexAdvanced":
      assertMoveUnsigned(event.epoch, 64, "LP reward epoch");
      assertMoveUnsigned(event.previousIndex, 256, "previous LP index");
      assertMoveUnsigned(event.newIndex, 256, "new LP index");
      assertMoveUnsigned(event.indexRemainder, 256, "LP index remainder");
      assertMoveUnsigned(event.received, 64, "LP reward received");
      assertMoveUnsigned(event.totalShares, 128, "LP reward total shares");
      assertMoveUnsigned(event.roundingReserve, 128, "LP rounding reserve");
      return;
    case "LpRewardsClaimed":
      assertMoveUnsigned(event.epoch, 64, "LP claim epoch");
      assertMoveUnsigned(event.amount, 64, "LP claim amount");
      assertMoveUnsigned(event.totalClaimed, 256, "LP claim total");
      return;
    case "LpRewardQuarantined":
      assertMoveUnsigned(event.epoch, 64, "LP quarantine epoch");
      assertMoveUnsigned(event.amount, 64, "LP quarantine amount");
      assertMoveUnsigned(event.unallocatedRewards, 128, "LP unallocated rewards");
      return;
    case "LpFractionalResidueRetired":
      assertMoveUnsigned(event.epoch, 64, "LP residue epoch");
      assertMoveUnsigned(event.residueMagnified, 256, "LP residue magnified");
      assertMoveUnsigned(event.cumulativeRetiredResidueMagnified, 256, "LP cumulative residue magnified");
      assertMoveUnsigned(event.roundingReserveBaseUnits, 128, "LP residue rounding base units");
      return;
    case "LpEpochTerminalDustClassified":
      assertMoveUnsigned(event.epoch, 64, "LP terminal epoch");
      assertMoveUnsigned(event.terminalRoundingBaseUnits, 128, "LP terminal rounding base units");
      assertMoveUnsigned(event.retiredResidueMagnified, 256, "LP terminal residue magnified");
      assertMoveUnsigned(event.lifetimeReceivedBaseUnits, 256, "LP lifetime received");
      assertMoveUnsigned(event.lifetimeClaimedBaseUnits, 256, "LP lifetime claimed");
      return;
    default: {
      const exhaustive: never = event;
      throw new TypeError(`unknown protocol event ${(exhaustive as { readonly type?: unknown }).type as string}`);
    }
  }
}

/** Exact Move-width validation for every numeric value retained in projection state. */
export function assertProjectionMoveDomains(projection: ProtocolProjection): void {
  assertMoveUnsigned(projection.protocolExclusionSlots, 64, "projection protocol exclusion slots");
  assertMoveUnsigned(projection.protocolExclusionsRemaining, 64, "projection exclusions remaining");
  assertMoveUnsigned(projection.registeredWalletCount, 64, "projection registered wallet count");
  assertMoveUnsigned(projection.feeBps, 64, "projection fee bps");
  assertMoveUnsigned(projection.currentIndex, 256, "projection reflection index");
  assertMoveUnsigned(projection.indexRemainder, 256, "projection reflection remainder");
  assertMoveUnsigned(projection.eligibleSupply, 128, "projection eligible supply");
  assertMoveSignedU256(projection.aggregateCorrection, "projection aggregate correction");
  assertMoveUnsigned(projection.unallocatedFees, 128, "projection unallocated fees");
  assertMoveUnsigned(projection.roundingReserve, 128, "projection core rounding reserve");
  assertMoveUnsigned(projection.rewardVaultCredits, 256, "projection reward vault credits");
  assertMoveUnsigned(projection.rewardVaultPayouts, 256, "projection reward vault payouts");
  assertMoveUnsigned(projection.lifetimeSwapFees, 256, "projection lifetime swap fees");
  assertMoveUnsigned(projection.lifetimeMaterialized, 256, "projection lifetime materialized");
  assertMoveUnsigned(projection.lifetimeCustodyRouted, 256, "projection lifetime custody routed");
  assertMoveUnsigned(projection.faucetTrflGrant, 64, "projection faucet tRFL grant");
  assertMoveUnsigned(projection.faucetTusdGrant, 64, "projection faucet tUSD grant");
  assertMoveUnsigned(projection.faucetCooldownSeconds, 64, "projection faucet cooldown");

  assertMoveUnsigned(projection.pool.trflReserve, 64, "projection tRFL reserve");
  assertMoveUnsigned(projection.pool.tusdReserve, 64, "projection tUSD reserve");
  assertMoveUnsigned(projection.pool.ammFeeBps, 64, "projection AMM fee bps");
  assertMoveUnsigned(projection.pool.maximumGrossSwap, 64, "projection maximum gross swap");
  assertMoveUnsigned(projection.pool.maximumReserveBps, 64, "projection maximum reserve bps");
  assertMoveUnsigned(projection.pool.maximumRflContribution, 64, "projection maximum tRFL contribution");
  assertMoveUnsigned(projection.pool.maximumTusdContribution, 64, "projection maximum tUSD contribution");
  assertMoveUnsigned(projection.pool.maximumNonFinalWithdrawalShareBps, 64, "projection maximum withdrawal share bps");

  if (projection.custody.adapterId !== null) assertMoveUnsigned(projection.custody.adapterId, 64, "projection custody adapter id");
  if (projection.custody.activeRouteEpoch !== null) assertMoveUnsigned(projection.custody.activeRouteEpoch, 64, "projection custody route epoch");
  assertMoveUnsigned(projection.custody.shares, 128, "projection custody shares");
  assertMoveSignedU256(projection.custody.correction, "projection custody correction");
  assertMoveUnsigned(projection.custody.claimed, 256, "projection custody claimed");
  assertMoveUnsigned(projection.custody.lifetimeRouted, 256, "projection custody lifetime routed");
  if (projection.activeLpEpoch !== null) assertMoveUnsigned(projection.activeLpEpoch, 64, "projection active LP epoch");

  for (const [account, position] of projection.positions) {
    assertMoveUnsigned(position.rawTrfl, 64, `wallet ${account} raw tRFL`);
    assertMoveUnsigned(position.rawTusd, 64, `wallet ${account} raw tUSD`);
    assertMoveSignedU256(position.correction, `wallet ${account} correction`);
    assertMoveUnsigned(position.claimed, 256, `wallet ${account} claimed`);
    assertMoveUnsigned(position.lifetimeClaimed, 256, `wallet ${account} lifetime claimed`);
    assertMoveUnsigned(position.lifetimeMaterialized, 256, `wallet ${account} lifetime materialized`);
  }
  for (const [key, epoch] of projection.lpEpochs) {
    assertMoveUnsigned(key, 64, "LP epoch map key");
    assertMoveUnsigned(epoch.epoch, 64, "LP epoch id");
    assertMoveUnsigned(epoch.index, 256, `LP epoch ${key} index`);
    assertMoveUnsigned(epoch.indexRemainder, 256, `LP epoch ${key} index remainder`);
    assertMoveUnsigned(epoch.totalShares, 128, `LP epoch ${key} total shares`);
    assertMoveSignedU256(epoch.aggregateCorrection, `LP epoch ${key} aggregate correction`);
    assertMoveUnsigned(epoch.unallocatedRewards, 128, `LP epoch ${key} unallocated rewards`);
    assertMoveUnsigned(epoch.roundingReserve, 128, `LP epoch ${key} rounding reserve`);
    assertMoveUnsigned(epoch.retiredResidueMagnified, 256, `LP epoch ${key} retired residue`);
    if (epoch.terminalRoundingBaseUnits !== null) {
      assertMoveUnsigned(epoch.terminalRoundingBaseUnits, 128, `LP epoch ${key} terminal rounding`);
    }
    assertMoveUnsigned(epoch.lifetimeReceived, 256, `LP epoch ${key} lifetime received`);
    assertMoveUnsigned(epoch.lifetimeClaimed, 256, `LP epoch ${key} lifetime claimed`);
    for (const [owner, position] of epoch.positions) {
      assertMoveUnsigned(position.shares, 128, `LP owner ${owner} shares`);
      assertMoveSignedU256(position.correction, `LP owner ${owner} correction`);
      assertMoveUnsigned(position.claimed, 256, `LP owner ${owner} claimed`);
    }
  }
  for (const epoch of projection.rewardVaultToEpoch.values()) assertMoveUnsigned(epoch, 64, "reward-vault epoch binding");
  for (const epoch of projection.stateIdToEpoch.values()) assertMoveUnsigned(epoch, 64, "state-object epoch binding");
  for (const cursor of projection.seenEventIds.values()) {
    const match = /^(0|[1-9][0-9]{0,19}):(0|[1-9][0-9]{0,19})$/.exec(cursor);
    if (match === null) throw new TypeError("seen-event cursor must contain canonical ledger:event ordinals");
    assertMoveUnsigned(BigInt(match[1]!), 64, "seen-event ledger version");
    const eventIndex = BigInt(match[2]!);
    assertMoveUnsigned(eventIndex, 64, "seen-event index");
    if (eventIndex > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError("seen-event index exceeds the safe ordinal representation");
    }
  }
}
