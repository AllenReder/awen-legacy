import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  TerminalSessionId,
  WorkspaceId,
  type TerminalSummary,
} from "@awen/contracts";
import { selectRunningSubprocessTerminalIds } from "@awen/client-runtime/state/terminal";

import { selectKnownTerminalSessions } from "./terminalSessions";

vi.mock("./terminal", () => ({ terminalEnvironment: {} }));

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
const workspaceA = WorkspaceId.make("workspace-a");
const workspaceB = WorkspaceId.make("workspace-b");

function summary(
  workspaceId: string | undefined,
  terminalId: string,
  changes: Partial<TerminalSummary> = {},
): TerminalSummary {
  return {
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    terminalId,
    sessionId: TerminalSessionId.make(terminalId),
    kind: "terminal",
    cwd: "/repo",
    worktreePath: null,
    status: "running",
    pid: 123,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: true,
    label: "Terminal",
    updatedAt: "2026-09-04T00:00:00.000Z",
    ...changes,
  };
}

describe("selectKnownTerminalSessions", () => {
  it("groups terminals by Workspace and preserves numeric order", () => {
    const metadata = [
      summary(workspaceB, "terminal-2"),
      summary(workspaceA, "terminal-10"),
      summary(workspaceB, "terminal-1"),
      summary(workspaceA, "terminal-1"),
      summary(workspaceA, "terminal-3"),
    ];
    const selected = selectKnownTerminalSessions(metadata, environmentA, workspaceA);
    expect(selected.map((session) => session.target.terminalId)).toEqual([
      "terminal-1",
      "terminal-3",
      "terminal-10",
    ]);
    expect(selected.map((session) => session.target.workspaceId)).toEqual([
      workspaceA,
      workspaceA,
      workspaceA,
    ]);

    const repeated = [...metadata];
    expect(selectKnownTerminalSessions(repeated, environmentA, workspaceA)).toBe(selected);

    const reordered = metadata.toReversed();
    // A reordered snapshot keeps the same identity but the order follows the
    // immutable snapshot's terminal-id ordering.
    expect(
      selectKnownTerminalSessions(reordered, environmentA, workspaceA).map(
        (session) => session.target.terminalId,
      ),
    ).toEqual(["terminal-1", "terminal-3", "terminal-10"]);
  });

  it("changes only the affected Workspace and preserves earlier snapshots", () => {
    const first = summary(workspaceA, "terminal-1");
    const second = summary(workspaceA, "terminal-2");
    const other = summary(workspaceB, "terminal-1");
    const metadata = [first, second, other];
    const beforeA = selectKnownTerminalSessions(metadata, environmentA, workspaceA);
    const beforeB = selectKnownTerminalSessions(metadata, environmentA, workspaceB);
    Object.freeze(beforeA);
    Object.freeze(beforeB);
    const exited = {
      ...second,
      status: "exited" as const,
      pid: null,
      exitCode: 0,
      hasRunningSubprocess: false,
      label: "Finished",
      updatedAt: "2026-09-04T00:00:01.000Z",
    };
    const next = [first, other, exited];
    const afterA = selectKnownTerminalSessions(next, environmentA, workspaceA);
    expect(selectKnownTerminalSessions(next, environmentA, workspaceB)).toBe(beforeB);
    expect(afterA).not.toBe(beforeA);
    expect(afterA[0]).toBe(beforeA[0]);
    expect(afterA[1]?.state).toMatchObject({
      status: "exited",
      hasRunningSubprocess: false,
      summary: { label: "Finished", pid: null, exitCode: 0 },
    });
    expect(selectRunningSubprocessTerminalIds(afterA)).toEqual(["terminal-1"]);
    expect(selectKnownTerminalSessions(metadata, environmentA, workspaceA)).toBe(beforeA);
    expect(selectKnownTerminalSessions([other], environmentA, workspaceA)).toEqual([]);
    expect(selectKnownTerminalSessions([other], environmentA, workspaceB)).toBe(beforeB);
  });

  it("keeps environment targets separate when snapshots share the same objects", () => {
    const metadata = [summary(workspaceA, "terminal-1")];
    const first = selectKnownTerminalSessions(metadata, environmentA, workspaceA);
    const second = selectKnownTerminalSessions(metadata, environmentB, workspaceA);
    expect(first[0]?.target.environmentId).toBe(environmentA);
    expect(second[0]?.target.environmentId).toBe(environmentB);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(selectKnownTerminalSessions([...metadata], environmentA, workspaceA)).toBe(first);
    expect(selectKnownTerminalSessions([...metadata], environmentB, workspaceA)).toBe(second);
  });

  it("returns stable empty results without a connected environment or assignment", () => {
    const metadata = [summary(workspaceA, "terminal-1")];
    const empty = selectKnownTerminalSessions(null, environmentA, workspaceA);
    expect(selectKnownTerminalSessions(metadata, null, workspaceA)).toBe(empty);
    expect(selectKnownTerminalSessions([], environmentA, null)).toBe(empty);
    expect(selectKnownTerminalSessions(metadata, environmentA, null)).toBe(empty);
    expect(selectKnownTerminalSessions(metadata, environmentA, workspaceB)).toBe(empty);
  });

  it("does not materialize unrelated terminals or unassigned servers", () => {
    const metadata = [
      summary(workspaceA, "terminal-1"),
      summary(workspaceA, "terminal-2"),
      summary(undefined, "terminal-3"),
      summary(workspaceB, "terminal-4"),
    ];
    expect(
      selectKnownTerminalSessions(metadata, environmentA, workspaceA).map(
        (session) => session.target.terminalId,
      ),
    ).toEqual(["terminal-1", "terminal-2"]);
    expect(selectKnownTerminalSessions(metadata, environmentA, workspaceB)).toHaveLength(1);
  });

  it("reads the metadata array once per selector index", () => {
    const source = Array.from({ length: 40 }, (_, index) =>
      summary(index % 2 === 0 ? workspaceA : workspaceB, "terminal-1"),
    );
    let reads = 0;
    const metadata = new Proxy(source, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(selectKnownTerminalSessions(metadata, environmentA, workspaceA)).toHaveLength(20);
    expect(reads).toBe(source.length);
  });
});
