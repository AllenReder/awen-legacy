import { afterEach, expect, it, vi } from "vite-plus/test";

import { resolveWindowChromeGeometry } from "@awen/shared/windowChromeGeometry";
import { createSidebarPresentation } from "./sidebarPresentation";

const geometry = resolveWindowChromeGeometry({
  hasDesktopBridge: true,
  isMac: true,
  fullscreen: false,
  zoomFactor: 1,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("moves the Sidebar visibly faster with a shorter scaled duration", () => {
  let now = 0;
  let handle = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++handle, callback);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("document", { documentElement: { dataset: {} } });

  const exposedWidthAfter30ms = (durationMs: number) => {
    now = 0;
    frames.clear();
    const properties = new Map<string, string>();
    const wrapper = {
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
      },
    } as unknown as HTMLElement;
    const presentation = createSidebarPresentation(wrapper, geometry, false);
    presentation.update({ open: false, enabled: true, width: 300, durationMs, geometry });
    presentation.update({ open: true, enabled: true, width: 300, durationMs, geometry });
    now = 30;
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(now));
    const exposed = Number.parseFloat(properties.get("--sidebar-exposed-width") ?? "0");
    presentation.dispose();
    return exposed;
  };

  const fast = exposedWidthAfter30ms(25);
  const slow = exposedWidthAfter30ms(400);
  expect(fast).toBeGreaterThan(slow + 100);
});

function setupPresentation(initiallyOpen = true) {
  let now = 0;
  let handle = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++handle, callback);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const dataset: Record<string, string> = {};
  vi.stubGlobal("document", { documentElement: { dataset } });
  const properties = new Map<string, string>();
  const wrapper = {
    style: { setProperty: (key: string, value: string) => properties.set(key, value) },
  } as unknown as HTMLElement;
  const presentation = createSidebarPresentation(wrapper, geometry, initiallyOpen);
  const update = (overrides: Partial<Parameters<typeof presentation.update>[0]> = {}) =>
    presentation.update({
      open: initiallyOpen,
      enabled: false,
      width: 300,
      durationMs: 400,
      geometry,
      ...overrides,
    });
  const read = (key: string) => Number.parseFloat(properties.get(key) ?? "NaN");
  return {
    presentation,
    update,
    read,
    frames,
    dataset,
    frame(ms: number) {
      now += ms;
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(now));
    },
  };
}

it("uses exact shared endpoints and updates geometry without rebuilding the spring", () => {
  const { presentation, update, read } = setupPresentation();
  update();
  expect(read("--sidebar-motion-action-left")).toBe(266);
  expect(read("--sidebar-exposed-width")).toBe(300);
  expect(read("--sidebar-motion-tabs-inset")).toBe(0);
  update({ open: false });
  expect(read("--sidebar-motion-action-left")).toBe(106);
  expect(read("--sidebar-motion-tabs-inset")).toBe(153);
  expect(read("--sidebar-exposed-width")).toBe(0);
  const fullscreen = resolveWindowChromeGeometry({
    hasDesktopBridge: true,
    isMac: true,
    fullscreen: true,
    zoomFactor: 1,
  });
  update({ open: false, geometry: fullscreen });
  expect(read("--sidebar-motion-action-left")).toBe(42);
  expect(read("--sidebar-motion-tabs-inset")).toBe(89);
  presentation.dispose();
});

it("keeps action and tabs on the same interrupted presentation value", () => {
  const { presentation, update, read, frame, frames, dataset } = setupPresentation(false);
  update();
  update({ open: true, enabled: true });
  frame(30);
  const progress = read("--sidebar-motion-progress");
  expect(progress).toBeGreaterThan(0);
  expect(progress).toBeLessThan(1);
  expect(read("--sidebar-motion-tabs-inset")).toBeCloseTo(153 * (1 - progress));
  expect(read("--sidebar-motion-action-left")).toBeCloseTo(106 + 160 * progress);
  expect(dataset.sidebarMotion).toBe("true");
  update({ open: false, enabled: true });
  expect(read("--sidebar-motion-progress")).toBe(progress);
  const zoomed = resolveWindowChromeGeometry({
    hasDesktopBridge: true,
    isMac: true,
    fullscreen: false,
    zoomFactor: 2,
  });
  update({ open: false, enabled: true, geometry: zoomed });
  expect(read("--sidebar-motion-progress")).toBe(progress);
  expect(read("--sidebar-motion-tabs-inset")).toBeCloseTo(115 * (1 - progress));
  update({ open: false, enabled: false });
  expect(read("--sidebar-motion-progress")).toBe(0);
  expect(frames.size).toBe(0);
  presentation.dispose();
  expect(dataset.sidebarMotion).toBeUndefined();
});

it("settles an opening animation immediately when resizing and stops frames on disposal", () => {
  const { presentation, update, read, frame, frames } = setupPresentation(false);
  update({ open: true, enabled: true });
  frame(30);
  presentation.resize(220);
  expect(frames.size).toBe(0);
  expect(read("--sidebar-motion-progress")).toBe(1);
  expect(read("--sidebar-exposed-width")).toBe(220);
  expect(read("--sidebar-motion-action-left")).toBe(186);
  update({ open: false, enabled: true });
  expect(frames.size).toBe(1);
  presentation.dispose();
  expect(frames.size).toBe(0);
});
