import { ThreadId } from "@awen/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  handler: null as null | { handle: (request: unknown) => Promise<unknown> },
  confirm: vi.fn<() => Promise<boolean>>(),
  invoke: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  respond: vi.fn(),
  focus: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => null,
  useAtomSet: () => (handler: typeof mocks.handler) => {
    mocks.handler = handler;
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("~/env", () => ({ isTauri: true }));
vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ dialogs: { confirm: mocks.confirm } }),
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "proof-environment" }] }),
}));
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    automationRequests: () => ({}),
    open: mocks.open,
    navigate: vi.fn(),
    close: mocks.close,
    respondToAutomation: mocks.respond,
    focusAutomationHost: mocks.focus,
  },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("./previewAutomationRequestConsumer", () => ({
  createPreviewAutomationRequestConsumerAtom: () => ({}),
}));

import { TauriProofAutomationHosts } from "./TauriProofAutomationHosts";

let renderer: ReactTestRenderer | null = null;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.handler = null;
  vi.stubEnv("VITE_BROWSER_HOST_PROOF_AGENT", "1");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    confirm: vi.fn(() => true),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", { hasFocus: () => true });
  mocks.open.mockResolvedValue(AsyncResult.success({ tabId: "tab_1" }));
  mocks.close.mockResolvedValue(AsyncResult.success(undefined));
  mocks.invoke.mockImplementation(async (command: string) =>
    command === "evaluate"
      ? {
          url: "http://localhost:6933/browser-host-proof-page.html",
          title: "Native proof page",
          loading: false,
          width: 430,
          height: 510,
        }
      : undefined,
  );
  await act(() => {
    renderer = create(<TauriProofAutomationHosts />);
  });
  await act(async () => {
    await mocks.handler!.handle({
      requestId: "proof-open",
      operation: "open",
      threadId: ThreadId.make("proof-thread"),
      input: { url: "http://localhost:6933/browser-host-proof-page.html" },
      timeoutMs: 1_000,
    });
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("keeps the native page open until the visible confirmation is accepted", async () => {
  let decide!: (confirmed: boolean) => void;
  mocks.confirm.mockReturnValue(
    new Promise<boolean>((resolve) => {
      decide = resolve;
    }),
  );
  const closeButton = renderer!.root.findByType("button");

  await act(async () => {
    closeButton.props.onClick();
    closeButton.props.onClick();
  });
  expect(mocks.confirm).toHaveBeenCalledWith("Close Agent browser page tab_1?", {
    variant: "destructive",
  });
  expect(mocks.confirm).toHaveBeenCalledOnce();
  expect(mocks.invoke).not.toHaveBeenCalledWith("close", { tab: "a" });

  await act(async () => decide(false));
  expect(mocks.invoke).not.toHaveBeenCalledWith("close", { tab: "a" });
  expect(mocks.close).not.toHaveBeenCalled();

  mocks.confirm.mockReturnValue(
    new Promise<boolean>((resolve) => {
      decide = resolve;
    }),
  );
  await act(async () => closeButton.props.onClick());
  await act(async () => decide(true));
  expect(mocks.invoke).toHaveBeenCalledWith("close", { tab: "a" });
  expect(mocks.close).toHaveBeenCalledOnce();
});
