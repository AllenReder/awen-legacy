import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId, WorkspaceId } from "@awen/contracts";
import { EMPTY_TERMINAL_SESSION_STATE } from "@awen/client-runtime/state/terminal";
import type { XtermTerminalSurfaceOptions } from "../terminal/xterm/surface";
import { TerminalView } from "./TerminalView";
import { terminalTargetForRuntime } from "./sessionTarget";

const boundary = vi.hoisted(() => ({
  attach: vi.fn(),
  write: vi.fn(async () => ({ _tag: "Success" })),
  resize: vi.fn(async () => ({ _tag: "Success" })),
  create: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../state/entities", () => ({ useAwenWorkspace: () => ({ workspaceRoot: "/checkout" }) }));
vi.mock("../state/terminalSessions", () => ({
  useAttachedTerminalSession: (input: unknown) => boundary.attach(input),
  useTerminalSessionSummary: () => null,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "resize" ? boundary.resize : boundary.write),
}));
vi.mock("../state/terminal", () => ({ terminalEnvironment: { write: "write", resize: "resize" } }));
vi.mock("../state/server", () => ({ serverEnvironment: { configValueAtom: () => null } }));
vi.mock("../state/preview", () => ({ previewEnvironment: { open: "preview" } }));
vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => vi.fn() }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({
      fontFamilyCode: "monospace",
      fontFamilyTerminal: "monospace",
      fontSizeCode: 13,
      fontSizeTerminal: 13,
    }),
}));
vi.mock("~/terminal/xterm/surface", () => ({
  XtermTerminalSurface: { create: (...args: unknown[]) => boundary.create(...args) },
}));
let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("keeps terminal history and identity across reopen, fits measured size, and grants PTY input/resize only to the focused View", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const events = { addEventListener() {}, removeEventListener() {} };
  const frames: FrameRequestCallback[] = [];
  const windowFake = {
    ...events,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame() {},
  };
  const documentFake = {
    ...events,
    defaultView: windowFake,
    activeElement: null,
    documentElement: { classList: { contains: () => false } },
    body: {},
    querySelector: () => null,
    createElement: () => ({ getContext: () => null }),
  };
  vi.stubGlobal("window", windowFake);
  vi.stubGlobal("document", documentFake);
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "", colorScheme: "light" }));
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const mount = {
    ...events,
    ownerDocument: documentFake,
    closest: () => null,
    contains: () => false,
    focus: vi.fn(),
  };
  const terminal = {
    setVisible: vi.fn(),
    setTheme: vi.fn(),
    setFont: vi.fn(),
    resetAndWrite: vi.fn(),
    write: vi.fn(),
    focus: vi.fn(),
    fit: vi.fn(),
    isAtBottom: () => true,
    scrollToBottom: vi.fn(),
    dispose: vi.fn(),
    clearSelection: vi.fn(),
  };
  let options: XtermTerminalSurfaceOptions;
  boundary.create.mockImplementation(async (_mount, supplied) => {
    options = supplied;
    return terminal;
  });
  boundary.attach.mockReturnValue({
    ...EMPTY_TERMINAL_SESSION_STATE,
    status: "running",
    output: {
      generation: 1,
      resetVersion: 1,
      nextOffset: 17,
      retainedBytes: 17,
      chunks: [{ startOffset: 0, data: "saved scrollback\r\n", byteLength: 17 }],
    },
  });
  const target = terminalTargetForRuntime({
    environmentId: "local" as EnvironmentId,
    workspaceId: "workspace" as WorkspaceId,
    terminalId: "shell",
  });
  const view = (focused: boolean, width = 640, focusRequestId = 0) => (
    <TerminalView
      target={target}
      paneId="pane"
      focused={focused}
      focusRequestId={focusRequestId}
      availableSize={{ width, height: 480 }}
    />
  );
  await act(async () => {
    renderer = create(view(false), { createNodeMock: () => mount });
  });
  expect(terminal.resetAndWrite).toHaveBeenCalledWith("saved scrollback\r\n");
  await act(() => {
    options.onResize(80, 24);
    options.onData("ignored");
  });
  expect(boundary.resize).not.toHaveBeenCalled();
  expect(boundary.write).not.toHaveBeenCalled();
  await act(() => renderer.update(view(true)));
  expect(boundary.resize).toHaveBeenLastCalledWith({
    environmentId: "local",
    input: { workspaceId: "workspace", terminalId: "shell", cols: 80, rows: 24 },
  });
  await act(() => options.onData("echo hello\r"));
  expect(boundary.write).toHaveBeenLastCalledWith({
    environmentId: "local",
    input: { workspaceId: "workspace", terminalId: "shell", data: "echo hello\r" },
  });
  terminal.focus.mockClear();
  await act(() => renderer.update(view(true, 320, 1)));
  await act(() => {
    for (const callback of frames.splice(0)) callback(0);
  });
  expect(terminal.fit).toHaveBeenCalled();
  expect(terminal.focus).toHaveBeenCalled();
  await act(() => renderer.unmount());
  expect(terminal.dispose).toHaveBeenCalled();
  terminal.resetAndWrite.mockClear();
  await act(async () => {
    renderer = create(view(true), { createNodeMock: () => mount });
  });
  expect(boundary.attach).toHaveBeenLastCalledWith({
    environmentId: "local",
    terminal: { workspaceId: "workspace", terminalId: "shell", cwd: "/checkout" },
  });
  expect(terminal.resetAndWrite).toHaveBeenCalledWith("saved scrollback\r\n");
});
