import {
  Cedra,
  CedraConfig,
  Network,
  isUserTransactionResponse,
  type MoveFunctionId,
  type MoveValue,
} from "@cedra-labs/ts-sdk";

declare const process: {
  readonly argv: readonly string[];
  exitCode?: number;
};

const SDK_VERSION = "2.2.8";

function requiredArgument(index: number, name: string): string {
  const value = process.argv[index];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

function functionId(address: string, module: string, name: string): MoveFunctionId {
  return `${address}::${module}::${name}` as MoveFunctionId;
}

function scalar(result: MoveValue[], name: string): string {
  const value = result[0];
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`${name} did not return a scalar value.`);
  }
  return value.toString();
}

function objectAddress(result: MoveValue[], name: string): string {
  const value = result[0];
  if (typeof value !== "object" || value === null || !("inner" in value)) {
    throw new Error(`${name} did not return an object address.`);
  }
  const inner = value.inner;
  if (typeof inner !== "string") {
    throw new Error(`${name} returned a malformed object address.`);
  }
  return inner;
}

async function main(): Promise<void> {
  const packageAddress = requiredArgument(2, "probe package address");
  const holderAddress = requiredArgument(3, "holder address");
  const ledgerVersion = requiredArgument(4, "ledger version");
  const transactionHash = requiredArgument(5, "reference transaction hash");
  const cedra = new Cedra(new CedraConfig({ network: Network.TESTNET }));
  const options = { ledgerVersion: BigInt(ledgerVersion) };

  const [
    metadataResult,
    primaryRawResult,
    primaryDerivedResult,
    secondaryStoreResult,
    secondaryRawResult,
    secondaryDerivedResult,
    vaultResult,
    transaction,
  ] = await Promise.all([
    cedra.viewJson({
      payload: {
        function: functionId(packageAddress, "hook_probe", "metadata"),
        typeArguments: [],
        functionArguments: [],
      },
      options,
    }),
    cedra.viewJson({
      payload: {
        function: functionId(packageAddress, "hook_probe", "raw_balance"),
        typeArguments: [],
        functionArguments: [holderAddress],
      },
      options,
    }),
    cedra.viewJson({
      payload: {
        function: functionId(packageAddress, "probe_driver", "primary_derived_balance"),
        typeArguments: [],
        functionArguments: [holderAddress],
      },
      options,
    }),
    cedra.viewJson({
      payload: {
        function: functionId(packageAddress, "probe_driver", "secondary_store"),
        typeArguments: [],
        functionArguments: [holderAddress],
      },
      options,
    }),
    cedra.viewJson({
      payload: {
        function: functionId(packageAddress, "probe_driver", "secondary_raw_balance"),
        typeArguments: [],
        functionArguments: [holderAddress],
      },
      options,
    }),
    cedra.viewJson({
      payload: {
        function: functionId(packageAddress, "probe_driver", "secondary_derived_balance"),
        typeArguments: [],
        functionArguments: [holderAddress],
      },
      options,
    }),
    cedra.viewJson({
      payload: {
        function: functionId(packageAddress, "hook_probe", "reward_vault_balance"),
        typeArguments: [],
        functionArguments: [],
      },
      options,
    }),
    cedra.getTransactionByHash({ transactionHash }),
  ]);

  const metadata = objectAddress(metadataResult, "metadata");
  const standardPrimaryResult = await cedra.viewJson({
    payload: {
      function: "0x1::primary_fungible_store::balance",
      typeArguments: ["0x1::fungible_asset::Metadata"],
      functionArguments: [holderAddress, metadata],
    },
    options,
  });

  if (!isUserTransactionResponse(transaction)) {
    throw new Error("Reference transaction is not a finalized user transaction.");
  }

  const values = {
    primary_raw: scalar(primaryRawResult, "primary raw balance"),
    primary_derived: scalar(primaryDerivedResult, "primary derived balance"),
    primary_standard: scalar(standardPrimaryResult, "standard primary balance"),
    secondary_store: scalar(secondaryStoreResult, "secondary store"),
    secondary_raw: scalar(secondaryRawResult, "secondary raw balance"),
    secondary_derived: scalar(secondaryDerivedResult, "secondary derived balance"),
    reward_vault: scalar(vaultResult, "reward vault balance"),
  };
  if (values.primary_raw !== values.primary_derived || values.primary_raw !== values.primary_standard) {
    throw new Error("Primary raw, derived, and standard balances diverged.");
  }
  if (values.secondary_raw !== values.secondary_derived) {
    throw new Error("Secondary raw and derived balances diverged.");
  }
  if (transaction.version !== ledgerVersion || !transaction.success) {
    throw new Error("Reference transaction is not the requested successful ledger version.");
  }

  const relevantEvents = transaction.events
    .filter((event) => (
      event.type === "0x1::fungible_asset::Withdraw"
      || event.type === "0x1::fungible_asset::Deposit"
      || event.type === functionId(packageAddress, "probe_driver", "SecondaryStoreFunded")
    ))
    .map((event) => ({ type: event.type, data: event.data }));

  console.log(JSON.stringify({
    network: "cedra-testnet",
    sdk_version: SDK_VERSION,
    package_address: packageAddress,
    holder_address: holderAddress,
    ledger_version: ledgerVersion,
    transaction_hash: transactionHash,
    metadata,
    values,
    relevant_events: relevantEvents,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
