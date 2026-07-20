import {
  assertTwoPersonApproval,
  encodeCedraEntryFunction,
  MockCedraReadAdapter,
  ReflectionPilotClient,
  StateChangingCallsDisabledError,
  reflectionFee,
  type TransactionDraft,
} from "../packages/protocol-sdk/src/index.js";
import { mockReadState, TEST_ACCOUNT } from "./fixtures.js";
import { equal, rejects, test } from "./harness.js";

function thrownBy(execute: () => unknown): unknown {
  try {
    execute();
  } catch (error) {
    return error;
  }
  return undefined;
}

test("SDK wrapper creates a deterministic net-receipt quote without a network", async () => {
  const client = new ReflectionPilotClient(new MockCedraReadAdapter(mockReadState()), {
    nowUnixSeconds: () => 100n,
  });
  const quote = await client.quoteSwap({
    direction: "sell",
    grossAmount: 1_000n,
    slippageBps: 100n,
    deadlineUnixSeconds: 101n,
  });
  equal(quote.reflectionFee, 10n, "The sell quote must charge exactly 1% reflection fee");
  equal(quote.netReserveInput, 990n, "The pool must receive the gross input less reflection fee");
  equal(quote.ammFee, 3n, "The invariant input must round down before deriving the AMM fee");
  equal(quote.grossPoolOutput, 958n, "The sell quote must use the floored invariant input");
  equal(quote.minimumNetUserReceipt <= quote.netUserReceipt, true, "Slippage minimum must not exceed net receipt");
  const buyQuote = await client.quoteSwap({
    direction: "buy",
    grossAmount: 1_000n,
    slippageBps: 100n,
    deadlineUnixSeconds: 101n,
  });
  equal(buyQuote.netReserveInput, 1_000n, "A buy must not deduct its output-side reflection fee from tUSD reserve input");
  equal(buyQuote.ammFee, 3n, "The buy invariant input must use the same floor policy");
  equal(buyQuote.grossPoolOutput, 1_006n, "The buy quote must expose the gross pool output");
  equal(buyQuote.netUserReceipt, 996n, "The buy quote must expose the net receipt after reflection fee");
});

test("SDK wrapper refuses state-changing submission until an explicit writer is injected", async () => {
  const client = new ReflectionPilotClient(new MockCedraReadAdapter(mockReadState()), {
    nowUnixSeconds: () => 100n,
  });
  const draft = client.createRewardClaimDraft(10n);
  await rejects(() => client.submit(draft), StateChangingCallsDisabledError);
});

test("SDK drafts match the deployed entry-function and signer argument surfaces", () => {
  const client = new ReflectionPilotClient(new MockCedraReadAdapter(mockReadState()));
  const faucet = client.createFaucetClaimDraft("tRFL");
  equal(faucet.functionId, "test_assets::test_faucet::claim_trfl", "tRFL faucet claim has no forged recipient argument");
  equal(faucet.arguments.length, 0, "Faucet recipient is the signer, not a user-supplied argument");
  const partial = client.createRewardClaimDraft(10n);
  equal(partial.functionId, "reflection_core::reflection_token::claim", "Partial claim targets the exact on-chain entry");
  equal(partial.arguments.length, 1, "Partial claim carries only its requested amount");
  equal(client.createRewardClaimAllDraft().functionId, "reflection_core::reflection_token::claim_all", "Claim-all targets its dedicated entry");
  const encoded = encodeCedraEntryFunction(partial, {
    reflectionCore: "0xcafe",
    testAssets: "0xbabe",
    testAmm: "0xdead",
  });
  equal(encoded.function, "0xcafe::reflection_token::claim", "Draft encoder qualifies the core publisher address for the official SDK");
});

test("liquidity and LP drafts match the finalized Move entries and ABI argument order", () => {
  const client = new ReflectionPilotClient(new MockCedraReadAdapter(mockReadState()), {
    nowUnixSeconds: () => 100n,
  });
  const add = client.createAddLiquidityDraft({
    maxRfl: 101n,
    maxUsd: 202n,
    minLpShares: 0n,
    deadlineUnixSeconds: 120n,
  });
  equal(add.kind, "add_liquidity", "Add-liquidity drafts have a distinct transaction kind");
  equal(add.functionId, "test_amm::pool::add_liquidity", "Add liquidity targets the finalized pool entry");
  equal(JSON.stringify(add.arguments, (_, value) => typeof value === "bigint" ? value.toString() : value), '["101","202","0","120"]', "Add liquidity preserves a zero minimum-share choice in ABI order");
  equal(add.expirationUnixSeconds, 120n, "Add-liquidity expiration matches its on-chain deadline");

  const remove = client.createRemoveLiquidityDraft({
    shares: 404n,
    minRfl: 0n,
    minUsd: 0n,
    deadlineUnixSeconds: 121n,
  });
  equal(remove.kind, "remove_liquidity", "Remove-liquidity drafts have a distinct transaction kind");
  equal(remove.functionId, "test_amm::pool::remove_liquidity", "Remove liquidity targets the finalized pool entry");
  equal(JSON.stringify(remove.arguments, (_, value) => typeof value === "bigint" ? value.toString() : value), '["404","0","0","121"]', "Remove liquidity preserves zero minimum-output choices in ABI order");
  equal(remove.expirationUnixSeconds, 121n, "Remove-liquidity expiration matches its on-chain deadline");

  const transfer = client.createTransferLpSharesDraft("0xabc123", 707n);
  equal(transfer.kind, "transfer_lp_shares", "LP-share transfers have a distinct transaction kind");
  equal(transfer.functionId, "test_amm::pool::transfer_lp_shares", "LP transfer targets the module-accounted share entry");
  equal(JSON.stringify(transfer.arguments, (_, value) => typeof value === "bigint" ? value.toString() : value), '["0xabc123","707"]', "LP transfer carries recipient then shares without a forged sender");

  const claimAll = client.createLpRewardClaimDraft(8n, 0n);
  equal(claimAll.kind, "claim_lp_rewards", "LP claims have a distinct transaction kind");
  equal(claimAll.functionId, "test_amm::pool::claim_lp_rewards", "LP claim targets the epoch-aware pool entry");
  equal(JSON.stringify(claimAll.arguments, (_, value) => typeof value === "bigint" ? value.toString() : value), '["8","0"]', "Zero LP claim amount is retained as the on-chain claim-all sentinel");

  const checkpoint = client.createCheckpointLpRewardsDraft();
  equal(checkpoint.kind, "checkpoint_lp_rewards", "LP checkpoints have a distinct transaction kind");
  equal(checkpoint.functionId, "test_amm::pool::checkpoint_lp_rewards", "Checkpoint targets the permissionless pool entry");
  equal(checkpoint.arguments.length, 0, "Checkpoint carries no caller argument because the signer is implicit");

  const limits = client.createConfigureLiquidityLimitsDraft({
    maxRfl: 808n,
    maxUsd: 909n,
    maxWithdrawalShareBps: 2_500n,
  });
  equal(limits.kind, "configure_liquidity_limits", "Liquidity-limit configuration has a distinct transaction kind");
  equal(limits.functionId, "test_amm::pool::configure_liquidity_limits", "Liquidity limits target the admin pool entry");
  equal(JSON.stringify(limits.arguments, (_, value) => typeof value === "bigint" ? value.toString() : value), '["808","909","2500"]', "Liquidity limit arguments preserve the Move ABI order");

  const coreOperator = client.createOperationalAdminHandoffDraft("reflection-core", "0x0bed");
  const faucetOperator = client.createOperationalAdminHandoffDraft("test-assets", "0x0bed");
  const ammOperator = client.createOperationalAdminHandoffDraft("test-amm", "0x0bed");
  equal(coreOperator.kind, "set_operational_admin", "Operational handoffs have a distinct transaction kind");
  equal(coreOperator.functionId, "reflection_core::reflection_token::set_operational_admin", "Core handoff targets the core publisher surface");
  equal(faucetOperator.functionId, "test_assets::test_faucet::set_operational_admin", "Faucet handoff targets the asset publisher surface");
  equal(ammOperator.functionId, "test_amm::pool::set_operational_admin", "AMM handoff targets the AMM publisher surface");

  const modules = {
    reflectionCore: "0xcafe" as const,
    testAssets: "0xbabe" as const,
    testAmm: "0xdead" as const,
  };
  const encodedCases: readonly [TransactionDraft, string, string][] = [
    [add, "0xdead::pool::add_liquidity", '["101","202","0","120"]'],
    [remove, "0xdead::pool::remove_liquidity", '["404","0","0","121"]'],
    [transfer, "0xdead::pool::transfer_lp_shares", '["0xabc123","707"]'],
    [claimAll, "0xdead::pool::claim_lp_rewards", '["8","0"]'],
    [checkpoint, "0xdead::pool::checkpoint_lp_rewards", "[]"],
    [limits, "0xdead::pool::configure_liquidity_limits", '["808","909","2500"]'],
    [coreOperator, "0xcafe::reflection_token::set_operational_admin", '["0x0bed"]'],
    [faucetOperator, "0xbabe::test_faucet::set_operational_admin", '["0x0bed"]'],
    [ammOperator, "0xdead::pool::set_operational_admin", '["0x0bed"]'],
  ];
  for (const [draft, expectedFunction, expectedArguments] of encodedCases) {
    const encoded = encodeCedraEntryFunction(draft, modules);
    equal(encoded.function, expectedFunction, `${draft.kind} qualifies the finalized test-AMM publisher`);
    equal(JSON.stringify(encoded.functionArguments), expectedArguments, `${draft.kind} encodes bigint arguments as exact decimal strings`);
  }
});

test("liquidity and LP drafts reject unsafe values before reaching a writer", async () => {
  const client = new ReflectionPilotClient(new MockCedraReadAdapter(mockReadState()), {
    nowUnixSeconds: () => 100n,
  });
  equal(thrownBy(() => client.createAddLiquidityDraft({ maxRfl: 0n, maxUsd: 1n, minLpShares: 1n, deadlineUnixSeconds: 101n })) instanceof RangeError, true, "Add liquidity rejects zero maxima");
  equal(thrownBy(() => client.createAddLiquidityDraft({ maxRfl: 1n, maxUsd: 1n, minLpShares: 1n, deadlineUnixSeconds: 100n })) instanceof RangeError, true, "Add liquidity rejects an expired deadline");
  equal(thrownBy(() => client.createRemoveLiquidityDraft({ shares: 1n << 128n, minRfl: 1n, minUsd: 1n, deadlineUnixSeconds: 101n })) instanceof RangeError, true, "Remove liquidity rejects shares outside u128");
  equal(thrownBy(() => client.createRemoveLiquidityDraft({ shares: 1n, minRfl: -1n, minUsd: 1n, deadlineUnixSeconds: 101n })) instanceof RangeError, true, "Remove liquidity rejects a negative tRFL minimum output");
  equal(thrownBy(() => client.createTransferLpSharesDraft("0x0", 1n)) instanceof TypeError, true, "LP transfer rejects the zero address");
  equal(thrownBy(() => client.createTransferLpSharesDraft("0xabc", 0n)) instanceof RangeError, true, "LP transfer rejects zero shares");
  equal(thrownBy(() => client.createLpRewardClaimDraft(0n, 0n)) instanceof RangeError, true, "LP claim rejects epoch zero");
  equal(thrownBy(() => client.createLpRewardClaimDraft(1n, -1n)) instanceof RangeError, true, "LP claim permits zero as claim-all but rejects negative amounts");
  equal(thrownBy(() => client.createConfigureLiquidityLimitsDraft({ maxRfl: 1n, maxUsd: 1n, maxWithdrawalShareBps: 10_001n })) instanceof RangeError, true, "Liquidity withdrawal caps cannot exceed 100 percent");
  equal(thrownBy(() => client.createOperationalAdminHandoffDraft("reflection-core", "0x0")) instanceof TypeError, true, "Operational handoff rejects the zero address");

  const draft = client.createCheckpointLpRewardsDraft();
  await rejects(() => client.submit(draft), StateChangingCallsDisabledError);
});

test("SDK wrapper enforces the Testnet reflection fee ceiling", () => {
  equal(reflectionFee(1_999n, 100n), 19n, "Reflection fee uses floor arithmetic");
  let threw = false;
  try {
    reflectionFee(1n, 101n);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  equal(threw, true, "Fees over 100 bps must be rejected");
});

test("release submission guard requires two distinct dated approvals", () => {
  let rejected = false;
  try {
    assertTwoPersonApproval({ releaseId: "pilot-001", approvedBy: ["alice"], approvedAt: "2026-07-19T00:00:00Z" });
  } catch {
    rejected = true;
  }
  equal(rejected, true, "One approval must not unlock a release operation");
  assertTwoPersonApproval({
    releaseId: "pilot-001",
    approvedBy: ["alice", "bob"],
    approvedAt: "2026-07-19T00:00:00Z",
  });
});
