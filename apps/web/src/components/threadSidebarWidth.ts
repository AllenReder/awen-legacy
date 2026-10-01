export const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_DEFAULT_WIDTH = 16 * 16;
export const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

export function resolveThreadSidebarMaximumWidth(
  viewportWidth: number,
  minimumWidth: number,
): number {
  return Math.max(minimumWidth, Math.floor(viewportWidth) - THREAD_MAIN_CONTENT_MIN_WIDTH);
}

export function resolveInitialThreadSidebarWidth(
  storedWidth: number | null,
  viewportWidth: number,
  minimumWidth: number,
): number {
  const preferredWidth = Math.max(minimumWidth, storedWidth ?? THREAD_SIDEBAR_DEFAULT_WIDTH);
  return Math.min(preferredWidth, resolveThreadSidebarMaximumWidth(viewportWidth, minimumWidth));
}
