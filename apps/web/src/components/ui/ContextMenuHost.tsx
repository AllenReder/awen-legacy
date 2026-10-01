import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArchiveIcon,
  CircleCheckIcon,
  ClockIcon,
  Columns3Icon,
  CrosshairIcon,
  FolderInputIcon,
  GitCommitHorizontalIcon,
  GitPullRequestIcon,
  PlayIcon,
  RefreshCwIcon,
  Rows3Icon,
  SettingsIcon,
  UploadIcon,
  XCircleIcon,
  CopyIcon,
  FolderIcon,
  GitBranchIcon,
  HashIcon,
  MailOpenIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  QuoteIcon,
  SquareTerminalIcon,
  TrashIcon,
} from "lucide-react";
import type { ContextMenuItem } from "@awen/contracts";
import {
  dismissContextMenu,
  getContextMenuRequest,
  resolveContextMenu,
  subscribeContextMenu,
  type ContextMenuRequest,
} from "../../contextMenuFallback";
import {
  Menu,
  MenuGroupLabel,
  MenuItem,
  MenuCheckboxItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
} from "./menu";

const icons = {
  archive: ArchiveIcon,
  "circle-check": CircleCheckIcon,
  clock: ClockIcon,
  columns: Columns3Icon,
  crosshair: CrosshairIcon,
  "folder-input": FolderInputIcon,
  commit: GitCommitHorizontalIcon,
  pr: GitPullRequestIcon,
  "pull-request": GitPullRequestIcon,
  play: PlayIcon,
  "refresh-cw": RefreshCwIcon,
  rows: Rows3Icon,
  settings: SettingsIcon,
  push: UploadIcon,
  "x-circle": XCircleIcon,
  copy: CopyIcon,
  folder: FolderIcon,
  "git-branch": GitBranchIcon,
  hash: HashIcon,
  "mail-open": MailOpenIcon,
  "message-square-plus": MessageSquarePlusIcon,
  pencil: PencilIcon,
  pin: PinIcon,
  "pin-off": PinOffIcon,
  plus: PlusIcon,
  quote: QuoteIcon,
  terminal: SquareTerminalIcon,
  trash: TrashIcon,
};
function Entries({
  items,
  selectItem,
}: {
  items: readonly ContextMenuItem[];
  selectItem: (id: string) => void;
}) {
  return items.map((item, index) => {
    const Icon = item.icon ? icons[item.icon as keyof typeof icons] : undefined;
    const content = (
      <>
        {Icon && <Icon />}
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
      </>
    );
    const select = () => {
      if (!item.disabled) selectItem(item.id);
    };
    const variant = item.destructive || item.id === "delete" ? "destructive" : "default";
    const pointer = (event: React.PointerEvent) => {
      if (!item.disabled && event.button === 0) item.onPointerDown?.(event.nativeEvent);
    };
    let row;
    if (item.header) row = <MenuGroupLabel>{item.label}</MenuGroupLabel>;
    else if (item.children?.length)
      row = (
        <MenuSub>
          <MenuSubTrigger disabled={item.disabled}>{content}</MenuSubTrigger>
          <MenuPopup side="right" align="start">
            <Entries items={item.children} selectItem={selectItem} />
          </MenuPopup>
        </MenuSub>
      );
    else if (item.checked !== undefined)
      row = (
        <MenuCheckboxItem
          checked={item.checked}
          disabled={item.disabled}
          onCheckedChange={select}
          onPointerDown={pointer}
        >
          {content}
        </MenuCheckboxItem>
      );
    else
      row = (
        <MenuItem
          disabled={item.disabled}
          variant={variant}
          onClick={select}
          onPointerDown={pointer}
        >
          {content}
        </MenuItem>
      );
    return (
      <div key={item.id} className="contents">
        {item.separatorBefore && index > 0 && <MenuSeparator />}
        {row}
      </div>
    );
  });
}
function OpenContextMenu({ request }: { request: ContextMenuRequest }) {
  const { x, y } = request.position;
  const anchor = { getBoundingClientRect: () => new DOMRect(x, y, 0, 0) };
  const [open, setOpen] = useState(false);
  // Give Base UI a closed → open transition on each imperative request so the
  // popup receives its starting styles, just like a trigger-driven menu.
  useLayoutEffect(() => setOpen(true), []);
  const result = useRef<string | null>(null);
  const selectItem = (id: string) => {
    result.current = id;
    setOpen(false);
  };
  return (
    <Menu
      open={open}
      modal={false}
      onOpenChangeComplete={(opened) => {
        if (!opened) resolveContextMenu(request.id, result.current);
      }}
      onOpenChange={(open, details) => {
        if (!open && details.reason !== "trigger-hover") setOpen(false);
      }}
    >
      <MenuPopup
        anchor={anchor}
        align="start"
        side="bottom"
        sideOffset={0}
        data-context-menu=""
        data-context-menu-request={request.id}
        finalFocus={() => request.origin}
        className="max-w-sm"
      >
        <Entries items={request.items} selectItem={selectItem} />
      </MenuPopup>
    </Menu>
  );
}
/** One renderer host for every imperative application context menu. */
export function ContextMenuHost() {
  const request = useSyncExternalStore(subscribeContextMenu, getContextMenuRequest, () => null);
  useEffect(() => dismissContextMenu, []);
  return request ? <OpenContextMenu key={request.id} request={request} /> : null;
}
