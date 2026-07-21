#!/usr/bin/env node

import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  Deserializer,
  MultiAgentTransaction,
  RawTransaction,
  SimpleTransaction,
  TransactionPayloadEntryFunction,
  generateSigningMessageForTransaction,
} from "@cedra-labs/ts-sdk";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = realpathSync(resolve(scriptDirectory, ".."));
const reviewedSdkPackage = "@cedra-labs/ts-sdk";
const reviewedSdkVersion = "2.2.8";
const reviewedSdkPinFile = "ops/evidence/reviewed-cedra-sdk-2.2.8.json";
const releaseExecutableClosureFile = "ops/evidence/release-executable-closure.json";
const safeRelativePath = /^[A-Za-z0-9@._+/-]+$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const sha512IntegrityPattern = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

function fail(message) {
  throw new Error(message);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function bytesFromHex(value, label) {
  requireValue(typeof value === "string" && /^0x(?:[0-9a-f]{2})+$/.test(value), `${label} must be lowercase, non-empty, even-length 0x hex`);
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
}

function hexFromBytes(value) {
  return `0x${Buffer.from(value).toString("hex")}`;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireRegularFile(path, label) {
  const stat = lstatSync(path);
  requireValue(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular non-symlink file`);
}

function portableRelative(root, path, label) {
  const value = relative(root, path).split(sep).join("/");
  requireValue(
    value.length > 0
      && value !== ".."
      && !value.startsWith("../")
      && safeRelativePath.test(value),
    `${label} is outside the reviewed package tree or has an unsafe path`,
  );
  return value;
}

function parseObject(path, label) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must contain a JSON object`);
  return value;
}

function sdkPackageTree(root) {
  const records = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      requireValue(!entry.isSymbolicLink(), `reviewed SDK package tree contains a symbolic link: ${portableRelative(root, path, "SDK path")}`);
      if (entry.isDirectory()) {
        visit(path);
      } else {
        requireValue(entry.isFile(), `reviewed SDK package tree contains a non-regular entry: ${portableRelative(root, path, "SDK path")}`);
        const bytes = readFileSync(path);
        records.push(`${digest(bytes)}\u0000${bytes.length.toString()}\u0000${portableRelative(root, path, "SDK file")}\n`);
      }
    }
  };
  visit(root);
  requireValue(records.length > 0, "reviewed SDK package tree is empty");
  return { sha256: digest(records.join("")), files: records.length };
}

function assertReviewedPin(pin, integrity, observed) {
  const expectedKeys = [
    "schema_version",
    "evidence_scope",
    "package_name",
    "package_version",
    "registry_tarball_url",
    "npm_tarball_sha512_integrity",
    "npm_tarball_sha256",
    "package_tree_digest_algorithm",
    "sdk_package_json_sha256",
    "sdk_loaded_entrypoint",
    "sdk_loaded_entrypoint_sha256",
    "sdk_package_tree_sha256",
    "sdk_package_file_count",
  ].sort();
  requireValue(JSON.stringify(Object.keys(pin).sort()) === JSON.stringify(expectedKeys), "reviewed Cedra SDK artifact pin has missing or extra fields");
  requireValue(
    pin.schema_version === 1
      && pin.evidence_scope === "reviewed-npm-sdk-artifact"
      && pin.package_name === reviewedSdkPackage
      && pin.package_version === reviewedSdkVersion
      && pin.registry_tarball_url === "https://registry.npmjs.org/@cedra-labs/ts-sdk/-/ts-sdk-2.2.8.tgz"
      && pin.npm_tarball_sha512_integrity === integrity
      && typeof pin.npm_tarball_sha256 === "string"
      && sha256Pattern.test(pin.npm_tarball_sha256)
      && pin.package_tree_digest_algorithm === "sha256(depth_first_lexicographic_path_components(sha256(file_bytes) NUL decimal_byte_length NUL posix_relative_path LF))",
    "reviewed Cedra SDK artifact pin is invalid or differs from package-lock.json",
  );
  requireValue(
    pin.sdk_package_json_sha256 === observed.packageJsonSha256
      && pin.sdk_loaded_entrypoint === observed.entrypoint
      && pin.sdk_loaded_entrypoint_sha256 === observed.entrypointSha256
      && pin.sdk_package_tree_sha256 === observed.treeSha256
      && pin.sdk_package_file_count === observed.fileCount,
    "actually loaded Cedra SDK artifact differs from the independently reviewed npm tarball pin",
  );
}

/** Independently recompute the lockfile and actually loaded SDK artifact identity. */
export function computeBuildIntegrity({
  repoRoot,
  sdkPackageJsonPath,
  sdkEntrypointPath,
  sdkReviewAttestationPath,
  sdkReviewSignaturePath,
  sdkReviewTrustPath,
}) {
  const root = realpathSync(resolve(repoRoot));
  const packageLockPath = resolve(root, "package-lock.json");
  const reviewPinPath = resolve(root, reviewedSdkPinFile);
  const executableClosurePath = resolve(root, releaseExecutableClosureFile);
  requireRegularFile(packageLockPath, "reviewed package lockfile");
  requireRegularFile(reviewPinPath, "reviewed Cedra SDK artifact pin");
  requireRegularFile(executableClosurePath, "reviewed release executable-closure manifest");
  const attestationPath = realpathSync(resolve(sdkReviewAttestationPath));
  const signaturePath = realpathSync(resolve(sdkReviewSignaturePath));
  const trustPath = realpathSync(resolve(sdkReviewTrustPath));
  requireRegularFile(attestationPath, "independent SDK-review attestation");
  requireRegularFile(signaturePath, "independent SDK-review signature");
  requireRegularFile(trustPath, "independent SDK-review trust anchor");
  const packageJsonPath = realpathSync(resolve(sdkPackageJsonPath));
  requireRegularFile(packageJsonPath, "loaded Cedra SDK package manifest");
  const sdkRoot = realpathSync(dirname(packageJsonPath));
  requireValue(packageJsonPath === resolve(sdkRoot, "package.json"), "loaded Cedra SDK package manifest is not the package-root package.json");
  const entrypointPath = realpathSync(resolve(sdkEntrypointPath));
  requireRegularFile(entrypointPath, "loaded Cedra SDK entrypoint");
  const entrypoint = portableRelative(sdkRoot, entrypointPath, "loaded Cedra SDK entrypoint");

  const sdkManifest = parseObject(packageJsonPath, "loaded Cedra SDK package manifest");
  requireValue(sdkManifest.name === reviewedSdkPackage && sdkManifest.version === reviewedSdkVersion, `loaded SDK must be ${reviewedSdkPackage} ${reviewedSdkVersion}`);
  const lock = parseObject(packageLockPath, "reviewed package lockfile");
  requireValue(lock.packages !== null && typeof lock.packages === "object" && !Array.isArray(lock.packages), "reviewed package lockfile has no packages map");
  const locked = lock.packages["node_modules/@cedra-labs/ts-sdk"];
  requireValue(locked !== null && typeof locked === "object" && !Array.isArray(locked), "reviewed package lockfile has no Cedra SDK record");
  requireValue(
    locked.version === reviewedSdkVersion
      && typeof locked.integrity === "string"
      && sha512IntegrityPattern.test(locked.integrity),
    `reviewed package lockfile must pin ${reviewedSdkPackage} ${reviewedSdkVersion} with SHA-512 integrity`,
  );
  const tree = sdkPackageTree(sdkRoot);
  const packageJsonSha256 = digest(readFileSync(packageJsonPath));
  const entrypointSha256 = digest(readFileSync(entrypointPath));
  assertReviewedPin(
    parseObject(reviewPinPath, "reviewed Cedra SDK artifact pin"),
    locked.integrity,
    {
      packageJsonSha256,
      entrypoint,
      entrypointSha256,
      treeSha256: tree.sha256,
      fileCount: tree.files,
    },
  );
  const attestation = parseObject(attestationPath, "independent SDK-review attestation");
  const trustSha256 = digest(readFileSync(trustPath));
  requireValue(
    attestation.evidence_scope === "independent-cedra-sdk-review-attestation"
      && attestation.decision === "approved-for-testnet-candidate-assembly"
      && typeof attestation.reviewer_identity === "string"
      && /^[A-Za-z0-9][A-Za-z0-9._@+-]{2,127}$/.test(attestation.reviewer_identity)
      && attestation.sdk_review_pin_sha256 === digest(readFileSync(reviewPinPath))
      && attestation.sdk_package_tree_sha256 === tree.sha256
      && attestation.sdk_package_file_count === tree.files
      && attestation.trusted_allowed_signers_sha256 === trustSha256,
    "independent SDK-review attestation does not bind approval-time SDK bytes and trust anchor",
  );
  return {
    release_executable_closure_file: releaseExecutableClosureFile,
    release_executable_closure_sha256: digest(readFileSync(executableClosurePath)),
    package_lock_file: "package-lock.json",
    package_lock_sha256: digest(readFileSync(packageLockPath)),
    sdk_package: reviewedSdkPackage,
    sdk_version: reviewedSdkVersion,
    sdk_lock_integrity: locked.integrity,
    sdk_review_pin_file: reviewedSdkPinFile,
    sdk_review_pin_sha256: digest(readFileSync(reviewPinPath)),
    sdk_package_json_sha256: packageJsonSha256,
    sdk_loaded_entrypoint: entrypoint,
    sdk_loaded_entrypoint_sha256: entrypointSha256,
    sdk_package_tree_sha256: tree.sha256,
    sdk_package_file_count: tree.files,
    sdk_review_attestation_sha256: digest(readFileSync(attestationPath)),
    sdk_review_signature_sha256: digest(readFileSync(signaturePath)),
    sdk_review_signature_namespace: "cedra-reflect-sdk-review-v1",
    sdk_review_reviewer_identity: attestation.reviewer_identity,
    sdk_review_trusted_signers_sha256: trustSha256,
  };
}

export function validateBuildEnvironment(candidate, observed) {
  const environment = candidate?.build_environment;
  requireValue(environment !== null && typeof environment === "object" && !Array.isArray(environment), "candidate build_environment is required");
  const expectedKeys = [
    "repository_head_commit",
    "repository_head_tree",
    "release_executable_closure_file",
    "release_executable_closure_sha256",
    "package_lock_file",
    "package_lock_sha256",
    "sdk_package",
    "sdk_version",
    "sdk_lock_integrity",
    "sdk_review_pin_file",
    "sdk_review_pin_sha256",
    "sdk_package_json_sha256",
    "sdk_loaded_entrypoint",
    "sdk_loaded_entrypoint_sha256",
    "sdk_package_tree_sha256",
    "sdk_package_file_count",
    "sdk_review_attestation_sha256",
    "sdk_review_signature_sha256",
    "sdk_review_signature_namespace",
    "sdk_review_reviewer_identity",
    "sdk_review_trusted_signers_sha256",
  ].sort();
  requireValue(JSON.stringify(Object.keys(environment).sort()) === JSON.stringify(expectedKeys), "candidate build_environment has missing or extra fields");
  requireValue(environment.repository_head_commit === candidate.application_commit, "candidate build HEAD differs from its application commit");
  requireValue(typeof environment.repository_head_tree === "string" && /^[0-9a-f]{40}$/.test(environment.repository_head_tree), "candidate build tree is invalid");
  requireValue(environment.release_executable_closure_file === releaseExecutableClosureFile, "candidate build must bind the reviewed release executable-closure manifest");
  for (const field of ["release_executable_closure_sha256", "package_lock_sha256", "sdk_review_pin_sha256", "sdk_package_json_sha256", "sdk_loaded_entrypoint_sha256", "sdk_package_tree_sha256", "sdk_review_attestation_sha256", "sdk_review_signature_sha256", "sdk_review_trusted_signers_sha256"]) {
    requireValue(typeof environment[field] === "string" && sha256Pattern.test(environment[field]), `candidate build ${field} is invalid`);
  }
  requireValue(JSON.stringify(environment, expectedKeys) === JSON.stringify({ ...observed, repository_head_commit: environment.repository_head_commit, repository_head_tree: environment.repository_head_tree }, expectedKeys), "candidate lockfile or actually loaded Cedra SDK artifact differs from approval-time bytes");
}

function canonicalAddress(value) {
  requireValue(typeof value === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(value), "invalid Cedra address");
  const digits = value.slice(2).toLowerCase().replace(/^0+/, "") || "0";
  requireValue(digits !== "0", "zero Cedra address is forbidden");
  return `0x${digits}`;
}

function entryArgumentBytes(argument) {
  const bytes = argument?.value?.value;
  requireValue(bytes instanceof Uint8Array, "entry function argument did not deserialize as raw BCS bytes");
  return bytes;
}

function decodeVectorU8(bytes, label) {
  const decoder = new Deserializer(bytes);
  const value = decoder.deserializeBytes();
  decoder.assertFinished();
  requireValue(value.length > 0, `${label} cannot be empty`);
  return hexFromBytes(value);
}

function decodeVectorVectorU8(bytes) {
  const decoder = new Deserializer(bytes);
  const count = decoder.deserializeUleb128AsU32();
  requireValue(count > 0, "publish module vector cannot be empty");
  const modules = [];
  for (let index = 0; index < count; index += 1) {
    const module = decoder.deserializeBytes();
    requireValue(module.length > 0, `publish module ${index} cannot be empty`);
    modules.push(hexFromBytes(module));
  }
  decoder.assertFinished();
  return modules;
}

function decodeInteger(bytes, bits, label) {
  const decoder = new Deserializer(bytes);
  let value;
  if (bits === 64) value = decoder.deserializeU64();
  else if (bits === 128) value = decoder.deserializeU128();
  else fail(`unsupported integer width for ${label}`);
  decoder.assertFinished();
  requireValue(value > 0n, `${label} must be positive`);
  return value.toString();
}

function decodePayload(rawTransaction, operationKey) {
  requireValue(rawTransaction.payload instanceof TransactionPayloadEntryFunction, "raw BCS payload is not an entry function");
  const entry = rawTransaction.payload.entryFunction;
  const address = canonicalAddress(entry.module_name.address.toStringLong());
  const functionId = `${address}::${entry.module_name.name.identifier}::${entry.function_name.identifier}`;
  const typeArguments = entry.type_args.map((argument) => argument.toString());
  let argumentsValue;
  if (["core_publish", "assets_publish", "amm_publish"].includes(operationKey)) {
    requireValue(entry.args.length === 2, "package publish raw BCS must contain exactly two arguments");
    argumentsValue = [
      decodeVectorU8(entryArgumentBytes(entry.args[0]), "package metadata"),
      decodeVectorVectorU8(entryArgumentBytes(entry.args[1])),
    ];
  } else if (operationKey === "pool_seed") {
    requireValue(entry.args.length === 3, "pool seed raw BCS must contain exactly three amount arguments");
    argumentsValue = [
      decodeInteger(entryArgumentBytes(entry.args[0]), 64, "rfl amount"),
      decodeInteger(entryArgumentBytes(entry.args[1]), 64, "usd amount"),
      decodeInteger(entryArgumentBytes(entry.args[2]), 128, "minimum LP shares"),
    ];
  } else {
    requireValue(entry.args.length === 0, `${operationKey} raw BCS must contain zero payload arguments`);
    argumentsValue = [];
  }
  return {
    type: "entry_function_payload",
    function: functionId,
    type_arguments: typeArguments,
    arguments: argumentsValue,
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validate(candidate, sdkReviewAttestationPath, sdkReviewSignaturePath, sdkReviewTrustPath) {
  const observedBuildIntegrity = computeBuildIntegrity({
    repoRoot: repositoryRoot,
    sdkPackageJsonPath: fileURLToPath(import.meta.resolve("@cedra-labs/ts-sdk/package.json")),
    sdkEntrypointPath: fileURLToPath(import.meta.resolve("@cedra-labs/ts-sdk")),
    sdkReviewAttestationPath,
    sdkReviewSignaturePath,
    sdkReviewTrustPath,
  });
  validateBuildEnvironment(candidate, observedBuildIntegrity);
  const identity = candidate.transaction_identity;
  const expected = candidate.transaction;
  requireValue(identity && expected, "candidate transaction and transaction_identity are required");

  const rawBytes = bytesFromHex(identity.rawTransactionBcsHex, "rawTransactionBcsHex");
  const transactionBytes = bytesFromHex(identity.transactionBcsHex, "transactionBcsHex");
  const signingMessageBytes = bytesFromHex(identity.signingMessageHex, "signingMessageHex");
  requireValue(digest(rawBytes) === identity.rawTransactionSha256, "raw transaction BCS digest mismatch");
  requireValue(digest(transactionBytes) === identity.transactionSha256, "transaction wrapper BCS digest mismatch");
  requireValue(digest(signingMessageBytes) === identity.signingMessageSha256, "signing message digest mismatch");

  const rawDeserializer = new Deserializer(rawBytes);
  const standaloneRaw = RawTransaction.deserialize(rawDeserializer);
  rawDeserializer.assertFinished();
  requireValue(hexFromBytes(standaloneRaw.bcsToBytes()) === identity.rawTransactionBcsHex, "raw transaction BCS is not canonical")

  const transactionDeserializer = new Deserializer(transactionBytes);
  let transaction;
  if (identity.transactionType === "multi-agent") {
    transaction = MultiAgentTransaction.deserialize(transactionDeserializer);
  } else if (identity.transactionType === "single-signer") {
    transaction = SimpleTransaction.deserialize(transactionDeserializer);
  } else {
    fail("unsupported transaction identity type");
  }
  transactionDeserializer.assertFinished();
  requireValue(hexFromBytes(transaction.bcsToBytes()) === identity.transactionBcsHex, "transaction wrapper BCS is not canonical");
  requireValue(hexFromBytes(transaction.rawTransaction.bcsToBytes()) === identity.rawTransactionBcsHex, "wrapper and standalone raw transaction bytes differ");
  requireValue(hexFromBytes(generateSigningMessageForTransaction(transaction)) === identity.signingMessageHex, "SDK signing message does not match bound bytes/signers");

  const raw = transaction.rawTransaction;
  const observedSecondary = (transaction.secondarySignerAddresses ?? []).map((address) => canonicalAddress(address.toStringLong()));
  const expectedSecondary = expected.secondary_signers.map(canonicalAddress);
  requireValue(identity.transactionType === (expectedSecondary.length === 0 ? "single-signer" : "multi-agent"), "transaction type disagrees with signer count");
  requireValue(canonicalAddress(raw.sender.toStringLong()) === canonicalAddress(expected.sender), "raw BCS sender mismatch");
  requireValue(sameJson(observedSecondary, expectedSecondary), "raw BCS ordered secondary signers mismatch");
  requireValue(sameJson(identity.secondarySignerAddresses.map(canonicalAddress), expectedSecondary), "identity ordered secondary signers mismatch");
  requireValue(transaction.feePayerAddress === undefined && identity.feePayerAddress === null, "fee payer is forbidden for this release");
  requireValue(raw.sequence_number.toString() === expected.sequence_number && identity.sequenceNumber === expected.sequence_number, "raw BCS sequence mismatch");
  requireValue(raw.max_gas_amount.toString() === expected.max_gas_amount && identity.maxGasAmount === expected.max_gas_amount, "raw BCS max gas mismatch");
  requireValue(raw.gas_unit_price.toString() === expected.gas_unit_price && identity.gasUnitPrice === expected.gas_unit_price, "raw BCS gas unit price mismatch");
  requireValue(raw.expiration_timestamp_secs.toString() === expected.expiration_timestamp_secs && identity.expirationTimestampSeconds === expected.expiration_timestamp_secs, "raw BCS expiration mismatch");
  requireValue(raw.chain_id.chainId === 2 && identity.chainId === 2, "raw BCS chain id must be Cedra Testnet chain 2");
  requireValue(identity.fungibleAssetGasType === "0x1::cedra_coin::CedraCoin", "release gas asset must be the default CED type");
  requireValue(raw.fa_address.toString() === identity.fungibleAssetGasType, "raw BCS fungible gas type mismatch");
  requireValue(decodePayload(raw, candidate.operation_key).function === expected.payload.function, "raw BCS entry function mismatch");
  requireValue(sameJson(decodePayload(raw, candidate.operation_key), expected.payload), "raw BCS type arguments or exact payload argument bytes mismatch");
}

function main() {
  requireValue(process.argv.length === 6, "usage: validate_release_transaction_bcs.mjs TRANSACTION_CANDIDATE_JSON SDK_REVIEW_ATTESTATION SDK_REVIEW_SIGNATURE SDK_REVIEW_TRUSTED_SIGNERS");
  const candidate = JSON.parse(readFileSync(process.argv[2], "utf8"));
  validate(candidate, process.argv[3], process.argv[4], process.argv[5]);
  process.stdout.write(`valid SDK raw/signing BCS transaction binding: ${process.argv[2]}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`raw transaction BCS validation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(65);
  }
}
