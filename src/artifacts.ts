import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FetchRequest, FetchResponse, ReplyRequest } from "./types.js";

export interface ReviewArtifactPaths {
  directory: string;
  commandRequestPath: string;
  fetchRequestPath: string;
  fetchResponsePath: string;
  diffPath: string;
}

interface CommandRequest {
  arguments: string;
  cwd: string;
  include_author_comments: boolean;
  requested_pull_number: number | null;
  started_at: string;
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Each `diff --git` section paired with the post-image path it touches. */
function diffSections(diff: string): Array<{ text: string; filePath?: string }> {
  return diff.split(/(?=^diff --git )/m).map((text) => {
    const header = text.match(/^diff --git a\/.+? b\/(.+)$/m);
    return header ? { text, filePath: header[1] } : { text };
  });
}

/** The files a diff touches, in the order they appear. */
export function diffPaths(diff: string): string[] {
  const paths = diffSections(diff)
    .map((section) => section.filePath)
    .filter((filePath): filePath is string => Boolean(filePath));
  return [...new Set(paths)];
}

export function filterGeneratedDiff(diff: string, isGenerated: (filePath: string) => boolean): string {
  return diffSections(diff)
    .filter((section) => !section.filePath || !isGenerated(section.filePath))
    .map((section) => section.text)
    .join("");
}

export async function createReviewArtifactDirectory(request: CommandRequest): Promise<ReviewArtifactPaths> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-review-comments-"));
  const paths = {
    directory,
    commandRequestPath: path.join(directory, "command-request.json"),
    fetchRequestPath: path.join(directory, "fetch-request.json"),
    fetchResponsePath: path.join(directory, "fetch-response.json"),
    diffPath: path.join(directory, "authored.diff"),
  };
  await writeFile(paths.commandRequestPath, formatJson(request), "utf8");
  return paths;
}

export async function writeFetchArtifacts(
  paths: ReviewArtifactPaths,
  request: FetchRequest,
  diff: string,
  responseWithoutPath: Omit<FetchResponse, "authored_diff_path">,
  isGenerated: (filePath: string) => boolean = () => false,
): Promise<FetchResponse> {
  const response: FetchResponse = { ...responseWithoutPath, authored_diff_path: paths.diffPath };
  await Promise.all([
    writeFile(paths.fetchRequestPath, formatJson(request), "utf8"),
    writeFile(paths.diffPath, filterGeneratedDiff(diff, isGenerated), "utf8"),
    writeFile(paths.fetchResponsePath, formatJson(response), "utf8"),
  ]);
  return response;
}

export async function writeReplyRequest(directory: string, request: ReplyRequest): Promise<string> {
  const operationNumbers = (await readdir(directory))
    .map((name) => name.match(/^reply-(\d+)-/))
    .map((match) => Number(match?.[1] ?? 0));
  const operationNumber = Math.max(0, ...operationNumbers) + 1;
  const safeThreadId = encodeURIComponent(request.thread_id);
  const requestPath = path.join(
    directory,
    `reply-${operationNumber.toString().padStart(3, "0")}-${safeThreadId}-request.json`,
  );
  await writeFile(requestPath, formatJson(request), "utf8");
  return requestPath;
}
