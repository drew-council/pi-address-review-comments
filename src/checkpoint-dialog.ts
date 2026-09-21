import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  Markdown,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { CHECKPOINT_ACTIONS, type CheckpointAction, type CheckpointOption, type CheckpointParams } from "./types.js";

const OPTIONS = CHECKPOINT_ACTIONS.map((action) => action.option);
const DEFAULT_ACTION: CheckpointOption = "resolve";

export function checkpointAction(option: CheckpointOption): CheckpointAction {
  return CHECKPOINT_ACTIONS.find((action) => action.option === option) ?? CHECKPOINT_ACTIONS[0];
}

function actionAt(index: number): CheckpointAction {
  return CHECKPOINT_ACTIONS[index] ?? CHECKPOINT_ACTIONS[0];
}

function makeMarkdown(checkpoint: CheckpointParams): string {
  const reviewer = checkpoint.reviewer ? `\n**Reviewer:** @${checkpoint.reviewer}` : "";
  const recommended = checkpoint.recommendedAction
    ? `\n**Recommended action:** \`${checkpoint.recommendedAction}\``
    : "";
  return `# Review checkpoint\n\n**Location:** \`${checkpoint.location}\`${reviewer}${recommended}\n\n---\n\n${checkpoint.checkpointMarkdown}\n\n---\n\n## Draft reply\n\n${checkpoint.draftReply}`;
}

function padToWidth(line: string, width: number): string {
  const truncated = truncateToWidth(line, width, "");
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

export class ReviewCheckpointDialog implements Component {
  private readonly markdown: Markdown;
  private scrollOffset = 0;
  private selectedIndex: number;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    checkpoint: CheckpointParams,
    private readonly done: (result: CheckpointOption | undefined) => void,
  ) {
    this.markdown = new Markdown(makeMarkdown(checkpoint), 1, 0, getMarkdownTheme(), {
      bgColor: (text) => theme.bg("customMessageBg", text),
    });
    this.selectedIndex = Math.max(0, OPTIONS.indexOf(checkpoint.recommendedAction ?? DEFAULT_ACTION));
  }

  render(width: number): string[] {
    const availableHeight = Math.max(1, this.tui.terminal.rows - 2);
    const height = Math.min(availableHeight, Math.max(12, Math.floor(this.tui.terminal.rows * 0.9)));
    const bodyWidth = Math.max(1, width - 2);
    const bodyLines = this.markdown.render(bodyWidth);
    const viewportHeight = Math.max(1, height - 7);
    const maxScrollOffset = Math.max(0, bodyLines.length - viewportHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScrollOffset));

    const visibleBody = bodyLines.slice(this.scrollOffset, this.scrollOffset + viewportHeight);
    while (visibleBody.length < viewportHeight) {
      visibleBody.push(this.theme.bg("customMessageBg", " ".repeat(bodyWidth)));
    }

    return [
      this.border("╭", "╮", width),
      this.frame(this.theme.fg("accent", this.theme.bold("Review checkpoint")), width),
      this.frame(this.scrollText(bodyLines.length, viewportHeight), width),
      ...visibleBody.map((line) => this.frame(line, width)),
      this.frame(this.actionText(), width),
      this.frame(this.theme.fg("dim", actionAt(this.selectedIndex).label), width),
      this.frame(
        this.theme.fg("dim", "↑↓/PgUp/PgDn scroll • ←→ choose • 1-6 shortcut • Enter select • Esc abort"),
        width,
      ),
      this.border("╰", "╯", width),
    ].slice(0, height);
  }

  handleInput(data: string): void {
    const page = Math.max(3, Math.floor(this.tui.terminal.rows * 0.5));
    if (matchesKey(data, Key.escape)) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.done(actionAt(this.selectedIndex).option);
      return;
    }
    if (/^[1-6]$/.test(data)) {
      this.done(actionAt(Number(data) - 1).option);
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.selectedIndex = (this.selectedIndex + CHECKPOINT_ACTIONS.length - 1) % CHECKPOINT_ACTIONS.length;
    } else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.selectedIndex = (this.selectedIndex + 1) % CHECKPOINT_ACTIONS.length;
    } else if (matchesKey(data, Key.up)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (matchesKey(data, Key.down)) {
      this.scrollOffset += 1;
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - page);
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset += page;
    } else if (matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
    } else if (matchesKey(data, Key.end)) {
      this.scrollOffset = Number.MAX_SAFE_INTEGER;
    } else {
      return;
    }
    this.tui.requestRender();
  }

  invalidate(): void {
    this.markdown.invalidate();
  }

  private border(left: string, right: string, width: number): string {
    return this.theme.fg("borderAccent", left + "─".repeat(Math.max(0, width - 2)) + right);
  }

  private frame(content: string, width: number): string {
    const inner = padToWidth(content, Math.max(0, width - 2));
    return this.theme.fg("borderAccent", "│") + inner + this.theme.fg("borderAccent", "│");
  }

  private scrollText(totalLines: number, viewportHeight: number): string {
    const first = Math.min(totalLines, this.scrollOffset + 1);
    const last = Math.min(totalLines, this.scrollOffset + viewportHeight);
    const above = this.scrollOffset > 0 ? `↑ ${this.scrollOffset} above` : "top";
    const below = last < totalLines ? `↓ ${totalLines - last} below` : "bottom";
    return this.theme.fg("dim", `Showing ${first}-${last} of ${totalLines} lines (${above}, ${below})`);
  }

  private actionText(): string {
    return CHECKPOINT_ACTIONS.map((action, index) => {
      const label = ` ${index + 1}:${action.option} `;
      return index === this.selectedIndex
        ? this.theme.bg("selectedBg", this.theme.fg("accent", label))
        : this.theme.fg("muted", label);
    }).join(" ");
  }
}
