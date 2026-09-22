import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJsonlCheckpointBackend } from "../mock/extension.js";
import type { CheckpointParams, ReplyRequest, WorkflowState } from "../src/types.js";

const workflow: WorkflowState = {
  repoRoot: "/tmp/mock-repo",
  repository: "example/mock-shop",
  githubUsername: "preview-user",
  artifactDirectory: "/tmp/mock-artifacts",
  commandRequestPath: "/tmp/mock-artifacts/command-request.json",
  fetchRequestPath: "/tmp/mock-artifacts/fetch-request.json",
  fetchResponsePath: "/tmp/mock-artifacts/fetch-response.json",
  diffPath: "/tmp/mock-artifacts/authored.diff",
  startCommitShort: "abc1234",
  prNumber: 4242,
  startedAt: "2026-01-01T00:00:00.000Z",
  threadIds: ["MOCK_THREAD"],
  active: true,
};

const checkpoint: CheckpointParams = {
  threadId: "MOCK_THREAD",
  location: "src/cart.ts:5",
  reviewer: "reviewer-one",
  checkpointMarkdown: "Fixed percentage math.",
  draftReply: "Fixed in `src/cart.ts:5`.",
};

const request: ReplyRequest = {
  thread_id: checkpoint.threadId,
  comment: checkpoint.draftReply,
  resolve: true,
};

test("mock checkpoint backend returns fake responses and logs decisions as JSONL", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "review-checkpoint-mock-test-"));
  const logPath = path.join(directory, "actions.jsonl");
  await writeFile(logPath, "", "utf8");

  try {
    const backend = createJsonlCheckpointBackend(logPath);
    const postedUrls: string[] = [];
    const response = await backend.submitReply({
      workflow,
      request,
      onReplyPosted: (reply) => postedUrls.push(reply.url),
    });
    await backend.recordDecision({ checkpoint, selectedOption: "resolve", request, response });

    expect(response.thread_id).toBe("MOCK_THREAD");
    expect(response.reply.url).toBe("https://example.invalid/mock-review/replies/1");
    expect(response.resolved_thread).toEqual({ id: "MOCK_THREAD", is_resolved: true });
    expect(postedUrls).toEqual([response.reply.url]);

    const entries = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe("checkpoint_decision");
    expect(entries[0]?.selectedOption).toBe("resolve");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
