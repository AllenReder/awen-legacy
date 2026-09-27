import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { AwenProjectId, AgentSessionId, EnvironmentId, WorkspaceId } from "@awen/contracts";
import {
  clearViewRegistry,
  registerViewDefinition,
  resolveViewDefinition,
  type ViewDataSource,
  type ViewTarget,
} from "./viewRegistry";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => renderer?.unmount());
  clearViewRegistry();
  vi.unstubAllGlobals();
});

it("renders a registered Project View with typed updates and only its granted command", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const target = {
    kind: "project",
    definitionId: "project-summary",
    environmentId: "local" as EnvironmentId,
    projectId: "p1" as AwenProjectId,
  } as const;
  let snapshot = "First name";
  const listeners = new Set<() => void>();
  const dataSource: ViewDataSource<string> = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  let opened = false;
  const capabilities = {
    open: {
      execute: () => {
        opened = true;
      },
    },
  };
  registerViewDefinition({
    id: "project-summary",
    label: "Project summary",
    accepts: (value): value is Extract<ViewTarget, { kind: "project" }> => value.kind === "project",
    bind: () => ({ dataSource, capabilities }),
    Component: ({ data, capabilities: commands, focused, availableSize, target: current }) => (
      <button
        onClick={() => commands.open.execute()}
      >{`${data}:${current.projectId}:${focused}:${availableSize.width}`}</button>
    ),
  });
  const definition = resolveViewDefinition(target)!;
  await act(() => {
    renderer = create(
      <definition.Component
        target={target}
        paneId="pane"
        focused
        availableSize={{ width: 640, height: 480 }}
      />,
    );
  });
  expect(renderer!.root.findByType("button").children).toEqual(["First name:p1:true:640"]);
  await act(() => {
    snapshot = "Renamed";
    listeners.forEach((listener) => listener());
  });
  expect(renderer!.root.findByType("button").children).toEqual(["Renamed:p1:true:640"]);
  await act(() => renderer!.root.findByType("button").props.onClick());
  expect(opened).toBe(true);
  await act(() => renderer!.unmount());
  expect(listeners.size).toBe(0);
});

it("rejects incompatible target kinds even when the requested definition id exists", () => {
  registerViewDefinition({
    id: "summary",
    label: "Project summary",
    accepts: (target): target is Extract<ViewTarget, { kind: "project" }> =>
      target.kind === "project",
    bind: () => ({
      dataSource: { getSnapshot: () => null, subscribe: () => () => {} },
      capabilities: {},
    }),
    Component: () => null,
  });
  expect(resolveViewDefinition({ kind: "welcome", definitionId: "summary" })).toBeNull();
});

it("renders a Session extension with canonical identity and unsubscribes on target replacement", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const active = new Set<string>();
  registerViewDefinition({
    id: "session-summary",
    label: "Session summary",
    accepts: (target): target is Extract<ViewTarget, { kind: "agentSession" }> =>
      target.kind === "agentSession",
    bind: (target) => ({
      dataSource: {
        getSnapshot: () => target.agentSessionId,
        subscribe: () => {
          active.add(target.agentSessionId);
          return () => {
            active.delete(target.agentSessionId);
          };
        },
      },
      capabilities: {},
    }),
    Component: ({ data }) => <output>{data}</output>,
  });
  const target = {
    kind: "agentSession",
    definitionId: "session-summary",
    environmentId: "local" as EnvironmentId,
    agentSessionId: "s1" as AgentSessionId,
  } as const;
  const definition = resolveViewDefinition(target)!;
  const props = { paneId: "pane", focused: true, availableSize: { width: 400, height: 300 } };
  await act(() => {
    renderer = create(<definition.Component {...props} target={target} />);
  });
  expect(renderer!.root.findByType("output").children).toEqual(["s1"]);
  await act(() =>
    renderer!.update(
      <definition.Component
        {...props}
        target={{ ...target, agentSessionId: "s2" as AgentSessionId }}
      />,
    ),
  );
  expect(renderer!.root.findByType("output").children).toEqual(["s2"]);
  expect([...active]).toEqual(["s2"]);
});
