import type { CommandExecutor } from "./types.js";

function detail(result: { code: number; stdout: string; stderr: string }): string {
  return result.stderr.trim() || result.stdout.trim() || `exited with status ${result.code}`;
}

async function runGit(exec: CommandExecutor, cwd: string, args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd, timeout: 30_000 });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${detail(result)}`);
  return result.stdout.trim();
}

export async function resolveRepositoryRoot(exec: CommandExecutor, cwd: string): Promise<string> {
  return runGit(exec, cwd, ["rev-parse", "--show-toplevel"]);
}

export async function currentBranch(exec: CommandExecutor, cwd: string): Promise<string> {
  const branch = await runGit(exec, cwd, ["branch", "--show-current"]);
  if (!branch) throw new Error("Detached HEAD; cannot infer the active pull request.");
  return branch;
}

export async function shortHead(exec: CommandExecutor, cwd: string): Promise<string> {
  return runGit(exec, cwd, ["rev-parse", "--short", "HEAD"]);
}

async function isDirty(exec: CommandExecutor, cwd: string): Promise<boolean> {
  return (await runGit(exec, cwd, ["status", "--porcelain"])) !== "";
}

export async function ensurePullCheckout(
  exec: CommandExecutor,
  cwd: string,
  repository: string,
  pullNumber: number,
  expectedHeadBranch: string,
): Promise<boolean> {
  const branch = await currentBranch(exec, cwd);
  if (branch === expectedHeadBranch) return false;
  if (await isDirty(exec, cwd)) {
    throw new Error(
      `Worktree is dirty; refusing to switch from ${branch} to pull request branch ${expectedHeadBranch}.`,
    );
  }

  const result = await exec("gh", ["pr", "checkout", String(pullNumber), "--repo", repository], {
    cwd,
    timeout: 120_000,
  });
  if (result.code !== 0) throw new Error(`gh pr checkout failed: ${detail(result)}`);
  return true;
}

async function resolveBaseCommit(exec: CommandExecutor, cwd: string, baseBranch: string): Promise<string> {
  for (const ref of [`origin/${baseBranch}`, baseBranch]) {
    const result = await exec("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd, timeout: 30_000 });
    if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  const fetched = await exec("git", ["fetch", "origin", baseBranch], { cwd, timeout: 120_000 });
  if (fetched.code !== 0) throw new Error(`git fetch origin ${baseBranch} failed: ${detail(fetched)}`);
  return runGit(exec, cwd, ["rev-parse", "FETCH_HEAD"]);
}

/** Keeps each `git check-attr` invocation well under the platform's argument limit. */
const MAX_PATHS_PER_CHECK = 200;
const MAX_PATH_BYTES_PER_CHECK = 60_000;

function chunkPaths(paths: readonly string[]): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let bytes = 0;
  for (const filePath of paths) {
    if (
      chunk.length > 0 &&
      (chunk.length >= MAX_PATHS_PER_CHECK || bytes + filePath.length > MAX_PATH_BYTES_PER_CHECK)
    ) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(filePath);
    bytes += filePath.length + 1;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

/** `git check-attr -z` emits NUL-separated path, attribute, value triplets. */
function parseCheckAttr(stdout: string): Array<{ filePath: string; value: string }> {
  const fields = stdout.split("\0");
  const entries: Array<{ filePath: string; value: string }> = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const filePath = fields[index];
    const value = fields[index + 2];
    if (filePath !== undefined && value !== undefined) entries.push({ filePath, value });
  }
  return entries;
}

/**
 * The subset of paths marked `linguist-generated` in the repository's `.gitattributes`, which is the
 * same attribute GitHub uses to collapse generated files in a pull request diff.
 */
export async function generatedPaths(
  exec: CommandExecutor,
  cwd: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<Set<string>> {
  const generated = new Set<string>();
  for (const chunk of chunkPaths(paths)) {
    const args = ["check-attr", "-z", "linguist-generated", "--", ...chunk];
    const result = await exec("git", args, { cwd, signal, timeout: 30_000 });
    if (result.code !== 0) throw new Error(`git check-attr failed: ${detail(result)}`);
    for (const { filePath, value } of parseCheckAttr(result.stdout)) {
      if (value === "set" || value === "true") generated.add(filePath);
    }
  }
  return generated;
}

export async function pullRequestDiff(exec: CommandExecutor, cwd: string, baseBranch: string): Promise<string> {
  const baseCommit = await resolveBaseCommit(exec, cwd, baseBranch);
  const mergeBase = await runGit(exec, cwd, ["merge-base", baseCommit, "HEAD"]);
  const args = ["diff", "--no-color", "--no-ext-diff", `${mergeBase}..HEAD`];
  const result = await exec("git", args, { cwd, timeout: 120_000 });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${detail(result)}`);
  return result.stdout;
}
