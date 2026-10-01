import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  dismissContextMenu,
  getContextMenuRequest,
  isContextMenuOpen,
  resolveContextMenu,
  showContextMenuFallback,
  subscribeContextMenu,
} from "./contextMenuFallback";

afterEach(() => dismissContextMenu());
it("publishes the same menu tree and resolves the selected identifier", async () => {
  const items = [
    { id: "rename", label: "Rename" },
    {
      id: "group",
      label: "More",
      children: [{ id: "delete", label: "Delete", destructive: true }],
    },
  ];
  const changed = vi.fn();
  const unsubscribe = subscribeContextMenu(changed);
  const result = showContextMenuFallback(items, { x: 40, y: 50 });
  expect(isContextMenuOpen()).toBe(true);
  expect(getContextMenuRequest()).toMatchObject({ items, position: { x: 40, y: 50 } });
  resolveContextMenu(getContextMenuRequest()!.id, "delete");
  await expect(result).resolves.toBe("delete");
  expect(isContextMenuOpen()).toBe(false);
  expect(changed).toHaveBeenCalledTimes(2);
  unsubscribe();
});
it("replacing a menu cancels its promise and isolates stale callbacks", async () => {
  const first = showContextMenuFallback([{ id: "old", label: "Old" }]);
  const oldId = getContextMenuRequest()!.id;
  const second = showContextMenuFallback([{ id: "new", label: "New" }]);
  await expect(first).resolves.toBeNull();
  resolveContextMenu(oldId, "old");
  expect(getContextMenuRequest()!.items[0]!.id).toBe("new");
  dismissContextMenu();
  await expect(second).resolves.toBeNull();
});
it("dismissal is idempotent", async () => {
  const pending = showContextMenuFallback([{ id: "item", label: "Item" }]);
  dismissContextMenu();
  dismissContextMenu();
  await expect(pending).resolves.toBeNull();
  expect(getContextMenuRequest()).toBeNull();
});
