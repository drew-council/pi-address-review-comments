# @bizmyth/pi-address-review-comments

A supervised GitHub PR review-comment workflow for the [Pi coding agent](https://github.com/earendil-works/pi-mono).

## What it does

`/address-review-comments` fetches every unresolved review thread on a pull request, hands the agent a
read-only snapshot of that context, and then requires a human decision — in a TUI dialog — before any
reply is posted or any thread is resolved.

The extension, not the agent, talks to GitHub. While a workflow is active, the agent is blocked from
fetching or mutating review threads itself, so the only path to a posted comment runs through the
checkpoint dialog.

## Requirements

- [`gh`](https://cli.github.com) authenticated for the repository (`gh auth login`).
- `git`, with the pull request's head branch available locally or checkoutable by `gh pr checkout`.
- The interactive TUI. The checkpoint tool refuses to run headless, because approval is mandatory.

## Install

```sh
pi install npm:@bizmyth/pi-address-review-comments
```

Restart Pi after installation. Review extensions before installing them; Pi extensions run with your full user permissions.

## Usage

```
/address-review-comments [PR_NUMBER] [--author-comments]
/gh-review-comments [PR_NUMBER] [--author-comments]
```

Without a PR number, the pull request is inferred from the current branch. `/gh-review-comments` is an
alias for projects that already define their own `address-review-comments` command.

Threads where the PR author is the only participant are skipped by default; `--author-comments` keeps
them. Threads the author opened that a reviewer later joined are always in scope.

On start the extension:

1. Resolves the repository and pull request, checking out the head branch when the worktree is clean.
2. Fetches unresolved review threads, top-level review summaries, and stack context (when the PR is
   part of a GitHub stack) through the `gh` GraphQL API.
3. Writes `command-request.json`, `fetch-request.json`, `fetch-response.json`, and `authored.diff`
   into a temporary artifact directory, filtering generated files out of the diff.
4. Sends the agent a prompt pointing at those artifacts, with the rules for the workflow.

A status entry shows the remaining thread count, and the workflow survives `/reload` and session
resume through session entries.

## The checkpoint

For every thread, the agent must call the `github_review_checkpoint` tool, which opens a scrollable
dialog showing the reviewer, the location, the agent's analysis, and the exact draft reply:

| Action | Effect |
| --- | --- |
| `resolve` | Post the reply and resolve the thread |
| `post` | Post the reply, leave the thread open |
| `edit` | Send instructions for rewording the draft, then checkpoint again |
| `feedback` | Send feedback for the agent to address in code and draft, then checkpoint again |
| `skip` | Post nothing; the agent reverts that thread's changes |
| `abort` | Stop the workflow and summarize |

`↑↓`/`PgUp`/`PgDn` scroll, `←→` choose, `1`-`6` pick directly, `Enter` confirms, and `Esc` aborts.
Dismissing the dialog counts as `abort`.

Every posted reply gets a standardized footer identifying the agent and its human supervisor:

```
> `pi` agent using `address-review-comments`, supervised by @your-login
```

The footer is stripped again when review threads are read back, so it never clutters the agent's context.

## Configuration

Configuration is optional. Pi reads `.pi/extensions/address-review-comments.json` in the project,
falling back to `~/.pi/agent/extensions/address-review-comments.json`, and merges them key by key
with the project file winning.

```json
{
  "generatedFilePatterns": ["(?:^|/)web/src/api/gen/", "(?:^|/)[^/]*\\.sql\\.go$"],
  "botLogins": ["house-review-bot"]
}
```

| Key | Meaning |
| --- | --- |
| `generatedFilePatterns` | Regular expressions matching generated paths to drop from the authored diff. Replaces the built-in list, which already covers common protobuf, Connect, sqlc, and `gen/` output. |
| `botLogins` | Extra logins to treat as review bots, added to the built-in list. Accounts GitHub types as `Bot` or that end in `[bot]` are detected automatically. |

Invalid patterns are reported as warnings when the command runs; the rest of the configuration still loads.

While a workflow is active, direct `gh pr view`, `gh pr diff`, and review-thread GraphQL calls are
blocked no matter how the extension is configured.

## Development

```sh
bun install
bun run check
```

`bun run check` runs Biome, TypeScript 7 (`tsc`, the Go-based compiler), and Bun tests. The tests are
hermetic: GitHub access is faked through an injected command executor.

## Releasing

Trusted publishing must already be configured for `publish.yml`. To release a new version:

```sh
bun pm version patch # or: minor / major
git push origin main --follow-tags
gh release create "$(git describe --tags --exact-match)" --generate-notes
```

Publishing the GitHub release runs the checks and publishes the matching package version to npm using OIDC. No long-lived `NPM_TOKEN` is required.

## License

MIT
