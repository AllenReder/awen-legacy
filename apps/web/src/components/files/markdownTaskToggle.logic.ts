import { setMarkdownTaskChecked } from "./filePreviewMode";

/**
 * A rendered Markdown task-list toggle, as the surface that owns the file sees it.
 *
 * The rendered view doubles as a draft surface: the checkbox the reader just clicked shows up
 * immediately as optimistic file contents. What follows is the part that differs per surface —
 * `explicitSave` keeps the change a draft that Cmd+S will write, and an auto-saving surface
 * hands it to its save coordinator. Neither may write from here: the coordinator owns that
 * debounce, and an explicit-save file has no write of its own until the reader asks for one.
 */
export interface MarkdownTaskToggle {
  readonly contents: string;
  /** Contents the rendered view is already showing, when a draft is ahead of the query data. */
  readonly optimisticContents: string | null;
  readonly markerOffset: number;
  readonly checked: boolean;
  readonly explicitSave: boolean;
}

export interface MarkdownTaskToggleEffects {
  readonly publishContents: (contents: string) => void;
  readonly changeDraft: (contents: string) => void;
  readonly scheduleSave: (contents: string) => void;
}

export function applyMarkdownTaskToggle(
  toggle: MarkdownTaskToggle,
  effects: MarkdownTaskToggleEffects,
): void {
  const currentContents = toggle.optimisticContents ?? toggle.contents;
  const nextContents = setMarkdownTaskChecked(currentContents, toggle.markerOffset, toggle.checked);
  if (nextContents === currentContents) return;

  effects.publishContents(nextContents);
  if (toggle.explicitSave) {
    effects.changeDraft(nextContents);
  } else {
    effects.scheduleSave(nextContents);
  }
}
