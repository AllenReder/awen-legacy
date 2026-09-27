import { describe, expect, it, vi, beforeEach, afterEach } from "vite-plus/test";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { AgentSessionId, EnvironmentId, ThreadId, WorkspaceId } from "@awen/contracts";
import { scopeThreadRef } from "@awen/client-runtime/environment";
import { useComposerDraftStore } from "../composerDraftStore";
import { useSessionCommands } from "./useSessionCommands";

const deleteMock = vi.fn();
const archiveMock = vi.fn();
const stopSessionMock = vi.fn();
const closeTerminalMock = vi.fn();
const removeSessionViewsMock = vi.fn();
const readThreadShellMock = vi.fn();
const useAwenAgentSessionShellMock = vi.fn();

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (cmd: unknown) => {
    if (cmd === "mock-delete") return deleteMock;
    if (cmd === "mock-archive") return archiveMock;
    if (cmd === "mock-stop") return stopSessionMock;
    if (cmd === "mock-terminal-close") return closeTerminalMock;
    return vi.fn();
  },
}));

vi.mock("../state/threads", () => ({
  threadEnvironment: {
    delete: "mock-delete",
    archive: "mock-archive",
    stopSession: "mock-stop",
  },
}));

vi.mock("../state/terminal", () => ({
  terminalEnvironment: {
    close: "mock-terminal-close",
  },
}));

vi.mock("../state/entities", () => ({
  readThreadDetail: () => null,
  readThreadShell: (ref: unknown) => readThreadShellMock(ref),
  useAwenAgentSessionShell: (env: unknown, id: unknown) => useAwenAgentSessionShellMock(env, id),
}));

vi.mock("../workbench/workbenchStore", () => ({
  useWorkbenchStore: () => ({
    removeSessionViews: removeSessionViewsMock,
    openTarget: vi.fn(),
    setFocused: vi.fn(),
    splitFocused: vi.fn(),
  }),
}));

vi.mock("../components/ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: vi.fn(),
}));

describe("useSessionCommands Agent lifecycle", () => {
  const target = {
    kind: "agentSession" as const,
    environmentId: "env-1" as EnvironmentId,
    agentSessionId: "thread-1" as AgentSessionId,
  };

  let closeOptions: Parameters<typeof useSessionCommands>[1];
  let renderer: ReactTestRenderer | undefined;
  let commandsHandle: ReturnType<typeof useSessionCommands> | undefined;

  function Probe() {
    const commands = useSessionCommands(target, closeOptions);
    useLayoutEffect(() => {
      commandsHandle = commands;
    });
    return null;
  }

  beforeEach(() => {
    closeOptions = undefined;
    vi.clearAllMocks();
    useComposerDraftStore.setState(useComposerDraftStore.getInitialState());
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    useAwenAgentSessionShellMock.mockReturnValue({
      id: "thread-1",
      threadId: "thread-1" as ThreadId,
      title: "New Agent Session",
    });
  });

  afterEach(() => {
    if (renderer) {
      act(() => renderer?.unmount());
      renderer = undefined;
    }
    vi.unstubAllGlobals();
  });

  it("archives a zero-turn Session when Archive is requested", async () => {
    archiveMock.mockResolvedValue({ _tag: "Success" });
    // zero-turn: latestTurn and session are both null
    readThreadShellMock.mockReturnValue({
      id: "thread-1",
      latestTurn: null,
      session: null,
    });

    act(() => {
      renderer = create(<Probe />);
    });

    await act(async () => {
      await commandsHandle?.closeSession();
    });

    expect(archiveMock).toHaveBeenCalledWith({
      environmentId: "env-1",
      input: { threadId: "thread-1" },
    });
    expect(deleteMock).not.toHaveBeenCalled();
    expect(removeSessionViewsMock).toHaveBeenCalledWith(target);
  });

  it("archives sessions with existing turns into history upon close", async () => {
    archiveMock.mockResolvedValue({ _tag: "Success" });
    // has completed turns
    readThreadShellMock.mockReturnValue({
      id: "thread-1",
      latestTurn: { turnId: "turn-1", status: "completed" },
      session: null,
    });

    act(() => {
      renderer = create(<Probe />);
    });

    await act(async () => {
      await commandsHandle?.closeSession();
    });

    expect(archiveMock).toHaveBeenCalledWith({
      environmentId: "env-1",
      input: { threadId: "thread-1" },
    });
    expect(deleteMock).not.toHaveBeenCalled();
    expect(removeSessionViewsMock).toHaveBeenCalledWith(target);
  });
  it("archives an unsent prompt instead of deleting its Session", async () => {
    readThreadShellMock.mockReturnValue({ latestTurn: null, session: null });
    archiveMock.mockResolvedValue({ _tag: "Success" });
    useComposerDraftStore
      .getState()
      .setPrompt(scopeThreadRef(target.environmentId, "thread-1" as ThreadId), "Keep this draft");
    await act(() => {
      renderer = create(<Probe />);
    });
    await act(() => commandsHandle!.closeSession());
    expect(archiveMock).toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("keeps unsent content during the close animation", async () => {
    readThreadShellMock.mockReturnValue({ latestTurn: null, session: null });
    archiveMock.mockResolvedValue({ _tag: "Success" });
    closeOptions = {
      onWillClose: () => {
        useComposerDraftStore
          .getState()
          .setPrompt(
            scopeThreadRef(target.environmentId, "thread-1" as ThreadId),
            "Typed during animation",
          );
      },
    };
    await act(() => {
      renderer = create(<Probe />);
    });
    await act(() => commandsHandle!.closeSession());
    expect(archiveMock).toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });
  it("archives an attachment-only draft", async () => {
    readThreadShellMock.mockReturnValue({ latestTurn: null, session: null });
    archiveMock.mockResolvedValue({ _tag: "Success" });
    useComposerDraftStore.getState().addFiles(
      scopeThreadRef(target.environmentId, "thread-1" as ThreadId),
      [
        {
          type: "file",
          id: "attachment",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          file: null,
        },
      ],
      { appendReference: false },
    );
    await act(() => {
      renderer = create(<Probe />);
    });
    await act(() => commandsHandle!.closeSession());
    expect(archiveMock).toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("restores the row and retains Views when archiving an empty Session fails", async () => {
    readThreadShellMock.mockReturnValue({ latestTurn: null, session: null });
    const revert = vi.fn();
    closeOptions = { onWillClose: () => revert };
    archiveMock.mockRejectedValueOnce(new Error("offline"));
    await act(() => {
      renderer = create(<Probe />);
    });
    await act(() => commandsHandle!.closeSession());
    expect(revert).toHaveBeenCalledTimes(1);
    expect(removeSessionViewsMock).not.toHaveBeenCalled();
  });
});
