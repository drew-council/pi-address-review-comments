import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeAgentPrompt, summarizeFetch } from "../src/prompt.js";
import type { WorkflowState } from "../src/types.js";
import { BASE_FILES, createMockFetchResponse, PULL_REQUEST_FILES } from "./fixture.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mockDirectory = path.join(projectRoot, ".mock");
const repositoryRoot = path.join(mockDirectory, "repo");
const artifactDirectory = path.join(mockDirectory, "artifacts");
const workflowPath = path.join(mockDirectory, "workflow.json");
const logPath = path.join(mockDirectory, "actions.jsonl");

async function writeFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const destination = path.join(root, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content, "utf8");
    }),
  );
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

async function createFixture(): Promise<{ prompt: string; workflow: WorkflowState }> {
  await rm(mockDirectory, { recursive: true, force: true });
  await mkdir(repositoryRoot, { recursive: true });
  await mkdir(artifactDirectory, { recursive: true });

  run("git", ["init", "-q", "-b", "main"], repositoryRoot);
  run("git", ["config", "user.name", "Mock Preview"], repositoryRoot);
  run("git", ["config", "user.email", "mock-preview@example.invalid"], repositoryRoot);

  await writeFiles(repositoryRoot, BASE_FILES);
  run("git", ["add", "."], repositoryRoot);
  run("git", ["commit", "-q", "-m", "Add cart module"], repositoryRoot);

  await writeFiles(repositoryRoot, PULL_REQUEST_FILES);
  run("git", ["add", "."], repositoryRoot);
  run("git", ["commit", "-q", "-m", "Add discounts and price formatting"], repositoryRoot);

  const diff = run("git", ["diff", "HEAD^", "HEAD"], repositoryRoot);
  const head = run("git", ["rev-parse", "HEAD"], repositoryRoot);
  const startCommitShort = run("git", ["rev-parse", "--short", "HEAD"], repositoryRoot);

  const commandRequestPath = path.join(artifactDirectory, "command-request.json");
  const fetchRequestPath = path.join(artifactDirectory, "fetch-request.json");
  const fetchResponsePath = path.join(artifactDirectory, "fetch-response.json");
  const diffPath = path.join(artifactDirectory, "authored.diff");
  const response = createMockFetchResponse(diffPath);
  response.pull_request.head_sha = head;
  const startedAt = new Date().toISOString();
  const workflow: WorkflowState = {
    repoRoot: repositoryRoot,
    repository: response.repository,
    githubUsername: response.github_username,
    artifactDirectory,
    commandRequestPath,
    fetchRequestPath,
    fetchResponsePath,
    diffPath,
    startCommitShort,
    prNumber: response.pull_request.number,
    startedAt,
    threadIds: response.review_threads.map((thread) => thread.id),
    active: true,
  };

  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  await Promise.all([
    writeFile(
      commandRequestPath,
      json({ arguments: "mock", cwd: repositoryRoot, include_author_comments: false, started_at: startedAt }),
      "utf8",
    ),
    writeFile(
      fetchRequestPath,
      json({
        repository: response.repository,
        selector: response.pull_request.number,
        pull_request_number: response.pull_request.number,
      }),
      "utf8",
    ),
    writeFile(fetchResponsePath, json(response), "utf8"),
    writeFile(diffPath, `${diff}\n`, "utf8"),
    writeFile(workflowPath, json(workflow), "utf8"),
    writeFile(logPath, "", "utf8"),
  ]);

  const prompt = `# Mock preview\n\nThis is a synthetic review workflow for interactively testing the extension. Work only in the fake repository below. No GitHub request is real; checkpoint decisions are handled by a local mock backend.\n\n${makeAgentPrompt(workflow, summarizeFetch(response))}`;
  return { prompt, workflow };
}

async function launch(): Promise<number> {
  const { prompt, workflow } = await createFixture();
  const piBinary = process.env.PI_REVIEW_MOCK_PI_BIN || "pi";
  const extensionPath = path.join(projectRoot, "mock", "extension.ts");
  const piArgs = [
    "--extension",
    extensionPath,
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-session",
    ...process.argv.slice(2),
    "--",
    prompt,
  ];

  console.log("Starting pi review-checkpoint preview");
  console.log(`  fake repository: ${workflow.repoRoot}`);
  console.log(`  action log:      ${logPath}`);
  console.log("  GitHub access:   disabled\n");

  return new Promise<number>((resolve, reject) => {
    const child = spawn(piBinary, piArgs, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PI_REVIEW_MOCK_WORKFLOW_PATH: workflowPath,
        PI_REVIEW_MOCK_LOG_PATH: logPath,
        PI_SKIP_VERSION_CHECK: "1",
      },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) console.error(`pi exited after signal ${signal}`);
      resolve(code ?? 1);
    });
  });
}

try {
  process.exitCode = await launch();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
