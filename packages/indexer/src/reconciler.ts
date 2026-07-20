import {
  coreIndexedLiability,
  custodyPending,
  expectedCoreVaultBalance,
  expectedLpVaultBalance,
  lpIndexedLiability,
  sumWalletShares,
} from "./accounting.js";
import type {
  CriticalAlert,
  EventCursor,
  ObservedAccountingSnapshot,
  ObservedLpEpoch,
  ProtocolProjection,
  ReconciliationReport,
} from "./types.js";

function alert(
  code: CriticalAlert["code"],
  message: string,
  cursor: EventCursor | null,
  expected: bigint | string | boolean,
  observed: bigint | string | boolean,
  scope = "global",
): CriticalAlert {
  return {
    id: `reconcile:${code}:${scope}:${cursor?.ledgerVersion.toString() ?? "none"}:${cursor?.eventIndex.toString() ?? "none"}`,
    severity: "critical",
    code,
    message,
    detectedAtUnixMilliseconds: BigInt(Date.now()),
    cursor,
    expected: String(expected),
    observed: String(observed),
  };
}

function tuple(values: readonly (bigint | string | boolean | null)[]): string {
  return values.map((value) => value === null ? "none" : String(value)).join("/");
}

function compareLpEpoch(
  projection: ProtocolProjection,
  observed: ObservedLpEpoch,
  cursor: EventCursor | null,
  alerts: CriticalAlert[],
): { expectedVaultBalance: bigint; calculatedLiability: bigint; backingSurplus: bigint } | null {
  const expected = projection.lpEpochs.get(observed.epoch);
  const scope = `lp-${observed.epoch.toString()}`;
  if (expected === undefined) {
    alerts.push(alert("LP_ACCOUNTING", "Observed chain state contains an LP epoch absent from replay.", cursor, "absent", observed.epoch, scope));
    return null;
  }
  const calculatedLiability = lpIndexedLiability(expected);
  const expectedVaultBalance = expectedLpVaultBalance(expected);
  const backingSurplus = observed.rewardVaultBalance - calculatedLiability;

  if (observed.rewardVault !== expected.rewardVault) {
    alerts.push(alert("VAULT_BINDING", "LP epoch reward-vault identifier differs from its event-bound vault.", cursor, expected.rewardVault, observed.rewardVault, scope));
  }
  if (observed.stateId !== expected.stateId) {
    alerts.push(alert("IDENTIFIER_REUSE", "LP epoch state-object identifier differs from immutable opening evidence.", cursor, expected.stateId, observed.stateId, scope));
  }
  if (observed.rewardVaultBalance !== expectedVaultBalance) {
    alerts.push(alert("LP_VAULT_BACKING", "Individual LP vault balance differs from routed rewards less claims.", cursor, expectedVaultBalance, observed.rewardVaultBalance, scope));
  }
  if (observed.indexedLiability !== calculatedLiability) {
    alerts.push(alert("LP_ACCOUNTING", "LP indexed liability differs from share/index/correction/claim arithmetic.", cursor, calculatedLiability, observed.indexedLiability, scope));
  }
  if (
    observed.rewardVaultBalance
      !== observed.indexedLiability + observed.unallocatedRewards + observed.roundingReserve
  ) {
    alerts.push(alert(
      "LP_VAULT_BACKING",
      "Observed LP vault does not equal indexed liability plus unallocated and rounding buckets.",
      cursor,
      observed.indexedLiability + observed.unallocatedRewards + observed.roundingReserve,
      observed.rewardVaultBalance,
      scope,
    ));
  }
  if (
    observed.status !== expected.status
    || observed.index !== expected.index
    || observed.indexRemainder !== expected.indexRemainder
    || observed.totalShares !== expected.totalShares
    || observed.aggregateCorrection !== expected.aggregateCorrection
    || observed.unallocatedRewards !== expected.unallocatedRewards
    || observed.roundingReserve !== expected.roundingReserve
    || observed.lifetimeReceived !== expected.lifetimeReceived
    || observed.lifetimeClaimed !== expected.lifetimeClaimed
    || observed.quarantined !== expected.quarantined
  ) {
    alerts.push(alert(
      "LP_ACCOUNTING",
      "LP epoch accounting fields disagree with event replay.",
      cursor,
      tuple([
        expected.status,
        expected.index,
        expected.indexRemainder,
        expected.totalShares,
        expected.aggregateCorrection,
        expected.unallocatedRewards,
        expected.roundingReserve,
        expected.lifetimeReceived,
        expected.lifetimeClaimed,
        expected.quarantined,
      ]),
      tuple([
        observed.status,
        observed.index,
        observed.indexRemainder,
        observed.totalShares,
        observed.aggregateCorrection,
        observed.unallocatedRewards,
        observed.roundingReserve,
        observed.lifetimeReceived,
        observed.lifetimeClaimed,
        observed.quarantined,
      ]),
      scope,
    ));
  }

  const observedPositions = new Map(observed.positions.map((position) => [position.owner, position]));
  for (const [owner, position] of expected.positions) {
    const chain = observedPositions.get(owner);
    if (
      chain === undefined
      || chain.shares !== position.shares
      || chain.correction !== position.correction
      || chain.claimed !== position.claimed
    ) {
      alerts.push(alert(
        "POSITION_ACCOUNTING",
        "LP position differs from independently replayed ownership and history.",
        cursor,
        tuple([position.shares, position.correction, position.claimed]),
        chain === undefined ? "missing" : tuple([chain.shares, chain.correction, chain.claimed]),
        `${scope}-${owner}`,
      ));
    }
    observedPositions.delete(owner);
  }
  for (const owner of observedPositions.keys()) {
    alerts.push(alert("POSITION_ACCOUNTING", "Observed LP position is absent from replay.", cursor, "absent", owner, `${scope}-${owner}`));
  }

  return { expectedVaultBalance, calculatedLiability, backingSurplus };
}

/**
 * Reconciles two independent sources: event-derived arithmetic and finalized
 * chain views. A replayed or observed vault balance is never substituted for a
 * calculated liability.
 */
export function reconcile(
  projection: ProtocolProjection,
  observed: ObservedAccountingSnapshot,
  cursor: EventCursor | null,
): ReconciliationReport {
  const alerts: CriticalAlert[] = [];
  const expectedRewardVaultBalance = expectedCoreVaultBalance(projection);
  const calculatedReflectionLiability = coreIndexedLiability(projection);
  const backingSurplus = observed.rewardVaultBalance - calculatedReflectionLiability;
  const calculatedCustodyPending = custodyPending(projection);

  const observedOperationalAdmins = {
    reflectionCore: observed.coreOperationalAdmin,
    testAssets: observed.faucetOperationalAdmin,
    testAmm: observed.ammOperationalAdmin,
  } as const;
  for (const key of ["reflectionCore", "testAssets", "testAmm"] as const) {
    const expected = projection.operationalAdmins[key];
    if (expected !== null && expected !== observedOperationalAdmins[key]) {
      alerts.push(alert(
        "OPERATIONAL_ADMIN",
        "On-chain operational admin differs from the evented publisher handoff.",
        cursor,
        expected,
        observedOperationalAdmins[key],
        key,
      ));
    }
  }

  if (projection.rewardVault === null || observed.rewardVault !== projection.rewardVault) {
    alerts.push(alert("VAULT_BINDING", "Core reward-vault identifier differs from initialization evidence.", cursor, projection.rewardVault ?? "missing", observed.rewardVault, "core"));
  }
  if (observed.rewardVaultBalance !== expectedRewardVaultBalance) {
    alerts.push(alert(
      "VAULT_BACKING",
      "Core reward-vault balance differs from lifetime fees less wallet materializations and custody routes.",
      cursor,
      expectedRewardVaultBalance,
      observed.rewardVaultBalance,
      "core",
    ));
  }
  if (observed.reflectionLiability !== calculatedReflectionLiability) {
    alerts.push(alert(
      "REFLECTION_LIABILITY",
      "Core indexed liability differs from global shares/index/correction less settled totals.",
      cursor,
      calculatedReflectionLiability,
      observed.reflectionLiability,
      "core",
    ));
  }
  if (
    observed.rewardVaultBalance
      !== observed.reflectionLiability + observed.unallocatedFees + observed.roundingReserve
  ) {
    alerts.push(alert(
      "VAULT_BACKING",
      "Observed core vault does not equal indexed liability plus unallocated and rounding buckets.",
      cursor,
      observed.reflectionLiability + observed.unallocatedFees + observed.roundingReserve,
      observed.rewardVaultBalance,
      "core-buckets",
    ));
  }
  if (
    observed.currentIndex !== projection.currentIndex
    || observed.indexRemainder !== projection.indexRemainder
  ) {
    alerts.push(alert("GLOBAL_INDEX", "On-chain global reflection index or remainder disagrees with replay.", cursor, tuple([projection.currentIndex, projection.indexRemainder]), tuple([observed.currentIndex, observed.indexRemainder])));
  }
  if (observed.eligibleSupply !== projection.eligibleSupply) {
    alerts.push(alert("ELIGIBLE_SUPPLY", "On-chain total global shares disagree with replay.", cursor, projection.eligibleSupply, observed.eligibleSupply));
  }
  if (
    observed.aggregateCorrection !== projection.aggregateCorrection
    || observed.unallocatedFees !== projection.unallocatedFees
    || observed.roundingReserve !== projection.roundingReserve
  ) {
    alerts.push(alert(
      "CORE_ACCOUNTING",
      "Core aggregate correction, unallocated, or rounding bucket disagrees with replay.",
      cursor,
      tuple([projection.aggregateCorrection, projection.unallocatedFees, projection.roundingReserve]),
      tuple([observed.aggregateCorrection, observed.unallocatedFees, observed.roundingReserve]),
    ));
  }
  if (
    observed.lifetimeSwapFees !== projection.lifetimeSwapFees
    || observed.lifetimeMaterialized !== projection.lifetimeMaterialized
    || observed.lifetimeCustodyRouted !== projection.lifetimeCustodyRouted
  ) {
    alerts.push(alert(
      "LIFETIME_TOTAL",
      "Core fee, wallet-materialization, or custody-route totals disagree with replay.",
      cursor,
      tuple([projection.lifetimeSwapFees, projection.lifetimeMaterialized, projection.lifetimeCustodyRouted]),
      tuple([observed.lifetimeSwapFees, observed.lifetimeMaterialized, observed.lifetimeCustodyRouted]),
    ));
  }
  if (
    observed.custodyAdapterId !== projection.custody.adapterId
    || observed.custodyActiveRouteEpoch !== projection.custody.activeRouteEpoch
    || observed.custodyActiveLpRewardVault !== projection.custody.activeLpRewardVault
  ) {
    alerts.push(alert(
      "VAULT_BINDING",
      "Custody adapter or active epoch/vault route disagrees with registration events.",
      cursor,
      tuple([projection.custody.adapterId, projection.custody.activeRouteEpoch, projection.custody.activeLpRewardVault]),
      tuple([observed.custodyAdapterId, observed.custodyActiveRouteEpoch, observed.custodyActiveLpRewardVault]),
      "custody-route",
    ));
  }
  if (
    observed.custodyShares !== projection.custody.shares
    || observed.custodyCorrection !== projection.custody.correction
    || observed.custodyClaimed !== projection.custody.claimed
    || observed.custodyPendingRewards !== calculatedCustodyPending
  ) {
    alerts.push(alert(
      "CUSTODY_ACCOUNTING",
      "Canonical custody shares, correction, settlement, or pending rewards disagree with replay.",
      cursor,
      tuple([projection.custody.shares, projection.custody.correction, projection.custody.claimed, calculatedCustodyPending]),
      tuple([observed.custodyShares, observed.custodyCorrection, observed.custodyClaimed, observed.custodyPendingRewards]),
    ));
  }
  if (
    projection.custody.reserveStore !== null
    && observed.custodyReserveStore !== projection.custody.reserveStore
  ) {
    alerts.push(alert("VAULT_BINDING", "Canonical reserve-store identifier differs from route evidence.", cursor, projection.custody.reserveStore, observed.custodyReserveStore, "custody"));
  }
  if (
    observed.trflReserve !== observed.custodyReserveBalance
    || observed.trflReserve !== observed.custodyShares
    || projection.pool.trflReserve !== projection.custody.shares
  ) {
    alerts.push(alert(
      "RESERVE_CUSTODY",
      "Pool tRFL reserve, raw custody-store balance, and custody shares must be exactly equal.",
      cursor,
      tuple([projection.pool.trflReserve, projection.custody.shares]),
      tuple([observed.trflReserve, observed.custodyReserveBalance, observed.custodyShares]),
    ));
  }
  if (
    observed.trflReserve !== projection.pool.trflReserve
    || observed.tusdReserve !== projection.pool.tusdReserve
  ) {
    alerts.push(alert("POOL_RESERVES", "On-chain pool reserves disagree with swap/liquidity receipts.", cursor, tuple([projection.pool.trflReserve, projection.pool.tusdReserve]), tuple([observed.trflReserve, observed.tusdReserve])));
  }
  if (
    observed.maximumRflContribution !== projection.pool.maximumRflContribution
    || observed.maximumTusdContribution !== projection.pool.maximumTusdContribution
    || observed.maximumNonFinalWithdrawalShareBps !== projection.pool.maximumNonFinalWithdrawalShareBps
  ) {
    alerts.push(alert(
      "POOL_LIMITS",
      "On-chain liquidity contribution or non-final withdrawal limits disagree with event replay.",
      cursor,
      tuple([
        projection.pool.maximumRflContribution,
        projection.pool.maximumTusdContribution,
        projection.pool.maximumNonFinalWithdrawalShareBps,
      ]),
      tuple([
        observed.maximumRflContribution,
        observed.maximumTusdContribution,
        observed.maximumNonFinalWithdrawalShareBps,
      ]),
    ));
  }

  const walletShares = sumWalletShares(projection.positions);
  if (walletShares + projection.custody.shares !== projection.eligibleSupply) {
    alerts.push(alert("ELIGIBLE_SUPPLY", "Replay itself violates wallet plus custody share conservation.", cursor, walletShares + projection.custody.shares, projection.eligibleSupply, "self"));
  }
  const observedPositions = new Map(observed.positions.map((position) => [position.account, position]));
  for (const [account, position] of projection.positions) {
    const chain = observedPositions.get(account);
    if (
      chain === undefined
      || chain.rawTrfl !== position.rawTrfl
      || chain.correction !== position.correction
      || chain.claimed !== position.claimed
    ) {
      alerts.push(alert(
        "POSITION_ACCOUNTING",
        "Wallet position differs from independently replayed raw shares and reward history.",
        cursor,
        tuple([position.rawTrfl, position.correction, position.claimed]),
        chain === undefined ? "missing" : tuple([chain.rawTrfl, chain.correction, chain.claimed]),
        `wallet-${account}`,
      ));
    }
    observedPositions.delete(account);
  }
  for (const account of observedPositions.keys()) {
    alerts.push(alert("POSITION_ACCOUNTING", "Observed wallet position is absent from replay.", cursor, "absent", account, `wallet-${account}`));
  }

  if (observed.activeLpEpoch !== projection.activeLpEpoch) {
    alerts.push(alert("LP_ACCOUNTING", "Active LP epoch differs from event history.", cursor, projection.activeLpEpoch?.toString() ?? "none", observed.activeLpEpoch?.toString() ?? "none", "active-epoch"));
  }
  const observedEpochIds = new Set(observed.lpEpochs.map((epoch) => epoch.epoch));
  for (const epoch of projection.lpEpochs.keys()) {
    if (!observedEpochIds.has(epoch)) {
      alerts.push(alert("LP_ACCOUNTING", "Replayed LP epoch is missing from chain observation.", cursor, epoch, "missing", `lp-${epoch.toString()}`));
    }
  }
  const lpResults = observed.lpEpochs
    .map((epoch) => {
      const result = compareLpEpoch(projection, epoch, cursor, alerts);
      return result === null ? null : { epoch: epoch.epoch, ...result };
    })
    .filter((result): result is NonNullable<typeof result> => result !== null);

  if (observed.packageVersion !== projection.packageVersion) {
    alerts.push(alert("PACKAGE_VERSION", "On-chain package version disagrees with event history.", cursor, projection.packageVersion, observed.packageVersion));
  }
  if (
    observed.swapsPaused !== projection.swapsPaused
    || observed.claimsPaused !== projection.claimsPaused
    || observed.poolPaused !== projection.pool.poolPaused
    || observed.liquidityPaused !== projection.pool.liquidityPaused
    || observed.lpClaimsPaused !== projection.pool.lpClaimsPaused
    || observed.shutdownMode !== projection.pool.shutdownMode
    || observed.poolSeeded !== projection.pool.seeded
  ) {
    alerts.push(alert(
      "PAUSE_STATE",
      "Core/pool pause and shutdown state disagrees with event history.",
      cursor,
      tuple([projection.swapsPaused, projection.claimsPaused, projection.pool.poolPaused, projection.pool.liquidityPaused, projection.pool.lpClaimsPaused, projection.pool.shutdownMode, projection.pool.seeded]),
      tuple([observed.swapsPaused, observed.claimsPaused, observed.poolPaused, observed.liquidityPaused, observed.lpClaimsPaused, observed.shutdownMode, observed.poolSeeded]),
    ));
  }

  return {
    ledgerVersion: observed.ledgerVersion,
    expectedRewardVaultBalance,
    calculatedReflectionLiability,
    backingSurplus,
    lpEpochs: lpResults,
    alerts,
    reconciled: alerts.length === 0,
  };
}
