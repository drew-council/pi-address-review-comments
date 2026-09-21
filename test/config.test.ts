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
  expect([...config.botLogins].sort()).toEqual([...DEFAULT_BOT_LOGINS].sort());
});

test("bot logins from both files add to the built-in list", async () => {
  const globalPath = await writeConfig("global", { botLogins: ["house-review-bot"] });
  const projectPath = await writeConfig("project", { botLogins: ["project-bot"] });

  const config = loadReviewConfig(cwd, homeDir);
  expect(config.configPaths).toEqual([globalPath, projectPath]);
  expect(config.botLogins.has("house-review-bot")).toBe(true);
  expect(config.botLogins.has("project-bot")).toBe(true);
  expect(config.botLogins.has("cursor")).toBe(true);
});

test("entries of the wrong shape are ignored without failing the load", async () => {
  await writeConfig("global", { botLogins: ["house-review-bot", 7, "  "] });

  const config = loadReviewConfig(cwd, homeDir);
  expect(config.warnings).toEqual([]);
  expect(config.botLogins.has("house-review-bot")).toBe(true);
  expect(config.botLogins.size).toBe(DEFAULT_BOT_LOGINS.length + 1);
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
