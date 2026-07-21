import type { InputEntryFunctionData } from "@cedra-labs/ts-sdk";
import type { Address, ProtocolAddresses, TransactionDraft } from "./types.js";

/** Package publishers, recorded only after a finalized deployment. */
export interface ProtocolModuleAddresses {
  readonly reflectionCore: Address;
  readonly testAssets: Address;
  readonly testAmm: Address;
}

export interface DeployedProtocolAddresses extends ProtocolAddresses {
  readonly modules: ProtocolModuleAddresses;
}

interface EntryShape {
  readonly functionId: string;
  readonly argumentKinds: readonly MoveArgumentKind[];
}

type MoveArgumentKind = "u64" | "u128" | "address";
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

const ENTRY_SHAPES: Readonly<Record<TransactionDraft["kind"], readonly EntryShape[]>> = {
  faucet_claim: [
    { functionId: "test_assets::test_faucet::claim_trfl", argumentKinds: [] },
    { functionId: "test_assets::test_faucet::claim_tusd", argumentKinds: [] },
  ],
  swap: [
    { functionId: "test_amm::pool::buy_trfl", argumentKinds: ["u64", "u64", "u64"] },
    { functionId: "test_amm::pool::sell_trfl", argumentKinds: ["u64", "u64", "u64"] },
  ],
  claim_rewards: [
    { functionId: "reflection_core::reflection_token::claim", argumentKinds: ["u64"] },
    { functionId: "reflection_core::reflection_token::claim_all", argumentKinds: [] },
  ],
  add_liquidity: [
    { functionId: "test_amm::pool::add_liquidity", argumentKinds: ["u64", "u64", "u128", "u64"] },
  ],
  remove_liquidity: [
    { functionId: "test_amm::pool::remove_liquidity", argumentKinds: ["u128", "u64", "u64", "u64"] },
  ],
  transfer_lp_shares: [
    { functionId: "test_amm::pool::transfer_lp_shares", argumentKinds: ["address", "u128"] },
  ],
  claim_lp_rewards: [
    { functionId: "test_amm::pool::claim_lp_rewards", argumentKinds: ["u64", "u64"] },
  ],
  checkpoint_lp_rewards: [
    { functionId: "test_amm::pool::checkpoint_lp_rewards", argumentKinds: [] },
  ],
};

function knownEntryShape(draft: TransactionDraft): EntryShape {
  if (typeof draft !== "object" || draft === null) {
    throw new TypeError("Cedra transaction draft must be an object");
  }
  const candidate = draft as Partial<TransactionDraft>;
  if (
    typeof candidate.kind !== "string"
    || !Object.prototype.hasOwnProperty.call(ENTRY_SHAPES, candidate.kind)
    || typeof candidate.functionId !== "string"
    || !Array.isArray(candidate.arguments)
    || !Array.isArray(candidate.secondarySignerAddresses)
    || typeof candidate.expirationUnixSeconds !== "bigint"
    || candidate.expirationUnixSeconds <= 0n
    || candidate.expirationUnixSeconds > U64_MAX
    || typeof candidate.warning !== "string"
    || candidate.warning.length === 0
  ) {
    throw new TypeError("Cedra transaction draft has invalid runtime fields");
  }
  const shapes = ENTRY_SHAPES[candidate.kind as TransactionDraft["kind"]];
  const match = shapes.find((shape) => (
    shape.functionId === candidate.functionId
    && shape.argumentKinds.length === candidate.arguments!.length
    && candidate.secondarySignerAddresses!.length === 0
  ));
  if (match === undefined) {
    throw new TypeError(`Draft kind ${draft.kind} does not match a supported entry-function shape`);
  }
  for (let index = 0; index < match.argumentKinds.length; index += 1) {
    assertMoveArgument(candidate.arguments[index], match.argumentKinds[index]!, index);
  }
  for (const signer of candidate.secondarySignerAddresses) canonicalAddressKey(signer);
  assertEntrySemantics(draft, match);
  return match;
}

/** Runtime validation for drafts crossing an adapter or application boundary. */
export function assertCedraTransactionDraft(draft: TransactionDraft): void {
  knownEntryShape(draft);
}

function assertMoveArgument(value: unknown, kind: MoveArgumentKind, index: number): void {
  if (kind === "address") {
    canonicalAddressKey(value);
    return;
  }
  const maximum = kind === "u64" ? U64_MAX : U128_MAX;
  if (typeof value !== "bigint" || value < 0n || value > maximum) {
    throw new TypeError(`Move argument ${index.toString()} must be a bigint in the ${kind} domain`);
  }
}

function assertPositiveArgument(draft: TransactionDraft, index: number, label: string): void {
  const value = draft.arguments[index];
  if (typeof value !== "bigint" || value <= 0n) throw new RangeError(`${label} must be positive`);
}

function assertEntrySemantics(draft: TransactionDraft, shape: EntryShape): void {
  switch (shape.functionId) {
    case "reflection_core::reflection_token::claim":
      assertPositiveArgument(draft, 0, "reward claim amount");
      break;
    case "test_amm::pool::buy_trfl":
    case "test_amm::pool::sell_trfl":
      assertPositiveArgument(draft, 0, "swap gross amount");
      assertDeadlineMatchesExpiration(draft, 2);
      break;
    case "test_amm::pool::add_liquidity":
      assertPositiveArgument(draft, 0, "maximum tRFL contribution");
      assertPositiveArgument(draft, 1, "maximum tUSD contribution");
      assertDeadlineMatchesExpiration(draft, 3);
      break;
    case "test_amm::pool::remove_liquidity":
      assertPositiveArgument(draft, 0, "LP shares");
      assertDeadlineMatchesExpiration(draft, 3);
      break;
    case "test_amm::pool::transfer_lp_shares":
      assertPositiveArgument(draft, 1, "LP shares");
      break;
    case "test_amm::pool::claim_lp_rewards":
      assertPositiveArgument(draft, 0, "LP epoch");
      break;
    default:
      break;
  }
}

function assertDeadlineMatchesExpiration(draft: TransactionDraft, index: number): void {
  const deadline = draft.arguments[index];
  if (typeof deadline !== "bigint" || deadline <= 0n || deadline !== draft.expirationUnixSeconds) {
    throw new RangeError("on-chain deadline must be positive and equal the transaction draft expiration");
  }
}

/**
 * Turns a pure UI transaction draft into the official SDK's entry-function
 * payload. The connected wallet supplies the transaction signer; no account
 * address is accepted as a forged function argument.
 */
export function encodeCedraEntryFunction(
  draft: TransactionDraft,
  modules: ProtocolModuleAddresses,
): InputEntryFunctionData {
  knownEntryShape(draft);
  if (draft.secondarySignerAddresses.length > 0) {
    throw new TypeError(
      "A multi-agent draft cannot be encoded as a single-signer entry. Use encodeCedraMultiAgentEntryFunction instead.",
    );
  }
  return encodePayload(draft, modules);
}

function canonicalAddressKey(address: unknown): string {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(address)) {
    throw new TypeError(`Invalid Cedra account address: ${String(address)}`);
  }
  const key = address.slice(2).replace(/^0+/, "").toLowerCase() || "0";
  if (key === "0") {
    throw new TypeError("Cedra signer and module publisher addresses cannot be zero");
  }
  return key;
}

function publisherForFunction(
  functionId: string,
  modules: ProtocolModuleAddresses,
): Address {
  const packageName = functionId.split("::")[0];
  const publisher = packageName === "reflection_core"
    ? modules.reflectionCore
    : packageName === "test_assets"
      ? modules.testAssets
      : packageName === "test_amm"
        ? modules.testAmm
        : undefined;
  if (publisher === undefined) {
    throw new TypeError(`Draft refers to unsupported package ${packageName ?? ""}`);
  }
  canonicalAddressKey(publisher);
  return publisher;
}

function assertModuleAddresses(modules: ProtocolModuleAddresses): void {
  const keys = [modules.reflectionCore, modules.testAssets, modules.testAmm].map(canonicalAddressKey);
  if (new Set(keys).size !== keys.length) {
    throw new TypeError("Core, asset, and AMM package publishers must be distinct canonical addresses");
  }
}

function encodePayload(
  draft: TransactionDraft,
  modules: ProtocolModuleAddresses,
): InputEntryFunctionData {
  assertModuleAddresses(modules);
  const parts = draft.functionId.split("::");
  if (parts.length !== 3) {
    throw new TypeError(`Unqualified draft function id: ${draft.functionId}`);
  }
  const [packageName, moduleName, functionName] = parts;
  const publisher = publisherForFunction(draft.functionId, modules);
  return {
    function: `${publisher}::${moduleName}::${functionName}` as InputEntryFunctionData["function"],
    functionArguments: draft.arguments.map((argument) => (
      typeof argument === "bigint" ? argument.toString() : argument
    )),
  };
}
