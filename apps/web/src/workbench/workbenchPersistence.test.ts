import { describe, expect, it } from "vite-plus/test";
import type { AgentSessionId, EnvironmentId, WorkspaceId } from "@awen/contracts";

import { leafIds } from "./layout";
import type { ViewTarget } from "./viewRegistry";
import {
  WORKBENCH_PERSISTENCE_KEY,
  WORKBENCH_PERSISTENCE_BACKUP_KEY,
  deserializeWorkbenchSnapshot,
  readWorkbenchSnapshot,
  serializeWorkbenchSnapshot,
  writeWorkbenchSnapshot,
} from "./workbenchPersistence";
import {
  applyActivateTab,
  applyCreateTab,
  applyOpenTarget,
  applyRenameTab,
  applySplitFocused,
  emptyWorkbenchSnapshot,
} from "./workbenchState";

const ENV_A: EnvironmentId = "env-a" as EnvironmentId;
const WS_A: WorkspaceId = "ws-a" as WorkspaceId;
const AGENT_A: AgentSessionId = "agent-a" as AgentSessionId;

function agent(): Extract<ViewTarget, { kind: "agentSession" }> {
  return {
    kind: "agentSession",
    environmentId: ENV_A,
    agentSessionId: AGENT_A,
  };
}

function terminal(): Extract<ViewTarget, { kind: "workspaceTerminal" }> {
  return {
    kind: "workspaceTerminal",
    environmentId: ENV_A,
    workspaceId: WS_A,
    terminalSessionId: "term-a" as Extract<
      ViewTarget,
      { kind: "workspaceTerminal" }
    >["terminalSessionId"],
  };
}

function makeIds(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

describe("workbench persistence", () => {
  it("round-trips Tabs, layout, PaneViews, focus, and title mode", () => {
    const ids = makeIds();
    let snapshot = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(), ids);
    const firstTabId = snapshot.activeTabId;
    snapshot = applySplitFocused(snapshot, terminal(), "right", ids);
    snapshot = applyRenameTab(snapshot, firstTabId, "Pinned work");
    snapshot = applyCreateTab(snapshot, ids);
    snapshot = applyOpenTarget(snapshot, agent(), ids);
    snapshot = applyActivateTab(snapshot, firstTabId);

    const restored = deserializeWorkbenchSnapshot(serializeWorkbenchSnapshot(snapshot));

    expect(restored).not.toBeNull();
    expect(restored?.activeTabId).toBe(snapshot.activeTabId);
    expect(restored?.tabs).toHaveLength(2);
    expect(restored?.tabs[0]?.titleMode).toBe("manual");
    expect(restored?.tabs[0]?.titleOverride).toBe("Pinned work");
    expect([...restored!.tabs[0]!.panes.values()].map((view) => view.target)).toEqual([
      agent(),
      terminal(),
    ]);
    expect(leafIds(restored!.tabs[0]!.layout)).toEqual([...restored!.tabs[0]!.panes.keys()]);
  });

  it("rejects duplicate resources inside a Tab", () => {
    const ids = makeIds();
    const raw = JSON.parse(
      serializeWorkbenchSnapshot(applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(), ids)),
    ) as {
      tabs: Array<{
        layout: unknown;
        focusedPaneId: string;
        panes: Array<[string, { id: string } & Record<string, unknown>]>;
      }>;
    };
    const firstPane = raw.tabs[0]!.panes[0]!;
    raw.tabs[0]!.layout = {
      type: "split",
      id: "split-a",
      dir: "right",
      children: [raw.tabs[0]!.layout, { type: "leaf", id: "pane-b" }],
      sizes: [0.5, 0.5],
    };
    raw.tabs[0]!.panes.push(["pane-b", { ...firstPane[1] }]);

    expect(deserializeWorkbenchSnapshot(JSON.stringify(raw))).toBeNull();
  });

  it("rejects duplicate resources across Tabs", () => {
    const ids = makeIds();
    const raw = JSON.parse(
      serializeWorkbenchSnapshot(applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(), ids)),
    ) as {
      tabs: Array<Record<string, unknown> & { id: string; panes: Array<[string, unknown]> }>;
    };
    const firstPane = raw.tabs[0]!.panes[0]!;
    raw.tabs.push({
      ...raw.tabs[0]!,
      id: "tab-mirror",
      layout: { type: "leaf", id: "pane-mirror" },
      focusedPaneId: "pane-mirror",
      panes: [["pane-mirror", { ...(firstPane[1] as object) }]],
    });
    const stored = JSON.stringify(raw);

    const restored = readWorkbenchSnapshot({
      getItem: () => stored,
      setItem: () => undefined,
    });
    expect(restored).toBeNull();
  });

  it("rejects two Views of the same non-Session target in one Tab", () => {
    const ids = makeIds();
    const fileView: ViewTarget = {
      kind: "workspace",
      definitionId: "fileView",
      environmentId: ENV_A,
      workspaceId: WS_A,
    };
    const raw = JSON.parse(
      serializeWorkbenchSnapshot(applyOpenTarget(emptyWorkbenchSnapshot(ids), fileView, ids)),
    ) as {
      tabs: Array<{
        layout: unknown;
        panes: Array<[string, { id: string } & Record<string, unknown>]>;
      }>;
    };
    const firstPane = raw.tabs[0]!.panes[0]!;
    raw.tabs[0]!.layout = {
      type: "split",
      id: "split-a",
      dir: "right",
      children: [raw.tabs[0]!.layout, { type: "leaf", id: "pane-b" }],
      sizes: [0.5, 0.5],
    };
    raw.tabs[0]!.panes.push(["pane-b", { ...firstPane[1] }]);

    expect(deserializeWorkbenchSnapshot(JSON.stringify(raw))).toBeNull();
  });

  it.each([
    ["invalid JSON", "{"],
    ["unknown version", JSON.stringify({ version: 99, tabs: [], activeTabId: "missing" })],
    [
      "Tab without all layout leaves",
      JSON.stringify({
        version: 1,
        activeTabId: "tab-a",
        tabs: [
          {
            id: "tab-a",
            layout: { type: "leaf", id: "pane-a" },
            focusedPaneId: "pane-a",
            titleMode: "auto",
            titleOverride: null,
            panes: [],
          },
        ],
      }),
    ],
  ])("rejects %s without throwing", (_label, raw) => {
    expect(deserializeWorkbenchSnapshot(raw)).toBeNull();
  });

  it("reads and writes through the versioned storage key", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const snapshot = emptyWorkbenchSnapshot(makeIds());

    writeWorkbenchSnapshot(snapshot, storage);

    expect(values.has(WORKBENCH_PERSISTENCE_KEY)).toBe(true);
    expect(readWorkbenchSnapshot(storage)).toEqual(snapshot);
  });

  it("backs up an unreadable snapshot before replacing it", () => {
    const invalid = JSON.stringify({ version: 99, tabs: [], activeTabId: "missing" });
    const values = new Map([[WORKBENCH_PERSISTENCE_KEY, invalid]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    writeWorkbenchSnapshot(emptyWorkbenchSnapshot(makeIds()), storage);

    expect(values.get(WORKBENCH_PERSISTENCE_BACKUP_KEY)).toBe(invalid);
    expect(deserializeWorkbenchSnapshot(values.get(WORKBENCH_PERSISTENCE_KEY)!)).not.toBeNull();
  });
});
