import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createReviewConfigCache, DEFAULT_BOT_LOGINS, loadReviewConfig } from "../src/config.js";
import { CONFIG_BASENAME } from "../src/constants.js";

let root: string;
let cwd: string;
let homeDir: string;

async function writeConfig(scope: "project" | "global", config: unknown): Promise<string> {
  const directory =
    scope === "project" ? path.join(cwd, ".pi", "extensions") : path.join(homeDir, ".pi", "agent", "extensions");
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, CONFIG_BASENAME);
  await writeFile(filePath, typeof config === "string" ? config : JSON.stringify(config), "utf8");
  return filePath;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pi-review-config-"));
  cwd = path.join(root, "repo");
  homeDir = path.join(root, "home");
  await mkdir(cwd, { recursive: true });
  await mkdir(homeDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("defaults apply when no configuration file exists", () => {
  const config = loadReviewConfig(cwd, homeDir);
  expect(config.configPaths).toEqual([]);
  expect(config.warnings).toEqual([]);
  expect(config.blockedSkillPaths).toEqual([]);
  expect(config.blockedCommandPatterns).toEqual([]);
  expect([...config.botLogins].sort()).toEqual([...DEFAULT_BOT_LOGINS].sort());
  expect(config.generatedFilePatterns.some((pattern) => pattern.test("web/src/api/client_pb.ts"))).toBe(true);
});

test("project configuration overrides the global file key by key", async () => {
  const globalPath = await writeConfig("global", {
    botLogins: ["house-review-bot"],
    blockedSkillPaths: [".agents/skills/address-review-comments/SKILL.md"],
    generatedFilePatterns: ["(?:^|/)global/"],
  });
  const projectPath = await writeConfig("project", {
    botLogins: ["project-bot"],
    generatedFilePatterns: ["(?:^|/)project/"],
  });

  const config = loadReviewConfig(cwd, homeDir);
  expect(config.configPaths).toEqual([globalPath, projectPath]);
  expect(config.botLogins.has("house-review-bot")).toBe(true);
  expect(config.botLogins.has("project-bot")).toBe(true);
  expect(config.botLogins.has("cursor")).toBe(true);
  expect(config.blockedSkillPaths).toEqual([".agents/skills/address-review-comments/SKILL.md"]);
  expect(config.generatedFilePatterns).toHaveLength(1);
  expect(config.generatedFilePatterns[0]?.test("project/client.ts")).toBe(true);
  expect(config.generatedFilePatterns[0]?.test("global/client.ts")).toBe(false);
});

test("configured command patterns compile and match legacy review commands", async () => {
  await writeConfig("global", {
    blockedCommandPatterns: [
      "(?:^|[\\s;&|])review\\s+comments\\s+(?:fetch|reply)\\b",
      "(?:^|[\\s;&|])go\\s+run\\b[\\s\\S]*cmd/review[\\s\\S]*comments\\s+(?:fetch|reply)\\b",
    ],
  });

  const config = loadReviewConfig(cwd, homeDir);
  const blocks = (command: string) => config.blockedCommandPatterns.some((pattern) => pattern.test(command));
  expect(blocks("review comments fetch 42")).toBe(true);
  expect(blocks("go run ./cmd/review comments reply --thread 1")).toBe(true);
  expect(blocks("git status")).toBe(false);
});

test("invalid entries are reported as warnings instead of failing the load", async () => {
  const filePath = await writeConfig("global", { generatedFilePatterns: ["(unclosed", "(?:^|/)gen/"] });

  const config = loadReviewConfig(cwd, homeDir);
  expect(config.generatedFilePatterns).toHaveLength(1);
  expect(config.generatedFilePatterns[0]?.test("api/gen/client.ts")).toBe(true);
  expect(config.warnings).toHaveLength(1);
  expect(config.warnings[0] ?? "").toContain(filePath);
  expect(config.warnings[0] ?? "").toContain("generatedFilePatterns");
});

test("malformed JSON falls back to defaults with a warning", async () => {
  await writeConfig("global", "{ not json");

  const config = loadReviewConfig(cwd, homeDir);
  expect(config.configPaths).toEqual([]);
  expect(config.warnings).toHaveLength(1);
  expect([...config.botLogins].sort()).toEqual([...DEFAULT_BOT_LOGINS].sort());
});

test("the cache reads each working directory once", async () => {
  await writeConfig("global", { botLogins: ["house-review-bot"] });
  const cache = createReviewConfigCache(homeDir);
  const first = cache(cwd);

  await writeConfig("global", { botLogins: ["changed-bot"] });
  expect(cache(cwd)).toBe(first);
  expect(first.botLogins.has("changed-bot")).toBe(false);
});
