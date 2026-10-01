import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SettingsIcon } from "lucide-react";

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ render }: any) => render,
  TooltipPopup: ({ children, ...props }: any) => (
    <div data-slot="tooltip-popup" {...props}>
      {children}
    </div>
  ),
}));

import { SidebarTitlebarButton } from "./SidebarTitlebarControl";

describe("SidebarTitlebarButton", () => {
  let renderer: ReactTestRenderer;

  afterEach(async () => {
    await act(() => renderer?.unmount());
  });

  it("renders a 28x28 button with no-drag and active scale styling", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const onClick = vi.fn();

    await act(() => {
      renderer = create(
        <SidebarTitlebarButton
          icon={<SettingsIcon className="size-4" />}
          label="Settings"
          shortcut="⌘,"
          onClick={onClick}
          testId="test-button"
        />,
      );
    });

    const button = renderer.root.findByProps({ "data-testid": "test-button" });
    expect(button.props.className).toContain("size-[var(--workspace-titlebar-control-size)]");
    expect(button.props.className).toContain("[-webkit-app-region:no-drag]");
    expect(button.props.className).toContain("active:scale-[0.98]");
    expect(button.props["aria-label"]).toBe("Settings");

    await act(() => {
      button.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    });

    expect(onClick).toHaveBeenCalled();
  });
});
