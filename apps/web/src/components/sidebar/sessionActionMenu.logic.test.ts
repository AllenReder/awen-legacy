import { describe, expect, it } from "vite-plus/test";
import type { WorkspaceId } from "@awen/contracts";
import { buildSessionActionMenuItems, siblingWorkspacesForAgent } from "./sessionActionMenu.logic";

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
      canMigrate: false,
      canMigrateNow: false,
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
      canMigrate: false,
      canMigrateNow: false,
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
      canMigrate: false,
      canMigrateNow: false,
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
      canMigrate: false,
      canMigrateNow: false,
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
      canMigrate: false,
      canMigrateNow: false,
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
      canMigrate: false,
      canMigrateNow: false,
    });

    const ids = items.map((i) => i.id);
    expect(ids).not.toContain("close-session");
    expect(ids).toContain("delete-session");
  });

  it("offers Move to Workspace for an Agent Session with a sibling Workspace, disabled while executing", () => {
    const enabled = buildSessionActionMenuItems({
      kind: "agent",
      isClosed: false,
      isOpenInWorkbench: false,
      isFocusedInWorkbench: false,
      canRename: true,
      canClose: true,
      canDelete: true,
      canMigrate: true,
      canMigrateNow: true,
    });
    const enabledItem = enabled.find((i) => i.id === "move-workspace");
    expect(enabledItem).toBeDefined();
    expect(enabledItem?.disabled).toBe(false);

    const executing = buildSessionActionMenuItems({
      kind: "agent",
      isClosed: false,
      isOpenInWorkbench: false,
      isFocusedInWorkbench: false,
      canRename: true,
      canClose: true,
      canDelete: true,
      canMigrate: true,
      canMigrateNow: false,
    });
    expect(executing.find((i) => i.id === "move-workspace")?.disabled).toBe(true);
  });
});

describe("siblingWorkspacesForAgent", () => {
  const ws = (id: string) => ({ id: id as WorkspaceId });
  const projects = [
    { environmentId: "env-1", workspaces: [ws("workspace:a"), ws("workspace:b")] },
    { environmentId: "env-2", workspaces: [ws("workspace:c")] },
  ];

  it("returns the other Workspaces of the Session's Project and environment", () => {
    expect(siblingWorkspacesForAgent(projects, "env-1", "workspace:a" as WorkspaceId)).toEqual([
      { id: "workspace:b" },
    ]);
  });

  it("returns nothing when the Session's Workspace is not in the projection", () => {
    expect(
      siblingWorkspacesForAgent(projects, "env-1", "workspace:missing" as WorkspaceId),
    ).toEqual([]);
  });

  it("does not cross environments", () => {
    expect(siblingWorkspacesForAgent(projects, "env-2", "workspace:a" as WorkspaceId)).toEqual([]);
  });
});
