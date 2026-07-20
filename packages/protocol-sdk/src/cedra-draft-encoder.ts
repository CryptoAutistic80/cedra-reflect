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
  readonly argumentCount: number;
}

const ENTRY_SHAPES: Readonly<Record<TransactionDraft["kind"], readonly EntryShape[]>> = {
  faucet_claim: [
    { functionId: "test_assets::test_faucet::claim_trfl", argumentCount: 0 },
    { functionId: "test_assets::test_faucet::claim_tusd", argumentCount: 0 },
  ],
  swap: [
    { functionId: "test_amm::pool::buy_trfl", argumentCount: 3 },
    { functionId: "test_amm::pool::sell_trfl", argumentCount: 3 },
  ],
  claim_rewards: [
    { functionId: "reflection_core::reflection_token::claim", argumentCount: 1 },
    { functionId: "reflection_core::reflection_token::claim_all", argumentCount: 0 },
  ],
  add_liquidity: [
    { functionId: "test_amm::pool::add_liquidity", argumentCount: 4 },
  ],
  remove_liquidity: [
    { functionId: "test_amm::pool::remove_liquidity", argumentCount: 4 },
  ],
  transfer_lp_shares: [
    { functionId: "test_amm::pool::transfer_lp_shares", argumentCount: 2 },
  ],
  claim_lp_rewards: [
    { functionId: "test_amm::pool::claim_lp_rewards", argumentCount: 2 },
  ],
  checkpoint_lp_rewards: [
    { functionId: "test_amm::pool::checkpoint_lp_rewards", argumentCount: 0 },
  ],
  configure_liquidity_limits: [
    { functionId: "test_amm::pool::configure_liquidity_limits", argumentCount: 3 },
  ],
  set_faucet_paused: [
    { functionId: "test_assets::test_faucet::set_paused", argumentCount: 1 },
  ],
  set_operational_admin: [
    { functionId: "reflection_core::reflection_token::set_operational_admin", argumentCount: 1 },
    { functionId: "test_assets::test_faucet::set_operational_admin", argumentCount: 1 },
    { functionId: "test_amm::pool::set_operational_admin", argumentCount: 1 },
  ],
};

function assertKnownEntryShape(draft: TransactionDraft): void {
  const matches = ENTRY_SHAPES[draft.kind].some((shape) => (
    shape.functionId === draft.functionId && shape.argumentCount === draft.arguments.length
  ));
  if (!matches) {
    throw new TypeError(`Draft kind ${draft.kind} does not match a supported entry-function shape`);
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
  assertKnownEntryShape(draft);
  const parts = draft.functionId.split("::");
  if (parts.length !== 3) {
    throw new TypeError(`Unqualified draft function id: ${draft.functionId}`);
  }
  const [packageName, moduleName, functionName] = parts;
  const publisher = packageName === "reflection_core"
    ? modules.reflectionCore
    : packageName === "test_assets"
      ? modules.testAssets
      : packageName === "test_amm"
        ? modules.testAmm
        : undefined;
  if (publisher === undefined) {
    throw new TypeError(`Draft refers to unsupported package ${packageName}`);
  }
  return {
    function: `${publisher}::${moduleName}::${functionName}` as InputEntryFunctionData["function"],
    functionArguments: draft.arguments.map((argument) => (
      typeof argument === "bigint" ? argument.toString() : argument
    )),
  };
}
