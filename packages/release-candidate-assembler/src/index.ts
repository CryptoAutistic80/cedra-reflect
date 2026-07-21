import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  CEDRA_COIN,
  Ed25519PublicKey,
  MoveVector,
  TypeTagU64,
  TypeTagVector,
  U64,
  parseTypeTag,
  type EntryFunctionABI,
  type InputEntryFunctionData,
  type MultiAgentTransaction,
  type PublicKey,
  type SimpleTransaction,
} from "@cedra-labs/ts-sdk";

import {
  CedraReleaseClient,
  describeMultiAgentTransaction,
  describeSingleSignerTransaction,
  type MultiAgentSimulationResult,
  type ReleaseTransactionIdentity,
  type SingleSignerSimulationResult,
} from "../../protocol-sdk/src/index.js";
import type { Address } from "../../protocol-sdk/src/types.js";
import {
  REVIEWED_SDK_PACKAGE,
  REVIEWED_SDK_VERSION,
  validateBuildIntegrityEvidence,
  type BuildIntegrityEvidence,
} from "./build-integrity.js";

export * from "./atomic-output.js";
export * from "./build-integrity.js";

export const RELEASE_OPERATION_KEYS = [
  "core_publish",
  "core_initialize",
  "assets_publish",
  "amm_publish",
  "pool_launch",
] as const;

export const RELEASE_ROLE_KEYS = [
  "core_publisher",
  "assets_publisher",
  "amm_publisher",
  "bootstrap_lp",
] as const;

export type ReleaseOperationKey = typeof RELEASE_OPERATION_KEYS[number];
export type ReleaseRoleKey = typeof RELEASE_ROLE_KEYS[number];
export type RoleMap = Readonly<Record<ReleaseRoleKey, Address>>;
export type PublicKeyMap = Readonly<Record<ReleaseRoleKey, `ed25519-pub-0x${string}`>>;

type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type JsonObject = { readonly [key: string]: JsonValue };

const TESTNET_CHAIN_ID = 2;
const TESTNET_CHAIN_ID_TEXT = "2";
const TESTNET_API_URL = "https://testnet.cedra.dev/v1";
const TESTNET_NETWORK = "cedra-testnet";
const SDK_VERSION = REVIEWED_SDK_VERSION;
const PROFILE_DERIVATION_METHOD = "sha3-256(ed25519_public_key_bytes || 0x00)";
const PROFILE_DERIVATION_TOOL = "OpenSSL dgst -sha3-256";
const MAX_U64 = (1n << 64n) - 1n;
const MAX_U128 = (1n << 128n) - 1n;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DEPLOYMENT_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const PUBLIC_KEY_PATTERN = /^ed25519-pub-0x[0-9a-f]{64}$/;
const ZERO_SIMULATION_SIGNATURE = `0x${"00".repeat(64)}`;
const PROFILE_NAMES: Readonly<Record<ReleaseRoleKey, string>> = {
  core_publisher: "cedra-reflect-core-publisher",
  assets_publisher: "cedra-reflect-assets-publisher",
  amm_publisher: "cedra-reflect-amm-publisher",
  bootstrap_lp: "cedra-reflect-bootstrap-lp",
};

export interface TransactionControls {
  readonly sequence_number: string;
  readonly max_gas_amount: string;
  readonly gas_unit_price: string;
  readonly expiration_timestamp_secs: string;
}

export interface GasBudget {
  readonly approved_max_gas_amount: string;
  readonly approved_max_gas_unit_price: string;
  readonly approved_max_total_fee_base_units: string;
}

export interface TransactionBuildRequest {
  readonly schema_version: 1;
  readonly evidence_scope: "testnet-transaction-build-request";
  readonly network: "cedra-testnet";
  readonly api_url: "https://testnet.cedra.dev/v1";
  readonly chain_id: "2";
  readonly gas_asset: typeof CEDRA_COIN;
  readonly deployment_id: string;
  readonly operation_key: ReleaseOperationKey;
  readonly application_commit: string;
  readonly exact_address_artifacts_sha256: string;
  readonly public_profile_evidence_sha256: string;
  readonly roles: RoleMap;
  readonly profile_public_keys: PublicKeyMap;
  readonly transaction_controls: TransactionControls;
  readonly gas_budget: GasBudget;
}

export interface RepositoryAssemblyState {
  readonly statusPorcelain: string;
  readonly headCommit: string;
  readonly headTree: string;
}

export interface BuildEnvironmentEvidence extends BuildIntegrityEvidence {
  readonly repository_head_commit: string;
  readonly repository_head_tree: string;
}

interface ExactPackageBinding {
  readonly publish_payload_file: string;
  readonly publish_payload_sha256: string;
  readonly compiled_package_files_manifest_sha256: string;
}

export interface ValidatedAssemblyContext {
  readonly exactArtifactsPath: string;
  readonly exactAddressArtifactsSha256: string;
  readonly applicationCommit: string;
  readonly applicationTree: string;
  readonly buildEnvironment: BuildEnvironmentEvidence;
  readonly roles: RoleMap;
  readonly profileEvidenceSha256: string;
  readonly publicRoleCandidateSha256: string;
  readonly profileDerivationMethod: typeof PROFILE_DERIVATION_METHOD;
  readonly profileDerivationTool: typeof PROFILE_DERIVATION_TOOL;
  readonly profileBindings: Readonly<Record<ReleaseRoleKey, {
    readonly profile_name: string;
    readonly address: Address;
    readonly public_key: `ed25519-pub-0x${string}`;
  }>>;
  readonly publicKeys: Readonly<Record<ReleaseRoleKey, Ed25519PublicKey>>;
  readonly packages: Readonly<Record<"reflection_core" | "test_assets" | "test_amm", ExactPackageBinding>>;
  readonly request: TransactionBuildRequest;
}

export type ReleaseClientPort = Pick<
  CedraReleaseClient,
  "buildMultiAgent" | "buildSingleSigner" | "simulateMultiAgent" | "simulateSingleSigner"
>;

interface TransactionPayloadEvidence {
  readonly type: "entry_function_payload";
  readonly function: `${string}::${string}::${string}`;
  readonly type_arguments: readonly string[];
  readonly arguments: readonly JsonValue[];
}

interface TransactionEvidence {
  readonly sender: Address;
  readonly secondary_signers: readonly Address[];
  readonly sequence_number: string;
  readonly expiration_timestamp_secs: string;
  readonly max_gas_amount: string;
  readonly gas_unit_price: string;
  readonly payload: TransactionPayloadEvidence;
}

type TransactionKind =
  | "package_publish"
  | "core_initialize"
  | "pool_launch";

interface PublishBinding {
  readonly package_key: "reflection_core" | "test_assets" | "test_amm";
  readonly publish_payload_sha256: string;
  readonly compiled_package_files_manifest_sha256: string;
}

export interface BuiltReleaseCandidate {
  readonly context: ValidatedAssemblyContext;
  readonly transactionKind: TransactionKind;
  readonly transaction: SimpleTransaction | MultiAgentTransaction;
  readonly transactionEvidence: TransactionEvidence;
  readonly transactionIdentity: ReleaseTransactionIdentity;
  readonly transactionSemanticsSha256: string;
  readonly publishBinding: PublishBinding | null;
  readonly senderRole: ReleaseRoleKey;
  readonly secondarySignerRoles: readonly ReleaseRoleKey[];
  readonly localAbi: EntryFunctionABI;
}

export interface CandidateBundle {
  readonly candidate: JsonObject;
  readonly simulationResponse: JsonObject;
}

function fail(message: string): never {
  throw new Error(message);
}

function exactObject(value: unknown, expectedKeys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} keys mismatch; expected ${expected.join(", ")}`);
  }
  return object;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || (pattern !== undefined && !pattern.test(value))) {
    fail(`${label} has an invalid value`);
  }
  return value;
}

function canonicalAddress(value: unknown, label: string): Address {
  const text = stringValue(value, label);
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(text)) {
    fail(`${label} is not a Cedra address`);
  }
  const digits = text.slice(2).toLowerCase().replace(/^0+/, "") || "0";
  if (digits === "0") {
    fail(`${label} must be non-zero`);
  }
  return `0x${digits}`;
}

function decimalValue(value: unknown, label: string, maximum: bigint, positive: boolean): string {
  const text = stringValue(value, label, DECIMAL_PATTERN);
  const number = BigInt(text);
  if ((positive && number === 0n) || number > maximum) {
    fail(`${label} is outside the permitted unsigned range`);
  }
  return text;
}

function safeNumber(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    fail(`${label} exceeds the exact integer range supported by Cedra SDK transaction options`);
  }
  return number;
}

function parseRoles(value: unknown, label: string): RoleMap {
  const object = exactObject(value, RELEASE_ROLE_KEYS, label);
  const result = {} as Record<ReleaseRoleKey, Address>;
  for (const role of RELEASE_ROLE_KEYS) {
    result[role] = canonicalAddress(object[role], `${label}.${role}`);
  }
  if (new Set(Object.values(result)).size !== RELEASE_ROLE_KEYS.length) {
    fail(`${label} must contain five distinct addresses`);
  }
  return result;
}

function parsePublicKeys(value: unknown, label: string): PublicKeyMap {
  const object = exactObject(value, RELEASE_ROLE_KEYS, label);
  const result = {} as Record<ReleaseRoleKey, `ed25519-pub-0x${string}`>;
  for (const role of RELEASE_ROLE_KEYS) {
    result[role] = stringValue(object[role], `${label}.${role}`, PUBLIC_KEY_PATTERN) as `ed25519-pub-0x${string}`;
  }
  if (new Set(Object.values(result)).size !== RELEASE_ROLE_KEYS.length) {
    fail(`${label} must contain four distinct Ed25519 public keys`);
  }
  return result;
}

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function sortedJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry) => sortedJsonValue(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, sortedJsonValue(entry)]),
    );
  }
  return value;
}

export function assertRuntimeSdkPackage(value: unknown, label = "loaded Cedra SDK package"): void {
  const manifest = objectValue(value, label);
  if (manifest.name !== REVIEWED_SDK_PACKAGE || manifest.version !== SDK_VERSION) {
    fail(`${label} must be ${REVIEWED_SDK_PACKAGE} ${SDK_VERSION}`);
  }
}

export function canonicalJsonBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(sortedJsonValue(value))}\n`);
}

function jsonSafe(value: unknown): JsonValue {
  const encoded = JSON.stringify(value, (_key, entry: unknown) => typeof entry === "bigint" ? entry.toString() : entry);
  if (encoded === undefined) {
    fail("value cannot be represented as JSON evidence");
  }
  return JSON.parse(encoded) as JsonValue;
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(sortedJsonValue(left)) === JSON.stringify(sortedJsonValue(right));
}

function parseBuildRequest(value: unknown): TransactionBuildRequest {
  const request = exactObject(value, [
    "schema_version",
    "evidence_scope",
    "network",
    "api_url",
    "chain_id",
    "gas_asset",
    "deployment_id",
    "operation_key",
    "application_commit",
    "exact_address_artifacts_sha256",
    "public_profile_evidence_sha256",
    "roles",
    "profile_public_keys",
    "transaction_controls",
    "gas_budget",
  ], "transaction build request");
  if (request.schema_version !== 1 || request.evidence_scope !== "testnet-transaction-build-request") {
    fail("transaction build request schema or evidence scope mismatch");
  }
  if (request.network !== TESTNET_NETWORK || request.api_url !== TESTNET_API_URL || request.chain_id !== TESTNET_CHAIN_ID_TEXT) {
    fail("transaction build request must be pinned to Cedra Testnet chain 2");
  }
  if (request.gas_asset !== CEDRA_COIN) {
    fail(`transaction build request gas_asset must be the default CED type ${CEDRA_COIN}`);
  }
  const operation = stringValue(request.operation_key, "operation_key") as ReleaseOperationKey;
  if (!RELEASE_OPERATION_KEYS.includes(operation)) {
    fail(`unsupported release operation_key: ${operation}`);
  }
  const controlsObject = exactObject(request.transaction_controls, [
    "sequence_number",
    "max_gas_amount",
    "gas_unit_price",
    "expiration_timestamp_secs",
  ], "transaction_controls");
  const controls: TransactionControls = {
    sequence_number: decimalValue(controlsObject.sequence_number, "transaction_controls.sequence_number", MAX_U64, false),
    max_gas_amount: decimalValue(controlsObject.max_gas_amount, "transaction_controls.max_gas_amount", MAX_U64, true),
    gas_unit_price: decimalValue(controlsObject.gas_unit_price, "transaction_controls.gas_unit_price", MAX_U64, true),
    expiration_timestamp_secs: decimalValue(controlsObject.expiration_timestamp_secs, "transaction_controls.expiration_timestamp_secs", MAX_U64, true),
  };
  safeNumber(controls.max_gas_amount, "transaction_controls.max_gas_amount");
  safeNumber(controls.gas_unit_price, "transaction_controls.gas_unit_price");
  safeNumber(controls.expiration_timestamp_secs, "transaction_controls.expiration_timestamp_secs");

  const budgetObject = exactObject(request.gas_budget, [
    "approved_max_gas_amount",
    "approved_max_gas_unit_price",
    "approved_max_total_fee_base_units",
  ], "gas_budget");
  const budget: GasBudget = {
    approved_max_gas_amount: decimalValue(budgetObject.approved_max_gas_amount, "gas_budget.approved_max_gas_amount", MAX_U64, true),
    approved_max_gas_unit_price: decimalValue(budgetObject.approved_max_gas_unit_price, "gas_budget.approved_max_gas_unit_price", MAX_U64, true),
    approved_max_total_fee_base_units: decimalValue(budgetObject.approved_max_total_fee_base_units, "gas_budget.approved_max_total_fee_base_units", MAX_U128, true),
  };
  if (controls.max_gas_amount !== budget.approved_max_gas_amount
    || controls.gas_unit_price !== budget.approved_max_gas_unit_price
    || BigInt(controls.max_gas_amount) * BigInt(controls.gas_unit_price) !== BigInt(budget.approved_max_total_fee_base_units)) {
    fail("approved gas fields must exactly equal the explicit transaction maximums and their worst-case product");
  }

  return {
    schema_version: 1,
    evidence_scope: "testnet-transaction-build-request",
    network: TESTNET_NETWORK,
    api_url: TESTNET_API_URL,
    chain_id: TESTNET_CHAIN_ID_TEXT,
    gas_asset: CEDRA_COIN,
    deployment_id: stringValue(request.deployment_id, "deployment_id", DEPLOYMENT_PATTERN),
    operation_key: operation,
    application_commit: stringValue(request.application_commit, "application_commit", COMMIT_PATTERN),
    exact_address_artifacts_sha256: stringValue(request.exact_address_artifacts_sha256, "exact_address_artifacts_sha256", SHA256_PATTERN),
    public_profile_evidence_sha256: stringValue(request.public_profile_evidence_sha256, "public_profile_evidence_sha256", SHA256_PATTERN),
    roles: parseRoles(request.roles, "roles"),
    profile_public_keys: parsePublicKeys(request.profile_public_keys, "profile_public_keys"),
    transaction_controls: controls,
    gas_budget: budget,
  };
}

function parseExactArtifacts(value: unknown): {
  readonly applicationCommit: string;
  readonly applicationTree: string;
  readonly roles: RoleMap;
  readonly publicRoleCandidateSha256: string;
  readonly packages: Readonly<Record<"reflection_core" | "test_assets" | "test_amm", ExactPackageBinding>>;
} {
  const exact = objectValue(value, "exact-address artifact bundle");
  if (exact.schema_version !== 3 || exact.evidence_scope !== "local-exact-address-build-only" || exact.network !== TESTNET_NETWORK) {
    fail("exact-address artifact bundle is not validated v3 Cedra Testnet evidence");
  }
  if (exact.working_tree_clean !== true || exact.local_build_eligible_for_human_review !== true) {
    fail("exact-address artifact bundle must be clean and eligible for human review");
  }
  if (exact.verification_binding === null || exact.verification_binding === undefined
    || exact.public_role_candidate_binding === null || exact.public_role_candidate_binding === undefined) {
    fail("exact-address artifact bundle must bind clean verification and the five-role candidate");
  }
  const roleBinding = objectValue(exact.public_role_candidate_binding, "public_role_candidate_binding");
  const packageObject = objectValue(exact.packages, "exact-address packages");
  const packages = {} as Record<"reflection_core" | "test_assets" | "test_amm", ExactPackageBinding>;
  for (const packageKey of ["reflection_core", "test_assets", "test_amm"] as const) {
    const packageBinding = objectValue(packageObject[packageKey], `exact-address packages.${packageKey}`);
    packages[packageKey] = {
      publish_payload_file: stringValue(packageBinding.publish_payload_file, `${packageKey}.publish_payload_file`),
      publish_payload_sha256: stringValue(packageBinding.publish_payload_sha256, `${packageKey}.publish_payload_sha256`, SHA256_PATTERN),
      compiled_package_files_manifest_sha256: stringValue(
        packageBinding.compiled_package_files_manifest_sha256,
        `${packageKey}.compiled_package_files_manifest_sha256`,
        SHA256_PATTERN,
      ),
    };
  }
  return {
    applicationCommit: stringValue(exact.application_commit, "exact-address application_commit", COMMIT_PATTERN),
    applicationTree: stringValue(exact.application_tree, "exact-address application_tree", COMMIT_PATTERN),
    roles: parseRoles(exact.roles, "exact-address roles"),
    publicRoleCandidateSha256: stringValue(roleBinding.sha256, "public_role_candidate_binding.sha256", SHA256_PATTERN),
    packages,
  };
}

function parseProfileEvidence(value: unknown): {
  readonly publicRoleCandidateSha256: string;
  readonly roles: RoleMap;
  readonly publicKeys: PublicKeyMap;
  readonly bindings: ValidatedAssemblyContext["profileBindings"];
  readonly derivationMethod: typeof PROFILE_DERIVATION_METHOD;
  readonly derivationTool: typeof PROFILE_DERIVATION_TOOL;
} {
  const evidence = objectValue(value, "public profile evidence");
  if (evidence.schema_version !== 1 || evidence.evidence_scope !== "local-public-profile-preflight"
    || evidence.network_intent !== TESTNET_NETWORK) {
    fail("public profile evidence is not the validated Cedra Testnet preflight shape");
  }
  const authentication = exactObject(evidence.authentication_key_validation, [
    "all_profile_authentication_keys_match",
    "derivation_method",
    "derivation_tool",
  ], "authentication_key_validation");
  if (authentication.derivation_method !== PROFILE_DERIVATION_METHOD
    || authentication.derivation_tool !== PROFILE_DERIVATION_TOOL
    || authentication.all_profile_authentication_keys_match !== true) {
    fail("public profile evidence must bind the OpenSSL SHA3-256 authentication-key derivation");
  }
  const profiles = exactObject(evidence.profiles, RELEASE_ROLE_KEYS, "profiles");
  const roles = {} as Record<ReleaseRoleKey, Address>;
  const publicKeys = {} as Record<ReleaseRoleKey, `ed25519-pub-0x${string}`>;
  const bindings = {} as Record<ReleaseRoleKey, {
    readonly profile_name: string;
    readonly address: Address;
    readonly public_key: `ed25519-pub-0x${string}`;
  }>;
  for (const role of RELEASE_ROLE_KEYS) {
    const profile = exactObject(profiles[role], [
      "profile_name",
      "network",
      "has_private_key",
      "public_key",
      "account",
      "rest_url",
      "faucet_url",
    ], `profiles.${role}`);
    if (profile.profile_name !== PROFILE_NAMES[role] || profile.network !== "Testnet"
      || profile.has_private_key !== true || profile.rest_url !== "https://testnet.cedra.dev"
      || profile.faucet_url !== "https://faucet-api.cedra.dev") {
      fail(`profiles.${role} is not the exact approved public Testnet profile`);
    }
    const publicKey = stringValue(profile.public_key, `profiles.${role}.public_key`, PUBLIC_KEY_PATTERN) as `ed25519-pub-0x${string}`;
    const address = canonicalAddress(`0x${stringValue(profile.account, `profiles.${role}.account`, /^[0-9a-f]{64}$/)}`, `profiles.${role}.account`);
    const sdkPublicKey = new Ed25519PublicKey(publicKey.slice("ed25519-pub-".length));
    const derivedAddress = canonicalAddress(sdkPublicKey.authKey().derivedAddress().toStringLong(), `profiles.${role}.derived_address`);
    if (derivedAddress !== address) {
      fail(`profiles.${role} failed independent @cedra-labs/ts-sdk ${SDK_VERSION} authentication-key revalidation`);
    }
    roles[role] = address;
    publicKeys[role] = publicKey;
    bindings[role] = { profile_name: PROFILE_NAMES[role], address, public_key: publicKey };
  }
  if (new Set(Object.values(roles)).size !== RELEASE_ROLE_KEYS.length
    || new Set(Object.values(publicKeys)).size !== RELEASE_ROLE_KEYS.length) {
    fail("public profile evidence must contain five distinct accounts and public keys");
  }
  return {
    publicRoleCandidateSha256: stringValue(evidence.public_role_candidate_sha256, "public_role_candidate_sha256", SHA256_PATTERN),
    roles,
    publicKeys,
    bindings,
    derivationMethod: PROFILE_DERIVATION_METHOD,
    derivationTool: PROFILE_DERIVATION_TOOL,
  };
}

export function validateAssemblyInputs(args: {
  readonly exactArtifactsPath: string;
  readonly exactArtifactsSha256: string;
  readonly exactArtifacts: unknown;
  readonly publicProfileEvidenceSha256: string;
  readonly publicProfileEvidence: unknown;
  readonly buildRequest: unknown;
  readonly repositoryState: RepositoryAssemblyState;
  readonly buildIntegrity: unknown;
  readonly now: Date;
}): ValidatedAssemblyContext {
  const exactSha = stringValue(args.exactArtifactsSha256, "observed exact-address artifact digest", SHA256_PATTERN);
  const profileSha = stringValue(args.publicProfileEvidenceSha256, "observed public-profile evidence digest", SHA256_PATTERN);
  const exact = parseExactArtifacts(args.exactArtifacts);
  const profiles = parseProfileEvidence(args.publicProfileEvidence);
  const request = parseBuildRequest(args.buildRequest);
  if (!sameJson(exact.roles, request.roles) || !sameJson(exact.roles, profiles.roles)) {
    fail("all five roles must match across the exact bundle, profile evidence, and build request");
  }
  if (!sameJson(profiles.publicKeys, request.profile_public_keys)) {
    fail("all five public keys must match between profile evidence and the build request");
  }
  if (request.application_commit !== exact.applicationCommit) {
    fail("build-request application commit differs from the exact-address bundle");
  }
  if (request.exact_address_artifacts_sha256 !== exactSha) {
    fail("build-request exact-address artifact digest differs from the observed file");
  }
  if (request.public_profile_evidence_sha256 !== profileSha) {
    fail("build-request public-profile evidence digest differs from the observed file");
  }
  if (profiles.publicRoleCandidateSha256 !== exact.publicRoleCandidateSha256) {
    fail("public profile evidence and exact-address bundle bind different five-role candidates");
  }
  if (args.repositoryState.statusPorcelain.length !== 0) {
    fail("candidate assembly requires a completely clean current Git working tree and index, including no untracked files");
  }
  const headCommit = stringValue(args.repositoryState.headCommit, "current Git HEAD", COMMIT_PATTERN);
  const headTree = stringValue(args.repositoryState.headTree, "current Git HEAD tree", COMMIT_PATTERN);
  if (headCommit !== exact.applicationCommit || headTree !== exact.applicationTree) {
    fail("current clean Git HEAD/tree differs from the exact-address release bundle");
  }
  const integrity = validateBuildIntegrityEvidence(args.buildIntegrity);
  if (!Number.isFinite(args.now.getTime())) {
    fail("assembler clock is invalid");
  }
  if (BigInt(request.transaction_controls.expiration_timestamp_secs) <= BigInt(Math.floor(args.now.getTime() / 1000))) {
    fail("absolute transaction expiry must be in the future at assembly time");
  }
  const sdkKeys = {} as Record<ReleaseRoleKey, Ed25519PublicKey>;
  for (const role of RELEASE_ROLE_KEYS) {
    sdkKeys[role] = new Ed25519PublicKey(profiles.publicKeys[role].slice("ed25519-pub-".length));
  }
  return {
    exactArtifactsPath: resolve(args.exactArtifactsPath),
    exactAddressArtifactsSha256: exactSha,
    applicationCommit: exact.applicationCommit,
    applicationTree: exact.applicationTree,
    buildEnvironment: {
      repository_head_commit: headCommit,
      repository_head_tree: headTree,
      ...integrity,
    },
    roles: exact.roles,
    profileEvidenceSha256: profileSha,
    publicRoleCandidateSha256: exact.publicRoleCandidateSha256,
    profileDerivationMethod: profiles.derivationMethod,
    profileDerivationTool: profiles.derivationTool,
    profileBindings: profiles.bindings,
    publicKeys: sdkKeys,
    packages: exact.packages,
    request,
  };
}

function localAbi(signers: number, parameters: EntryFunctionABI["parameters"]): EntryFunctionABI {
  return { signers, typeParameters: [], parameters };
}

function functionId(value: string): InputEntryFunctionData["function"] {
  return value as InputEntryFunctionData["function"];
}

function publishOperation(
  context: ValidatedAssemblyContext,
  packageKey: "reflection_core" | "test_assets" | "test_amm",
  senderRole: "core_publisher" | "assets_publisher" | "amm_publisher",
): {
  readonly transactionKind: "package_publish";
  readonly senderRole: ReleaseRoleKey;
  readonly secondarySignerRoles: readonly ReleaseRoleKey[];
  readonly data: InputEntryFunctionData;
  readonly payload: TransactionPayloadEvidence;
  readonly abi: EntryFunctionABI;
  readonly publishBinding: PublishBinding;
} {
  const binding = context.packages[packageKey];
  if (binding.publish_payload_file !== "publish-payload.json") {
    fail(`${packageKey} publish payload must use the reviewed publish-payload.json filename`);
  }
  const packageDirectory = resolve(dirname(context.exactArtifactsPath), packageKey);
  const payloadPath = resolve(packageDirectory, binding.publish_payload_file);
  if (!payloadPath.startsWith(`${packageDirectory}/`)) {
    fail(`${packageKey} publish payload escaped its exact-address package directory`);
  }
  const stat = lstatSync(payloadPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${packageKey} publish payload must be a regular non-symlink file`);
  }
  const bytes = readFileSync(payloadPath);
  if (sha256(bytes) !== binding.publish_payload_sha256) {
    fail(`${packageKey} publish payload digest differs from the exact-address bundle`);
  }
  const payloadObject = exactObject(JSON.parse(bytes.toString("utf8")) as unknown, [
    "type",
    "function",
    "type_arguments",
    "arguments",
  ], `${packageKey} publish payload`);
  if (payloadObject.type !== "entry_function_payload" || payloadObject.function !== "0x1::code::publish_package_txn"
    || !Array.isArray(payloadObject.type_arguments) || payloadObject.type_arguments.length !== 0
    || !Array.isArray(payloadObject.arguments) || payloadObject.arguments.length !== 2) {
    fail(`${packageKey} publish payload has the wrong entry-function shape`);
  }
  const metadataHex = stringValue(payloadObject.arguments[0], `${packageKey} metadata bytes`, /^0x(?:[0-9a-f]{2})+$/);
  const moduleValues = payloadObject.arguments[1];
  if (!Array.isArray(moduleValues) || moduleValues.length === 0) {
    fail(`${packageKey} publish payload must contain ordered module byte arrays`);
  }
  const moduleHex = moduleValues.map((value, index) => stringValue(value, `${packageKey} module bytes ${index}`, /^0x(?:[0-9a-f]{2})+$/));
  const abi = localAbi(1, [TypeTagVector.u8(), new TypeTagVector(TypeTagVector.u8())]);
  return {
    transactionKind: "package_publish",
    senderRole,
    secondarySignerRoles: [],
    data: {
      function: "0x1::code::publish_package_txn",
      typeArguments: [],
      functionArguments: [
        MoveVector.U8(metadataHex),
        new MoveVector(moduleHex.map((module) => MoveVector.U8(module))),
      ],
      abi,
    },
    payload: {
      type: "entry_function_payload",
      function: "0x1::code::publish_package_txn",
      type_arguments: [],
      arguments: [metadataHex, moduleHex],
    },
    abi,
    publishBinding: {
      package_key: packageKey,
      publish_payload_sha256: binding.publish_payload_sha256,
      compiled_package_files_manifest_sha256: binding.compiled_package_files_manifest_sha256,
    },
  };
}

function operationShape(context: ValidatedAssemblyContext): {
  readonly transactionKind: TransactionKind;
  readonly senderRole: ReleaseRoleKey;
  readonly secondarySignerRoles: readonly ReleaseRoleKey[];
  readonly data: InputEntryFunctionData;
  readonly payload: TransactionPayloadEvidence;
  readonly abi: EntryFunctionABI;
  readonly publishBinding: PublishBinding | null;
} {
  const roles = context.roles;
  const noArguments = [] as const;
  const noParameters: EntryFunctionABI["parameters"] = [];
  switch (context.request.operation_key) {
    case "core_publish":
      return publishOperation(context, "reflection_core", "core_publisher");
    case "assets_publish":
      return publishOperation(context, "test_assets", "assets_publisher");
    case "amm_publish":
      return publishOperation(context, "test_amm", "amm_publisher");
    case "core_initialize": {
      const abi = localAbi(1, [new TypeTagU64()]);
      const functionName = functionId(`${roles.core_publisher}::reflection_token::initialize`);
      return {
        transactionKind: "core_initialize", senderRole: "core_publisher", secondarySignerRoles: [], abi,
        data: { function: functionName, typeArguments: [], functionArguments: [new U64(100n)], abi },
        payload: { type: "entry_function_payload", function: functionName, type_arguments: [], arguments: ["100"] },
        publishBinding: null,
      };
    }
    case "pool_launch": {
      const abi = localAbi(4, noParameters);
      const functionName = functionId(`${roles.amm_publisher}::pool::launch`);
      return {
        transactionKind: "pool_launch", senderRole: "core_publisher",
        secondarySignerRoles: ["assets_publisher", "amm_publisher", "bootstrap_lp"], abi,
        data: { function: functionName, typeArguments: [], functionArguments: [], abi },
        payload: { type: "entry_function_payload", function: functionName, type_arguments: [], arguments: noArguments },
        publishBinding: null,
      };
    }
  }
}

export async function buildReleaseCandidate(
  context: ValidatedAssemblyContext,
  releaseClient: ReleaseClientPort,
): Promise<BuiltReleaseCandidate> {
  const shape = operationShape(context);
  const sender = context.roles[shape.senderRole];
  const secondarySigners = shape.secondarySignerRoles.map((role) => context.roles[role]);
  if (shape.abi.signers !== 1 + secondarySigners.length) {
    fail(`${context.request.operation_key} local ABI signer count does not match ordered transaction signers`);
  }
  const controls = context.request.transaction_controls;
  const options = {
    accountSequenceNumber: BigInt(controls.sequence_number),
    maxGasAmount: safeNumber(controls.max_gas_amount, "max_gas_amount"),
    gasUnitPrice: safeNumber(controls.gas_unit_price, "gas_unit_price"),
    expireTimestamp: safeNumber(controls.expiration_timestamp_secs, "expiration_timestamp_secs"),
    faAddress: parseTypeTag(CEDRA_COIN),
  };
  let transaction: SimpleTransaction | MultiAgentTransaction;
  let identity: ReleaseTransactionIdentity;
  if (secondarySigners.length === 0) {
    transaction = await releaseClient.buildSingleSigner({ senderAddress: sender, data: shape.data, options });
    identity = describeSingleSignerTransaction(transaction);
  } else {
    transaction = await releaseClient.buildMultiAgent({
      senderAddress: sender,
      secondarySignerAddresses: secondarySigners,
      data: shape.data,
      options,
    });
    identity = describeMultiAgentTransaction(transaction);
  }
  if (identity.chainId !== TESTNET_CHAIN_ID || identity.fungibleAssetGasType !== CEDRA_COIN || identity.feePayerAddress !== null) {
    fail("built transaction is not fixed to Testnet chain 2, default CED gas, and no fee payer");
  }
  const transactionEvidence: TransactionEvidence = {
    sender,
    secondary_signers: secondarySigners,
    sequence_number: controls.sequence_number,
    expiration_timestamp_secs: controls.expiration_timestamp_secs,
    max_gas_amount: controls.max_gas_amount,
    gas_unit_price: controls.gas_unit_price,
    payload: shape.payload,
  };
  const transactionSemanticsSha256 = sha256(canonicalJsonBytes(jsonSafe(transactionEvidence)));
  return {
    context,
    transactionKind: shape.transactionKind,
    transaction,
    transactionEvidence,
    transactionIdentity: identity,
    transactionSemanticsSha256,
    publishBinding: shape.publishBinding,
    senderRole: shape.senderRole,
    secondarySignerRoles: shape.secondarySignerRoles,
    localAbi: shape.abi,
  };
}

function signerPublicKey(built: BuiltReleaseCandidate, role: ReleaseRoleKey): PublicKey {
  return built.context.publicKeys[role];
}

function expectedRestPublicKey(built: BuiltReleaseCandidate, role: ReleaseRoleKey): string {
  return built.context.profileBindings[role].public_key.slice("ed25519-pub-".length);
}

function assertZeroEd25519SimulationAuthenticator(
  value: unknown,
  expectedPublicKey: string,
  label: string,
): void {
  const authenticator = exactObject(value, ["type", "public_key", "signature"], label);
  if (authenticator.type !== "ed25519_signature") {
    fail(`${label} must be an Ed25519 simulation authenticator`);
  }
  if (authenticator.public_key !== expectedPublicKey) {
    fail(`${label} public key differs from the requested public profile key`);
  }
  if (authenticator.signature !== ZERO_SIMULATION_SIGNATURE) {
    fail(`${label} must contain the SDK's all-zero 64-byte simulation signature`);
  }
}

function assertSimulationAuthenticatorBinding(responses: JsonValue, built: BuiltReleaseCandidate): void {
  if (!Array.isArray(responses) || responses.length !== 1) {
    fail("Cedra simulation must return exactly one transaction response");
  }
  const response = objectValue(responses[0], "Cedra simulation response");
  if (built.secondarySignerRoles.length === 0) {
    assertZeroEd25519SimulationAuthenticator(
      response.signature,
      expectedRestPublicKey(built, built.senderRole),
      "Cedra simulation sender authenticator",
    );
    return;
  }

  const authenticator = exactObject(response.signature, [
    "type",
    "sender",
    "secondary_signer_addresses",
    "secondary_signers",
  ], "Cedra multi-agent simulation authenticator");
  if (authenticator.type !== "multi_agent_signature") {
    fail("Cedra multi-agent simulation must return a multi-agent authenticator");
  }
  assertZeroEd25519SimulationAuthenticator(
    authenticator.sender,
    expectedRestPublicKey(built, built.senderRole),
    "Cedra simulation sender authenticator",
  );
  if (!Array.isArray(authenticator.secondary_signer_addresses)
    || !Array.isArray(authenticator.secondary_signers)
    || authenticator.secondary_signer_addresses.length !== built.secondarySignerRoles.length
    || authenticator.secondary_signers.length !== built.secondarySignerRoles.length) {
    fail("Cedra simulation secondary authenticator arrays differ from the requested signer set");
  }
  for (const [index, role] of built.secondarySignerRoles.entries()) {
    const observedAddress = canonicalAddress(
      authenticator.secondary_signer_addresses[index],
      `Cedra simulation secondary signer address ${index.toString()}`,
    );
    if (observedAddress !== built.transactionEvidence.secondary_signers[index]) {
      fail(`Cedra simulation secondary signer address ${index.toString()} differs from the requested signer order`);
    }
    assertZeroEd25519SimulationAuthenticator(
      authenticator.secondary_signers[index],
      expectedRestPublicKey(built, role),
      `Cedra simulation secondary authenticator ${index.toString()}`,
    );
  }
}

function simulationSummary(responses: JsonValue): { readonly success: true; readonly vmStatus: string; readonly gasUsed: string } {
  if (!Array.isArray(responses) || responses.length !== 1) {
    fail("Cedra simulation must return exactly one transaction response");
  }
  const response = objectValue(responses[0], "Cedra simulation response");
  if (response.success !== true) {
    fail(`Cedra simulation failed: ${String(response.vm_status ?? "missing vm_status")}`);
  }
  const vmStatus = stringValue(response.vm_status, "Cedra simulation vm_status");
  const gasUsed = decimalValue(String(response.gas_used), "Cedra simulation gas_used", MAX_U64, false);
  return { success: true, vmStatus, gasUsed };
}

export async function simulateReleaseCandidate(
  built: BuiltReleaseCandidate,
  releaseClient: ReleaseClientPort,
  capturedAt: Date,
): Promise<CandidateBundle> {
  if (!Number.isFinite(capturedAt.getTime())) {
    fail("simulation capture time is invalid");
  }
  let result: MultiAgentSimulationResult | SingleSignerSimulationResult;
  if (built.secondarySignerRoles.length === 0) {
    result = await releaseClient.simulateSingleSigner({
      transaction: built.transaction as SimpleTransaction,
      expectedIdentity: built.transactionIdentity as SingleSignerSimulationResult["identity"],
      senderPublicKey: signerPublicKey(built, built.senderRole),
    });
  } else {
    result = await releaseClient.simulateMultiAgent({
      transaction: built.transaction as MultiAgentTransaction,
      expectedIdentity: built.transactionIdentity as MultiAgentSimulationResult["identity"],
      senderPublicKey: signerPublicKey(built, built.senderRole),
      secondarySignerPublicKeys: built.secondarySignerRoles.map((role) => signerPublicKey(built, role)),
    });
  }
  if (!sameJson(jsonSafe(result.identity), jsonSafe(built.transactionIdentity))) {
    fail("Cedra simulation returned a transaction identity different from the built candidate");
  }
  const responses = jsonSafe(result.responses);
  assertSimulationAuthenticatorBinding(responses, built);
  const summary = simulationSummary(responses);
  if (BigInt(summary.gasUsed) > BigInt(built.transactionEvidence.max_gas_amount)) {
    fail("simulated gas exceeds the explicitly requested maximum");
  }
  const simulationResponse: JsonObject = {
    identity: jsonSafe(built.transactionIdentity),
    responses,
  };
  const simulationBytes = canonicalJsonBytes(simulationResponse);
  const captured = capturedAt.toISOString().replace(/\.\d{3}Z$/, "Z");
  const context = built.context;
  const candidate: JsonObject = {
    schema_version: 2,
    evidence_scope: "testnet-transaction-candidate",
    status: "simulated-awaiting-detached-approvals",
    network: TESTNET_NETWORK,
    api_url: TESTNET_API_URL,
    chain_id: TESTNET_CHAIN_ID_TEXT,
    deployment_id: context.request.deployment_id,
    application_commit: context.applicationCommit,
    exact_address_artifacts_sha256: context.exactAddressArtifactsSha256,
    public_profile_binding: {
      evidence_sha256: context.profileEvidenceSha256,
      public_role_candidate_sha256: context.publicRoleCandidateSha256,
      derivation_method: context.profileDerivationMethod,
      derivation_tool: context.profileDerivationTool,
      assembler_revalidation_sdk_package: REVIEWED_SDK_PACKAGE,
      assembler_revalidation_sdk_version: SDK_VERSION,
      profiles: jsonSafe(context.profileBindings),
    },
    build_environment: jsonSafe(context.buildEnvironment),
    roles: jsonSafe(context.roles),
    transaction_kind: built.transactionKind,
    operation_key: context.request.operation_key,
    transaction: jsonSafe(built.transactionEvidence),
    transaction_identity: jsonSafe(built.transactionIdentity),
    transaction_semantics_sha256: built.transactionSemanticsSha256,
    gas_budget: jsonSafe(context.request.gas_budget),
    simulation: {
      captured_at: captured,
      success: true,
      vm_status: summary.vmStatus,
      gas_used: summary.gasUsed,
      raw_response_file: "simulation-response.json",
      raw_response_sha256: sha256(simulationBytes),
      transaction_semantics_sha256: built.transactionSemanticsSha256,
    },
    publish_binding: built.publishBinding === null ? null : jsonSafe(built.publishBinding),
  };
  return { candidate, simulationResponse };
}

export async function assembleReleaseCandidate(args: {
  readonly context: ValidatedAssemblyContext;
  readonly releaseClient: ReleaseClientPort;
  readonly capturedAt: Date;
}): Promise<CandidateBundle> {
  const built = await buildReleaseCandidate(args.context, args.releaseClient);
  return simulateReleaseCandidate(built, args.releaseClient, args.capturedAt);
}

export function candidateBundleBytes(bundle: CandidateBundle): {
  readonly candidate: Uint8Array;
  readonly simulationResponse: Uint8Array;
} {
  return {
    candidate: canonicalJsonBytes(bundle.candidate),
    simulationResponse: canonicalJsonBytes(bundle.simulationResponse),
  };
}
