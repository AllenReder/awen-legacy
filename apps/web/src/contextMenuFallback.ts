import type { ContextMenuItem } from "@awen/contracts";

export interface ContextMenuRequest {
  readonly id: number;
  readonly items: readonly ContextMenuItem[];
  readonly position: { x: number; y: number };
  readonly origin: HTMLElement | null;
  readonly resolve: (result: string | null) => void;
}
let request: ContextMenuRequest | null = null;
let nextId = 0;
const listeners = new Set<() => void>();
const publish = () => {
  for (const listener of listeners) listener();
};
export const getContextMenuRequest = () => request;
export const isContextMenuOpen = () => request !== null;
export function subscribeContextMenu(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function resolveContextMenu(id: number, result: string | null): void {
  if (request?.id !== id) return;
  const previous = request;
  request = null;
  previous.resolve(result);
  publish();
}
export function dismissContextMenu(): void {
  if (request) resolveContextMenu(request.id, null);
}

/** Compatibility interface; rendering and keyboard behavior belong to the shared Menu host. */
export function showContextMenuFallback<T extends string>(
  items: readonly ContextMenuItem<T>[],
  position?: { x: number; y: number },
): Promise<T | null> {
  dismissContextMenu();
  return new Promise<T | null>((resolve) => {
    request = {
      id: ++nextId,
      items,
      position: position ?? { x: 16, y: 16 },
      origin:
        typeof document !== "undefined" && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
      resolve: (result) => resolve(result as T | null),
    };
    publish();
  });
}
