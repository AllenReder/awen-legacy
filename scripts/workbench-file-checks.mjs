import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Exercise the actual file editor, decision dialogs, disk writes and restored Pane. */
export async function verifyWorkbenchFiles(page, repositoryRoot) {
  // Let initial deep-link routing finish before issuing navigation commands.
  await page.locator('[data-pane-target-kind="agentSession"]').waitFor({ state: "visible" });
  const scope = await page.evaluate(async () => {
    const { readAwenProjects } = await import("/src/state/entities.ts");
    const project = readAwenProjects()[0];
    const workspace = project.workspaces[0];
    return {
      environmentId: project.environmentId,
      workspaceId: workspace.id,
      workspaceRoot: workspace.workspaceRoot,
    };
  });
  const relativeRoot = NodePath.relative(repositoryRoot, scope.workspaceRoot);
  NodeAssert.ok(
    !relativeRoot.startsWith("..") && !NodePath.isAbsolute(relativeRoot),
    "Fixture Workspace must belong to this checkout",
  );
  const directory = await NodeFSP.mkdtemp(NodePath.join(scope.workspaceRoot, "awen-files-e2e-"));
  const relativeDirectory = NodePath.basename(directory);
  const a = `${relativeDirectory}/a.txt`;
  const b = `${relativeDirectory}/b.txt`;
  await NodeFSP.writeFile(NodePath.join(directory, "a.txt"), "original A\n");
  await NodeFSP.writeFile(NodePath.join(directory, "b.txt"), "original B\n");
  try {
    const open = async (selectedPath) =>
      page.evaluate(
        async ({ scope, selectedPath }) => {
          const { useWorkbenchStore } = await import("/src/workbench/workbenchStore.ts");
          // The decision is completed by subsequent UI actions; do not await its promise here.
          void useWorkbenchStore.getState().openTarget({
            kind: "workspace",
            definitionId: "fileView",
            environmentId: scope.environmentId,
            workspaceId: scope.workspaceId,
            initialPath: selectedPath,
          });
        },
        { scope, selectedPath },
      );
    const selection = async () =>
      page.evaluate(async () => {
        const { useWorkbenchStore } = await import("/src/workbench/workbenchStore.ts");
        return useWorkbenchStore
          .getState()
          .tabs.flatMap((tab) => [...tab.panes.entries()])
          .filter(([, pane]) => pane.definitionId === "fileView")
          .map(([id, pane]) => ({ id, path: pane.presentation.selectedPath }));
      });
    const waitForSelection = async (selectedPath) =>
      page.waitForFunction(async (selectedPath) => {
        const { useWorkbenchStore } = await import("/src/workbench/workbenchStore.ts");
        const panes = useWorkbenchStore
          .getState()
          .tabs.flatMap((tab) => [...tab.panes.values()])
          .filter((pane) => pane.definitionId === "fileView");
        return panes.length === 1 && panes[0].presentation.selectedPath === selectedPath;
      }, selectedPath);
    const editor = page
      .locator('[data-testid="workspace-file-view"] [contenteditable="true"]')
      .first();
    const append = async (text) => {
      await editor.waitFor({ state: "visible" });
      await editor.click();
      await editor.press("ControlOrMeta+End");
      await page.keyboard.insertText(text);
    };
    await open(a);
    await waitForSelection(a);
    console.log("workbench Files: selection opened");
    await editor.waitFor({ state: "visible" });
    const originalPane = (await selection())[0].id;
    await append("unsaved A");
    await open(b);
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    NodeAssert.deepEqual(await selection(), [{ id: originalPane, path: a }]);
    NodeAssert.match(await editor.innerText(), /unsaved A/);

    // Use the real file tree for the second attempt, not another navigation command.
    const showExplorer = page.getByRole("button", { name: "Show file explorer", exact: true });
    if (await showExplorer.isVisible()) await showExplorer.click();
    await page.locator(`[role="treeitem"][data-item-path="${b}"]`).click();
    await dialog.getByRole("button", { name: "Don't Save", exact: true }).click();
    await waitForSelection(b);
    NodeAssert.deepEqual(await selection(), [{ id: originalPane, path: b }]);
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(directory, "a.txt"), "utf8"),
      "original A\n",
    );
    await append("saved B");
    await open(a);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await waitForSelection(a);
    NodeAssert.match(await NodeFSP.readFile(NodePath.join(directory, "b.txt"), "utf8"), /saved B/);
    await append("restored A");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: /Open .*Files/ }).click();
    await waitForSelection(a);
    await editor.waitFor({ state: "visible" });
    NodeAssert.match(await editor.innerText(), /restored A/);
    NodeAssert.deepEqual(await selection(), [{ id: originalPane, path: a }]);
    console.log(
      "workbench Files passed: one Pane, tree switching, cancel/discard/save, disk contents, draft restoration",
    );
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}
