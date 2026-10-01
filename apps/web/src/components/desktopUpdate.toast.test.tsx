import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock("./ui/toast", () => ({ toastManager: { add: state.addToast } }));
import { openDesktopUpdateReleaseNotes } from "./desktopUpdate.toast";
const url = "https://github.com/AllenReder/awen/releases/tag/v0.1.0-alpha.4";
describe("manual Release navigation", () => {
  beforeEach(() => state.addToast.mockReset());
  it("opens the exact Release page", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    await openDesktopUpdateReleaseNotes({ openExternal }, url);
    expect(openExternal).toHaveBeenCalledWith(url);
    expect(state.addToast).not.toHaveBeenCalled();
  });
  it.each([false, "reject"])("reports failed navigation: %s", async (result) => {
    const openExternal =
      result === "reject"
        ? vi.fn().mockRejectedValue(new Error("IPC"))
        : vi.fn().mockResolvedValue(false);
    await openDesktopUpdateReleaseNotes({ openExternal }, url);
    expect(state.addToast).toHaveBeenCalledWith({
      type: "error",
      title: "Unable to open Release page",
    });
  });
});
