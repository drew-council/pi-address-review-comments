import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, type SelectListTheme, Text, type TUI } from "@earendil-works/pi-tui";
import { CHECKPOINT_ACTIONS, type CheckpointAction, type CheckpointOption, type CheckpointParams } from "./types.js";

const DEFAULT_ACTION: CheckpointOption = "resolve";

export function checkpointAction(option: CheckpointOption): CheckpointAction {
  return CHECKPOINT_ACTIONS.find((action) => action.option === option) ?? CHECKPOINT_ACTIONS[0];
}

function actionAt(index: number): CheckpointAction {
  return CHECKPOINT_ACTIONS[index] ?? CHECKPOINT_ACTIONS[0];
}

function selectListTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("muted", text),
    noMatch: (text) => theme.fg("muted", text),
  };
}

function metadataLine(checkpoint: CheckpointParams): string {
  return [
    `Location: ${checkpoint.location}`,
    checkpoint.reviewer ? `Reviewer: @${checkpoint.reviewer}` : undefined,
    checkpoint.recommendedAction ? `Recommended: ${checkpoint.recommendedAction}` : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join("   ");
}

/**
 * Compact, non-overlay action picker for a review checkpoint.
 *
 * The full checkpoint — reviewer, analysis, relevant diff, and draft reply — is rendered
 * into the transcript by the checkpoint tool's `renderCall`. Keeping this picker out of the
 * overlay layer leaves pi's native transcript scrolling (mouse wheel, PgUp/PgDn, Home/End)
 * available while the user reviews that content and decides.
 */
export class ReviewCheckpointDialog extends Container {
  private readonly selectList: SelectList;

  constructor(
    private readonly tui: TUI,
    theme: Theme,
    checkpoint: CheckpointParams,
    private readonly done: (result: CheckpointOption | undefined) => void,
  ) {
    super();

    const items: SelectItem[] = CHECKPOINT_ACTIONS.map((action, index) => ({
      value: action.option,
      label: `${index + 1}. ${action.option}`,
      description: action.label,
    }));
    this.selectList = new SelectList(items, items.length, selectListTheme(theme));
    this.selectList.onSelect = (item) => done(item.value as CheckpointOption);
    this.selectList.onCancel = () => done(undefined);
    const recommendedIndex = CHECKPOINT_ACTIONS.findIndex(
      (action) => action.option === (checkpoint.recommendedAction ?? DEFAULT_ACTION),
    );
    this.selectList.setSelectedIndex(recommendedIndex >= 0 ? recommendedIndex : 0);

    const border = (text: string) => theme.fg("accent", text);
    this.addChild(new DynamicBorder(border));
    this.addChild(new Text(theme.fg("accent", theme.bold("Review checkpoint")), 1, 0));
    this.addChild(new Text(theme.fg("dim", metadataLine(checkpoint)), 1, 0));
    this.addChild(new Text(theme.fg("dim", "Full analysis and draft reply are in the transcript above."), 1, 0));
    this.addChild(this.selectList);
    this.addChild(new Text(theme.fg("dim", "↑↓ choose • 1-6 jump • Enter confirm • Esc abort"), 1, 0));
    this.addChild(new DynamicBorder(border));
  }

  handleInput(data: string): void {
    const match = /^([1-6])$/.exec(data);
    if (match) {
      const index = Number(match[1]) - 1;
      if (index < CHECKPOINT_ACTIONS.length) {
        this.done(actionAt(index).option);
        return;
      }
    }
    this.selectList.handleInput(data);
    this.tui.requestRender();
  }
}
