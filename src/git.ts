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

export async function pullRequestDiff(exec: CommandExecutor, cwd: string, baseBranch: string): Promise<string> {
  const baseCommit = await resolveBaseCommit(exec, cwd, baseBranch);
  const mergeBase = await runGit(exec, cwd, ["merge-base", baseCommit, "HEAD"]);
  const args = ["diff", "--no-color", "--no-ext-diff", `${mergeBase}..HEAD`];
  const result = await exec("git", args, { cwd, timeout: 120_000 });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${detail(result)}`);
  return result.stdout;
}
