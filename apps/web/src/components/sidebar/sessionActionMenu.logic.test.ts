import { describe, expect, it } from "vite-plus/test";
import { buildSessionActionMenuItems } from "./sessionActionMenu.logic";

describe("buildSessionActionMenuItems", () => {
  it("builds active Agent Session menu items with Open, Split, Rename, Close and Delete", () => {
    const items = buildSessionActionMenuItems({
      kind: "agent",
      isClosed: false,
      isOpenInWorkbench: false,
      isFocusedInWorkbench: false,
      canRename: true,
      canClose: true,
      canDelete: true,
    });

    const ids = items.map((i) => i.id);
    expect(ids).toEqual([
      "open",
      "split:right",
      "split:down",
      "rename",
      "close-session",
      "delete-session",
    ]);

    const deleteItem = items.find((i) => i.id === "delete-session");
    expect(deleteItem?.destructive).toBe(true);
  });

  it("includes Focus when the session is open in the Workbench and disables it if already focused", () => {
    const itemsUnfocused = buildSessionActionMenuItems({
      kind: "agent",
      isClosed: false,
      isOpenInWorkbench: true,
      isFocusedInWorkbench: false,
      canRename: true,
      canClose: true,
      canDelete: true,
    });

    const focusItem = itemsUnfocused.find((i) => i.id === "focus");
    expect(focusItem).toBeDefined();
    expect(focusItem?.disabled).toBe(false);

    const itemsFocused = buildSessionActionMenuItems({
      kind: "agent",
      isClosed: false,
      isOpenInWorkbench: true,
      isFocusedInWorkbench: true,
      canRename: true,
      canClose: true,
      canDelete: true,
    });
    const focusItemDisabled = itemsFocused.find((i) => i.id === "focus");
    expect(focusItemDisabled?.disabled).toBe(true);
  });

  it("omits Rename on Terminal Session when canRename is false", () => {
    const items = buildSessionActionMenuItems({
      kind: "terminal",
      isClosed: false,
      isOpenInWorkbench: false,
      isFocusedInWorkbench: false,
      canRename: false,
      canClose: true,
      canDelete: true,
    });

    expect(items.some((i) => i.id === "rename")).toBe(false);
  });

  it("includes Rename on Terminal Session when the caller provides the rename capability", () => {
    const items = buildSessionActionMenuItems({
      kind: "terminal",
      isClosed: true,
      isOpenInWorkbench: false,
      isFocusedInWorkbench: false,
      canRename: true,
      canClose: true,
      canDelete: true,
    });

    expect(items.some((i) => i.id === "rename")).toBe(true);
  });

  it("omits Close session on closed / history rows while retaining Delete session", () => {
    const items = buildSessionActionMenuItems({
      kind: "agent",
      isClosed: true,
      isOpenInWorkbench: false,
      isFocusedInWorkbench: false,
      canRename: true,
      canClose: true,
      canDelete: true,
    });

    const ids = items.map((i) => i.id);
    expect(ids).not.toContain("close-session");
    expect(ids).toContain("delete-session");
  });
});
