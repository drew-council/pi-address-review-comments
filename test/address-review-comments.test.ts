import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseAddressReviewArgs } from "../src/args.js";
import {
  createReviewArtifactDirectory,
  diffPaths,
  filterGeneratedDiff,
  writeFetchArtifacts,
  writeReplyRequest,
} from "../src/artifacts.js";
import { createReplyRequest } from "../src/attribution.js";
import { REVIEW_COMMAND_NAME, REVIEW_COMMAND_USAGE } from "../src/constants.js";
import { queueCheckpointFeedback } from "../src/feedback-message.js";
import { filterAuthorComments } from "../src/filters.js";
import { generatedPaths } from "../src/git.js";
import { fetchGitHubReviewData, GitHubClient, GitHubUsernameCache, ReviewThreadResolveError } from "../src/github.js";
import { summarizeStack } from "../src/prompt.js";
import type { CommandExecutor, ExecResult, ReviewComment, ReviewThread } from "../src/types.js";

function success(stdout: string): ExecResult {
  return { code: 0, stdout, stderr: "" };
}

test("queues checkpoint feedback as a normal steer-delivered user message", () => {
  const messages: Array<{ content: string; options: { deliverAs: "steer" } }> = [];
  const sender = {
    sendUserMessage: (content: string, options: { deliverAs: "steer" }) => messages.push({ content, options }),
  };

  expect(queueCheckpointFeedback(sender, "  Please keep the existing API.\n")).toBe("Please keep the existing API.");
  expect(messages).toEqual([{ content: "Please keep the existing API.", options: { deliverAs: "steer" } }]);
  expect(queueCheckpointFeedback(sender, "  \n")).toBeUndefined();
  expect(messages).toHaveLength(1);
});

test("appends the supervised-agent attribution to both reply actions", () => {
  const expectedComment = `Fixed.\n\n> \`pi\` agent using \`${REVIEW_COMMAND_NAME}\`, supervised by @supervisor-login`;

  expect(createReplyRequest("thread-1", "Fixed.", false, "supervisor-login")).toEqual({
    thread_id: "thread-1",
    comment: expectedComment,
    resolve: false,
  });
  expect(createReplyRequest("thread-1", "Fixed.", true, "supervisor-login")).toEqual({
    thread_id: "thread-1",
    comment: expectedComment,
    resolve: true,
  });
});

test("fetches the authenticated GitHub username only once per session cache", async () => {
  let calls = 0;
  const exec: CommandExecutor = async (_command, args) => {
    expect(args).toEqual(["api", "user", "--jq", ".login"]);
    calls += 1;
    return success("supervisor-login\n");
  };
  const client = new GitHubClient(exec, "/repo");
  const cache = new GitHubUsernameCache();

  expect(await Promise.all([cache.get(client), cache.get(client)])).toEqual(["supervisor-login", "supervisor-login"]);
  expect(await cache.get(client)).toBe("supervisor-login");
  expect(calls).toBe(1);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const emptyThreadsResponse = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      },
    },
  },
});

const noStackResponse = JSON.stringify({ data: { repository: { pullRequest: { stack: null } } } });

function isStackQuery(args: string[]): boolean {
  return args.some((arg) => arg.startsWith("query=") && arg.includes("StackOverview"));
}

test("starts diff, review-thread, and stack requests concurrently", async () => {
  const diff = deferred<ExecResult>();
  const threads = deferred<ExecResult>();
  const stack = deferred<ExecResult>();
  const started: string[] = [];
  const exec: CommandExecutor = async (_command, args) => {
    if (args[0] === "api" && args[1] === "graphql") {
      if (isStackQuery(args)) {
        started.push("stack");
        return stack.promise;
      }
      started.push("threads");
      return threads.promise;
    }
    throw new Error(`Unexpected gh call: ${args.join(" ")}`);
  };

  const request = fetchGitHubReviewData(new GitHubClient(exec, "/repo"), "owner/repo", 42, async () => {
    started.push("diff");
    return (await diff.promise).stdout;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(started.sort()).toEqual(["diff", "stack", "threads"]);

  diff.resolve(success("diff --git a/file.ts b/file.ts\n"));
  threads.resolve(success(emptyThreadsResponse));
  stack.resolve(success(noStackResponse));
  expect(await request).toEqual({
    diff: "diff --git a/file.ts b/file.ts\n",
    threads: [],
    reviews: [],
    stack: null,
  });
});

test("a failed stack lookup does not fail the fetch", async () => {
  const exec: CommandExecutor = async (_command, args) => {
    if (isStackQuery(args)) return { code: 1, stdout: "", stderr: "stacks unavailable" };
    return success(emptyThreadsResponse);
  };
  const result = await fetchGitHubReviewData(new GitHubClient(exec, "/repo"), "owner/repo", 42, async () => "");
  expect(result.stack).toBeNull();
  expect(result.stackError ?? "").toMatch(/stacks unavailable/);
});

test("maps a stack overview and marks the current PR", async () => {
  const exec: CommandExecutor = async (_command, args) => {
    expect(isStackQuery(args)).toBe(true);
    expect(args).toContain("number=42");
    return success(
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              stack: {
                number: 7,
                size: 3,
                baseRefName: "main",
                entries: {
                  nodes: [
                    {
                      position: 3,
                      pullRequest: {
                        number: 43,
                        title: "Add frontend",
                        state: "OPEN",
                        isDraft: true,
                        headRefName: "frontend",
                        baseRefName: "api",
                        url: "https://github.test/pull/43",
                        mergeQueueEntry: null,
                      },
                    },
                    {
                      position: 1,
                      pullRequest: {
                        number: 41,
                        title: "Add auth",
                        state: "MERGED",
                        isDraft: false,
                        headRefName: "auth",
                        baseRefName: "main",
                        url: "https://github.test/pull/41",
                        mergeQueueEntry: null,
                      },
                    },
                    {
                      position: 2,
                      pullRequest: {
                        number: 42,
                        title: "Add API routes",
                        state: "OPEN",
                        isDraft: false,
                        headRefName: "api",
                        baseRefName: "auth",
                        url: "https://github.test/pull/42",
                        mergeQueueEntry: { id: "MQE_1" },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      }),
    );
  };

  const stack = await new GitHubClient(exec, "/repo").fetchPullRequestStack("owner/repo", 42);
  expect(stack).toEqual({
    number: 7,
    trunk: "main",
    size: 3,
    entries: [
      {
        position: 1,
        number: 41,
        title: "Add auth",
        status: "merged",
        head_branch: "auth",
        base_branch: "main",
        url: "https://github.test/pull/41",
        is_current: false,
      },
      {
        position: 2,
        number: 42,
        title: "Add API routes",
        status: "queued",
        head_branch: "api",
        base_branch: "auth",
        url: "https://github.test/pull/42",
        is_current: true,
      },
      {
        position: 3,
        number: 43,
        title: "Add frontend",
        status: "draft",
        head_branch: "frontend",
        base_branch: "api",
        url: "https://github.test/pull/43",
        is_current: false,
      },
    ],
  });

  const summary = summarizeStack(stack);
  expect(summary).toBeTruthy();
  expect(summary ?? "").toMatch(/^Stack #7 on trunk `main`\. This PR is position 2 of 3/);
  expect(summary ?? "").toMatch(/\n {2}1\. #41 \[merged\] auth <- main {2}Add auth\n/);
  expect(summary ?? "").toMatch(/\n→ 2\. #42 \[queued\] api <- auth {2}Add API routes {2}\(this PR\)\n/);
  expect(summary ?? "").toMatch(/\n {2}3\. #43 \[draft\] frontend <- api {2}Add frontend$/);
  expect(summarizeStack(null)).toBeUndefined();
});

test("maps review-thread pagination and fetches extra comment pages", async () => {
  const calls: string[][] = [];
  const exec: CommandExecutor = async (_command, args) => {
    calls.push(args);
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("query($owner:")) {
      return success(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviews: {
                  nodes: [
                    { body: "", author: { __typename: "User", login: "approver" } },
                    {
                      body: "Overall looks good, but please add tests.",
                      author: { __typename: "User", login: "reviewer" },
                    },
                  ],
                },
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread-1",
                      isResolved: false,
                      isOutdated: true,
                      path: "src/file.ts",
                      line: 12,
                      startLine: 10,
                      comments: {
                        nodes: [
                          {
                            body: "First",
                            diffHunk: "@@ -1 +1 @@",
                            author: { __typename: "User", login: "reviewer" },
                          },
                          {
                            body: "Fixed.\n\n> `pi` agent using `address-review-comments`, supervised by @supervisor",
                            diffHunk: "",
                            author: { __typename: "User", login: "author" },
                          },
                        ],
                        pageInfo: { hasNextPage: true, endCursor: "comments-next" },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
      );
    }
    if (query.includes("query($id:")) {
      return success(
        JSON.stringify({
          data: {
            node: {
              __typename: "PullRequestReviewThread",
              comments: {
                nodes: [
                  {
                    body: "Bot follow-up",
                    diffHunk: "",
                    author: { __typename: "Bot", login: "custom-review-bot" },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
      );
    }
    throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
  };

  const result = await new GitHubClient(exec, "/repo").fetchReviewThreads("owner/repo", 42);
  expect(result.reviews).toEqual([
    { body: "Overall looks good, but please add tests.", author: "reviewer", author_is_bot: false },
  ]);
  expect(result.threads).toEqual([
    {
      id: "thread-1",
      is_resolved: false,
      is_outdated: true,
      path: "src/file.ts",
      diff_hunk: "@@ -1 +1 @@",
      current_start_line: 10,
      current_end_line: 12,
      comments: [
        { body: "First", author: "reviewer", author_is_bot: false },
        { body: "Fixed.", author: "author", author_is_bot: false },
        { body: "Bot follow-up", author: "custom-review-bot", author_is_bot: true },
      ],
    },
  ]);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain("-F");
  expect(calls[0]).toContain("number=42");
  expect(calls[1]).toContain("after=comments-next");
});

test("maps emoji reactions on review comments and top-level reviews with author attribution", async () => {
  const exec: CommandExecutor = async (_command, args) => {
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("query($owner:")) {
      return success(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviews: {
                  nodes: [
                    {
                      body: "Overall looks good.",
                      author: { __typename: "User", login: "reviewer" },
                      reactions: {
                        nodes: [
                          { content: "HEART", user: { login: "pr-author" } },
                          { content: "EYES", user: { login: "reviewer-two" } },
                        ],
                      },
                    },
                  ],
                },
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread-1",
                      isResolved: false,
                      isOutdated: false,
                      path: "src/file.ts",
                      line: 5,
                      comments: {
                        nodes: [
                          {
                            body: "Please handle the empty case.",
                            diffHunk: "@@ -1 +1 @@",
                            author: { __typename: "User", login: "reviewer" },
                            reactions: {
                              nodes: [
                                { content: "THUMBS_UP", user: { login: "pr-author" } },
                                { content: "ROCKET", user: { login: "reviewer-two" } },
                                { content: "UNKNOWN_FUTURE", user: { login: "pr-author" } },
                              ],
                            },
                          },
                          {
                            body: "Agreed, fixing now.",
                            diffHunk: "",
                            author: { __typename: "User", login: "pr-author" },
                            reactions: { nodes: [{ content: "THUMBS_UP", user: null }] },
                          },
                        ],
                        pageInfo: { hasNextPage: true, endCursor: "comments-next" },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
      );
    }
    if (query.includes("query($id:")) {
      return success(
        JSON.stringify({
          data: {
            node: {
              __typename: "PullRequestReviewThread",
              comments: {
                nodes: [
                  {
                    body: "Follow-up without reactions",
                    diffHunk: "",
                    author: { __typename: "User", login: "reviewer" },
                    reactions: { nodes: [] },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }),
      );
    }
    throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
  };

  const result = await new GitHubClient(exec, "/repo").fetchReviewThreads("owner/repo", 42);
  expect(result.reviews[0]?.reactions).toEqual([
    { content: "HEART", author: "pr-author" },
    { content: "EYES", author: "reviewer-two" },
  ]);
  const comments = result.threads[0]?.comments ?? [];
  expect(comments[0]?.reactions).toEqual([
    { content: "THUMBS_UP", author: "pr-author" },
    { content: "ROCKET", author: "reviewer-two" },
    { content: "UNKNOWN_FUTURE", author: "pr-author" },
  ]);
  expect(comments[1]?.reactions).toEqual([{ content: "THUMBS_UP", author: null }]);
  expect(comments[2]?.reactions).toBeUndefined();
});

test("bounds nested reaction connections and fetches remaining reactions by comment id", async () => {
  const calls: string[] = [];
  const exec: CommandExecutor = async (_command, args) => {
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    calls.push(query);
    if (query.includes("query($owner:")) {
      expect(query).toContain("reviewThreads(first: 100");
      expect(query.match(/reactions\(first: 20\)/g)).toHaveLength(2);
      return success(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviews: {
                  nodes: [
                    {
                      id: "review-1",
                      body: "Summary",
                      author: { login: "reviewer" },
                      reactions: {
                        nodes: [{ content: "HEART", user: { login: "author" } }],
                        pageInfo: { hasNextPage: true, endCursor: "review-next" },
                      },
                    },
                  ],
                },
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread-1",
                      isResolved: false,
                      path: "src/file.ts",
                      comments: {
                        nodes: [
                          {
                            id: "comment-1",
                            body: "Please fix",
                            author: { login: "reviewer" },
                            reactions: {
                              nodes: [{ content: "EYES", user: { login: "author" } }],
                              pageInfo: { hasNextPage: true, endCursor: "inline-next" },
                            },
                          },
                        ],
                        pageInfo: { hasNextPage: true, endCursor: "comments-next" },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        }),
      );
    }
    if (query.includes("query($id: ID!, $after: String)")) {
      expect(query).toContain("reactions(first: 20)");
      return success(
        JSON.stringify({
          data: {
            node: {
              __typename: "PullRequestReviewThread",
              comments: {
                nodes: [
                  {
                    id: "comment-2",
                    body: "Follow-up",
                    author: { login: "reviewer" },
                    reactions: {
                      nodes: [{ content: "ROCKET", user: { login: "author" } }],
                      pageInfo: { hasNextPage: true, endCursor: "followup-next" },
                    },
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        }),
      );
    }
    if (query.includes("query($id: ID!, $after: String!)")) {
      expect(query).toContain("... on Reactable");
      expect(query).toContain("reactions(first: 100, after: $after)");
      const id = args.find((arg) => arg.startsWith("id="))?.slice(3);
      const cursor = args.find((arg) => arg.startsWith("after="))?.slice(6);
      const pages: Record<string, { typename: string; content: string; login: string; next?: string }> = {
        "review-1:review-next": {
          typename: "PullRequestReview",
          content: "THUMBS_UP",
          login: "reviewer",
          next: "review-last",
        },
        "review-1:review-last": { typename: "PullRequestReview", content: "EYES", login: "author" },
        "comment-1:inline-next": { typename: "PullRequestReviewComment", content: "THUMBS_UP", login: "reviewer" },
        "comment-2:followup-next": { typename: "PullRequestReviewComment", content: "HOORAY", login: "reviewer" },
      };
      const page = pages[`${id}:${cursor}`];
      if (!page) throw new Error(`Unexpected reaction page: ${id}:${cursor}`);
      return success(
        JSON.stringify({
          data: {
            node: {
              __typename: page.typename,
              reactions: {
                nodes: [{ content: page.content, user: { login: page.login } }],
                pageInfo: { hasNextPage: Boolean(page.next), endCursor: page.next ?? null },
              },
            },
          },
        }),
      );
    }
    throw new Error(`Unexpected query: ${query.slice(0, 80)}`);
  };

  const result = await new GitHubClient(exec, "/repo").fetchReviewThreads("owner/repo", 42);
  expect(result.reviews[0]?.reactions).toEqual([
    { content: "HEART", author: "author" },
    { content: "THUMBS_UP", author: "reviewer" },
    { content: "EYES", author: "author" },
  ]);
  expect(result.threads[0]?.comments.map((comment) => comment.reactions)).toEqual([
    [
      { content: "EYES", author: "author" },
      { content: "THUMBS_UP", author: "reviewer" },
    ],
    [
      { content: "ROCKET", author: "author" },
      { content: "HOORAY", author: "reviewer" },
    ],
  ]);
  expect(calls).toHaveLength(6);
});

test("treats configured review-bot logins as bots", async () => {
  const exec: CommandExecutor = async () =>
    success(
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviews: {
                nodes: [{ body: "Automated review", author: { __typename: "User", login: "house-review-bot" } }],
              },
              reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        },
      }),
    );

  const withoutConfig = await new GitHubClient(exec, "/repo").fetchReviewThreads("owner/repo", 42);
  expect(withoutConfig.reviews[0]?.author_is_bot).toBe(false);

  const withConfig = await new GitHubClient(exec, "/repo", new Set(["house-review-bot"])).fetchReviewThreads(
    "owner/repo",
    42,
  );
  expect(withConfig.reviews[0]?.author_is_bot).toBe(true);
});

test("posts a reply before resolving and returns the structured mutation payload", async () => {
  const operations: string[] = [];
  const exec: CommandExecutor = async (_command, args) => {
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("addPullRequestReviewThreadReply")) {
      operations.push("reply");
      return success(
        JSON.stringify({
          data: {
            addPullRequestReviewThreadReply: {
              comment: {
                id: "comment-1",
                databaseId: 123,
                url: "https://github.test/comment/123",
                body: "Fixed.",
                createdAt: "2026-01-01T00:00:00Z",
                author: { login: "author" },
              },
            },
          },
        }),
      );
    }
    if (query.includes("resolveReviewThread")) {
      operations.push("resolve");
      return success(
        JSON.stringify({
          data: { resolveReviewThread: { thread: { id: "thread-1", isResolved: true } } },
        }),
      );
    }
    throw new Error(`Unexpected mutation: ${query.slice(0, 80)}`);
  };

  const response = await new GitHubClient(exec, "/repo").submitReply("thread-1", "Fixed.", true);
  expect(operations).toEqual(["reply", "resolve"]);
  expect(response.reply.url).toBe("https://github.test/comment/123");
  expect(response.resolved_thread).toEqual({ id: "thread-1", is_resolved: true });
});

test("preserves the posted reply when the follow-up resolve mutation fails", async () => {
  const exec: CommandExecutor = async (_command, args) => {
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("addPullRequestReviewThreadReply")) {
      return success(
        JSON.stringify({
          data: {
            addPullRequestReviewThreadReply: {
              comment: {
                id: "comment-1",
                databaseId: 123,
                url: "https://github.test/comment/123",
                body: "Fixed.",
                createdAt: "2026-01-01T00:00:00Z",
                author: { login: "author" },
              },
            },
          },
        }),
      );
    }
    return { code: 1, stdout: "", stderr: "resolution denied" };
  };

  const error = await new GitHubClient(exec, "/repo").submitReply("thread-1", "Fixed.", true).then(
    () => undefined,
    (reason: unknown) => reason,
  );

  expect(error).toBeInstanceOf(ReviewThreadResolveError);
  const resolveError = error as ReviewThreadResolveError;
  expect(resolveError.reply.url).toBe("https://github.test/comment/123");
  expect(resolveError.message).toMatch(/resolution denied/);
});

test("keeps workflow requests and fetch artifacts in one temporary directory", async () => {
  const paths = await createReviewArtifactDirectory({
    arguments: "42",
    cwd: "/repo",
    include_author_comments: false,
    requested_pull_number: 42,
    started_at: "2026-01-01T00:00:00Z",
  });
  try {
    const response = await writeFetchArtifacts(
      paths,
      { repository: "owner/repo", selector: 42, pull_request_number: 42 },
      "diff --git a/file.ts b/file.ts\n",
      {
        repository: "owner/repo",
        github_username: "supervisor-login",
        pull_request: {
          number: 42,
          title: "Review me",
          body: "Body",
          author: "author",
          base_branch: "main",
          head_branch: "feature",
          head_sha: "abc123",
        },
        review_threads: [],
        review_summaries: [],
        stack: null,
      },
    );
    const replyRequestPath = await writeReplyRequest(paths.directory, {
      thread_id: "PRRT/thread=1",
      comment: "Fixed.",
      resolve: true,
    });

    for (const artifactPath of [
      paths.commandRequestPath,
      paths.fetchRequestPath,
      paths.fetchResponsePath,
      paths.diffPath,
      replyRequestPath,
    ]) {
      expect(path.dirname(artifactPath)).toBe(paths.directory);
    }
    expect(response.authored_diff_path).toBe(paths.diffPath);
    expect(response.github_username).toBe("supervisor-login");
    expect(JSON.parse(await readFile(paths.fetchResponsePath, "utf8")).github_username).toBe("supervisor-login");
    expect(JSON.parse(await readFile(replyRequestPath, "utf8"))).toEqual({
      thread_id: "PRRT/thread=1",
      comment: "Fixed.",
      resolve: true,
    });
    expect((await readdir(paths.directory)).some((name) => /reply-.+-response\.json/.test(name))).toBe(false);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

const authoredSection = "diff --git a/src/feature.ts b/src/feature.ts\n+authored\n";
const generatedSection = "diff --git a/web/src/api/client_pb.ts b/web/src/api/client_pb.ts\n+generated\n";

test("lists the files a diff touches", () => {
  expect(diffPaths(authoredSection + generatedSection)).toEqual(["src/feature.ts", "web/src/api/client_pb.ts"]);
  expect(diffPaths("")).toEqual([]);
});

test("drops generated sections from the authored diff without dropping normal files", () => {
  const isGenerated = (filePath: string) => filePath === "web/src/api/client_pb.ts";
  expect(filterGeneratedDiff(authoredSection + generatedSection, isGenerated)).toBe(authoredSection);
  expect(filterGeneratedDiff(authoredSection + generatedSection, () => false)).toBe(authoredSection + generatedSection);
});

test("reads generated files from the repository's linguist-generated attributes", async () => {
  const calls: string[][] = [];
  const exec: CommandExecutor = async (command, args, options) => {
    expect(command).toBe("git");
    expect(options?.cwd).toBe("/repo");
    calls.push(args);
    const paths = args.slice(args.indexOf("--") + 1);
    const value = (filePath: string) => {
      if (filePath.endsWith("_pb.ts")) return "true";
      if (filePath.startsWith("api/gen/")) return "set";
      if (filePath === "src/exception.ts") return "unset";
      return "unspecified";
    };
    return success(paths.map((filePath) => `${filePath}\0linguist-generated\0${value(filePath)}\0`).join(""));
  };

  const generated = await generatedPaths(exec, "/repo", [
    "web/src/api/client_pb.ts",
    "api/gen/service.go",
    "src/exception.ts",
    "src/feature.ts",
  ]);
  expect([...generated].sort()).toEqual(["api/gen/service.go", "web/src/api/client_pb.ts"]);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.slice(0, 4)).toEqual(["check-attr", "-z", "linguist-generated", "--"]);
});

test("splits long path lists across several check-attr calls", async () => {
  const batches: number[] = [];
  const exec: CommandExecutor = async (_command, args) => {
    const paths = args.slice(args.indexOf("--") + 1);
    batches.push(paths.length);
    return success(paths.map((filePath) => `${filePath}\0linguist-generated\0unspecified\0`).join(""));
  };

  const paths = Array.from({ length: 450 }, (_value, index) => `src/file-${index}.ts`);
  expect(await generatedPaths(exec, "/repo", paths)).toEqual(new Set());
  expect(batches).toEqual([200, 200, 50]);
});

test("a failing check-attr call is reported instead of silently keeping everything", async () => {
  const exec: CommandExecutor = async () => ({ code: 128, stdout: "", stderr: "not a git repository" });
  await expect(generatedPaths(exec, "/repo", ["src/feature.ts"])).rejects.toThrow(/not a git repository/);
});

test("real git reports the paths a .gitattributes file marks as generated", async () => {
  const spawnExec: CommandExecutor = async (command, args, options) => {
    const child = Bun.spawn([command, ...args], { cwd: options?.cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code: await child.exited, stdout, stderr };
  };

  const repository = await mkdtemp(path.join(tmpdir(), "pi-review-gitattributes-"));
  try {
    expect((await spawnExec("git", ["init", "--quiet", "."], { cwd: repository })).code).toBe(0);
    await writeFile(
      path.join(repository, ".gitattributes"),
      "*.pb.go linguist-generated=true\napi/gen/** linguist-generated\nsrc/exception.go -linguist-generated\n",
      "utf8",
    );

    const generated = await generatedPaths(spawnExec, repository, [
      "api/service.pb.go",
      "api/gen/client.ts",
      "src/exception.go",
      "src/feature.go",
    ]);
    expect([...generated].sort()).toEqual(["api/gen/client.ts", "api/service.pb.go"]);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("validates review command arguments", () => {
  expect(parseAddressReviewArgs("")).toEqual({ ok: true, prNumber: undefined, includeAuthorComments: false });
  expect(parseAddressReviewArgs("4098")).toEqual({ ok: true, prNumber: 4098, includeAuthorComments: false });
  expect(parseAddressReviewArgs("--author-comments")).toEqual({
    ok: true,
    prNumber: undefined,
    includeAuthorComments: true,
  });
  expect(parseAddressReviewArgs("--author-comments 4098")).toEqual({
    ok: true,
    prNumber: 4098,
    includeAuthorComments: true,
  });
  expect(parseAddressReviewArgs("--auto 4098")).toEqual({
    ok: false,
    message: `Unsupported option. Use ${REVIEW_COMMAND_USAGE}.`,
  });
  expect(parseAddressReviewArgs("abc")).toEqual({ ok: false, message: "PR number must be a positive integer." });
});

test("skips PR author comments unless they are part of a reviewer conversation", () => {
  const thread = (id: string, authors: string[]): ReviewThread => ({
    id,
    is_resolved: false,
    is_outdated: false,
    path: "src/feature.ts",
    diff_hunk: "",
    current_start_line: 1,
    current_end_line: 1,
    comments: authors.map((author) => ({ body: `note from ${author}`, author, author_is_bot: false })),
  });
  const threads = [
    thread("author-only", ["pull-author"]),
    thread("reviewer", ["someone-else"]),
    thread("author-then-reviewer", ["pull-author", "someone-else"]),
  ];
  const reviews: ReviewComment[] = [
    { body: "self note", author: "pull-author", author_is_bot: false },
    { body: "looks good", author: "someone-else", author_is_bot: false },
  ];

  const filtered = filterAuthorComments(threads, reviews, "pull-author");
  expect(filtered.threads.map((entry) => entry.id)).toEqual(["reviewer", "author-then-reviewer"]);
  expect(filtered.reviews.map((review) => review.author)).toEqual(["someone-else"]);
  expect(filtered.skipped).toBe(2);

  const unknownAuthor = filterAuthorComments(threads, reviews, null);
  expect(unknownAuthor.threads).toHaveLength(3);
  expect(unknownAuthor.skipped).toBe(0);
});
