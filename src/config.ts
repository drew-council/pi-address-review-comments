/**
 * Optional per-repository configuration.
 *
 * Precedence is project `.pi/extensions/address-review-comments.json` over global
 * `~/.pi/agent/extensions/address-review-comments.json`, merged key by key.
 *
 * ```json
 * {
 *   "botLogins": ["house-review-bot"]
 * }
 * ```
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_BASENAME } from "./constants.js";

/**
 * Review bots that GitHub reports as regular users. Accounts with a `Bot` type or a `[bot]` login
 * suffix are detected without being listed here.
 */
export const DEFAULT_BOT_LOGINS = [
  "amazon-inspector-n-virginia",
  "amazon-inspector-oregon",
  "app/dependabot",
  "cursor",
  "dependabot[bot]",
  "greptile-apps",
];

export interface ReviewConfig {
  /** The files the configuration was merged from, closest last. */
  configPaths: string[];
  botLogins: Set<string>;
  /** Human-readable problems found while loading, surfaced once per working directory. */
  warnings: string[];
}

interface ConfigFile {
  botLogins?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

export function configPaths(cwd: string, homeDir: string = homedir()): { project: string; global: string } {
  return {
    project: join(cwd, ".pi", "extensions", CONFIG_BASENAME),
    global: join(homeDir, ".pi", "agent", "extensions", CONFIG_BASENAME),
  };
}

function readConfigFile(filePath: string, warnings: string[]): ConfigFile | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      warnings.push(`${filePath} is not a JSON object; ignoring it.`);
      return undefined;
    }
    return { botLogins: stringList(parsed.botLogins) };
  } catch (error) {
    warnings.push(`Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export function loadReviewConfig(cwd: string, homeDir: string = homedir()): ReviewConfig {
  const warnings: string[] = [];
  const paths = configPaths(cwd, homeDir);
  const loaded = [
    { path: paths.global, file: readConfigFile(paths.global, warnings) },
    { path: paths.project, file: readConfigFile(paths.project, warnings) },
  ].filter((entry): entry is { path: string; file: ConfigFile } => entry.file !== undefined);

  const config: ReviewConfig = {
    configPaths: loaded.map((entry) => entry.path),
    botLogins: new Set(DEFAULT_BOT_LOGINS),
    warnings,
  };
  for (const { file } of loaded) {
    for (const login of file.botLogins ?? []) config.botLogins.add(login);
  }
  return config;
}

/** Keeps configuration and its warnings stable for the lifetime of a session. */
export function createReviewConfigCache(homeDir?: string): (cwd: string) => ReviewConfig {
  const cache = new Map<string, ReviewConfig>();
  return (cwd) => {
    const cached = cache.get(cwd);
    if (cached) return cached;
    const config = loadReviewConfig(cwd, homeDir);
    cache.set(cwd, config);
    return config;
  };
}
