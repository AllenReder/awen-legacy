import * as NodeAssert from "node:assert/strict";

const close = (actual, expected, label) =>
  NodeAssert.ok(
    Math.abs(actual - expected) <= 0.5,
    `${label}: expected ${expected}, received ${actual}`,
  );

export async function waitForSidebarEndpoint(page, open) {
  await page.waitForFunction((expanded) => {
    const wrapper = document.querySelector("[data-slot=sidebar-wrapper]");
    return (
      wrapper &&
      Number(getComputedStyle(wrapper).getPropertyValue("--sidebar-motion-progress")) ===
        (expanded ? 1 : 0)
    );
  }, open);
}

async function readChrome(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing chrome element: ${selector}`);
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const wrapper = document.querySelector("[data-slot=sidebar-wrapper]");
    return {
      trigger: rect("[data-testid=fixed-sidebar-trigger]"),
      action: rect("[data-sidebar-action-control] button"),
      togglePlaceholder: rect("[data-testid=sidebar-toggle-placeholder]"),
      actionPlaceholder: rect("[data-testid=sidebar-action-placeholder]"),
      sidebar: rect("[data-app-sidebar][data-slot=sidebar-container]"),
      spacer: rect("[data-slot=workbench-tabs-inset-spacer]"),
      separator: rect("[data-slot=workbench-titlebar-separator]"),
      width: parseFloat(getComputedStyle(wrapper).getPropertyValue("--sidebar-width")),
    };
  });
}

async function dragSidebar(page, targetWidth, checkDuringDrag) {
  const rail = page.locator("[data-app-sidebar] [data-slot=sidebar-rail]");
  const box = await rail.boundingBox();
  NodeAssert.ok(box, "Sidebar resize rail is missing");
  const before = await readChrome(page);
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 150);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + targetWidth - before.width, y, { steps: 5 });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  if (checkDuringDrag) {
    const geometry = await readChrome(page);
    await checkDuringDrag(geometry);
  }
  await page.mouse.up();
  await waitForSidebarEndpoint(page, true);
}

/** Real DOM checks shared by the browser suite and isolated Electron probe. */
export async function verifyWindowChrome(page, { nativeMac = false, zoomFactor = 1 } = {}) {
  const triggerLeft = nativeMac ? 76 / zoomFactor : 12;
  const collapsedActionLeft = triggerLeft + 30;
  const minimumWidth = triggerLeft + 64;
  const collapsedTabsInset = triggerLeft + 77;
  const toggle = page.getByTestId("fixed-sidebar-trigger");
  // Native metrics change before Chromium applies zoom and dispatches resize.
  await page.waitForFunction((left) => {
    const trigger = document.querySelector("[data-testid=fixed-sidebar-trigger]");
    return trigger && Math.abs(trigger.getBoundingClientRect().x - left) <= 0.5;
  }, triggerLeft);
  if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
  await waitForSidebarEndpoint(page, true);
  const expanded = await readChrome(page);
  close(expanded.trigger.x, triggerLeft, "Toggle left");
  close(expanded.trigger.width, 28, "Toggle width");
  close(expanded.trigger.height, 28, "Toggle height");
  close(expanded.togglePlaceholder.x, expanded.trigger.x, "Toggle placeholder alignment");
  close(expanded.actionPlaceholder.x, expanded.action.x, "Settings placeholder alignment");
  close(expanded.width - expanded.action.x - expanded.action.width, 6, "Expanded right gap");
  close(expanded.spacer.width, 0, "Expanded tabs inset");

  await toggle.click();
  await waitForSidebarEndpoint(page, false);
  const collapsed = await readChrome(page);
  close(collapsed.trigger.x, triggerLeft, "Collapsed toggle left");
  close(collapsed.action.x, collapsedActionLeft, "Collapsed settings left");
  close(
    collapsed.action.x - collapsed.trigger.x - collapsed.trigger.width,
    2,
    "Collapsed button gap",
  );
  close(collapsed.spacer.width, collapsedTabsInset, "Collapsed tabs inset");
  close(
    collapsed.separator.x - collapsed.action.x - collapsed.action.width,
    6,
    "Separator left gap",
  );
  close(
    collapsed.spacer.x + collapsed.spacer.width - collapsed.separator.x - collapsed.separator.width,
    12,
    "Separator right gap",
  );

  await toggle.click();
  await waitForSidebarEndpoint(page, true);
  await dragSidebar(page, 0, (rects) => {
    close(rects.width, minimumWidth, "Minimum Sidebar width");
    close(rects.width - rects.action.x - rects.action.width, 6, "Right gap during resize");
    close(rects.action.x - rects.trigger.x - rects.trigger.width, 2, "Button gap at minimum width");
  });
  await dragSidebar(page, expanded.width);
  await page.getByTestId("sidebar-settings-button").click();
  await page.getByTestId("sidebar-back-button").waitFor();
  const settings = await readChrome(page);
  close(settings.actionPlaceholder.x, settings.action.x, "Settings Back placeholder alignment");
  close(settings.trigger.x, triggerLeft, "Settings toggle left");
  await page.getByTestId("sidebar-back-button").click();
  await page.getByTestId("sidebar-settings-button").waitFor();
  console.log(`PASS chrome geometry: nativeMac=${nativeMac}, zoom=${zoomFactor}`);
}

export async function verifyMobileSidebar(page) {
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  const toggle = page.getByTestId("fixed-sidebar-trigger");
  await page.waitForFunction(
    () =>
      document
        .querySelector("[data-testid=fixed-sidebar-trigger]")
        ?.getAttribute("aria-pressed") === "false",
  );
  await toggle.click();
  await page
    .locator('[role="dialog"][data-mobile="true"][data-slot="sidebar"]')
    .waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page
    .locator('[role="dialog"][data-mobile="true"][data-slot="sidebar"]')
    .waitFor({ state: "hidden" });
  if (viewport) await page.setViewportSize(viewport);
  await waitForSidebarEndpoint(page, true);
  console.log("PASS mobile Sidebar Sheet open/close");
}
