import { createHash } from "node:crypto";

import {
  AccountAddress,
  CEDRA_COIN,
  Cedra,
  CedraConfig,
  MultiAgentTransaction,
  Network,
  SimpleTransaction,
  TransactionPayloadEntryFunction,
  TypeTag,
  generateTransactionPayloadWithABI,
  generateSigningMessageForTransaction,
  parseTypeTag,
  type InputEntryFunctionData,
  type InputEntryFunctionDataWithABI,
  type InputGenerateTransactionOptions,
  type PublicKey,
} from "@cedra-labs/ts-sdk";
import { CEDRA_TESTNET_CHAIN_ID, type Address } from "./types.js";

const MAX_U64 = (1n << 64n) - 1n;

export class CedraReleaseChainIdMismatchError extends Error {
  public constructor(observed: unknown) {
    super(
      `Release transactions must use Cedra Testnet chain ${CEDRA_TESTNET_CHAIN_ID.toString()}; observed ${String(observed)}`,
    );
    this.name = "CedraReleaseChainIdMismatchError";
  }
}

export class CedraReleaseTransactionMismatchError extends Error {
  public constructor(detail: string) {
    super(`Cedra SDK returned a transaction that differs from the explicit release request: ${detail}`);
    this.name = "CedraReleaseTransactionMismatchError";
  }
}

/**
 * Every release-sensitive transaction option is mandatory. The builder must
 * not silently discover a sequence number, gas budget, gas price, or expiry
 * after reviewers approve a payload.
 */
export interface ExplicitReleaseTransactionOptions {
  readonly accountSequenceNumber: NonNullable<InputGenerateTransactionOptions["accountSequenceNumber"]>;
  readonly maxGasAmount: number;
  readonly gasUnitPrice: number;
  readonly expireTimestamp: number;
  readonly faAddress?: NonNullable<InputGenerateTransactionOptions["faAddress"]>;
}

/** Public transaction identity needed to build a Cedra multi-agent envelope. */
export interface MultiAgentEntryRequest {
  readonly senderAddress: Address;
  readonly secondarySignerAddresses: readonly Address[];
  readonly data: InputEntryFunctionData;
  readonly options: ExplicitReleaseTransactionOptions;
}

export interface SingleSignerEntryRequest {
  readonly senderAddress: Address;
  readonly data: InputEntryFunctionData;
  readonly options: ExplicitReleaseTransactionOptions;
}

/** JSON-safe identity of the exact transaction bytes presented for review. */
export interface ReleaseTransactionIdentity {
  readonly transactionType: "single-signer" | "multi-agent";
  readonly senderAddress: Address;
  readonly secondarySignerAddresses: readonly Address[];
  readonly feePayerAddress: Address | null;
  readonly sequenceNumber: string;
  readonly maxGasAmount: string;
  readonly gasUnitPrice: string;
  readonly expirationTimestampSeconds: string;
  readonly chainId: number;
  readonly fungibleAssetGasType: string;
  readonly rawTransactionBcsHex: `0x${string}`;
  readonly rawTransactionSha256: string;
  readonly transactionBcsHex: `0x${string}`;
  readonly transactionSha256: string;
  readonly signingMessageHex: `0x${string}`;
  readonly signingMessageSha256: string;
}

export interface MultiAgentTransactionIdentity extends ReleaseTransactionIdentity {
  readonly transactionType: "multi-agent";
}

export interface SingleSignerTransactionIdentity extends ReleaseTransactionIdentity {
  readonly transactionType: "single-signer";
  readonly secondarySignerAddresses: readonly [];
}

/** Simulation operates on one already-built, already-fingerprinted object. */
export interface MultiAgentSimulationRequest {
  readonly transaction: MultiAgentTransaction;
  readonly expectedIdentity: MultiAgentTransactionIdentity;
  readonly senderPublicKey: PublicKey;
  readonly secondarySignerPublicKeys: readonly PublicKey[];
}

export interface MultiAgentSimulationResult {
  readonly identity: MultiAgentTransactionIdentity;
  readonly responses: Awaited<ReturnType<Cedra["transaction"]["simulate"]["multiAgent"]>>;
}

export interface SingleSignerSimulationRequest {
  readonly transaction: SimpleTransaction;
  readonly expectedIdentity: SingleSignerTransactionIdentity;
  readonly senderPublicKey: PublicKey;
}

export interface SingleSignerSimulationResult {
  readonly identity: SingleSignerTransactionIdentity;
  readonly responses: Awaited<ReturnType<Cedra["transaction"]["simulate"]["simple"]>>;
}

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Derives review evidence from the exact Cedra object. The signing-message
 * digest binds the raw transaction and ordered multi-agent authenticator list.
 */
export function describeMultiAgentTransaction(
  transaction: MultiAgentTransaction,
): MultiAgentTransactionIdentity {
  if (!(transaction instanceof MultiAgentTransaction)) {
    throw new TypeError("Expected a Cedra MultiAgentTransaction instance");
  }
  return describeTransaction(
    transaction,
    "multi-agent",
    transaction.secondarySignerAddresses.map((address) => address.toStringLong() as Address),
  ) as MultiAgentTransactionIdentity;
}

export function describeSingleSignerTransaction(
  transaction: SimpleTransaction,
): SingleSignerTransactionIdentity {
  if (!(transaction instanceof SimpleTransaction)) {
    throw new TypeError("Expected a Cedra SimpleTransaction instance");
  }
  return describeTransaction(transaction, "single-signer", []) as SingleSignerTransactionIdentity;
}

function describeTransaction(
  transaction: MultiAgentTransaction | SimpleTransaction,
  transactionType: ReleaseTransactionIdentity["transactionType"],
  secondarySignerAddresses: readonly Address[],
): ReleaseTransactionIdentity {
  const raw = transaction.rawTransaction;
  const chainId: unknown = raw.chain_id.chainId;
  if (
    typeof chainId !== "number"
    || !Number.isInteger(chainId)
    || chainId !== CEDRA_TESTNET_CHAIN_ID
  ) {
    throw new CedraReleaseChainIdMismatchError(chainId);
  }
  const rawBytes = raw.bcsToBytes();
  const transactionBytes = transaction.bcsToBytes();
  const signingMessage = generateSigningMessageForTransaction(transaction);
  return {
    transactionType,
    senderAddress: raw.sender.toStringLong() as Address,
    secondarySignerAddresses,
    feePayerAddress: transaction.feePayerAddress === undefined
      ? null
      : transaction.feePayerAddress.toStringLong() as Address,
    sequenceNumber: raw.sequence_number.toString(),
    maxGasAmount: raw.max_gas_amount.toString(),
    gasUnitPrice: raw.gas_unit_price.toString(),
    expirationTimestampSeconds: raw.expiration_timestamp_secs.toString(),
    chainId,
    fungibleAssetGasType: raw.fa_address.toString(),
    rawTransactionBcsHex: bytesToHex(rawBytes),
    rawTransactionSha256: sha256(rawBytes),
    transactionBcsHex: bytesToHex(transactionBytes),
    transactionSha256: sha256(transactionBytes),
    signingMessageHex: bytesToHex(signingMessage),
    signingMessageSha256: sha256(signingMessage),
  };
}

function identitiesMatch(
  expected: ReleaseTransactionIdentity,
  observed: ReleaseTransactionIdentity,
): boolean {
  return expected.transactionType === observed.transactionType
    && expected.senderAddress === observed.senderAddress
    && expected.secondarySignerAddresses.length === observed.secondarySignerAddresses.length
    && expected.secondarySignerAddresses.every((address, index) => (
      address === observed.secondarySignerAddresses[index]
    ))
    && expected.feePayerAddress === observed.feePayerAddress
    && expected.sequenceNumber === observed.sequenceNumber
    && expected.maxGasAmount === observed.maxGasAmount
    && expected.gasUnitPrice === observed.gasUnitPrice
    && expected.expirationTimestampSeconds === observed.expirationTimestampSeconds
    && expected.chainId === observed.chainId
    && expected.fungibleAssetGasType === observed.fungibleAssetGasType
    && expected.rawTransactionBcsHex === observed.rawTransactionBcsHex
    && expected.rawTransactionSha256 === observed.rawTransactionSha256
    && expected.transactionBcsHex === observed.transactionBcsHex
    && expected.transactionSha256 === observed.transactionSha256
    && expected.signingMessageHex === observed.signingMessageHex
    && expected.signingMessageSha256 === observed.signingMessageSha256;
}

function canonicalNonzeroAddress(value: unknown, label: string): Address {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a hexadecimal account address string.`);
  }
  let parsed: AccountAddress;
  try {
    parsed = AccountAddress.fromString(value, { maxMissingChars: 63 });
  } catch {
    throw new TypeError(`${label} must be a valid hexadecimal account address string.`);
  }
  if (parsed.equals(AccountAddress.ZERO)) {
    throw new TypeError(`${label} cannot be the zero address.`);
  }
  return parsed.toStringLong() as Address;
}

function explicitSequenceNumber(value: unknown): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError("Account sequence number must be an exact unsigned u64 integer.");
    }
    return BigInt(value);
  }
  if (typeof value !== "bigint") {
    throw new TypeError("Account sequence number must be a bigint or safe integer number.");
  }
  return value;
}

function assertBuiltTransactionMatchesRequest(
  identity: ReleaseTransactionIdentity,
  senderAddress: Address,
  secondarySignerAddresses: readonly Address[],
  options: ExplicitReleaseTransactionOptions,
): void {
  const expectedSender = canonicalNonzeroAddress(senderAddress, "release sender address");
  const expectedSecondary = secondarySignerAddresses.map((address, index) => (
    canonicalNonzeroAddress(address, `secondary signer address ${index.toString()}`)
  ));
  const expectedGasType = (options.faAddress ?? parseTypeTag(CEDRA_COIN)).toString();
  const mismatches: string[] = [];
  if (identity.senderAddress !== expectedSender) mismatches.push("sender address");
  if (
    identity.secondarySignerAddresses.length !== expectedSecondary.length
    || !expectedSecondary.every((address, index) => identity.secondarySignerAddresses[index] === address)
  ) mismatches.push("ordered secondary signer addresses");
  if (identity.feePayerAddress !== null) mismatches.push("unexpected fee payer");
  if (identity.sequenceNumber !== explicitSequenceNumber(options.accountSequenceNumber).toString()) {
    mismatches.push("account sequence number");
  }
  if (identity.maxGasAmount !== options.maxGasAmount.toString()) mismatches.push("maximum gas amount");
  if (identity.gasUnitPrice !== options.gasUnitPrice.toString()) mismatches.push("gas unit price");
  if (identity.expirationTimestampSeconds !== options.expireTimestamp.toString()) {
    mismatches.push("expiration timestamp");
  }
  if (identity.fungibleAssetGasType !== expectedGasType) mismatches.push("gas asset type");
  if (mismatches.length > 0) {
    throw new CedraReleaseTransactionMismatchError(mismatches.join(", "));
  }
}

function assertBuiltPayloadMatchesRequest(
  transaction: MultiAgentTransaction | SimpleTransaction,
  data: InputEntryFunctionData,
): void {
  const payload = transaction.rawTransaction.payload;
  if (!(payload instanceof TransactionPayloadEntryFunction)) {
    throw new CedraReleaseTransactionMismatchError("payload is not an entry function");
  }
  if (typeof data.function !== "string") {
    throw new TypeError("Release entry function must be a fully qualified string.");
  }
  const parts = data.function.split("::");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new TypeError("Release entry function must be address::module::function.");
  }
  const [address, moduleName, functionName] = parts as [string, string, string];
  const entry = payload.entryFunction;
  const mismatches: string[] = [];
  if (entry.module_name.address.toStringLong() !== canonicalNonzeroAddress(address, "entry-function module address")) {
    mismatches.push("entry-function module address");
  }
  if (entry.module_name.name.identifier !== moduleName) mismatches.push("entry-function module name");
  if (entry.function_name.identifier !== functionName) mismatches.push("entry-function name");

  if (!Array.isArray(data.functionArguments) || !Array.isArray(data.typeArguments ?? [])) {
    throw new TypeError("Release entry-function arguments must be ordered arrays.");
  }
  if (entry.args.length !== data.functionArguments.length) mismatches.push("entry-function argument count");
  const expectedTypeArguments = (data.typeArguments ?? []).map((argument) => {
    if (typeof argument === "string") return parseTypeTag(argument).toString();
    if (!(argument instanceof TypeTag)) {
      throw new TypeError("Release type arguments must be strings or official Cedra TypeTag instances.");
    }
    return argument.toString();
  });
  if (
    entry.type_args.length !== expectedTypeArguments.length
    || !expectedTypeArguments.every((argument, index) => entry.type_args[index]?.toString() === argument)
  ) mismatches.push("entry-function type arguments");

  const expected = generateTransactionPayloadWithABI(data as InputEntryFunctionDataWithABI);
  if (bytesToHex(expected.bcsToBytes()) !== bytesToHex(payload.bcsToBytes())) {
    mismatches.push("entry-function payload BCS");
  }
  if (mismatches.length > 0) {
    throw new CedraReleaseTransactionMismatchError(mismatches.join(", "));
  }
}

function assertLocalReleaseAbi(data: InputEntryFunctionData, expectedSigners: number): void {
  if (
    typeof data !== "object"
    || data === null
    || typeof data.abi !== "object"
    || data.abi === null
    || !Array.isArray(data.abi.typeParameters)
    || !Array.isArray(data.abi.parameters)
  ) {
    throw new TypeError("Release entries require an explicit local ABI; remote ABI discovery is forbidden.");
  }
  if (!Number.isSafeInteger(data.abi.signers) || data.abi.signers !== expectedSigners) {
    throw new TypeError(`Release ABI must declare exactly ${expectedSigners.toString()} ordered signer(s).`);
  }
  if (!Array.isArray(data.functionArguments) || !Array.isArray(data.typeArguments ?? [])) {
    throw new TypeError("Release entry-function arguments must be ordered arrays.");
  }
}

/**
 * Official-SDK boundary for initialization, liquidity seeding, and authority
 * handoffs. It can only build and simulate. Authenticated approvals, signing,
 * and submission belong to a separate reviewed release ceremony.
 */
export class CedraReleaseClient {
  public constructor(private readonly cedra: Cedra) {}

  public static forTestnet(): CedraReleaseClient {
    return new CedraReleaseClient(new Cedra(new CedraConfig({ network: Network.TESTNET })));
  }

  public async buildMultiAgent(request: MultiAgentEntryRequest): Promise<MultiAgentTransaction> {
    this.assertDistinctSignerAddresses(request.senderAddress, request.secondarySignerAddresses);
    this.assertExplicitOptions(request.options);
    assertLocalReleaseAbi(request.data, 1 + request.secondarySignerAddresses.length);
    const transaction = await this.cedra.transaction.build.multiAgent({
      sender: request.senderAddress,
      secondarySignerAddresses: [...request.secondarySignerAddresses],
      data: request.data,
      options: request.options,
      withFeePayer: false,
    });
    // Never trust an injected client or endpoint configuration to preserve the
    // release network. The exact built object is rejected before it can be
    // fingerprinted, simulated, or presented for approval.
    const identity = describeMultiAgentTransaction(transaction);
    assertBuiltPayloadMatchesRequest(transaction, request.data);
    assertBuiltTransactionMatchesRequest(
      identity,
      request.senderAddress,
      request.secondarySignerAddresses,
      request.options,
    );
    return transaction;
  }

  public async buildSingleSigner(request: SingleSignerEntryRequest): Promise<SimpleTransaction> {
    this.assertDistinctSignerAddresses(request.senderAddress, [], false);
    this.assertExplicitOptions(request.options);
    assertLocalReleaseAbi(request.data, 1);
    const transaction = await this.cedra.transaction.build.simple({
      sender: request.senderAddress,
      data: request.data,
      options: request.options,
      withFeePayer: false,
    });
    const identity = describeSingleSignerTransaction(transaction);
    assertBuiltPayloadMatchesRequest(transaction, request.data);
    assertBuiltTransactionMatchesRequest(identity, request.senderAddress, [], request.options);
    return transaction;
  }

  public async simulateMultiAgent(request: MultiAgentSimulationRequest): Promise<MultiAgentSimulationResult> {
    const identity = describeMultiAgentTransaction(request.transaction);
    if (!identitiesMatch(request.expectedIdentity, identity)) {
      throw new Error("The transaction presented for simulation differs from the reviewed BCS/signing identity.");
    }
    if (request.secondarySignerPublicKeys.length !== identity.secondarySignerAddresses.length) {
      throw new Error("Every ordered secondary signer address requires exactly one matching public key.");
    }
    const responses = await this.cedra.transaction.simulate.multiAgent({
      transaction: request.transaction,
      signerPublicKey: request.senderPublicKey,
      secondarySignersPublicKeys: [...request.secondarySignerPublicKeys],
    });
    return { identity, responses };
  }

  public async simulateSingleSigner(request: SingleSignerSimulationRequest): Promise<SingleSignerSimulationResult> {
    const identity = describeSingleSignerTransaction(request.transaction);
    if (!identitiesMatch(request.expectedIdentity, identity)) {
      throw new Error("The single-signer transaction differs from the reviewed BCS/signing identity.");
    }
    const responses = await this.cedra.transaction.simulate.simple({
      transaction: request.transaction,
      signerPublicKey: request.senderPublicKey,
    });
    return { identity, responses };
  }

  private assertDistinctSignerAddresses(
    senderAddress: Address,
    secondarySignerAddresses: readonly Address[],
    requireSecondarySigner = true,
  ): void {
    if (!Array.isArray(secondarySignerAddresses)) {
      throw new TypeError("Secondary signer addresses must be an ordered array.");
    }
    if (requireSecondarySigner && secondarySignerAddresses.length === 0) {
      throw new Error("A multi-agent operation requires at least one secondary signer.");
    }
    const addresses = [senderAddress, ...secondarySignerAddresses].map((address, index) => (
      canonicalNonzeroAddress(address, index === 0 ? "release sender address" : `secondary signer address ${(index - 1).toString()}`)
    ));
    if (new Set(addresses).size !== addresses.length) {
      throw new Error("Every multi-agent signer must have a distinct canonical address.");
    }
  }

  private assertExplicitOptions(options: ExplicitReleaseTransactionOptions): void {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("Explicit release transaction options are required.");
    }
    const sequenceNumber = explicitSequenceNumber(options.accountSequenceNumber);
    if (sequenceNumber < 0n || sequenceNumber > MAX_U64) {
      throw new RangeError("Account sequence number must be an unsigned u64 integer.");
    }
    for (const [label, value, allowZero] of [
      ["maximum gas amount", options.maxGasAmount, false],
      // SDK 2.2.8 treats zero as "not supplied" and may perform an RPC gas
      // estimate, which would mutate the exact reviewed candidate inputs.
      ["gas unit price", options.gasUnitPrice, false],
      ["expiration timestamp", options.expireTimestamp, false],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
        throw new RangeError(`${label} must be an explicit safe unsigned integer${allowZero ? "" : " greater than zero"}.`);
      }
    }
    if (options.faAddress !== undefined && !(options.faAddress instanceof TypeTag)) {
      throw new TypeError("Fungible-asset gas type must be an official Cedra TypeTag instance.");
    }
  }
}
