/**
 * Optional per-repository configuration.
 *
 * Precedence is project `.pi/extensions/address-review-comments.json` over global
 * `~/.pi/agent/extensions/address-review-comments.json`, merged key by key.
 *
 * ```json
 * {
 *   "generatedFilePatterns": ["(?:^|/)web/src/gen/"],
 *   "botLogins": ["house-review-bot"]
 * }
 * ```
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_BASENAME } from "./constants.js";

/** Codegen output that reviewers never edit by hand, dropped from the authored diff. */
export const DEFAULT_GENERATED_FILE_PATTERNS = [
  /(?:^|\/)[^/]*\.connect\.go$/,
  /(?:^|\/)[^/]*\.grpc\.pb\.(?:cc|h)$/,
  /(?:^|\/)[^/]*\.pb\.(?:cc|go|h)$/,
  /(?:^|\/)[^/]*\.sql\.go$/,
  /(?:^|\/)[^/]*_(?:connect|pb)\.(?:d\.ts|js|ts)$/,
  /(?:^|\/)[^/]*_gen\.(?:json|md)$/,
  /(?:^|\/)[^/]*_grpc\.pb\.go$/,
  /(?:^|\/)[^/]*_pb2(?:_grpc)?\.(?:py|pyi)$/,
  /(?:^|\/)gen\//,
];

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
  generatedFilePatterns: RegExp[];
  botLogins: Set<string>;
  /** Human-readable problems found while loading, surfaced once per working directory. */
  warnings: string[];
}

interface ConfigFile {
  generatedFilePatterns?: string[];
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
    return {
      generatedFilePatterns: stringList(parsed.generatedFilePatterns),
      botLogins: stringList(parsed.botLogins),
    };
  } catch (error) {
    warnings.push(`Failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function compilePatterns(sources: string[], filePath: string, key: string, warnings: string[]): RegExp[] {
  const patterns: RegExp[] = [];
  for (const source of sources) {
    try {
      patterns.push(new RegExp(source));
    } catch (error) {
      warnings.push(
        `${filePath} has an invalid ${key} entry ${JSON.stringify(source)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return patterns;
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
    generatedFilePatterns: DEFAULT_GENERATED_FILE_PATTERNS,
    botLogins: new Set(DEFAULT_BOT_LOGINS),
    warnings,
  };

  for (const { path, file } of loaded) {
    if (file.generatedFilePatterns) {
      config.generatedFilePatterns = compilePatterns(
        file.generatedFilePatterns,
        path,
        "generatedFilePatterns",
        warnings,
      );
    }
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
