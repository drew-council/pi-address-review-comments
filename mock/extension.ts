import { appendFile, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CheckpointBackend, CheckpointDecision, CheckpointSubmission } from "../src/checkpoint-backend.js";
import { registerCheckpointTool } from "../src/checkpoint-tool.js";
import { CHECKPOINT_TOOL_NAME } from "../src/constants.js";
import type { ReplyResponse, WorkflowState } from "../src/types.js";

const STATUS_ID = "github-review-comments-mock";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required. Start this preview with \`bun run mock\`.`);
  return value;
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

export function createJsonlCheckpointBackend(logPath: string): CheckpointBackend {
  let replyNumber = 0;

  return {
    async submitReply({ workflow, request, signal, onReplyPosted }: CheckpointSubmission): Promise<ReplyResponse> {
      signal?.throwIfAborted();
      await delay(150, undefined, { signal });
      replyNumber += 1;
      const reply = {
        id: `MOCK_REPLY_${replyNumber}`,
        database_id: 10_000 + replyNumber,
        url: `https://example.invalid/mock-review/replies/${replyNumber}`,
        body: request.comment,
        created_at: new Date().toISOString(),
        author: workflow.githubUsername,
      };
      onReplyPosted?.(reply);
      if (request.resolve) await delay(150, undefined, { signal });
      return {
        thread_id: request.thread_id,
        reply,
        resolved_thread: request.resolve ? { id: request.thread_id, is_resolved: true } : null,
      };
    },
    async recordDecision(decision: CheckpointDecision): Promise<void> {
      await appendJsonLine(logPath, {
        type: "checkpoint_decision",
        timestamp: new Date().toISOString(),
        ...decision,
      });
    },
  };
}

export default async function mockAddressReviewCommentsExtension(pi: ExtensionAPI): Promise<void> {
  const workflowPath = requiredEnvironment("PI_REVIEW_MOCK_WORKFLOW_PATH");
  const logPath = requiredEnvironment("PI_REVIEW_MOCK_LOG_PATH");
  let activeWorkflow: WorkflowState | undefined = JSON.parse(await readFile(workflowPath, "utf8")) as WorkflowState;
  const terminalThreadIds = new Set<string>();

  const updateStatus = (ctx: ExtensionContext): void => {
    if (!activeWorkflow) {
      ctx.ui.setStatus(STATUS_ID, undefined);
      return;
    }
    const remaining = activeWorkflow.threadIds.filter((id) => !terminalThreadIds.has(id)).length;
    ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("warning", `mock review: ${remaining} left`));
  };

  const finish = (ctx: ExtensionContext): void => {
    activeWorkflow = undefined;
    updateStatus(ctx);
  };

  registerCheckpointTool(
    pi,
    {
      getWorkflow: () => activeWorkflow,
      isTerminal: (threadId) => terminalThreadIds.has(threadId),
      finish,
      markTerminal(threadId, ctx) {
        terminalThreadIds.add(threadId);
        const complete = Boolean(activeWorkflow?.threadIds.every((candidate) => terminalThreadIds.has(candidate)));
        if (complete) {
          finish(ctx);
          ctx.ui.notify(`Mock workflow complete. Decisions were written to ${logPath}`, "info");
        } else {
          updateStatus(ctx);
        }
        return complete;
      },
    },
    createJsonlCheckpointBackend(logPath),
  );

  pi.on("session_start", async (_event, ctx) => {
    const workflow = activeWorkflow;
    if (!workflow) return;
    pi.setSessionName("Mock review checkpoint preview");
    updateStatus(ctx);
    await appendJsonLine(logPath, {
      type: "run_started",
      timestamp: new Date().toISOString(),
      repository: workflow.repository,
      pullRequest: workflow.prNumber,
      repoRoot: workflow.repoRoot,
    });
    ctx.ui.notify(`Mock review active; no GitHub requests will be made. Log: ${logPath}`, "info");
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return undefined;
    const command = String((event.input as { command?: unknown }).command ?? "");
    if (!/(?:^|[;&|\s])gh(?:\s|$)/.test(command)) return undefined;
    return {
      block: true,
      reason: `GitHub CLI is disabled in the mock preview. Use the fixture data and ${CHECKPOINT_TOOL_NAME}.`,
    };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_ID, undefined);
    await appendJsonLine(logPath, { type: "run_finished", timestamp: new Date().toISOString() });
  });
}
