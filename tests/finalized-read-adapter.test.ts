import type { Cedra } from "@cedra-labs/ts-sdk";
import {
  FinalizedCedraReadAdapter,
  MalformedMoveViewError,
  ManifestIdentityMismatchError,
  type FinalizedCedraViewClient,
  type FinalizedProtocolManifest,
} from "../packages/protocol-sdk/src/index.js";
import { equal, rejects, test } from "./harness.js";

const CORE = "0xcafe" as const;
const ASSETS = "0xbabe" as const;
const AMM = "0xdead" as const;
const TOKEN = "0x111" as const;
const REWARD = "0x222" as const;
const DISTRIBUTION = "0x333" as const;
const TUSD = "0x444" as const;
const RFL_RESERVE = "0x555" as const;
const USD_RESERVE = "0x666" as const;

const manifest: FinalizedProtocolManifest = {
  networkLabel: "cedra-testnet",
  chainId: 2,
  deploymentId: "reflection-pilot-001",
  packageVersion: "testnet-v0.1.0",
  finalizedLedgerVersion: 4_000n,
  packages: {
    reflectionCore: CORE,
    testAssets: ASSETS,
    testAmm: AMM,
  },
  addresses: {
    tokenMetadata: TOKEN,
    mockUsdMetadata: TUSD,
    rewardVault: REWARD,
    distributionVault: DISTRIBUTION,
    pool: AMM,
    poolRflReserveStore: RFL_RESERVE,
    poolUsdReserveStore: USD_RESERVE,
  },
};

function utf8Hex(value: string): string {
  return `0x${[...new TextEncoder().encode(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function baseResponses(): Map<string, unknown[]> {
  return new Map<string, unknown[]>([
    [`${CORE}::reflection_registry::state_object`, [CORE]],
    [`${CORE}::reflection_registry::deployment_id`, [utf8Hex("reflection-pilot-001")]],
    [`${CORE}::reflection_registry::network_label`, [utf8Hex("cedra-testnet")]],
    [`${CORE}::reflection_registry::release_version`, ["0", "1", "0"]],
    [`${CORE}::reflection_token::metadata`, [{ inner: TOKEN }]],
    [`${CORE}::reflection_token::reward_vault`, [REWARD]],
    [`${CORE}::reflection_token::distribution_vault`, [{ inner: DISTRIBUTION }]],
    [`${ASSETS}::mock_usd::metadata`, [TUSD]],
    [`${ASSETS}::mock_usd::pool_reserve`, [USD_RESERVE]],
    [`${CORE}::reflection_token::fee_bps`, ["100"]],
    [`${AMM}::pool::rfl_reserve_store`, [{ inner: RFL_RESERVE }]],
    [`${AMM}::pool::usd_reserve_store`, [{ inner: USD_RESERVE }]],
    [`${CORE}::reflection_token::automatic_materialization_enabled`, [false]],
    [`${CORE}::reflection_token::registered_wallet_count`, ["2"]],
    [`${CORE}::reflection_token::global_accounting`, ["10", "2", "3000", "4", "50", "60"]],
    [`${CORE}::reflection_token::reward_vault_balance`, ["70"]],
    [`${CORE}::reflection_token::aggregate_indexed_liability`, ["80"]],
    [`${CORE}::reflection_token::pauses`, [false, true]],
    [`${CORE}::reflection_token::distribution_vault_balance`, ["1000000"]],
    [`${CORE}::reflection_token::raw_balance`, ["500"]],
    [`${CORE}::reflection_token::pending_rewards`, ["20"]],
    [`${CORE}::reflection_token::effective_balance`, ["520"]],
    [`${CORE}::reflection_token::wallet_is_registered`, [true]],
    [`${CORE}::reflection_token::wallet_position_accounting`, [true, "7", "90"]],
    [`${ASSETS}::test_faucet::configuration`, ["1000", "2000", "60"]],
    [`${ASSETS}::test_faucet::last_claim`, [true, "1699999900"]],
    [`${ASSETS}::test_faucet::paused`, [false]],
    [`${AMM}::pool::reserves_view`, ["100000", "200000"]],
    [`${AMM}::pool::limits`, ["30", "1000", "5000"]],
    [`${AMM}::pool::liquidity_limits`, ["6000", "7000", "2500"]],
    [`${AMM}::pool::pause_state`, [false, false, false, false, true]],
    [`${AMM}::pool::quote_sell`, ["1954", "10", "3"]],
    [`${AMM}::pool::quote_buy`, ["492", "4", "3"]],
  ]);
}

interface RecordedView {
  readonly functionId: string;
  readonly ledgerVersion: bigint;
  readonly functionArguments: readonly unknown[];
}

class FakeFinalizedClient implements FinalizedCedraViewClient {
  public readonly views: RecordedView[] = [];
  public ledgerReads = 0;

  public constructor(
    public readonly responses: Map<string, unknown[]> = baseResponses(),
    private readonly ledgerVersion = 4_242n,
    private readonly ledgerTimestampMicroseconds = 1_700_000_000_000_000n,
    private readonly chainId = 2,
  ) {}

  public async getLedgerInfo(): Promise<{
    ledger_version: string;
    ledger_timestamp: string;
    chain_id: number;
  }> {
    this.ledgerReads += 1;
    return {
      ledger_version: this.ledgerVersion.toString(),
      ledger_timestamp: this.ledgerTimestampMicroseconds.toString(),
      chain_id: this.chainId,
    };
  }

  public async viewJson(args: Parameters<FinalizedCedraViewClient["viewJson"]>[0]): Promise<unknown[]> {
    const rawLedgerVersion = args.options.ledgerVersion;
    if (rawLedgerVersion === undefined) {
      throw new Error("Adapter failed to pin a view to a ledger version");
    }
    const functionId = String(args.payload.function);
    this.views.push({
      functionId,
      ledgerVersion: BigInt(rawLedgerVersion),
      functionArguments: args.payload.functionArguments ?? [],
    });
    const response = this.responses.get(functionId);
    if (response === undefined) {
      throw new Error(`No fake response for ${functionId}`);
    }
    return [...response];
  }
}

// This compile-time assignment ensures the injected surface remains compatible
// with the installed official SDK without constructing a network client.
function acceptOfficialClient(client: Cedra): FinalizedCedraViewClient {
  return client;
}
void acceptOfficialClient;

test("finalized adapter pins an entire protocol snapshot to one ledger version", async () => {
  const fake = new FakeFinalizedClient();
  const adapter = new FinalizedCedraReadAdapter(fake, manifest);
  const protocol = await adapter.getProtocol();
  equal(protocol.ledgerVersion, 4_242n, "Protocol snapshot records the selected ledger version");
  equal(protocol.pool.ledgerVersion, 4_242n, "Nested pool snapshot uses the same selected ledger version");
  equal(protocol.eligibleSupply, 3_000n, "Global eligible supply is parsed without number coercion");
  equal(protocol.reflectionLiability, 80n, "u256 reflection liability remains a bigint");
  equal(Object.isFrozen(protocol), true, "Finalized protocol result is frozen at its root");
  equal(Object.isFrozen(protocol.pool), true, "Finalized protocol result is frozen through nested pool state");
  equal(fake.ledgerReads, 1, "One ledger header pins the multi-view read");
  equal(fake.views.every((view) => view.ledgerVersion === 4_242n), true, "Every identity and state view uses the selected ledger version");
});

test("finalized adapter fails closed when on-chain identity differs from the manifest", async () => {
  const fake = new FakeFinalizedClient();
  fake.responses.set(`${CORE}::reflection_registry::deployment_id`, [utf8Hex("wrong-deployment")]);
  const adapter = new FinalizedCedraReadAdapter(fake, manifest);
  await rejects(() => adapter.getPool(), ManifestIdentityMismatchError);
  equal(
    fake.views.some((view) => view.functionId === `${AMM}::pool::reserves_view`),
    false,
    "No pool state is accepted after deployment identity validation fails",
  );
});

test("finalized adapter rejects a finalized ledger from a non-Testnet chain before any view", async () => {
  const fake = new FakeFinalizedClient(baseResponses(), 4_242n, 1_700_000_000_000_000n, 4);
  const adapter = new FinalizedCedraReadAdapter(fake, manifest);
  await rejects(() => adapter.getPool(), ManifestIdentityMismatchError);
  equal(fake.views.length, 0, "Wrong-chain ledger identity must stop all Move views");
});

test("finalized adapter rejects malformed Move tuples instead of partially accepting them", async () => {
  const fake = new FakeFinalizedClient();
  fake.responses.set(`${CORE}::reflection_token::global_accounting`, ["10", "2", "3000", "4", "50"]);
  const adapter = new FinalizedCedraReadAdapter(fake, manifest);
  await rejects(() => adapter.getProtocol(), MalformedMoveViewError);
});

test("finalized adapter reads terminal LP dust with exact base and magnified units", async () => {
  const maximumU128 = (1n << 128n) - 1n;
  const maximumU256 = (1n << 256n) - 1n;
  const functionId = `${AMM}::pool::lp_epoch_terminal_dust`;
  const fake = new FakeFinalizedClient();
  fake.responses.set(functionId, [maximumU128.toString(), maximumU256.toString()]);
  const dust = await new FinalizedCedraReadAdapter(fake, manifest).getLpEpochTerminalDust(7n);
  equal(dust.epoch, 7n, "Terminal-dust result retains the requested u64 epoch");
  equal(dust.terminalRoundingBaseUnits, maximumU128, "Physical terminal rounding retains the full Move u128 domain");
  equal(dust.retiredResidueMagnified, maximumU256, "Fractional residue retains the full Move u256 domain");
  equal(dust.ledgerVersion, 4_242n, "Terminal-dust view is pinned to the finalized identity ledger");
  equal(Object.isFrozen(dust), true, "Terminal-dust result is immutable at the adapter boundary");
  const call = fake.views.find((view) => view.functionId === functionId);
  equal(call?.functionArguments[0], "7", "Epoch reaches the official JSON view payload as an exact decimal string");

  const u128Overflow = new FakeFinalizedClient();
  u128Overflow.responses.set(functionId, [(1n << 128n).toString(), "0"]);
  await rejects(
    () => new FinalizedCedraReadAdapter(u128Overflow, manifest).getLpEpochTerminalDust(7n),
    MalformedMoveViewError,
  );
  const u256Overflow = new FakeFinalizedClient();
  u256Overflow.responses.set(functionId, ["0", (1n << 256n).toString()]);
  await rejects(
    () => new FinalizedCedraReadAdapter(u256Overflow, manifest).getLpEpochTerminalDust(7n),
    MalformedMoveViewError,
  );
  await rejects(
    () => new FinalizedCedraReadAdapter(new FakeFinalizedClient(), manifest).getLpEpochTerminalDust(0n),
    RangeError,
  );
  await rejects(
    () => new FinalizedCedraReadAdapter(new FakeFinalizedClient(), manifest).getLpEpochTerminalDust(1n << 64n),
    RangeError,
  );
});

test("finalized adapter preserves the contract's sell and buy quote tuple semantics", async () => {
  const fake = new FakeFinalizedClient();
  const adapter = new FinalizedCedraReadAdapter(fake, manifest);
  const sell = await adapter.quoteSwap({
    direction: "sell",
    grossAmount: 1_000n,
    slippageBps: 100n,
    deadlineUnixSeconds: 1_700_000_100n,
  });
  equal(sell.reflectionFee, 10n, "Sell reflection is deducted from the tRFL input");
  equal(sell.netReserveInput, 990n, "Sell reserve input is gross tRFL less reflection");
  equal(sell.grossPoolOutput, 1_954n, "Sell tuple first value is gross tUSD pool output");
  equal(sell.netUserReceipt, 1_954n, "Sell tuple first value is also the user's tUSD receipt");
  equal(sell.minimumNetUserReceipt, 1_934n, "Sell minimum applies slippage to net receipt with floor arithmetic");
  equal(sell.priceImpactBps, 97n, "Sell impact compares execution price with the pre-swap spot price");
  equal(Object.isFrozen(sell), true, "Finalized quote is frozen at its root");
  equal(Object.isFrozen(sell.context), true, "Finalized quote provenance is recursively frozen");

  const buy = await adapter.quoteSwap({
    direction: "buy",
    grossAmount: 1_000n,
    slippageBps: 100n,
    deadlineUnixSeconds: 1_700_000_100n,
  });
  equal(buy.netReserveInput, 1_000n, "Buy sends the complete tUSD input to AMM settlement");
  equal(buy.grossPoolOutput, 496n, "Buy gross output restores the output-side reflection fee");
  equal(buy.netUserReceipt, 492n, "Buy tuple first value is net tRFL received by the user");
  equal(buy.minimumNetUserReceipt, 487n, "Buy minimum applies slippage to net tRFL receipt");
  equal(buy.priceImpactBps, 49n, "Buy impact uses the tUSD input reserve");
  equal(
    fake.views.filter((view) => view.functionId.includes("::pool::quote_")).every((view) => (
      view.functionArguments[0] === "1000"
    )),
    true,
    "u64 quote inputs reach the official JSON payload as exact decimal strings",
  );
});

test("finalized adapter binds both AMM reserves and the tUSD capability to the manifest", async () => {
  const fake = new FakeFinalizedClient();
  fake.responses.set(`${ASSETS}::mock_usd::pool_reserve`, ["0x777"]);
  const adapter = new FinalizedCedraReadAdapter(fake, manifest);
  await rejects(() => adapter.getProtocol(), ManifestIdentityMismatchError);
  equal(
    fake.views.some((view) => view.functionId === `${CORE}::reflection_token::global_accounting`),
    false,
    "No protocol accounting is accepted after the tUSD capability binding diverges",
  );
});

test("finalized adapter aggregates core pause, AMM pause, shutdown, and seed state", async () => {
  for (const [pause, description] of [
    [[true, false], "core pause"],
    [[false, false], "AMM shutdown"],
    [[false, false], "unseeded pool"],
  ] as const) {
    const fake = new FakeFinalizedClient();
    fake.responses.set(`${CORE}::reflection_token::pauses`, [...pause]);
    if (description === "AMM shutdown") {
      fake.responses.set(`${AMM}::pool::pause_state`, [false, false, false, true, true]);
    }
    if (description === "unseeded pool") {
      fake.responses.set(`${AMM}::pool::pause_state`, [false, false, false, false, false]);
    }
    const pool = await new FinalizedCedraReadAdapter(fake, manifest).getPool();
    equal(pool.swapsPaused, true, `${description} makes swaps unavailable`);
  }
});

test("finalized adapter rejects quote tuples that disagree with exact contract arithmetic", async () => {
  const fake = new FakeFinalizedClient();
  fake.responses.set(`${AMM}::pool::quote_sell`, ["1955", "10", "3"]);
  await rejects(
    () => new FinalizedCedraReadAdapter(fake, manifest).quoteSwap({
      direction: "sell",
      grossAmount: 1_000n,
      slippageBps: 100n,
      deadlineUnixSeconds: 1_700_000_100n,
    }),
    MalformedMoveViewError,
  );
});

test("finalized adapter fails closed when faucet cooldown addition leaves u64 time", async () => {
  const fake = new FakeFinalizedClient();
  fake.responses.set(`${ASSETS}::test_faucet::configuration`, ["1000", "2000", ((1n << 64n) - 1n).toString()]);
  fake.responses.set(`${ASSETS}::test_faucet::last_claim`, [true, "1"]);
  await rejects(
    () => new FinalizedCedraReadAdapter(fake, manifest).getFaucetStatus("0xa11ce", "tRFL"),
    MalformedMoveViewError,
  );
});

test("finalized production adapter rejects non-Testnet manifests", async () => {
  const localManifest = { ...manifest, networkLabel: "local" } as unknown as FinalizedProtocolManifest;
  let rejected = false;
  try {
    new FinalizedCedraReadAdapter(new FakeFinalizedClient(), localManifest);
  } catch (error) {
    rejected = error instanceof TypeError;
  }
  equal(rejected, true, "A local network label cannot instantiate the finalized Testnet adapter");
});

test("finalized production adapter rejects a manifest with a non-Testnet chain ID", () => {
  const wrongChainManifest = { ...manifest, chainId: 4 } as unknown as FinalizedProtocolManifest;
  let rejected = false;
  try {
    new FinalizedCedraReadAdapter(new FakeFinalizedClient(), wrongChainManifest);
  } catch (error) {
    rejected = error instanceof TypeError;
  }
  equal(rejected, true, "The approved manifest itself must bind Cedra Testnet chain 2");
});

test("finalized adapter snapshots its approved manifest against caller mutation", async () => {
  const mutable = {
    ...manifest,
    packages: { ...manifest.packages },
    addresses: { ...manifest.addresses },
  };
  const fake = new FakeFinalizedClient();
  const adapter = new FinalizedCedraReadAdapter(fake, mutable);
  (mutable.addresses as { poolRflReserveStore: string }).poolRflReserveStore = "0x999";
  const pool = await adapter.getPool();
  equal(pool.ledgerVersion, 4_242n, "Caller mutation cannot change the identity used by later reads");
});
