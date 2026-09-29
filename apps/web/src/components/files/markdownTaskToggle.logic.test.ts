import { describe, expect, it } from "vite-plus/test";

import {
  applyMarkdownTaskToggle,
  type MarkdownTaskToggleEffects,
} from "./markdownTaskToggle.logic";

const MARKDOWN = "- [ ] ship it\n- [x] ship it twice\n";

function effects(): {
  readonly spies: MarkdownTaskToggleEffects;
  readonly published: string[];
  readonly drafts: string[];
  readonly saves: string[];
} {
  const published: string[] = [];
  const drafts: string[] = [];
  const saves: string[] = [];
  return {
    published,
    drafts,
    saves,
    spies: {
      publishContents: (contents) => void published.push(contents),
      changeDraft: (contents) => void drafts.push(contents),
      scheduleSave: (contents) => void saves.push(contents),
    },
  };
}

describe("applyMarkdownTaskToggle", () => {
  it("keeps an explicit-save markdown draft out of the auto-save path", () => {
    const test = effects();
    applyMarkdownTaskToggle(
      {
        contents: MARKDOWN,
        optimisticContents: null,
        markerOffset: 2,
        checked: true,
        explicitSave: true,
      },
      test.spies,
    );

    expect(test.published).toEqual(["- [x] ship it\n- [x] ship it twice\n"]);
    expect(test.drafts).toEqual(["- [x] ship it\n- [x] ship it twice\n"]);
    expect(test.saves).toEqual([]);
  });

  it("hands the toggle to the save coordinator when the surface auto-saves", () => {
    const test = effects();
    applyMarkdownTaskToggle(
      {
        contents: MARKDOWN,
        optimisticContents: null,
        markerOffset: 2,
        checked: true,
        explicitSave: false,
      },
      test.spies,
    );

    expect(test.saves).toEqual(["- [x] ship it\n- [x] ship it twice\n"]);
    expect(test.drafts).toEqual([]);
  });

  it("toggles the optimistic contents the reader is already looking at", () => {
    const test = effects();
    applyMarkdownTaskToggle(
      {
        contents: MARKDOWN,
        optimisticContents: "- [x] ship it\n- [x] ship it twice\n",
        markerOffset: 16,
        checked: false,
        explicitSave: true,
      },
      test.spies,
    );

    expect(test.published).toEqual(["- [x] ship it\n- [ ] ship it twice\n"]);
  });

  it("does nothing when the marker is not a task-list item", () => {
    const test = effects();
    applyMarkdownTaskToggle(
      {
        contents: MARKDOWN,
        optimisticContents: null,
        markerOffset: 1,
        checked: true,
        explicitSave: true,
      },
      test.spies,
    );

    expect(test.published).toEqual([]);
    expect(test.drafts).toEqual([]);
    expect(test.saves).toEqual([]);
  });
});
