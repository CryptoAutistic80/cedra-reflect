import {
  AccountAddress,
  CEDRA_COIN,
  ChainId,
  EntryFunction,
  MultiAgentTransaction,
  RawTransaction,
  SimpleTransaction,
  TransactionPayloadEntryFunction,
  parseTypeTag,
} from "@cedra-labs/ts-sdk";
import {
  CedraReleaseClient,
  CedraReleaseChainIdMismatchError,
  CedraReleaseTransactionMismatchError,
  describeMultiAgentTransaction,
  describeSingleSignerTransaction,
  encodeCedraEntryFunction,
  MockCedraReadAdapter,
  ReflectionPilotClient,
  StateChangingCallsDisabledError,
  UnverifiedSwapDraftError,
  UnverifiedSwapQuoteError,
  reflectionFee,
  type CedraReadAdapter,
  type LpEpochTerminalDustSnapshot,
  type SwapQuote,
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

function noArgumentAbi(signers: number) {
  return { signers, typeParameters: [], parameters: [] };
}

function quoteMutatingClient(
  mutate: (quote: SwapQuote) => SwapQuote,
  nowUnixSeconds: () => bigint = () => 100n,
): ReflectionPilotClient {
  const honest = new MockCedraReadAdapter(mockReadState());
  const reader: CedraReadAdapter = {
    getPortfolio: (account) => honest.getPortfolio(account),
    getProtocol: () => honest.getProtocol(),
    getPool: () => honest.getPool(),
    getLpEpochTerminalDust: (epoch) => honest.getLpEpochTerminalDust(epoch),
    getFaucetStatus: (account, asset) => honest.getFaucetStatus(account, asset),
    quoteSwap: async (input) => mutate(structuredClone(await honest.quoteSwap(input))),
  };
  return new ReflectionPilotClient(reader, { nowUnixSeconds });
}

function terminalDustMutatingClient(
  mutate: (dust: LpEpochTerminalDustSnapshot) => LpEpochTerminalDustSnapshot,
): ReflectionPilotClient {
  const honest = new MockCedraReadAdapter(mockReadState());
  const reader: CedraReadAdapter = {
    getPortfolio: (account) => honest.getPortfolio(account),
    getProtocol: () => honest.getProtocol(),
    getPool: () => honest.getPool(),
    getLpEpochTerminalDust: async (epoch) => mutate(structuredClone(await honest.getLpEpochTerminalDust(epoch))),
    getFaucetStatus: (account, asset) => honest.getFaucetStatus(account, asset),
    quoteSwap: (input) => honest.quoteSwap(input),
  };
  return new ReflectionPilotClient(reader);
}

function releaseTransactions(
  chainId = 2,
  secondarySignerAddresses: readonly string[] = ["0x0bed"],
  options: {
    readonly sequenceNumber: bigint;
    readonly maxGasAmount: bigint;
    readonly gasUnitPrice: bigint;
    readonly expiration: bigint;
  } = {
    sequenceNumber: 7n,
    maxGasAmount: 8_000n,
    gasUnitPrice: 100n,
    expiration: 1_800_000_000n,
  },
): { readonly single: SimpleTransaction; readonly multi: MultiAgentTransaction } {
  const sender = AccountAddress.fromString("0xcafe", { maxMissingChars: 63 });
  const payload = new TransactionPayloadEntryFunction(EntryFunction.build(
    "0x1::code",
    "publish_package_txn",
    [],
    [],
  ));
  const raw = new RawTransaction(
    sender,
    options.sequenceNumber,
    payload,
    options.maxGasAmount,
    options.gasUnitPrice,
    options.expiration,
    new ChainId(chainId),
    parseTypeTag(CEDRA_COIN),
  );
  return {
    single: new SimpleTransaction(raw),
    multi: new MultiAgentTransaction(raw, secondarySignerAddresses.map((address) => (
      AccountAddress.fromString(address, { maxMissingChars: 63 })
    ))),
  };
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

test("SDK wrapper detaches and validates exact terminal LP dust units", async () => {
  const client = new ReflectionPilotClient(new MockCedraReadAdapter(mockReadState()));
  const dust = await client.getLpEpochTerminalDust(7n);
  equal(dust.epoch, 7n, "Terminal-dust read retains its exact epoch");
  equal(dust.terminalRoundingBaseUnits, 0n, "Mock terminal rounding is returned in physical base units");
  equal(dust.retiredResidueMagnified, 0n, "Mock retired residue is returned in magnified units");
  equal(Object.isFrozen(dust), true, "SDK returns detached immutable terminal evidence");
  await rejects(() => client.getLpEpochTerminalDust(0n), RangeError);
  await rejects(
    () => terminalDustMutatingClient((observed) => ({ ...observed, epoch: observed.epoch + 1n })).getLpEpochTerminalDust(7n),
    TypeError,
  );
  await rejects(
    () => terminalDustMutatingClient((observed) => ({ ...observed, terminalRoundingBaseUnits: 1n << 128n })).getLpEpochTerminalDust(7n),
    RangeError,
  );
  await rejects(
    () => terminalDustMutatingClient((observed) => ({ ...observed, retiredResidueMagnified: 1n << 256n })).getLpEpochTerminalDust(7n),
    RangeError,
  );
});

test("every mock and safe-client read result is detached and deeply frozen", async () => {
  const source = mockReadState();
  const mock = new MockCedraReadAdapter(source);
  (source.protocol.pool as unknown as { trflReserve: bigint }).trflReserve = 999_999n;

  const firstProtocol = await mock.getProtocol();
  const secondProtocol = await mock.getProtocol();
  equal(firstProtocol.pool.trflReserve, 100_990n, "Mock construction detaches from its caller-owned fixture graph");
  equal(firstProtocol === secondProtocol, false, "Independent mock reads never share a result object");
  equal(firstProtocol.pool === secondProtocol.pool, false, "Independent mock reads never share nested pool objects");
  equal(Object.isFrozen(firstProtocol), true, "Mock protocol result is frozen at its root");
  equal(Object.isFrozen(firstProtocol.pool), true, "Mock protocol result is frozen through nested records");
  equal(
    thrownBy(() => {
      (firstProtocol.pool as unknown as { trflReserve: bigint }).trflReserve = 1n;
    }) instanceof TypeError,
    true,
    "Nested mock read mutation is refused",
  );

  const mockPortfolio = await mock.getPortfolio(TEST_ACCOUNT);
  const mockPool = await mock.getPool();
  const mockFaucet = await mock.getFaucetStatus(TEST_ACCOUNT, "tRFL");
  const mockDust = await mock.getLpEpochTerminalDust(1n);
  const mockQuote = await mock.quoteSwap({
    direction: "sell",
    grossAmount: 1_000n,
    slippageBps: 100n,
    deadlineUnixSeconds: 101n,
  });
  equal(
    [mockPortfolio, mockPool, mockFaucet, mockDust, mockQuote, mockQuote.context]
      .every((result) => Object.isFrozen(result)),
    true,
    "Every direct mock read surface, including quote provenance, is frozen",
  );

  const retained = mockReadState().protocol;
  const honest = new MockCedraReadAdapter(mockReadState());
  const maliciousReader: CedraReadAdapter = {
    getPortfolio: (account) => honest.getPortfolio(account),
    getProtocol: async () => retained,
    getPool: () => honest.getPool(),
    getLpEpochTerminalDust: (epoch) => honest.getLpEpochTerminalDust(epoch),
    getFaucetStatus: (account, asset) => honest.getFaucetStatus(account, asset),
    quoteSwap: (input) => honest.quoteSwap(input),
  };
  const safe = new ReflectionPilotClient(maliciousReader);
  const safeProtocol = await safe.getProtocol();
  (retained.pool as unknown as { trflReserve: bigint }).trflReserve = 777_777n;
  equal(safeProtocol.pool.trflReserve, 100_990n, "Safe client detaches a result retained by a hostile adapter");
  equal(Object.isFrozen(safeProtocol), true, "Safe-client read is frozen at its root");
  equal(Object.isFrozen(safeProtocol.pool), true, "Safe-client read is frozen recursively");
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
  equal(faucet.secondarySignerAddresses.length, 0, "Ordinary wallet entries are explicitly single-signer");
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
  equal(thrownBy(() => encodeCedraEntryFunction(partial, {
    reflectionCore: "0x0",
    testAssets: "0xbabe",
    testAmm: "0xdead",
  })) instanceof TypeError, true, "Draft encoder rejects a zero package publisher address");
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
  equal(thrownBy(() => client.createFaucetClaimDraft("bogus" as never)) instanceof TypeError, true, "Faucet drafts reject an invalid runtime asset instead of falling through to tUSD");
  equal(thrownBy(() => client.createRewardClaimDraft(1n << 64n)) instanceof RangeError, true, "Reward claims reject values outside Move u64");

  const quote = await client.quoteSwap({
    direction: "sell",
    grossAmount: 1_000n,
    slippageBps: 100n,
    deadlineUnixSeconds: 101n,
  });
  equal(
    thrownBy(() => client.createSwapDraft({ quote: { ...quote, direction: "bogus" as never } })) instanceof UnverifiedSwapQuoteError,
    true,
    "Swap drafts reject an arbitrary quote object before trusting its fields",
  );
  equal(
    thrownBy(() => client.createSwapDraft({ quote: { ...quote, netReserveInput: quote.netReserveInput + 1n } })) instanceof UnverifiedSwapQuoteError,
    true,
    "Swap drafts reject a cloned quote with changed economics",
  );

  const malformedEncodedDraft = {
    ...client.createRewardClaimDraft(1n),
    arguments: [1] as unknown as readonly bigint[],
  } as unknown as TransactionDraft;
  equal(
    thrownBy(() => encodeCedraEntryFunction(malformedEncodedDraft, {
      reflectionCore: "0xcafe",
      testAssets: "0xbabe",
      testAmm: "0xdead",
    })) instanceof TypeError,
    true,
    "Encoder rejects a numeric value where the Move ABI requires a bigint u64",
  );

  const draft = client.createCheckpointLpRewardsDraft();
  await rejects(() => client.submit(draft), StateChangingCallsDisabledError);
});

test("swap drafts bind finalized provenance, exact arithmetic, slippage, mutation, rounding, and expiry", async () => {
  let now = 100n;
  const client = new ReflectionPilotClient(new MockCedraReadAdapter(mockReadState()), {
    nowUnixSeconds: () => now,
  });
  const mutableRequest = {
    direction: "sell",
    grossAmount: 1_999n,
    slippageBps: 333n,
    deadlineUnixSeconds: 102n,
  } as const as {
    direction: "sell";
    grossAmount: bigint;
    slippageBps: bigint;
    deadlineUnixSeconds: bigint;
  };
  const sellPromise = client.quoteSwap(mutableRequest);
  mutableRequest.grossAmount = 999n;
  const sell = await sellPromise;
  equal(sell.grossAmount, 1_999n, "Caller mutation cannot alter the detached quote request");
  equal(sell.reflectionFee, 19n, "Sell reflection uses contract floor arithmetic at 100 bps");
  equal(
    sell.minimumNetUserReceipt,
    (sell.netUserReceipt * 9_667n) / 10_000n,
    "Declared slippage is bound with exact floor arithmetic",
  );
  equal(sell.context.chainId, 2, "Quote provenance is pinned to Cedra Testnet");
  equal(sell.context.inputReserve, mockReadState().protocol.pool.trflReserve, "Sell provenance pins tRFL input reserve");
  equal(Object.isFrozen(sell), true, "Issued quote is frozen");
  equal(Object.isFrozen(sell.context), true, "Issued quote provenance is frozen");
  equal(Reflect.set(sell as unknown as Record<string, unknown>, "reflectionFee", 999n), false, "Frozen quote rejects mutation");
  const sellDraft = client.createSwapDraft({ quote: sell });
  equal(sellDraft.functionId, "test_amm::pool::sell_trfl", "Verified sell quote binds the sell entry");
  equal(sellDraft.arguments[1], sell.minimumNetUserReceipt, "Draft cannot weaken the verified minimum receipt");
  equal(Object.isFrozen(sellDraft), true, "Issued swap draft is frozen");
  await rejects(() => client.submit({ ...sellDraft }), UnverifiedSwapDraftError);
  await rejects(() => client.submit(sellDraft), StateChangingCallsDisabledError);

  const buyBundle = await client.quoteAndCreateSwapDraft({
    direction: "buy",
    grossAmount: 1_999n,
    slippageBps: 333n,
    deadlineUnixSeconds: 102n,
  });
  equal(buyBundle.draft.functionId, "test_amm::pool::buy_trfl", "Atomic quote-and-draft covers output-fee buys");
  equal(
    buyBundle.quote.reflectionFee,
    (buyBundle.quote.grossPoolOutput * 100n) / 10_000n,
    "Buy reflection is independently floored on gross tRFL output",
  );
  equal(buyBundle.quote.context.inputReserve, mockReadState().protocol.pool.tusdReserve, "Buy provenance pins tUSD input reserve");

  equal(
    thrownBy(() => client.createSwapDraft({ quote: structuredClone(sell) })) instanceof UnverifiedSwapQuoteError,
    true,
    "A structurally identical fabricated or cloned quote has no client-issued authority",
  );
  equal(
    thrownBy(() => client.createSwapDraft({
      quote: { ...sell, minimumNetUserReceipt: sell.minimumNetUserReceipt - 1n },
    })) instanceof UnverifiedSwapQuoteError,
    true,
    "A weakened minimum cannot cross the issued-quote boundary",
  );

  for (const [name, mutate] of [
    ["excess reflection fee rate", (quote: SwapQuote) => ({
      ...quote,
      context: { ...quote.context, reflectionFeeBps: 501n },
    })],
    ["wrong reflection fee", (quote: SwapQuote) => ({ ...quote, reflectionFee: quote.reflectionFee + 1n })],
    ["wrong AMM fee", (quote: SwapQuote) => ({ ...quote, ammFee: quote.ammFee + 1n })],
    ["wrong constant-product output", (quote: SwapQuote) => ({ ...quote, grossPoolOutput: quote.grossPoolOutput + 1n })],
    ["weakened minimum", (quote: SwapQuote) => ({
      ...quote,
      minimumNetUserReceipt: quote.minimumNetUserReceipt - 1n,
    })],
  ] as const) {
    await rejects(
      () => quoteMutatingClient(mutate).quoteSwap({
        direction: "sell",
        grossAmount: 1_000n,
        slippageBps: 100n,
        deadlineUnixSeconds: 101n,
      }),
      RangeError,
    );
    equal(name.length > 0, true, `${name} regression is named`);
  }

  const honest = new MockCedraReadAdapter(mockReadState());
  let retained: SwapQuote | undefined;
  const retainingReader: CedraReadAdapter = {
    getPortfolio: (account) => honest.getPortfolio(account),
    getProtocol: () => honest.getProtocol(),
    getPool: () => honest.getPool(),
    getLpEpochTerminalDust: (epoch) => honest.getLpEpochTerminalDust(epoch),
    getFaucetStatus: (account, asset) => honest.getFaucetStatus(account, asset),
    quoteSwap: async (input) => {
      // Deliberately reintroduce a mutable adapter-owned alias to exercise the
      // safe client's independent detachment boundary.
      retained = structuredClone(await honest.quoteSwap(input));
      return retained;
    },
  };
  const retainingClient = new ReflectionPilotClient(retainingReader, { nowUnixSeconds: () => 100n });
  const detached = await retainingClient.quoteSwap({
    direction: "sell",
    grossAmount: 1_000n,
    slippageBps: 100n,
    deadlineUnixSeconds: 101n,
  });
  (retained as unknown as { reflectionFee: bigint }).reflectionFee = 999n;
  equal(detached.reflectionFee, 10n, "Adapter-side mutation cannot alter the detached issued quote");
  retainingClient.createSwapDraft({ quote: detached });

  now = 102n;
  equal(
    thrownBy(() => client.createSwapDraft({ quote: sell })) instanceof RangeError,
    true,
    "An issued quote cannot become a draft at or after expiry",
  );
});

test("SDK wrapper enforces the immutable v0.2 reflection fee ceiling", () => {
  equal(reflectionFee(1_999n, 100n), 19n, "Reflection fee uses floor arithmetic");
  equal(reflectionFee(10_000n, 500n), 500n, "Creation-time fees may use the full v0.2 range");
  let threw = false;
  try {
    reflectionFee(1n, 501n);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  equal(threw, true, "Fees over 500 bps must be rejected");
});

test("release client is structurally build/simulate-only", () => {
  equal(
    "submitAfterApproval" in CedraReleaseClient.prototype,
    false,
    "Unauthenticated names and timestamps cannot unlock a repository submission API",
  );
  equal("submit" in CedraReleaseClient.prototype, false, "Release client exposes no generic submit method");
});

test("release client rejects non-Testnet transactions and zero gas price at every boundary", async () => {
  const chainTwo = releaseTransactions(2);
  const chainFour = releaseTransactions(4);
  equal(
    thrownBy(() => describeSingleSignerTransaction(chainFour.single)) instanceof CedraReleaseChainIdMismatchError,
    true,
    "Single-signer description rejects a non-Testnet raw transaction",
  );
  equal(
    thrownBy(() => describeMultiAgentTransaction(chainFour.multi)) instanceof CedraReleaseChainIdMismatchError,
    true,
    "Multi-agent description rejects a non-Testnet raw transaction",
  );

  let buildCalls = 0;
  let simulationCalls = 0;
  const wrongChainClient = new CedraReleaseClient({
    transaction: {
      build: {
        simple: async () => {
          buildCalls += 1;
          return chainFour.single;
        },
      },
      simulate: {
        simple: async () => {
          simulationCalls += 1;
          return [];
        },
      },
    },
  } as never);
  const request = {
    senderAddress: "0xcafe" as const,
    data: {
      function: "0x1::code::publish_package_txn" as const,
      functionArguments: [],
      abi: noArgumentAbi(1),
    },
    options: {
      accountSequenceNumber: 7n,
      maxGasAmount: 8_000,
      gasUnitPrice: 100,
      expireTimestamp: 1_800_000_000,
    },
  };
  await rejects(() => wrongChainClient.buildSingleSigner(request), CedraReleaseChainIdMismatchError);
  equal(buildCalls, 1, "Wrong-chain build output is inspected and rejected");
  await rejects(() => wrongChainClient.simulateSingleSigner({
    transaction: chainFour.single,
    expectedIdentity: describeSingleSignerTransaction(chainTwo.single),
    senderPublicKey: {} as never,
  }), CedraReleaseChainIdMismatchError);
  equal(simulationCalls, 0, "Wrong-chain simulation fails before any RPC call");

  await rejects(() => wrongChainClient.buildSingleSigner({
    ...request,
    options: { ...request.options, gasUnitPrice: 0 },
  }), RangeError);
  equal(buildCalls, 1, "Zero gas price is rejected before SDK 2.2.8 can substitute an RPC default");

  await rejects(() => wrongChainClient.buildSingleSigner({
    ...request,
    options: { ...request.options, accountSequenceNumber: Number.MAX_SAFE_INTEGER + 1 },
  }), RangeError);
  await rejects(() => wrongChainClient.buildSingleSigner({
    ...request,
    options: { ...request.options, accountSequenceNumber: "7" as never },
  }), TypeError);
  await rejects(() => wrongChainClient.buildSingleSigner({
    ...request,
    options: { ...request.options, faAddress: {} as never },
  }), TypeError);
  await rejects(() => wrongChainClient.buildSingleSigner({
    ...request,
    data: { function: request.data.function, functionArguments: [] },
  }), TypeError);
  equal(buildCalls, 1, "Malformed explicit controls or missing local ABI are rejected without invoking the SDK builder");
});

test("release client preserves exact secondary-signer order and rejects canonical duplicates", async () => {
  const builtMulti = releaseTransactions(2, ["0x0bed", "0x0bee"]).multi;
  const builtSingle = releaseTransactions(2, [], {
    sequenceNumber: 8n,
    maxGasAmount: 9_000n,
    gasUnitPrice: 101n,
    expiration: 1_800_000_001n,
  }).single;
  const buildCalls: Array<{
    readonly sender: string;
    readonly secondarySignerAddresses: readonly string[];
    readonly data: unknown;
    readonly options: unknown;
    readonly withFeePayer: boolean;
  }> = [];
  const singleBuildCalls: Array<{
    readonly sender: string;
    readonly data: unknown;
    readonly options: unknown;
    readonly withFeePayer: boolean;
  }> = [];
  const fakeCedra = {
    transaction: {
      build: {
        simple: async (request: {
          readonly sender: string;
          readonly data: unknown;
          readonly options: unknown;
          readonly withFeePayer: boolean;
        }) => {
          singleBuildCalls.push(request);
          return builtSingle;
        },
        multiAgent: async (request: {
          readonly sender: string;
          readonly secondarySignerAddresses: readonly string[];
          readonly data: unknown;
          readonly options: unknown;
          readonly withFeePayer: boolean;
        }) => {
          buildCalls.push(request);
          return builtMulti;
        },
      },
    },
  };
  const release = new CedraReleaseClient(fakeCedra as never);
  const multiData = {
    function: "0x1::code::publish_package_txn" as const,
    functionArguments: [],
    abi: noArgumentAbi(3),
  };
  const singleData = { ...multiData, abi: noArgumentAbi(1) };
  await release.buildMultiAgent({
    senderAddress: "0xcafe",
    secondarySignerAddresses: ["0x0bed", "0x0bee"],
    data: multiData,
    options: {
      accountSequenceNumber: 7n,
      maxGasAmount: 8_000,
      gasUnitPrice: 100,
      expireTimestamp: 1_800_000_000,
    },
  });
  equal(buildCalls[0]?.sender, "0xcafe", "Package publisher remains the Cedra primary signer");
  equal(
    JSON.stringify(buildCalls[0]?.secondarySignerAddresses),
    '["0x0bed","0x0bee"]',
    "Cedra builder receives secondary signers in the reviewed authenticator order",
  );
  equal(
    JSON.stringify(buildCalls[0]?.options, (_, value) => typeof value === "bigint" ? value.toString() : value),
    '{"accountSequenceNumber":"7","maxGasAmount":8000,"gasUnitPrice":100,"expireTimestamp":1800000000}',
    "Cedra builder receives every explicit sequence, gas, and expiration control",
  );
  equal(buildCalls[0]?.withFeePayer, false, "Release builder explicitly disables an unreviewed fee payer");
  await release.buildSingleSigner({
    senderAddress: "0xcafe",
    data: singleData,
    options: {
      accountSequenceNumber: 8n,
      maxGasAmount: 9_000,
      gasUnitPrice: 101,
      expireTimestamp: 1_800_000_001,
    },
  });
  equal(singleBuildCalls[0]?.sender, "0xcafe", "Single-signer release build retains its exact publisher");
  equal(singleBuildCalls[0]?.withFeePayer, false, "Single-signer release build also disables an unreviewed fee payer");
  await rejects(() => release.buildMultiAgent({
    senderAddress: "0x01",
    secondarySignerAddresses: ["0x1"],
    data: multiData,
    options: {
      accountSequenceNumber: 7n,
      maxGasAmount: 8_000,
      gasUnitPrice: 100,
      expireTimestamp: 1_800_000_000,
    },
  }), Error);
  await rejects(() => release.buildMultiAgent({
    senderAddress: "0xcafe",
    secondarySignerAddresses: ["0x0bed", "0x0bee"],
    data: { ...multiData, abi: noArgumentAbi(2) },
    options: {
      accountSequenceNumber: 7n,
      maxGasAmount: 8_000,
      gasUnitPrice: 100,
      expireTimestamp: 1_800_000_000,
    },
  }), TypeError);
  await rejects(() => release.buildSingleSigner({
    senderAddress: "0xcafe",
    data: {
      function: "0x1::wrong_module::wrong_entry",
      functionArguments: [],
      abi: noArgumentAbi(1),
    },
    options: {
      accountSequenceNumber: 8n,
      maxGasAmount: 9_000,
      gasUnitPrice: 101,
      expireTimestamp: 1_800_000_001,
    },
  }), CedraReleaseTransactionMismatchError);
  await rejects(() => release.buildSingleSigner({
    senderAddress: "0xbeef",
    data: singleData,
    options: {
      accountSequenceNumber: 8n,
      maxGasAmount: 9_000,
      gasUnitPrice: 101,
      expireTimestamp: 1_800_000_001,
    },
  }), CedraReleaseTransactionMismatchError);
  equal(
    singleBuildCalls.length,
    3,
    "Injected SDK results with different payload or sender identity are inspected and rejected after build",
  );
});

test("release fingerprints exact BCS/signing bytes and simulates without rebuilding", async () => {
  const { single, multi } = releaseTransactions();
  const singleIdentity = describeSingleSignerTransaction(single);
  const multiIdentity = describeMultiAgentTransaction(multi);
  equal(singleIdentity.transactionType, "single-signer", "Single-signer evidence is explicitly typed");
  equal(multiIdentity.transactionType, "multi-agent", "Multi-agent evidence is explicitly typed");
  equal(singleIdentity.sequenceNumber, "7", "Identity binds the explicit account sequence number");
  equal(singleIdentity.maxGasAmount, "8000", "Identity binds the explicit gas maximum");
  equal(singleIdentity.gasUnitPrice, "100", "Identity binds the explicit gas price");
  equal(singleIdentity.expirationTimestampSeconds, "1800000000", "Identity binds the absolute expiry");
  equal(singleIdentity.rawTransactionSha256.length, 64, "Raw-transaction evidence uses SHA-256");
  equal(singleIdentity.transactionSha256.length, 64, "Wrapper evidence uses SHA-256");
  equal(singleIdentity.signingMessageSha256.length, 64, "Signing-message evidence uses SHA-256");
  equal(multiIdentity.secondarySignerAddresses[0]?.endsWith("0bed"), true, "Signing identity retains the secondary authenticator address");
  equal(multiIdentity.signingMessageSha256 === singleIdentity.signingMessageSha256, false, "Multi-agent signer identity changes the signing message");

  const simulated: unknown[] = [];
  const fakeCedra = {
    transaction: {
      simulate: {
        simple: async (request: { readonly transaction: unknown }) => {
          simulated.push(request.transaction);
          return [];
        },
        multiAgent: async (request: { readonly transaction: unknown }) => {
          simulated.push(request.transaction);
          return [];
        },
      },
    },
  };
  const release = new CedraReleaseClient(fakeCedra as never);
  await release.simulateSingleSigner({
    transaction: single,
    expectedIdentity: singleIdentity,
    senderPublicKey: {} as never,
  });
  await release.simulateMultiAgent({
    transaction: multi,
    expectedIdentity: multiIdentity,
    senderPublicKey: {} as never,
    secondarySignerPublicKeys: [{} as never],
  });
  equal(simulated[0] === single, true, "Single-signer simulation receives the exact reviewed object");
  equal(simulated[1] === multi, true, "Multi-agent simulation receives the exact reviewed object");
  await rejects(() => release.simulateMultiAgent({
    transaction: multi,
    expectedIdentity: { ...multiIdentity, gasUnitPrice: "101" },
    senderPublicKey: {} as never,
    secondarySignerPublicKeys: [{} as never],
  }), Error);
  equal(simulated.length, 2, "Identity mismatch fails before any simulation call");
});
