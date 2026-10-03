import { EnvironmentId } from "@awen/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  clearCache: vi.fn<(...args: unknown[]) => Promise<void>>(),
  clearCookies: vi.fn<(...args: unknown[]) => Promise<void>>(),
  hardReload: vi.fn<(...args: unknown[]) => Promise<void>>(),
  toastAdd: vi.fn(),
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: mocks.toastAdd },
}));

vi.mock("./previewBridge", () => ({
  previewBridge: {
    hardReload: mocks.hardReload,
    openDevTools: async () => undefined,
    zoomIn: async () => undefined,
    zoomOut: async () => undefined,
    resetZoom: async () => undefined,
    setColorScheme: async () => undefined,
    clearCookies: mocks.clearCookies,
    clearCache: mocks.clearCache,
  },
}));

vi.mock("~/components/ui/button", () => ({
  Button: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipPopup: () => null,
  TooltipTrigger: () => null,
}));

// The menu primitives are base-ui popups; the test drives the same onClick handlers the popup
// would, so the stubs only have to keep the children reachable.
vi.mock("~/components/ui/menu", () => ({
  Menu: ({ children }: { children?: ReactNode }) => children,
  MenuGroup: ({ children }: { children?: ReactNode }) => children,
  MenuGroupLabel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  MenuPopup: ({ children }: { children?: ReactNode }) => children,
  MenuRadioGroup: ({ children }: { children?: ReactNode }) => children,
  MenuRadioItem: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MenuSeparator: () => null,
  MenuSub: ({ children }: { children?: ReactNode }) => children,
  MenuSubPopup: ({ children }: { children?: ReactNode }) => children,
  MenuSubTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MenuTrigger: () => null,
}));

import { PreviewMoreMenu } from "./PreviewMoreMenu";

const environmentId = EnvironmentId.make("environment-preview-menu-test");

const props = {
  tabId: "tab-1",
  hasWebContents: true,
  zoomFactor: 1,
  colorScheme: "system" as const,
  deviceToolbarVisible: false,
  onToggleDeviceToolbar: () => {},
  nativePictureInPicture: false,
  onNativePictureInPicture: () => {},
  environmentId,
  profileId: "default",
  profileName: "Default",
};

let renderer: ReactTestRenderer | null = null;

function mount() {
  act(() => {
    renderer = create(<PreviewMoreMenu {...props} />);
  });
}

function menuButton(label: string): ReactTestInstance {
  const button = renderer?.root
    .findAllByType("button")
    .find((candidate) => candidate.children.join("") === label);
  if (!button) throw new Error(`No menu button labelled "${label}"`);
  return button;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    menuButton(label).props.onClick();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.clearCache.mockReset().mockResolvedValue(undefined);
  mocks.clearCookies.mockReset().mockResolvedValue(undefined);
  mocks.hardReload.mockReset().mockResolvedValue(undefined);
  mocks.toastAdd.mockReset();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("preview menu failures", () => {
  it("tells the reader a failed cookie clear did not happen", async () => {
    mocks.clearCookies.mockRejectedValueOnce(new Error("No preview profile is configured"));
    mount();

    await click("Clear cookies");

    expect(mocks.toastAdd).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Unable to clear cookies",
      description: "No preview profile is configured",
    });
  });

  it("tells the reader a failed cache clear did not happen", async () => {
    mocks.clearCache.mockRejectedValueOnce(new Error("The preview host went away"));
    mount();

    await click("Clear cache");

    expect(mocks.toastAdd).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Unable to clear cache",
      description: "The preview host went away",
    });
  });

  it("reports a refused tab action instead of swallowing it", async () => {
    mocks.hardReload.mockRejectedValueOnce(new Error("No web contents for this tab"));
    mount();

    await click("Hard reload");

    expect(mocks.toastAdd).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Unable to reload the preview",
      description: "No web contents for this tab",
    });
  });

  it("stays quiet when the preview bridge accepts the action", async () => {
    mount();

    await click("Clear cookies");
    await click("Clear cache");
    await click("Hard reload");

    expect(mocks.toastAdd).not.toHaveBeenCalled();
  });
});
