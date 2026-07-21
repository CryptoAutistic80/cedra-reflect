import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

export const REVIEWED_SDK_PACKAGE = "@cedra-labs/ts-sdk";
export const REVIEWED_SDK_VERSION = "2.2.8";
export const REVIEWED_SDK_PIN_FILE = "ops/evidence/reviewed-cedra-sdk-2.2.8.json";
export const RELEASE_EXECUTABLE_CLOSURE_FILE = "ops/evidence/release-executable-closure.json";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9@._+/-]+$/;

export interface BuildIntegrityEvidence {
  readonly release_executable_closure_file: typeof RELEASE_EXECUTABLE_CLOSURE_FILE;
  readonly release_executable_closure_sha256: string;
  readonly package_lock_file: "package-lock.json";
  readonly package_lock_sha256: string;
  readonly sdk_package: typeof REVIEWED_SDK_PACKAGE;
  readonly sdk_version: typeof REVIEWED_SDK_VERSION;
  readonly sdk_lock_integrity: string;
  readonly sdk_review_pin_file: typeof REVIEWED_SDK_PIN_FILE;
  readonly sdk_review_pin_sha256: string;
  readonly sdk_package_json_sha256: string;
  readonly sdk_loaded_entrypoint: string;
  readonly sdk_loaded_entrypoint_sha256: string;
  readonly sdk_package_tree_sha256: string;
  readonly sdk_package_file_count: number;
  readonly sdk_review_attestation_sha256: string;
  readonly sdk_review_signature_sha256: string;
  readonly sdk_review_signature_namespace: "cedra-reflect-sdk-review-v1";
  readonly sdk_review_reviewer_identity: string;
  readonly sdk_review_trusted_signers_sha256: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireRegularFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular non-symlink file`);
  }
}

function portableRelative(root: string, path: string, label: string): string {
  const value = relative(root, path).split(sep).join("/");
  if (value.length === 0 || value === ".." || value.startsWith("../")
    || !SAFE_RELATIVE_PATH.test(value)) {
    fail(`${label} is outside the reviewed package tree or has an unsafe path`);
  }
  return value;
}

function packageTree(root: string): { readonly sha256: string; readonly files: number } {
  const records: string[] = [];
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        fail(`reviewed SDK package tree contains a symbolic link: ${portableRelative(root, path, "SDK path")}`);
      }
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) {
        fail(`reviewed SDK package tree contains a non-regular entry: ${portableRelative(root, path, "SDK path")}`);
      }
      const bytes = readFileSync(path);
      records.push(`${sha256(bytes)}\u0000${bytes.length.toString()}\u0000${portableRelative(root, path, "SDK file")}\n`);
    }
  };
  visit(root);
  if (records.length === 0) {
    fail("reviewed SDK package tree is empty");
  }
  return { sha256: sha256(records.join("")), files: records.length };
}

function parseJson(path: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(`${label} must contain a JSON object`);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertReviewedPin(
  pin: Record<string, unknown>,
  integrity: string,
  observed: {
    readonly packageJsonSha256: string;
    readonly entrypoint: string;
    readonly entrypointSha256: string;
    readonly treeSha256: string;
    readonly fileCount: number;
  },
): void {
  const keys = Object.keys(pin).sort();
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
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    fail("reviewed Cedra SDK artifact pin has missing or extra fields");
  }
  if (pin.schema_version !== 1
    || pin.evidence_scope !== "reviewed-npm-sdk-artifact"
    || pin.package_name !== REVIEWED_SDK_PACKAGE
    || pin.package_version !== REVIEWED_SDK_VERSION
    || pin.registry_tarball_url !== "https://registry.npmjs.org/@cedra-labs/ts-sdk/-/ts-sdk-2.2.8.tgz"
    || pin.npm_tarball_sha512_integrity !== integrity
    || typeof pin.npm_tarball_sha256 !== "string"
    || !SHA256_PATTERN.test(pin.npm_tarball_sha256)
    || pin.package_tree_digest_algorithm !== "sha256(depth_first_lexicographic_path_components(sha256(file_bytes) NUL decimal_byte_length NUL posix_relative_path LF))") {
    fail("reviewed Cedra SDK artifact pin is invalid or differs from package-lock.json");
  }
  if (pin.sdk_package_json_sha256 !== observed.packageJsonSha256
    || pin.sdk_loaded_entrypoint !== observed.entrypoint
    || pin.sdk_loaded_entrypoint_sha256 !== observed.entrypointSha256
    || pin.sdk_package_tree_sha256 !== observed.treeSha256
    || pin.sdk_package_file_count !== observed.fileCount) {
    fail("actually loaded Cedra SDK artifact differs from the independently reviewed npm tarball pin");
  }
}

export function computeBuildIntegrity(args: {
  readonly repoRoot: string;
  readonly sdkPackageJsonPath: string;
  readonly sdkEntrypointPath: string;
  readonly sdkReviewAttestationPath: string;
  readonly sdkReviewSignaturePath: string;
  readonly sdkReviewTrustPath: string;
}): BuildIntegrityEvidence {
  const repoRoot = realpathSync(resolve(args.repoRoot));
  const packageLockPath = resolve(repoRoot, "package-lock.json");
  const reviewPinPath = resolve(repoRoot, REVIEWED_SDK_PIN_FILE);
  const executableClosurePath = resolve(repoRoot, RELEASE_EXECUTABLE_CLOSURE_FILE);
  requireRegularFile(packageLockPath, "reviewed package lockfile");
  requireRegularFile(reviewPinPath, "reviewed Cedra SDK artifact pin");
  requireRegularFile(executableClosurePath, "reviewed release executable-closure manifest");
  const sdkReviewAttestationPath = realpathSync(resolve(args.sdkReviewAttestationPath));
  const sdkReviewSignaturePath = realpathSync(resolve(args.sdkReviewSignaturePath));
  const sdkReviewTrustPath = realpathSync(resolve(args.sdkReviewTrustPath));
  requireRegularFile(sdkReviewAttestationPath, "independent SDK-review attestation");
  requireRegularFile(sdkReviewSignaturePath, "independent SDK-review signature");
  requireRegularFile(sdkReviewTrustPath, "independent SDK-review trust anchor");

  const sdkPackageJsonPath = realpathSync(resolve(args.sdkPackageJsonPath));
  requireRegularFile(sdkPackageJsonPath, "loaded Cedra SDK package manifest");
  const sdkRoot = realpathSync(dirname(sdkPackageJsonPath));
  if (sdkPackageJsonPath !== resolve(sdkRoot, "package.json")) {
    fail("loaded Cedra SDK package manifest is not the package-root package.json");
  }
  const sdkEntrypointPath = realpathSync(resolve(args.sdkEntrypointPath));
  requireRegularFile(sdkEntrypointPath, "loaded Cedra SDK entrypoint");
  const sdkEntrypoint = portableRelative(sdkRoot, sdkEntrypointPath, "loaded Cedra SDK entrypoint");

  const sdkManifest = parseJson(sdkPackageJsonPath, "loaded Cedra SDK package manifest");
  if (sdkManifest.name !== REVIEWED_SDK_PACKAGE || sdkManifest.version !== REVIEWED_SDK_VERSION) {
    fail(`loaded SDK must be ${REVIEWED_SDK_PACKAGE} ${REVIEWED_SDK_VERSION}`);
  }
  const lock = parseJson(packageLockPath, "reviewed package lockfile");
  const packages = lock.packages;
  if (packages === null || typeof packages !== "object" || Array.isArray(packages)) {
    fail("reviewed package lockfile has no packages map");
  }
  const lockedSdk = (packages as Record<string, unknown>)["node_modules/@cedra-labs/ts-sdk"];
  if (lockedSdk === null || typeof lockedSdk !== "object" || Array.isArray(lockedSdk)) {
    fail("reviewed package lockfile has no Cedra SDK record");
  }
  const locked = lockedSdk as Record<string, unknown>;
  if (locked.version !== REVIEWED_SDK_VERSION
    || typeof locked.integrity !== "string"
    || !SHA512_INTEGRITY_PATTERN.test(locked.integrity)) {
    fail(`reviewed package lockfile must pin ${REVIEWED_SDK_PACKAGE} ${REVIEWED_SDK_VERSION} with SHA-512 integrity`);
  }
  const tree = packageTree(sdkRoot);
  const packageJsonSha256 = sha256(readFileSync(sdkPackageJsonPath));
  const entrypointSha256 = sha256(readFileSync(sdkEntrypointPath));
  assertReviewedPin(
    parseJson(reviewPinPath, "reviewed Cedra SDK artifact pin"),
    locked.integrity,
    {
      packageJsonSha256,
      entrypoint: sdkEntrypoint,
      entrypointSha256,
      treeSha256: tree.sha256,
      fileCount: tree.files,
    },
  );
  const attestation = parseJson(sdkReviewAttestationPath, "independent SDK-review attestation");
  const reviewerIdentity = attestation.reviewer_identity;
  const trustSha256 = sha256(readFileSync(sdkReviewTrustPath));
  if (attestation.evidence_scope !== "independent-cedra-sdk-review-attestation"
    || attestation.decision !== "approved-for-testnet-candidate-assembly"
    || typeof reviewerIdentity !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._@+-]{2,127}$/.test(reviewerIdentity)
    || attestation.sdk_review_pin_sha256 !== sha256(readFileSync(reviewPinPath))
    || attestation.sdk_package_tree_sha256 !== tree.sha256
    || attestation.sdk_package_file_count !== tree.files
    || attestation.trusted_allowed_signers_sha256 !== trustSha256) {
    fail("independent SDK-review attestation does not bind the loaded reviewed SDK and external trust anchor");
  }
  return {
    release_executable_closure_file: RELEASE_EXECUTABLE_CLOSURE_FILE,
    release_executable_closure_sha256: sha256(readFileSync(executableClosurePath)),
    package_lock_file: "package-lock.json",
    package_lock_sha256: sha256(readFileSync(packageLockPath)),
    sdk_package: REVIEWED_SDK_PACKAGE,
    sdk_version: REVIEWED_SDK_VERSION,
    sdk_lock_integrity: locked.integrity,
    sdk_review_pin_file: REVIEWED_SDK_PIN_FILE,
    sdk_review_pin_sha256: sha256(readFileSync(reviewPinPath)),
    sdk_package_json_sha256: packageJsonSha256,
    sdk_loaded_entrypoint: sdkEntrypoint,
    sdk_loaded_entrypoint_sha256: entrypointSha256,
    sdk_package_tree_sha256: tree.sha256,
    sdk_package_file_count: tree.files,
    sdk_review_attestation_sha256: sha256(readFileSync(sdkReviewAttestationPath)),
    sdk_review_signature_sha256: sha256(readFileSync(sdkReviewSignaturePath)),
    sdk_review_signature_namespace: "cedra-reflect-sdk-review-v1",
    sdk_review_reviewer_identity: reviewerIdentity,
    sdk_review_trusted_signers_sha256: trustSha256,
  };
}

export function validateBuildIntegrityEvidence(value: unknown): BuildIntegrityEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("build integrity evidence must be an object");
  }
  const observed = value as Record<string, unknown>;
  const keys = Object.keys(observed).sort();
  const expectedKeys = [
    "release_executable_closure_file",
    "release_executable_closure_sha256",
    "package_lock_file",
    "package_lock_sha256",
    "sdk_loaded_entrypoint",
    "sdk_loaded_entrypoint_sha256",
    "sdk_lock_integrity",
    "sdk_package",
    "sdk_package_file_count",
    "sdk_package_json_sha256",
    "sdk_package_tree_sha256",
    "sdk_review_pin_file",
    "sdk_review_pin_sha256",
    "sdk_review_attestation_sha256",
    "sdk_review_signature_sha256",
    "sdk_review_signature_namespace",
    "sdk_review_reviewer_identity",
    "sdk_review_trusted_signers_sha256",
    "sdk_version",
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    fail("build integrity evidence has missing or extra fields");
  }
  if (observed.package_lock_file !== "package-lock.json"
    || observed.release_executable_closure_file !== RELEASE_EXECUTABLE_CLOSURE_FILE
    || observed.sdk_package !== REVIEWED_SDK_PACKAGE
    || observed.sdk_version !== REVIEWED_SDK_VERSION
    || observed.sdk_review_pin_file !== REVIEWED_SDK_PIN_FILE
    || observed.sdk_review_signature_namespace !== "cedra-reflect-sdk-review-v1"
    || typeof observed.sdk_review_reviewer_identity !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._@+-]{2,127}$/.test(observed.sdk_review_reviewer_identity)
    || typeof observed.sdk_lock_integrity !== "string"
    || !SHA512_INTEGRITY_PATTERN.test(observed.sdk_lock_integrity)
    || typeof observed.sdk_loaded_entrypoint !== "string"
    || !SAFE_RELATIVE_PATH.test(observed.sdk_loaded_entrypoint)
    || observed.sdk_loaded_entrypoint.startsWith("/")
    || observed.sdk_loaded_entrypoint.includes("../")
    || typeof observed.sdk_package_file_count !== "number"
    || !Number.isSafeInteger(observed.sdk_package_file_count)
    || observed.sdk_package_file_count <= 0) {
    fail("build integrity evidence has an invalid fixed field");
  }
  for (const key of [
    "release_executable_closure_sha256",
    "package_lock_sha256",
    "sdk_review_pin_sha256",
    "sdk_package_json_sha256",
    "sdk_loaded_entrypoint_sha256",
    "sdk_package_tree_sha256",
    "sdk_review_attestation_sha256",
    "sdk_review_signature_sha256",
    "sdk_review_trusted_signers_sha256",
  ] as const) {
    if (typeof observed[key] !== "string" || !SHA256_PATTERN.test(observed[key])) {
      fail(`build integrity evidence ${key} is not a SHA-256 digest`);
    }
  }
  return observed as unknown as BuildIntegrityEvidence;
}

export function assertBuildIntegrityMatches(
  expected: BuildIntegrityEvidence,
  observed: BuildIntegrityEvidence,
): void {
  if (JSON.stringify(expected) !== JSON.stringify(observed)) {
    fail("current reviewed lockfile or loaded Cedra SDK artifact differs from the candidate build integrity");
  }
}
