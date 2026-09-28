import { useState, type FormEvent } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export function SidebarRenameDialog({
  kind,
  title,
  directoryName,
  onClose,
  onRename,
}: {
  readonly kind: "Project" | "Workspace" | "Agent Session" | "Terminal Session";
  readonly title: string;
  readonly directoryName?: string;
  readonly onClose: () => void;
  readonly onRename: (title: string) => Promise<void>;
}) {
  const [nextTitle, setNextTitle] = useState(title);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmedTitle = nextTitle.trim();

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedTitle || pending) return;
    if (trimmedTitle === title) {
      onClose();
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onRename(trimmedTitle);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Could not rename ${kind}.`);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !pending ? onClose() : undefined)}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Rename {kind}</DialogTitle>
          <DialogDescription>
            {directoryName === undefined
              ? "This changes the Session name in the Sidebar."
              : `This changes the name in the Sidebar. The folder on disk stays named “${directoryName}”.`}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <DialogPanel className="space-y-2">
            <Label htmlFor="sidebar-rename-title">Display name</Label>
            <Input
              id="sidebar-rename-title"
              data-testid="sidebar-rename-input"
              autoFocus
              value={nextTitle}
              disabled={pending}
              onChange={(event) => {
                setNextTitle(event.target.value);
                if (error !== null) setError(null);
              }}
            />
            {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmedTitle || pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
