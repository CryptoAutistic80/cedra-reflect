import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const compiledRoot = resolve(moduleDirectory, "../../../..");
const sourceRoot = resolve(moduleDirectory, "../../..");
const repoRoot = existsSync(join(compiledRoot, "scripts/rename_noreplace.py")) ? compiledRoot : sourceRoot;
const renameNoReplaceHelper = join(repoRoot, "scripts/rename_noreplace.py");

function pythonBinary(): string {
  for (const candidate of ["/usr/bin/python3", "/usr/local/bin/python3"]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Linux Python 3 is required for kernel-enforced RENAME_NOREPLACE publication");
}

function renameDirectoryNoReplace(
  source: string,
  destination: string,
  pythonRuntime: string,
  helperPath: string,
): void {
  const result = spawnSync(pythonRuntime, [helperPath, source, destination], {
    encoding: "utf8",
    env: {
      LC_ALL: "C",
      LANG: "C",
      PATH: "/usr/local/bin:/usr/bin:/bin",
    },
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("\n")
      .trim();
    throw new Error(`kernel-enforced no-replace candidate publication failed${detail.length > 0 ? `: ${detail}` : ""}`);
  }
}

async function writePrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

async function fsyncDirectory(path: string, _phase: "staging" | "pre-publish" | "post-publish" | "cleanup"): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Finalize one candidate without exposing a partially validated directory.
 *
 * The sibling O_EXCL lock serializes cooperating assemblers for the same
 * output name. Both files are written and fsynced at mode 0600 in a mode-0700
 * staging directory. The caller's BCS/semantic validator runs against that
 * staging pair, then Linux renameat2(RENAME_NOREPLACE) publishes the pair with
 * a kernel-enforced same-parent no-overwrite guarantee. There is deliberately
 * no racy portability fallback.
 */
export async function finalizeCandidateDirectoryAtomically(args: {
  readonly outputDirectory: string;
  readonly candidateBytes: Uint8Array;
  readonly simulationBytes: Uint8Array;
  readonly validate: (candidatePath: string, simulationPath: string) => void | Promise<void>;
  readonly syncDirectory?: (path: string, phase: "staging" | "pre-publish" | "post-publish" | "cleanup") => Promise<void>;
  readonly pythonRuntime?: string;
  readonly renameNoReplaceHelper?: string;
}): Promise<string> {
  const outputDirectory = resolve(args.outputDirectory);
  const parent = dirname(outputDirectory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const resolvedParent = await realpath(parent);
  if (resolvedParent !== parent) {
    throw new Error("output parent must not resolve through a symlink");
  }
  const parentStat = await stat(parent);
  const effectiveUid = process.geteuid?.();
  if (!parentStat.isDirectory()
    || effectiveUid === undefined
    || parentStat.uid !== effectiveUid
    || (parentStat.mode & 0o022) !== 0) {
    throw new Error("output parent must be owned by the current euid and not group/world-writable");
  }
  const lockPath = `${outputDirectory}.assemble.lock`;
  const lockHandle = await open(lockPath, "wx", 0o600).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("another assembler owns the exclusive output lock");
    }
    throw error;
  });
  let stagingDirectory: string | null = null;
  let published = false;
  const syncDirectory = args.syncDirectory ?? fsyncDirectory;
  try {
    await lockHandle.writeFile(`${process.pid}\n`);
    await lockHandle.sync();
    stagingDirectory = await mkdtemp(join(parent, ".cedra-reflect-candidate-"));
    await chmod(stagingDirectory, 0o700);
    const simulationPath = join(stagingDirectory, "simulation-response.json");
    const candidatePath = join(stagingDirectory, "transaction-candidate.json");
    await writePrivateFile(simulationPath, args.simulationBytes);
    await writePrivateFile(candidatePath, args.candidateBytes);
    await syncDirectory(stagingDirectory, "staging");
    await args.validate(candidatePath, simulationPath);
    await syncDirectory(parent, "pre-publish");
    renameDirectoryNoReplace(
      stagingDirectory,
      outputDirectory,
      args.pythonRuntime ?? pythonBinary(),
      args.renameNoReplaceHelper ?? renameNoReplaceHelper,
    );
    published = true;
    try {
      await syncDirectory(parent, "post-publish");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`candidate was published at ${outputDirectory}, but directory durability is unknown: ${detail}`);
    }
    return outputDirectory;
  } finally {
    const finish = async (operation: () => Promise<void>): Promise<void> => {
      if (published) {
        await operation().catch(() => undefined);
      } else {
        await operation();
      }
    };
    await finish(async () => lockHandle.close());
    if (!published && stagingDirectory !== null && stagingDirectory.startsWith(`${parent}/.cedra-reflect-candidate-`)) {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
    await finish(async () => unlink(lockPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }));
    await finish(async () => syncDirectory(parent, "cleanup"));
  }
}
