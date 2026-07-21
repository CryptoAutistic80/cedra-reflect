import { createHash } from "node:crypto";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Deserializer,
  Ed25519PublicKey,
  MultiAgentTransaction,
  SimpleTransaction,
  TransactionPayloadEntryFunction,
  generateSigningMessageForTransaction,
} from "@cedra-labs/ts-sdk";

import {
  RELEASE_OPERATION_KEYS,
  RELEASE_ROLE_KEYS,
  assertRuntimeSdkPackage,
  buildReleaseCandidate,
  candidateBundleBytes,
  computeBuildIntegrity,
  finalizeCandidateDirectoryAtomically,
  simulateReleaseCandidate,
  validateAssemblyInputs,
  type BuiltReleaseCandidate,
  type BuildIntegrityEvidence,
  type JsonValue,
  type ReleaseClientPort,
  type ReleaseOperationKey,
  type ReleaseRoleKey,
} from "../packages/release-candidate-assembler/src/index.js";
import { CedraReleaseClient } from "../packages/protocol-sdk/src/index.js";
import { equal, ok, rejects, run, test } from "./harness.js";

const COMMIT = "1".repeat(40);
const TREE = "4".repeat(40);
const ROLE_CANDIDATE_SHA = "2".repeat(64);
const NOW = new Date("2030-01-01T00:00:00Z");
const EXPIRY = "2000000000";
const TEST_TMP = "/tmp";
const PROFILE_DERIVATION_METHOD = "sha3-256(ed25519_public_key_bytes || 0x00)";
const PROFILE_DERIVATION_TOOL = "OpenSSL dgst -sha3-256";

const BUILD_INTEGRITY: BuildIntegrityEvidence = {
  release_executable_closure_file: "ops/evidence/release-executable-closure.json",
  release_executable_closure_sha256: "d".repeat(64),
  package_lock_file: "package-lock.json",
  package_lock_sha256: "5".repeat(64),
  sdk_package: "@cedra-labs/ts-sdk",
  sdk_version: "2.2.8",
  sdk_lock_integrity: `sha512-${"A".repeat(86)}==`,
  sdk_review_pin_file: "ops/evidence/reviewed-cedra-sdk-2.2.8.json",
  sdk_review_pin_sha256: "a".repeat(64),
  sdk_package_json_sha256: "6".repeat(64),
  sdk_loaded_entrypoint: "dist/esm/index.mjs",
  sdk_loaded_entrypoint_sha256: "7".repeat(64),
  sdk_package_tree_sha256: "8".repeat(64),
  sdk_package_file_count: 731,
  sdk_review_attestation_sha256: "9".repeat(64),
  sdk_review_signature_sha256: "b".repeat(64),
  sdk_review_signature_namespace: "cedra-reflect-sdk-review-v1",
  sdk_review_reviewer_identity: "test-only-sdk-reviewer",
  sdk_review_trusted_signers_sha256: "c".repeat(64),
};

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeJson(path: string, value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return bytes;
}

function makeTestSdkReviewBinding(
  root: string,
  reviewPinPath: string,
  sdkTreeSha256: string,
  sdkFileCount: number,
): { readonly attestation: string; readonly signature: string; readonly trust: string } {
  const trust = join(root, "test-only-sdk-review.allowed_signers");
  writeFileSync(trust, "test-only-sdk-reviewer ssh-ed25519 TEST_ONLY\n", { mode: 0o600 });
  const signature = join(root, "test-only-sdk-review.sig");
  writeFileSync(signature, "TEST ONLY - signature verification belongs to the shell preflight\n", { mode: 0o600 });
  const attestation = join(root, "test-only-sdk-review-attestation.json");
  writeJson(attestation, {
    evidence_scope: "independent-cedra-sdk-review-attestation",
    decision: "approved-for-testnet-candidate-assembly",
    reviewer_identity: "test-only-sdk-reviewer",
    sdk_review_pin_sha256: sha256(readFileSync(reviewPinPath)),
    sdk_package_tree_sha256: sdkTreeSha256,
    sdk_package_file_count: sdkFileCount,
    trusted_allowed_signers_sha256: sha256(readFileSync(trust)),
  });
  return { attestation, signature, trust };
}

function canonicalAddress(value: string): `0x${string}` {
  const digits = value.slice(2).replace(/^0+/, "") || "0";
  return `0x${digits}`;
}

function bytesFromHex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
}

function argumentBytes(value: unknown): Uint8Array {
  const bytes = (value as { readonly value?: { readonly value?: unknown } })?.value?.value;
  ok(bytes instanceof Uint8Array, "Entry-function argument retains its exact BCS bytes");
  return bytes;
}

function validateBuiltBcs(built: BuiltReleaseCandidate): void {
  const identity = built.transactionIdentity;
  equal(
    `0x${Buffer.from(built.transaction.rawTransaction.bcsToBytes()).toString("hex")}`,
    identity.rawTransactionBcsHex,
    "Raw transaction identity binds the exact BCS",
  );
  equal(
    `0x${Buffer.from(built.transaction.bcsToBytes()).toString("hex")}`,
    identity.transactionBcsHex,
    "Transaction wrapper identity binds the exact BCS",
  );
  equal(
    `0x${Buffer.from(generateSigningMessageForTransaction(built.transaction)).toString("hex")}`,
    identity.signingMessageHex,
    "Signing-message identity binds the exact signer envelope",
  );
  const transactionBytes = bytesFromHex(identity.transactionBcsHex);
  const deserializer = new Deserializer(transactionBytes);
  const decoded = identity.transactionType === "multi-agent"
    ? MultiAgentTransaction.deserialize(deserializer)
    : SimpleTransaction.deserialize(deserializer);
  deserializer.assertFinished();
  equal(
    `0x${Buffer.from(decoded.bcsToBytes()).toString("hex")}`,
    identity.transactionBcsHex,
    "Transaction wrapper BCS round-trips canonically",
  );
  const payload = decoded.rawTransaction.payload;
  ok(payload instanceof TransactionPayloadEntryFunction, "Release payload is an entry function");
  const entry = payload.entryFunction;
  const functionName = `${canonicalAddress(entry.module_name.address.toStringLong())}::${entry.module_name.name.identifier}::${entry.function_name.identifier}`;
  equal(functionName, built.transactionEvidence.payload.function, "BCS entry-function ID matches semantic evidence");
  equal(entry.type_args.length, 0, "Release ABI has no type arguments");
  if (["core_publish", "assets_publish", "amm_publish"].includes(built.context.request.operation_key)) {
    equal(entry.args.length, 2, "Publish BCS has metadata and ordered module arguments only");
    const metadataDecoder = new Deserializer(argumentBytes(entry.args[0]));
    const metadata = `0x${Buffer.from(metadataDecoder.deserializeBytes()).toString("hex")}`;
    metadataDecoder.assertFinished();
    const modulesDecoder = new Deserializer(argumentBytes(entry.args[1]));
    const count = modulesDecoder.deserializeUleb128AsU32();
    const modules: string[] = [];
    for (let index = 0; index < count; index += 1) {
      modules.push(`0x${Buffer.from(modulesDecoder.deserializeBytes()).toString("hex")}`);
    }
    modulesDecoder.assertFinished();
    equal(
      JSON.stringify([metadata, modules]),
      JSON.stringify(built.transactionEvidence.payload.arguments),
      "Publish BCS uses typed MoveVector metadata and ordered module bytes",
    );
  } else if (built.context.request.operation_key === "core_initialize") {
    equal(entry.args.length, 1, "Core initialization BCS has one immutable fee argument");
    const decoder = new Deserializer(argumentBytes(entry.args[0]));
    const fee = decoder.deserializeU64();
    decoder.assertFinished();
    equal(fee, 100n, "Core initialization fixes the v0.2 creation fee at 100 bps");
    equal(JSON.stringify(built.transactionEvidence.payload.arguments), '["100"]', "Fee evidence matches the typed payload");
  } else {
    equal(entry.args.length, 0, "Four-signer pool launch has no hidden payload arguments");
  }
}

interface Fixture {
  readonly root: string;
  readonly exactPath: string;
  readonly exact: Record<string, unknown>;
  readonly exactSha: string;
  readonly profile: Record<string, unknown>;
  readonly profileSha: string;
  readonly roles: Record<ReleaseRoleKey, `0x${string}`>;
  readonly publicKeys: Record<ReleaseRoleKey, `ed25519-pub-0x${string}`>;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(TEST_TMP, "cedra-candidate-assembler-test-"));
  const roles = {} as Record<ReleaseRoleKey, `0x${string}`>;
  const publicKeys = {} as Record<ReleaseRoleKey, `ed25519-pub-0x${string}`>;
  const profileNames: Record<ReleaseRoleKey, string> = {
    core_publisher: "cedra-reflect-core-publisher",
    assets_publisher: "cedra-reflect-assets-publisher",
    amm_publisher: "cedra-reflect-amm-publisher",
    bootstrap_lp: "cedra-reflect-bootstrap-lp",
  };
  const profiles = {} as Record<ReleaseRoleKey, unknown>;
  RELEASE_ROLE_KEYS.forEach((role, index) => {
    const keyHex = `0x${(index + 1).toString(16).padStart(2, "0").repeat(32)}`;
    const publicKey = new Ed25519PublicKey(keyHex);
    const address = canonicalAddress(publicKey.authKey().derivedAddress().toStringLong());
    roles[role] = address;
    publicKeys[role] = `ed25519-pub-${keyHex}` as `ed25519-pub-0x${string}`;
    profiles[role] = {
      profile_name: profileNames[role],
      network: "Testnet",
      has_private_key: true,
      public_key: publicKeys[role],
      account: publicKey.authKey().derivedAddress().toStringLongWithoutPrefix(),
      rest_url: "https://testnet.cedra.dev",
      faucet_url: "https://faucet-api.cedra.dev",
    };
  });

  const payloads = {
    reflection_core: { metadata: "0x0102", modules: ["0xa1", "0xa2"] },
    test_assets: { metadata: "0x0304", modules: ["0xb1"] },
    test_amm: { metadata: "0x0506", modules: ["0xc1", "0xc2", "0xc3"] },
  } as const;
  const packages: Record<string, unknown> = {};
  for (const packageKey of Object.keys(payloads) as Array<keyof typeof payloads>) {
    const directory = join(root, packageKey);
    mkdirSync(directory, { mode: 0o700 });
    const definition = payloads[packageKey];
    const payload = {
      arguments: [definition.metadata, definition.modules],
      function: "0x1::code::publish_package_txn",
      type: "entry_function_payload",
      type_arguments: [],
    };
    const payloadBytes = writeJson(join(directory, "publish-payload.json"), payload);
    packages[packageKey] = {
      publish_payload_file: "publish-payload.json",
      publish_payload_sha256: sha256(payloadBytes),
      compiled_package_files_manifest_sha256: sha256(`${packageKey}-compiled`),
    };
  }
  const exact: Record<string, unknown> = {
    schema_version: 3,
    evidence_scope: "local-exact-address-build-only",
    network: "cedra-testnet",
    application_commit: COMMIT,
    application_tree: TREE,
    working_tree_clean: true,
    local_build_eligible_for_human_review: true,
    verification_binding: { record_sha256: "3".repeat(64) },
    public_role_candidate_binding: { file: "provenance/public-role-candidate.json", sha256: ROLE_CANDIDATE_SHA },
    roles,
    packages,
  };
  const exactPath = join(root, "exact-address-artifacts.json");
  const exactSha = sha256(writeJson(exactPath, exact));
  const profile: Record<string, unknown> = {
    schema_version: 1,
    evidence_scope: "local-public-profile-preflight",
    network_intent: "cedra-testnet",
    public_role_candidate_sha256: ROLE_CANDIDATE_SHA,
    profiles,
    authentication_key_validation: {
      all_profile_authentication_keys_match: true,
      derivation_method: PROFILE_DERIVATION_METHOD,
      derivation_tool: PROFILE_DERIVATION_TOOL,
    },
  };
  const profileSha = sha256(new TextEncoder().encode(`${JSON.stringify(profile)}\n`));
  return { root, exactPath, exact, exactSha, profile, profileSha, roles, publicKeys };
}

function requestFor(fixture: Fixture, operation: ReleaseOperationKey): Record<string, unknown> {
  return {
    schema_version: 1,
    evidence_scope: "testnet-transaction-build-request",
    network: "cedra-testnet",
    api_url: "https://testnet.cedra.dev/v1",
    chain_id: "2",
    gas_asset: "0x1::cedra_coin::CedraCoin",
    deployment_id: "assembler-test-v1",
    operation_key: operation,
    application_commit: COMMIT,
    exact_address_artifacts_sha256: fixture.exactSha,
    public_profile_evidence_sha256: fixture.profileSha,
    roles: fixture.roles,
    profile_public_keys: fixture.publicKeys,
    transaction_controls: {
      sequence_number: String(RELEASE_OPERATION_KEYS.indexOf(operation)),
      max_gas_amount: "200000",
      gas_unit_price: "100",
      expiration_timestamp_secs: EXPIRY,
    },
    gas_budget: {
      approved_max_gas_amount: "200000",
      approved_max_gas_unit_price: "100",
      approved_max_total_fee_base_units: "20000000",
    },
  };
}

function contextFor(fixture: Fixture, request: Record<string, unknown>) {
  return validateAssemblyInputs({
    exactArtifactsPath: fixture.exactPath,
    exactArtifactsSha256: fixture.exactSha,
    exactArtifacts: fixture.exact,
    publicProfileEvidenceSha256: fixture.profileSha,
    publicProfileEvidence: fixture.profile,
    buildRequest: request,
    repositoryState: {
      statusPorcelain: "",
      headCommit: COMMIT,
      headTree: TREE,
    },
    buildIntegrity: BUILD_INTEGRITY,
    now: NOW,
  });
}

const offlineBuilder = CedraReleaseClient.forTestnet();

function buildPort(onBuild?: (signers: number, hasAbi: boolean) => void): ReleaseClientPort {
  return {
    buildSingleSigner: async (request) => {
      onBuild?.(1, request.data.abi !== undefined);
      return offlineBuilder.buildSingleSigner(request);
    },
    buildMultiAgent: async (request) => {
      onBuild?.(1 + request.secondarySignerAddresses.length, request.data.abi !== undefined);
      return offlineBuilder.buildMultiAgent(request);
    },
    simulateSingleSigner: async () => { throw new Error("unexpected simulation during build"); },
    simulateMultiAgent: async () => { throw new Error("unexpected simulation during build"); },
  };
}

function mockResponse(built: BuiltReleaseCandidate): Record<string, unknown> {
  const transaction = built.transactionEvidence;
  const publicKey = (role: ReleaseRoleKey) => built.context.profileBindings[role].public_key.slice("ed25519-pub-".length);
  const signature = built.secondarySignerRoles.length === 0
    ? { type: "ed25519_signature", public_key: publicKey(built.senderRole), signature: `0x${"00".repeat(64)}` }
    : {
      type: "multi_agent_signature",
      sender: { type: "ed25519_signature", public_key: publicKey(built.senderRole), signature: `0x${"00".repeat(64)}` },
      secondary_signer_addresses: transaction.secondary_signers,
      secondary_signers: built.secondarySignerRoles.map((role) => ({
        type: "ed25519_signature",
        public_key: publicKey(role),
        signature: `0x${"00".repeat(64)}`,
      })),
    };
  return {
    sender: transaction.sender,
    sequence_number: transaction.sequence_number,
    expiration_timestamp_secs: transaction.expiration_timestamp_secs,
    max_gas_amount: transaction.max_gas_amount,
    gas_unit_price: transaction.gas_unit_price,
    payload: transaction.payload,
    signature,
    success: true,
    vm_status: "Executed successfully",
    gas_used: "1",
  };
}

function simulationPort(
  built: BuiltReleaseCandidate,
  transform: (response: Record<string, unknown>) => Record<string, unknown> = (response) => response,
): ReleaseClientPort {
  const response = transform(mockResponse(built));
  const observed: { single: number; multi: number } = { single: 0, multi: 0 };
  const cedra = new CedraReleaseClient({
    transaction: {
      simulate: {
        simple: async (request: { readonly signerPublicKey: unknown; readonly transaction: unknown }) => {
          equal(request.transaction === built.transaction, true, "Simulation receives the exact built single-signer object");
          ok(request.signerPublicKey instanceof Ed25519PublicKey, "Simulation sender uses only an Ed25519 public key");
          observed.single += 1;
          return [response];
        },
        multiAgent: async (request: {
          readonly signerPublicKey: unknown;
          readonly secondarySignersPublicKeys: readonly unknown[];
          readonly transaction: unknown;
        }) => {
          equal(request.transaction === built.transaction, true, "Simulation receives the exact built multi-agent object");
          ok(request.signerPublicKey instanceof Ed25519PublicKey, "Simulation sender uses only an Ed25519 public key");
          equal(
            request.secondarySignersPublicKeys.every((key) => key instanceof Ed25519PublicKey),
            true,
            "Every simulation secondary signer uses only a public key",
          );
          equal(request.secondarySignersPublicKeys.length, built.secondarySignerRoles.length, "Simulation preserves public-key order");
          observed.multi += 1;
          return [response];
        },
      },
    },
  } as never);
  return {
    buildSingleSigner: async () => { throw new Error("unexpected rebuild during simulation"); },
    buildMultiAgent: async () => { throw new Error("unexpected rebuild during simulation"); },
    simulateSingleSigner: cedra.simulateSingleSigner.bind(cedra),
    simulateMultiAgent: cedra.simulateMultiAgent.bind(cedra),
  };
}

test("candidate assembler binds the actual loaded Cedra SDK package to exact version 2.2.8", async () => {
  const packagePath = fileURLToPath(import.meta.resolve("@cedra-labs/ts-sdk/package.json"));
  const entrypointPath = fileURLToPath(import.meta.resolve("@cedra-labs/ts-sdk"));
  const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
  assertRuntimeSdkPackage(manifest, packagePath);
  const reviewRoot = mkdtempSync(join(TEST_TMP, "cedra-sdk-review-binding-test-"));
  const review = makeTestSdkReviewBinding(
    reviewRoot,
    join(process.cwd(), "ops/evidence/reviewed-cedra-sdk-2.2.8.json"),
    "0259184429bdc85d4d78e1a6bf105677e8cea7707bec5dcdbba269dea36e2765",
    731,
  );
  const observed = computeBuildIntegrity({
    repoRoot: process.cwd(),
    sdkPackageJsonPath: packagePath,
    sdkEntrypointPath: entrypointPath,
    sdkReviewAttestationPath: review.attestation,
    sdkReviewSignaturePath: review.signature,
    sdkReviewTrustPath: review.trust,
  });
  equal(observed.sdk_review_pin_sha256, "adeca264fd6c99cdcf74bc4d8381ecd1b45218ef3ba054da48d84aed86834299", "Candidate assembler binds the reviewed pin file itself");
  equal(observed.sdk_package_tree_sha256, "0259184429bdc85d4d78e1a6bf105677e8cea7707bec5dcdbba269dea36e2765", "Installed SDK tree equals the lock-authenticated npm tarball pin");
  await rejects(async () => assertRuntimeSdkPackage({ ...manifest, version: "2.2.9" }, packagePath), Error);
});

test("build integrity rejects a loaded SDK artifact that differs from the reviewed npm pin", async () => {
  const root = mkdtempSync(join(TEST_TMP, "cedra-build-integrity-test-"));
  try {
    const sdkRoot = join(root, "sdk");
    mkdirSync(sdkRoot, { recursive: true, mode: 0o700 });
    writeJson(join(root, "package-lock.json"), {
      packages: {
        "node_modules/@cedra-labs/ts-sdk": {
          version: "2.2.8",
          integrity: `sha512-${"B".repeat(86)}==`,
        },
      },
    });
    const packageJsonPath = join(sdkRoot, "package.json");
    const packageJsonBytes = writeJson(packageJsonPath, { name: "@cedra-labs/ts-sdk", version: "2.2.8" });
    const entrypoint = join(sdkRoot, "index.mjs");
    const entrypointBytes = new TextEncoder().encode("export const reviewed = true;\n");
    writeFileSync(entrypoint, entrypointBytes, { mode: 0o600 });
    const treeDigest = sha256(
      `${sha256(entrypointBytes)}\u0000${entrypointBytes.length}\u0000index.mjs\n`
      + `${sha256(packageJsonBytes)}\u0000${packageJsonBytes.length}\u0000package.json\n`,
    );
    const pinDirectory = join(root, "ops", "evidence");
    mkdirSync(pinDirectory, { recursive: true, mode: 0o700 });
    writeJson(join(pinDirectory, "reviewed-cedra-sdk-2.2.8.json"), {
      schema_version: 1,
      evidence_scope: "reviewed-npm-sdk-artifact",
      package_name: "@cedra-labs/ts-sdk",
      package_version: "2.2.8",
      registry_tarball_url: "https://registry.npmjs.org/@cedra-labs/ts-sdk/-/ts-sdk-2.2.8.tgz",
      npm_tarball_sha512_integrity: `sha512-${"B".repeat(86)}==`,
      npm_tarball_sha256: "c".repeat(64),
      package_tree_digest_algorithm: "sha256(depth_first_lexicographic_path_components(sha256(file_bytes) NUL decimal_byte_length NUL posix_relative_path LF))",
      sdk_package_json_sha256: sha256(packageJsonBytes),
      sdk_loaded_entrypoint: "index.mjs",
      sdk_loaded_entrypoint_sha256: sha256(entrypointBytes),
      sdk_package_tree_sha256: treeDigest,
      sdk_package_file_count: 2,
    });
    writeJson(join(pinDirectory, "release-executable-closure.json"), { test_only: true });
    const review = makeTestSdkReviewBinding(
      root,
      join(pinDirectory, "reviewed-cedra-sdk-2.2.8.json"),
      treeDigest,
      2,
    );
    const integrityArgs = {
      repoRoot: root,
      sdkPackageJsonPath: packageJsonPath,
      sdkEntrypointPath: entrypoint,
      sdkReviewAttestationPath: review.attestation,
      sdkReviewSignaturePath: review.signature,
      sdkReviewTrustPath: review.trust,
    };
    computeBuildIntegrity(integrityArgs);
    writeFileSync(entrypoint, "export const reviewed = false;\n", { mode: 0o600 });
    await rejects(async () => computeBuildIntegrity(integrityArgs), Error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const expectedSigners: Record<ReleaseOperationKey, readonly ReleaseRoleKey[]> = {
  core_publish: ["core_publisher"],
  core_initialize: ["core_publisher"],
  assets_publish: ["assets_publisher"],
  amm_publish: ["amm_publisher"],
  pool_launch: ["core_publisher", "assets_publisher", "amm_publisher", "bootstrap_lp"],
};

const fixture = makeFixture();

for (const operation of RELEASE_OPERATION_KEYS) {
  test(`candidate assembler builds, simulates, and validates exact ${operation} BCS offline`, async () => {
    const context = contextFor(fixture, requestFor(fixture, operation));
    let observedSignerCount = 0;
    let localAbiPresent = false;
    const built = await buildReleaseCandidate(context, buildPort((count, hasAbi) => {
      observedSignerCount = count;
      localAbiPresent = hasAbi;
    }));
    equal(localAbiPresent, true, `${operation} supplies an explicit local ABI`);
    equal(observedSignerCount, expectedSigners[operation].length, `${operation} uses the exact signer count`);
    equal(built.localAbi.signers, expectedSigners[operation].length, `${operation} ABI signer count is independently asserted`);
    equal(built.transactionIdentity.chainId, 2, `${operation} is fixed to Testnet chain 2`);
    equal(built.transactionIdentity.fungibleAssetGasType, "0x1::cedra_coin::CedraCoin", `${operation} uses default CED gas`);
    equal(built.transactionIdentity.feePayerAddress, null, `${operation} has no fee payer`);
    equal(
      JSON.stringify([built.senderRole, ...built.secondarySignerRoles]),
      JSON.stringify(expectedSigners[operation]),
      `${operation} preserves exact signer-role order`,
    );
    validateBuiltBcs(built);
    const bundle = await simulateReleaseCandidate(built, simulationPort(built), NOW);
    const bytes = candidateBundleBytes(bundle);
    equal(
      sha256(bytes.simulationResponse),
      (bundle.candidate.simulation as { readonly raw_response_sha256: JsonValue }).raw_response_sha256,
      `${operation} candidate binds the exact canonical simulation response`,
    );
    const profileBinding = bundle.candidate.public_profile_binding as { readonly [key: string]: JsonValue };
    equal(profileBinding.derivation_method, PROFILE_DERIVATION_METHOD, `${operation} identifies the profile evidence derivation`);
    equal(profileBinding.derivation_tool, PROFILE_DERIVATION_TOOL, `${operation} identifies the profile evidence tool`);
    equal(profileBinding.assembler_revalidation_sdk_package, "@cedra-labs/ts-sdk", `${operation} identifies the independent assembler SDK revalidation`);
    equal(profileBinding.assembler_revalidation_sdk_version, "2.2.8", `${operation} binds the reviewed assembler SDK version`);
  });
}

test("candidate assembler rejects dirty or non-review-eligible exact bundles", async () => {
  const exact = structuredClone(fixture.exact);
  exact.working_tree_clean = false;
  await rejects(async () => validateAssemblyInputs({
    exactArtifactsPath: fixture.exactPath,
    exactArtifactsSha256: fixture.exactSha,
    exactArtifacts: exact,
    publicProfileEvidenceSha256: fixture.profileSha,
    publicProfileEvidence: fixture.profile,
    buildRequest: requestFor(fixture, "core_publish"),
    repositoryState: { statusPorcelain: "", headCommit: COMMIT, headTree: TREE },
    buildIntegrity: BUILD_INTEGRITY,
    now: NOW,
  }), Error);
});

test("candidate assembler rejects profile key/address mismatches", async () => {
  const profile = structuredClone(fixture.profile) as Record<string, unknown>;
  const profiles = profile.profiles as Record<string, Record<string, unknown>>;
  profiles.core_publisher!.account = profiles.assets_publisher!.account;
  await rejects(async () => validateAssemblyInputs({
    exactArtifactsPath: fixture.exactPath,
    exactArtifactsSha256: fixture.exactSha,
    exactArtifacts: fixture.exact,
    publicProfileEvidenceSha256: fixture.profileSha,
    publicProfileEvidence: profile,
    buildRequest: requestFor(fixture, "core_publish"),
    repositoryState: { statusPorcelain: "", headCommit: COMMIT, headTree: TREE },
    buildIntegrity: BUILD_INTEGRITY,
    now: NOW,
  }), Error);
});

test("candidate assembler rejects legacy SDK attribution in public-profile evidence", async () => {
  const profile = structuredClone(fixture.profile) as Record<string, unknown>;
  profile.authentication_key_validation = {
    all_profile_authentication_keys_match: true,
    sdk_package: "@cedra-labs/ts-sdk",
    sdk_version: "2.2.8",
  };
  await rejects(async () => validateAssemblyInputs({
    exactArtifactsPath: fixture.exactPath,
    exactArtifactsSha256: fixture.exactSha,
    exactArtifacts: fixture.exact,
    publicProfileEvidenceSha256: fixture.profileSha,
    publicProfileEvidence: profile,
    buildRequest: requestFor(fixture, "core_publish"),
    repositoryState: { statusPorcelain: "", headCommit: COMMIT, headTree: TREE },
    buildIntegrity: BUILD_INTEGRITY,
    now: NOW,
  }), Error);
});

test("candidate assembler rejects a dirty checkout or a HEAD tree unlike the reviewed exact bundle", async () => {
  const common = {
    exactArtifactsPath: fixture.exactPath,
    exactArtifactsSha256: fixture.exactSha,
    exactArtifacts: fixture.exact,
    publicProfileEvidenceSha256: fixture.profileSha,
    publicProfileEvidence: fixture.profile,
    buildRequest: requestFor(fixture, "core_publish"),
    buildIntegrity: BUILD_INTEGRITY,
    now: NOW,
  };
  await rejects(async () => validateAssemblyInputs({
    ...common,
    repositoryState: { statusPorcelain: " M package-lock.json\n", headCommit: COMMIT, headTree: TREE },
  }), Error);
  await rejects(async () => validateAssemblyInputs({
    ...common,
    repositoryState: { statusPorcelain: "", headCommit: COMMIT, headTree: "9".repeat(40) },
  }), Error);
});

test("candidate assembler rejects request extras, digest changes, zero gas, and excess fees", async () => {
  const base = requestFor(fixture, "core_publish");
  const variants: Array<Record<string, unknown>> = [];
  variants.push({ ...base, unexpected: true });
  variants.push({ ...base, exact_address_artifacts_sha256: "9".repeat(64) });
  variants.push({ ...base, public_profile_evidence_sha256: "9".repeat(64) });
  variants.push({ ...base, transaction_controls: { ...(base.transaction_controls as object), gas_unit_price: "0" } });
  variants.push({ ...base, gas_budget: { ...(base.gas_budget as object), approved_max_total_fee_base_units: "1" } });
  for (const variant of variants) {
    await rejects(async () => contextFor(fixture, variant), Error);
  }
});

test("candidate assembler rejects expired absolute transaction controls", async () => {
  const request = requestFor(fixture, "core_initialize");
  request.transaction_controls = {
    ...(request.transaction_controls as object),
    expiration_timestamp_secs: String(Math.floor(NOW.getTime() / 1000)),
  };
  await rejects(async () => contextFor(fixture, request), Error);
});

test("candidate assembler rejects failed simulation without producing an approvable record", async () => {
  const built = await buildReleaseCandidate(contextFor(fixture, requestFor(fixture, "core_initialize")), buildPort());
  const failed = new CedraReleaseClient({
    transaction: {
      simulate: {
        simple: async () => [{ ...mockResponse(built), success: false, vm_status: "ABORTED" }],
      },
    },
  } as never);
  const port: ReleaseClientPort = {
    buildSingleSigner: async () => { throw new Error("unexpected build"); },
    buildMultiAgent: async () => { throw new Error("unexpected build"); },
    simulateSingleSigner: failed.simulateSingleSigner.bind(failed),
    simulateMultiAgent: failed.simulateMultiAgent.bind(failed),
  };
  await rejects(async () => simulateReleaseCandidate(built, port, NOW), Error);
});

test("candidate assembler rejects simulation authenticators with changed keys or nonzero signatures", async () => {
  const single = await buildReleaseCandidate(
    contextFor(fixture, requestFor(fixture, "core_initialize")),
    buildPort(),
  );
  await rejects(async () => simulateReleaseCandidate(single, simulationPort(single, (response) => {
    const changed = structuredClone(response);
    (changed.signature as Record<string, unknown>).public_key = `0x${"ff".repeat(32)}`;
    return changed;
  }), NOW), Error);
  await rejects(async () => simulateReleaseCandidate(single, simulationPort(single, (response) => {
    const changed = structuredClone(response);
    (changed.signature as Record<string, unknown>).signature = `0x01${"00".repeat(63)}`;
    return changed;
  }), NOW), Error);

  const multi = await buildReleaseCandidate(
    contextFor(fixture, requestFor(fixture, "pool_launch")),
    buildPort(),
  );
  await rejects(async () => simulateReleaseCandidate(multi, simulationPort(multi, (response) => {
    const changed = structuredClone(response);
    const signature = changed.signature as Record<string, unknown>;
    const secondary = signature.secondary_signers as Array<Record<string, unknown>>;
    secondary[0]!.public_key = `0x${"ee".repeat(32)}`;
    return changed;
  }), NOW), Error);
});

test("candidate output is an exclusive atomic mode-0700 directory containing two mode-0600 files", async () => {
  const built = await buildReleaseCandidate(contextFor(fixture, requestFor(fixture, "core_initialize")), buildPort());
  const bundle = await simulateReleaseCandidate(built, simulationPort(built), NOW);
  const bytes = candidateBundleBytes(bundle);
  const output = join(fixture.root, "atomic-output");
  let validatorCalls = 0;
  await finalizeCandidateDirectoryAtomically({
    outputDirectory: output,
    candidateBytes: bytes.candidate,
    simulationBytes: bytes.simulationResponse,
    pythonRuntime: "/usr/bin/python3",
    renameNoReplaceHelper: join(process.cwd(), "scripts", "rename_noreplace.py"),
    validate: (candidatePath, simulationPath) => {
      validatorCalls += 1;
      equal(readFileSync(candidatePath).equals(Buffer.from(bytes.candidate)), true, "Validator sees exact candidate bytes in staging");
      equal(readFileSync(simulationPath).equals(Buffer.from(bytes.simulationResponse)), true, "Validator sees exact simulation bytes in staging");
    },
  });
  equal(validatorCalls, 1, "Atomic finalization validates exactly once before rename");
  equal(statSync(output).mode & 0o777, 0o700, "Final candidate directory is private");
  equal(statSync(join(output, "transaction-candidate.json")).mode & 0o777, 0o600, "Candidate file is private");
  equal(statSync(join(output, "simulation-response.json")).mode & 0o777, 0o600, "Simulation file is private");
  equal(
    JSON.stringify(readdirSync(output).sort()),
    JSON.stringify(["simulation-response.json", "transaction-candidate.json"]),
    "Atomic output exposes only the validated evidence pair",
  );
  await rejects(async () => finalizeCandidateDirectoryAtomically({
    outputDirectory: output,
    candidateBytes: bytes.candidate,
    simulationBytes: bytes.simulationResponse,
    validate: () => undefined,
  }), Error);

  const rejectedOutput = join(fixture.root, "rejected-atomic-output");
  await rejects(async () => finalizeCandidateDirectoryAtomically({
    outputDirectory: rejectedOutput,
    candidateBytes: bytes.candidate,
    simulationBytes: bytes.simulationResponse,
    validate: () => { throw new Error("deliberate validator failure"); },
  }), Error);
  equal(existsSync(rejectedOutput), false, "Validator failure never exposes a final candidate directory");
  equal(existsSync(`${rejectedOutput}.assemble.lock`), false, "Validator failure releases the exclusive output lock");

  const racedOutput = join(fixture.root, "raced-atomic-output");
  await rejects(async () => finalizeCandidateDirectoryAtomically({
    outputDirectory: racedOutput,
    candidateBytes: bytes.candidate,
    simulationBytes: bytes.simulationResponse,
    validate: () => {
      mkdirSync(racedOutput, { mode: 0o700 });
      writeFileSync(join(racedOutput, "racer-owned"), "preserve\n", { mode: 0o600 });
    },
  }), Error);
  equal(readFileSync(join(racedOutput, "racer-owned"), "utf8"), "preserve\n", "Kernel no-replace preserves the race winner");
  equal(existsSync(join(racedOutput, "transaction-candidate.json")), false, "A losing assembler never merges candidate files into the race winner");
  equal(existsSync(`${racedOutput}.assemble.lock`), false, "No-replace race failure releases the exclusive output lock");

  const durabilityUnknownOutput = join(fixture.root, "durability-unknown-output");
  let durabilityError = "";
  try {
    await finalizeCandidateDirectoryAtomically({
      outputDirectory: durabilityUnknownOutput,
      candidateBytes: bytes.candidate,
      simulationBytes: bytes.simulationResponse,
      validate: () => undefined,
      syncDirectory: async (_path, phase) => {
        if (phase === "post-publish") throw new Error("injected parent fsync failure");
      },
    });
  } catch (error) {
    durabilityError = error instanceof Error ? error.message : String(error);
  }
  ok(/published.*durability is unknown/.test(durabilityError), "Post-rename fsync failure is explicit about visibility and uncertain durability");
  equal(existsSync(durabilityUnknownOutput), true, "Post-rename fsync failure reports an already-visible candidate");
  equal(
    readFileSync(join(durabilityUnknownOutput, "transaction-candidate.json")).equals(Buffer.from(bytes.candidate)),
    true,
    "Durability-unknown publication retains the exact validated candidate bytes",
  );

  const unsafeParent = join(fixture.root, "unsafe-output-parent");
  mkdirSync(unsafeParent, { mode: 0o700 });
  chmodSync(unsafeParent, 0o777);
  const unsafeOutput = join(unsafeParent, "candidate");
  await rejects(async () => finalizeCandidateDirectoryAtomically({
    outputDirectory: unsafeOutput,
    candidateBytes: bytes.candidate,
    simulationBytes: bytes.simulationResponse,
    validate: () => undefined,
  }), Error);
  equal(existsSync(unsafeOutput), false, "Group/world-writable output parent is rejected before staging or publication");
});

try {
  await run();
} finally {
  if (fixture.root.startsWith(`${TEST_TMP}/cedra-candidate-assembler-test-`)) {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}
