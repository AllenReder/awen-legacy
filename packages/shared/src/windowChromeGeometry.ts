/** Application sizes are CSS pixels; macOS native positions are window points. */
export const WINDOW_CHROME = {
  titlebarHeight: 36,
  buttonSize: 28,
  sidebarEdgeWidth: 1,
  controlGap: 12,
  triggerLeft: 6,
  macTriggerLeftPoints: 76,
  buttonGap: 2,
  actionRightGap: 6,
  separatorLeftGap: 6,
  separatorWidth: 1,
  separatorRightGap: 12,
  macWindowButtonLeftPoints: 10,
  macWindowButtonRadiusPoints: 7,
} as const;

export interface WindowChromeEnvironment {
  readonly hasDesktopBridge: boolean;
  readonly isMac: boolean;
  readonly fullscreen: boolean;
  readonly zoomFactor: number;
}

/** Every returned size is in CSS pixels. */
export interface WindowChromeGeometry {
  readonly titlebarHeight: number;
  readonly buttonSize: number;
  readonly triggerLeft: number;
  readonly actionRightGap: number;
  readonly sidebarEdgeWidth: number;
  readonly collapsedActionLeft: number;
  readonly collapsedTabsInset: number;
  readonly minimumSidebarWidth: number;
  readonly separatorRightGap: number;
}

export function resolveWindowChromeGeometry(input: WindowChromeEnvironment): WindowChromeGeometry {
  const zoom = Number.isFinite(input.zoomFactor) && input.zoomFactor > 0 ? input.zoomFactor : 1;
  const triggerLeft =
    input.hasDesktopBridge && input.isMac && !input.fullscreen
      ? WINDOW_CHROME.macTriggerLeftPoints / zoom
      : WINDOW_CHROME.triggerLeft;
  const collapsedActionLeft = triggerLeft + WINDOW_CHROME.buttonSize + WINDOW_CHROME.buttonGap;
  return {
    titlebarHeight: WINDOW_CHROME.titlebarHeight,
    buttonSize: WINDOW_CHROME.buttonSize,
    triggerLeft,
    actionRightGap: WINDOW_CHROME.actionRightGap,
    sidebarEdgeWidth: WINDOW_CHROME.sidebarEdgeWidth,
    collapsedActionLeft,
    collapsedTabsInset:
      collapsedActionLeft +
      WINDOW_CHROME.buttonSize +
      WINDOW_CHROME.separatorLeftGap +
      WINDOW_CHROME.separatorWidth +
      WINDOW_CHROME.separatorRightGap,
    minimumSidebarWidth:
      collapsedActionLeft + WINDOW_CHROME.buttonSize + WINDOW_CHROME.actionRightGap,
    separatorRightGap: WINDOW_CHROME.separatorRightGap,
  };
}
