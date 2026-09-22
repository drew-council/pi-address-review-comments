import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeReplyRequest } from "./artifacts.js";
import { GitHubClient } from "./github.js";
import type {
  CheckpointOption,
  CheckpointParams,
  ReplyRequest,
  ReplyResponse,
  ReviewThreadReply,
  WorkflowState,
} from "./types.js";

export interface CheckpointSubmission {
  workflow: WorkflowState;
  request: ReplyRequest;
  signal?: AbortSignal;
  onReplyPosted?: (reply: ReviewThreadReply) => void;
}

export interface CheckpointDecision {
  checkpoint: CheckpointParams;
  selectedOption: CheckpointOption;
  dismissed?: boolean;
  feedback?: string;
  request?: ReplyRequest;
  response?: ReplyResponse;
  reply?: ReviewThreadReply;
  error?: string;
}

/** Side effects performed after a user decides a review checkpoint. */
export interface CheckpointBackend {
  submitReply(submission: CheckpointSubmission): Promise<ReplyResponse>;
  recordDecision(decision: CheckpointDecision): Promise<void>;
}

export function createGitHubCheckpointBackend(pi: ExtensionAPI): CheckpointBackend {
  return {
    async submitReply({ workflow, request, signal, onReplyPosted }) {
      await writeReplyRequest(workflow.artifactDirectory || path.dirname(workflow.fetchResponsePath), request);
      const client = new GitHubClient((command, args, options) => pi.exec(command, args, options), workflow.repoRoot);
      return client.submitReply(request.thread_id, request.comment, request.resolve, signal, onReplyPosted);
    },
    async recordDecision() {},
  };
}
