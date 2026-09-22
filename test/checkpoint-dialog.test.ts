import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { checkpointAction, ReviewCheckpointDialog } from "../src/checkpoint-dialog.js";
import type { CheckpointOption, CheckpointParams } from "../src/types.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const tui = {
  requestRender() {},
  terminal: { rows: 24, columns: 80 },
} as unknown as TUI;

const checkpoint: CheckpointParams = {
  threadId: "thread-1",
  location: "src/index.ts:42",
  reviewer: "octocat",
  recommendedAction: "post",
  checkpointMarkdown: "The reviewer asked for a rename.",
  draftReply: "Renamed as requested.",
};

function makeDialog(done: (result: CheckpointOption | undefined) => void): ReviewCheckpointDialog {
  return new ReviewCheckpointDialog(tui, theme, checkpoint, done);
}

test("checkpointAction falls back to the first action for unknown options", () => {
  expect(checkpointAction("post").option).toBe("post");
  expect(checkpointAction("not-an-action" as CheckpointOption).option).toBe("resolve");
});

test("renders a compact picker with location, reviewer, and every action", () => {
  const rendered = makeDialog(() => {})
    .render(80)
    .join("\n");

  expect(rendered).toContain("Review checkpoint");
  expect(rendered).toContain("src/index.ts:42");
  expect(rendered).toContain("@octocat");
  expect(rendered).toContain("Recommended: post");
  for (const option of ["resolve", "post", "edit", "feedback", "skip", "abort"]) {
    expect(rendered).toContain(option);
  }
  expect(rendered).toContain("Enter confirm");
});

test("number keys choose the matching action immediately", () => {
  const selected: Array<CheckpointOption | undefined> = [];
  const dialog = makeDialog((result) => selected.push(result));

  dialog.handleInput("3");
  dialog.handleInput("6");

  expect(selected).toEqual(["edit", "abort"]);
});

test("digits outside the action range fall through to the list", () => {
  const selected: Array<CheckpointOption | undefined> = [];
  const dialog = makeDialog((result) => selected.push(result));

  // 9 does not map to a checkpoint action, so nothing should be selected.
  dialog.handleInput("9");

  expect(selected).toEqual([]);
});
