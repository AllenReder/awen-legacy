import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@awen/contracts";
import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";

const mocks = vi.hoisted(() => ({
  show: vi.fn(),
  copy: vi.fn(),
  capture: vi.fn(),
  error: vi.fn(),
}));
vi.mock("~/localApi", () => ({ readLocalApi: () => ({ contextMenu: { show: mocks.show } }) }));
vi.mock("~/hooks/useCopyToClipboard", () => ({ writeTextToClipboard: mocks.copy }));
vi.mock("~/lib/assistantTextSelection", () => ({ captureAssistantTextSelection: mocks.capture }));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.error } }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("~/lib/selectionActions", () => ({
  observeSelectionActions: () => ({ cancel() {}, dispose() {}, selectionChanged() {} }),
  resolveSelectionActionPosition: vi.fn(),
}));

let renderer: ReactTestRenderer;
let viewport: EventTarget & { contains: (node: unknown) => boolean };
let text: string;
let range: { startContainer: object; endContainer: object; cloneRange: () => unknown };
const cite = vi.fn();
const clearSelection = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  viewport = Object.assign(new EventTarget(), { contains: () => true });
  text = "Selected\n  original text";
  range = { startContainer: {}, endContainer: {}, cloneRange: () => range };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("window", {
    getSelection: () => ({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
      toString: () => text,
      removeAllRanges: clearSelection,
    }),
  });
  mocks.capture.mockReturnValue(null);
  mocks.show.mockResolvedValue(null);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
async function mount() {
  await act(() => {
    renderer = create(
      <AssistantSelectionToolbar
        viewport={viewport as unknown as HTMLElement}
        threadRef={{
          environmentId: EnvironmentId.make("local"),
          threadId: ThreadId.make("thread"),
        }}
        onCite={cite}
      />,
    );
  });
}
function rightClick() {
  const event = new Event("contextmenu", { cancelable: true });
  Object.assign(event, { clientX: 12, clientY: 34 });
  viewport.dispatchEvent(event);
  return event;
}
it("copies the original selected text captured before the menu changes focus", async () => {
  let resolve!: (action: string) => void;
  mocks.show.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await mount();
  expect(rightClick().defaultPrevented).toBe(true);
  expect(mocks.show).toHaveBeenCalledWith([{ id: "copy", label: "Copy", icon: "copy" }], {
    x: 12,
    y: 34,
  });
  text = "Different selection";
  await act(async () => {
    resolve("copy");
  });
  expect(mocks.copy).toHaveBeenCalledWith("Selected\n  original text");
});
it("cites the captured assistant source after the selection changes", async () => {
  const source = { dataset: { assistantCitationSource: "message" } };
  mocks.capture.mockReturnValue({
    source,
    range,
    selector: { text: "Selected assistant text", start: 0, end: 23 },
  });
  let resolve!: (action: string) => void;
  mocks.show.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  cite.mockReturnValue(true);
  await mount();
  rightClick();
  expect(mocks.show.mock.calls[0]![0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "cite", label: "Cite", icon: "quote", disabled: false }),
    ]),
  );
  text = "Different selection";
  await act(async () => {
    resolve("cite");
  });
  expect(cite).toHaveBeenCalledWith(
    expect.objectContaining({ messageId: "message", text: "Selected assistant text" }),
    { source, range, viewport },
  );
  expect(clearSelection).not.toHaveBeenCalled();
});
it("does not open a menu for selections extending outside the conversation", async () => {
  viewport.contains = () => false;
  await mount();
  expect(rightClick().defaultPrevented).toBe(false);
  expect(mocks.show).not.toHaveBeenCalled();
});
