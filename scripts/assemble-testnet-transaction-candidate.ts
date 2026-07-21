#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message: string): never {
  throw new Error(message);
}

async function requireRegularInput(path: string, label: string): Promise<string> {
  const absolute = resolve(path);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular non-symlink file`);
  }
  return absolute;
}

async function requireRealDirectory(path: string, label: string): Promise<string> {
  const absolute = resolve(path);
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`${label} must be a real directory`);
  }
  return absolute;
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function runChecked(
  repoRoot: string,
  command: string,
  args: readonly string[],
  label: string,
  extraEnvironment: Readonly<Record<string, string>> = {},
): void {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LC_ALL: "C",
      LANG: "C",
      TMPDIR: "/tmp",
      ...extraEnvironment,
    },
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    fail(`${label} failed${detail.length > 0 ? `: ${detail}` : ""}`);
  }
}

function runCaptured(repoRoot: string, command: string, args: readonly string[], label: string): string {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LC_ALL: "C",
      LANG: "C",
      TMPDIR: "/tmp",
    },
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    fail(`${label} failed${detail.length > 0 ? `: ${detail}` : ""}`);
  }
  return result.stdout ?? "";
}

async function main(): Promise<void> {
  if (process.argv.length !== 11) {
    fail(
      "usage: assemble-testnet-transaction-candidate EXACT_ADDRESS_ARTIFACTS_JSON PUBLIC_PROFILE_EVIDENCE_JSON BUILD_REQUEST_JSON OUTPUT_DIRECTORY SDK_REVIEW_ATTESTATION SDK_REVIEW_SIGNATURE SDK_REVIEW_TRUSTED_SIGNERS REPOSITORY_ROOT FRESH_EMITTED_JS_DIRECTORY",
    );
  }
  process.umask(0o077);
  const exactPath = await requireRegularInput(process.argv[2]!, "exact-address artifact bundle");
  const profilePath = await requireRegularInput(process.argv[3]!, "public-profile evidence");
  const requestPath = await requireRegularInput(process.argv[4]!, "transaction build request");
  const outputDirectory = resolve(process.argv[5]!);
  const sdkReviewAttestationPath = await requireRegularInput(process.argv[6]!, "independent SDK-review attestation");
  const sdkReviewSignaturePath = await requireRegularInput(process.argv[7]!, "independent SDK-review signature");
  const sdkReviewTrustPath = await requireRegularInput(process.argv[8]!, "independent SDK-review trust anchor");
  const repoRoot = await requireRealDirectory(process.argv[9]!, "release repository");
  const emittedRoot = await requireRealDirectory(process.argv[10]!, "fresh emitted-JS directory");

  runChecked(
    repoRoot,
    "/usr/bin/bash",
    [
      join(repoRoot, "scripts/preflight_release_executable_closure.sh"),
      repoRoot,
      process.execPath,
      sdkReviewAttestationPath,
      sdkReviewSignaturePath,
      sdkReviewTrustPath,
      "execution",
      emittedRoot,
    ],
    "release executable-closure preflight before SDK imports",
  );
  runChecked(
    repoRoot,
    "/usr/bin/bash",
    [join(repoRoot, "scripts/validate_live_release_checkout.sh"), repoRoot, requestPath, exactPath],
    "live clean release checkout verification",
  );

  const { CedraReleaseClient } = await import("../packages/protocol-sdk/src/index.js");
  const {
    assembleReleaseCandidate,
    assertRuntimeSdkPackage,
    candidateBundleBytes,
    computeBuildIntegrity,
    finalizeCandidateDirectoryAtomically,
    validateAssemblyInputs,
  } = await import("../packages/release-candidate-assembler/src/index.js");
  const runtimeSdkPackagePath = fileURLToPath(import.meta.resolve("@cedra-labs/ts-sdk/package.json"));
  const runtimeSdkEntrypointPath = fileURLToPath(import.meta.resolve("@cedra-labs/ts-sdk"));

  runChecked(
    repoRoot,
    "/usr/bin/bash",
    [join(repoRoot, "scripts/validate_candidate_release_inputs.sh"), exactPath, profilePath],
    "approval-grade exact-address and public-profile validation",
  );

  const [exactBytes, profileBytes, requestBytes, rootPackageBytes, runtimeSdkPackageBytes] = await Promise.all([
    readFile(exactPath),
    readFile(profilePath),
    readFile(requestPath),
    readFile(join(repoRoot, "package.json")),
    readFile(runtimeSdkPackagePath),
  ]);
  const packageManifest = parseJson(rootPackageBytes, "root package.json") as Record<string, unknown>;
  const dependencies = packageManifest.dependencies as Record<string, unknown> | undefined;
  if (dependencies?.["@cedra-labs/ts-sdk"] !== "2.2.8") {
    fail("candidate assembler requires the exact @cedra-labs/ts-sdk 2.2.8 dependency");
  }
  assertRuntimeSdkPackage(
    parseJson(runtimeSdkPackageBytes, `loaded Cedra SDK package at ${runtimeSdkPackagePath}`),
    `loaded Cedra SDK package at ${runtimeSdkPackagePath}`,
  );
  const repositoryState = {
    statusPorcelain: runCaptured(
      repoRoot,
      "/usr/bin/git",
      ["-C", repoRoot, "status", "--porcelain=v1", "--untracked-files=all"],
      "clean release checkout verification",
    ),
    headCommit: runCaptured(repoRoot, "/usr/bin/git", ["-C", repoRoot, "rev-parse", "HEAD"], "release HEAD verification").trim(),
    headTree: runCaptured(repoRoot, "/usr/bin/git", ["-C", repoRoot, "rev-parse", "HEAD^{tree}"], "release tree verification").trim(),
  };
  const buildIntegrity = computeBuildIntegrity({
    repoRoot,
    sdkPackageJsonPath: runtimeSdkPackagePath,
    sdkEntrypointPath: runtimeSdkEntrypointPath,
    sdkReviewAttestationPath,
    sdkReviewSignaturePath,
    sdkReviewTrustPath,
  });
  const now = new Date();
  const context = validateAssemblyInputs({
    exactArtifactsPath: exactPath,
    exactArtifactsSha256: digest(exactBytes),
    exactArtifacts: parseJson(exactBytes, "exact-address artifact bundle"),
    publicProfileEvidenceSha256: digest(profileBytes),
    publicProfileEvidence: parseJson(profileBytes, "public-profile evidence"),
    buildRequest: parseJson(requestBytes, "transaction build request"),
    repositoryState,
    buildIntegrity,
    now,
  });
  const releaseClient = CedraReleaseClient.forTestnet();
  const bundle = await assembleReleaseCandidate({ context, releaseClient, capturedAt: new Date() });
  const bytes = candidateBundleBytes(bundle);
  const finalizedDirectory = await finalizeCandidateDirectoryAtomically({
    outputDirectory,
    candidateBytes: bytes.candidate,
    simulationBytes: bytes.simulationResponse,
    pythonRuntime: "/usr/bin/python3",
    renameNoReplaceHelper: join(repoRoot, "scripts/rename_noreplace.py"),
    validate: (candidatePath) => {
      runChecked(
        repoRoot,
        "/usr/bin/bash",
        [join(repoRoot, "scripts/validate_transaction_candidate.sh"), candidatePath, exactPath, profilePath],
        "exact BCS and semantic candidate validation",
        {
          RELEASE_NODE_RUNTIME: process.execPath,
          SDK_REVIEW_ATTESTATION: sdkReviewAttestationPath,
          SDK_REVIEW_SIGNATURE: sdkReviewSignaturePath,
          SDK_REVIEW_TRUSTED_SIGNERS: sdkReviewTrustPath,
        },
      );
    },
  });
  process.stdout.write(`validated keyless Testnet transaction candidate: ${finalizedDirectory}/transaction-candidate.json\n`);
  process.stdout.write("no private key was read; no transaction was signed or submitted\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`candidate assembly failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 65;
});
