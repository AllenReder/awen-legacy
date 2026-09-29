import type { EnvironmentAwenProject } from "@awen/client-runtime/state/models";
import { ChevronDownIcon, FolderOpenIcon, GitBranchIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { readLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { cn } from "../../lib/utils";
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

export interface AddWorkspaceDialogProps {
  readonly project: EnvironmentAwenProject | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onAssociate: (path: string) => Promise<void>;
}

export function AddWorkspaceDialog({
  project,
  open,
  onOpenChange,
  onAssociate,
}: AddWorkspaceDialogProps) {
  const [path, setPath] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const rootCwd =
    project?.workspaces.find((w) => w.role === "main")?.workspaceRoot ??
    project?.workspaces[0]?.workspaceRoot ??
    null;

  const refsQuery = useEnvironmentQuery(
    open && project && rootCwd
      ? vcsEnvironment.listRefs({
          environmentId: project.environmentId,
          input: { cwd: rootCwd, limit: 100 },
        })
      : null,
  );

  const existingWorktrees = useMemo(() => {
    if (!refsQuery.data?.refs) return [];
    const seen = new Set<string>();
    const list: Array<{ name: string; path: string; current: boolean }> = [];
    for (const r of refsQuery.data.refs) {
      if (r.worktreePath && !seen.has(r.worktreePath)) {
        seen.add(r.worktreePath);
        list.push({
          name: r.name,
          path: r.worktreePath,
          current: r.current,
        });
      }
    }
    return list;
  }, [refsQuery.data?.refs]);

  const associatedPaths = useMemo(
    () => new Set((project?.workspaces ?? []).map((w) => w.workspaceRoot)),
    [project?.workspaces],
  );

  useEffect(() => {
    if (!open) return;
    setPath("");
    setPending(false);
    setError(null);
    if (typeof window !== "undefined") {
      const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
      return () => window.cancelAnimationFrame(frame);
    }
  }, [open]);

  const handleBrowse = useCallback(async () => {
    const api = readLocalApi();
    if (!api) return;
    try {
      const selected = await api.dialogs.pickFolder();
      if (selected) {
        setPath(selected);
        setError(null);
      }
    } catch {
      // Ignore picker cancellation or failures
    }
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const trimmedPath = path.trim();
      if (!trimmedPath) {
        setError("Please enter or select a worktree path.");
        return;
      }
      setPending(true);
      setError(null);
      try {
        await onAssociate(trimmedPath);
        onOpenChange(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add workspace.");
      } finally {
        setPending(false);
      }
    },
    [onAssociate, onOpenChange, path],
  );

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogPopup className="max-w-lg" data-testid="add-workspace-dialog">
        <DialogHeader>
          <DialogTitle>Add Workspace</DialogTitle>
          <DialogDescription>
            Attach an existing Git worktree to{" "}
            <span className="font-medium text-foreground">{project?.title ?? "Project"}</span>.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="contents">
          <DialogPanel className="space-y-4">
            {existingWorktrees.length > 0 ? (
              <div className="space-y-1.5" data-testid="existing-worktrees-container">
                <Label className="text-xs font-medium text-foreground">
                  Existing Worktrees in Repository
                </Label>
                <div
                  className="max-h-36 overflow-y-auto rounded-md border border-border divide-y divide-border/60 bg-muted/20"
                  data-testid="existing-worktrees-list"
                >
                  {existingWorktrees.map((wt) => {
                    const isAlreadyAssociated = associatedPaths.has(wt.path);
                    const isSelected = path === wt.path;
                    return (
                      <button
                        key={wt.path}
                        type="button"
                        disabled={isAlreadyAssociated || pending}
                        onClick={() => {
                          setPath(wt.path);
                          if (error) setError(null);
                        }}
                        className={cn(
                          "w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors",
                          isAlreadyAssociated
                            ? "opacity-50 cursor-not-allowed bg-muted/40"
                            : isSelected
                              ? "bg-primary/10 text-primary font-medium"
                              : "hover:bg-muted/60 text-foreground cursor-pointer",
                        )}
                        data-testid={`existing-worktree-item-${wt.name}`}
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate font-mono text-[11px] font-medium">
                            {wt.name}
                          </span>
                          <span className="truncate text-muted-foreground text-[10px]">
                            {wt.path}
                          </span>
                        </div>
                        {isAlreadyAssociated ? (
                          <span className="shrink-0 text-[10px] text-muted-foreground/70">
                            Added
                          </span>
                        ) : isSelected ? (
                          <span className="shrink-0 text-[10px] text-primary font-medium">
                            Selected
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Click an existing worktree above to select it, or specify a custom path below.
                </p>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="add-workspace-path">Worktree Path</Label>
              <div className="flex gap-2">
                <Input
                  ref={inputRef}
                  id="add-workspace-path"
                  data-testid="add-workspace-path-input"
                  placeholder="/path/to/worktree"
                  value={path}
                  disabled={pending}
                  onChange={(e) => {
                    setPath(e.target.value);
                    if (error) setError(null);
                  }}
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={handleBrowse}
                  data-testid="add-workspace-browse-btn"
                >
                  <FolderOpenIcon className="size-4 mr-1.5" />
                  Browse…
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Path of an existing Git worktree checkout directory on your machine.
              </p>
            </div>

            {error ? (
              <p className="text-xs text-destructive font-medium" data-testid="add-workspace-error">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending || !path.trim()}
              data-testid="add-workspace-submit-btn"
            >
              {pending ? "Adding…" : "Add Workspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export interface NewWorkspaceDialogProps {
  readonly project: EnvironmentAwenProject | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreate: (input: {
    readonly newBranch?: string | undefined;
    readonly baseRef?: string | undefined;
    readonly path?: string | undefined;
  }) => Promise<void>;
}

export function NewWorkspaceDialog({
  project,
  open,
  onOpenChange,
  onCreate,
}: NewWorkspaceDialogProps) {
  const [newBranch, setNewBranch] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [path, setPath] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isBaseRefDropdownOpen, setIsBaseRefDropdownOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const baseRefContainerRef = useRef<HTMLDivElement>(null);

  const rootCwd =
    project?.workspaces.find((w) => w.role === "main")?.workspaceRoot ??
    project?.workspaces[0]?.workspaceRoot ??
    null;

  const refsQuery = useEnvironmentQuery(
    open && project && rootCwd
      ? vcsEnvironment.listRefs({
          environmentId: project.environmentId,
          input: { cwd: rootCwd, limit: 100 },
        })
      : null,
  );

  const availableRefs = useMemo(() => {
    const set = new Set<string>();
    set.add("HEAD");
    if (refsQuery.data?.refs) {
      for (const r of refsQuery.data.refs) {
        set.add(r.name);
      }
    }
    return Array.from(set);
  }, [refsQuery.data?.refs]);

  const filteredRefs = useMemo(() => {
    const q = baseRef.trim().toLowerCase();
    if (!q) return availableRefs;
    return availableRefs.filter((r) => r.toLowerCase().includes(q));
  }, [availableRefs, baseRef]);

  useEffect(() => {
    if (!open) return;
    setNewBranch("");
    setBaseRef("");
    setPath("");
    setPending(false);
    setError(null);
    setIsBaseRefDropdownOpen(false);
    setHighlightedIndex(0);
    if (typeof window !== "undefined") {
      const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
      return () => window.cancelAnimationFrame(frame);
    }
  }, [open]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const handleClickOutside = (event: MouseEvent) => {
      if (
        baseRefContainerRef.current &&
        !baseRefContainerRef.current.contains(event.target as Node)
      ) {
        setIsBaseRefDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleBaseRefKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!isBaseRefDropdownOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setIsBaseRefDropdownOpen(true);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((prev) => (prev + 1) % Math.max(1, filteredRefs.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex(
        (prev) => (prev - 1 + filteredRefs.length) % Math.max(1, filteredRefs.length),
      );
    } else if (event.key === "Enter") {
      if (filteredRefs.length > 0 && isBaseRefDropdownOpen) {
        event.preventDefault();
        const selected = filteredRefs[highlightedIndex] ?? filteredRefs[0];
        if (selected) {
          setBaseRef(selected);
          setIsBaseRefDropdownOpen(false);
        }
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setIsBaseRefDropdownOpen(false);
    }
  };

  const handleBrowse = useCallback(async () => {
    const api = readLocalApi();
    if (!api) return;
    try {
      const selected = await api.dialogs.pickFolder();
      if (selected) {
        setPath(selected);
      }
    } catch {
      // Ignore picker cancellation or failures
    }
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      setPending(true);
      setError(null);
      try {
        await onCreate({
          ...(newBranch.trim() ? { newBranch: newBranch.trim() } : {}),
          ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}),
          ...(path.trim() ? { path: path.trim() } : {}),
        });
        onOpenChange(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create workspace.");
      } finally {
        setPending(false);
      }
    },
    [baseRef, newBranch, onCreate, onOpenChange, path],
  );

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogPopup className="max-w-lg" data-testid="new-workspace-dialog">
        <DialogHeader>
          <DialogTitle>New Workspace</DialogTitle>
          <DialogDescription>
            Create a new Git worktree for{" "}
            <span className="font-medium text-foreground">{project?.title ?? "Project"}</span>.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="contents">
          <DialogPanel className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-workspace-branch">New Branch Name</Label>
              <Input
                ref={inputRef}
                id="new-workspace-branch"
                data-testid="new-workspace-branch-input"
                placeholder="e.g. feature-login (leave blank for detached HEAD)"
                value={newBranch}
                disabled={pending}
                onChange={(e) => setNewBranch(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Branch to create and check out. Leave blank to check out at a detached HEAD.
              </p>
            </div>

            <div className="space-y-1.5" ref={baseRefContainerRef}>
              <Label htmlFor="new-workspace-base-ref">Base Ref</Label>
              <div className="relative">
                <Input
                  id="new-workspace-base-ref"
                  data-testid="new-workspace-base-ref-input"
                  placeholder="HEAD"
                  value={baseRef}
                  disabled={pending}
                  onClick={() => setIsBaseRefDropdownOpen(true)}
                  onFocus={() => setIsBaseRefDropdownOpen(true)}
                  onChange={(e) => {
                    setBaseRef(e.target.value);
                    setIsBaseRefDropdownOpen(true);
                    setHighlightedIndex(0);
                  }}
                  onKeyDown={handleBaseRefKeyDown}
                  autoComplete="off"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label="Toggle refs dropdown"
                  onClick={() => setIsBaseRefDropdownOpen((prev) => !prev)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1 cursor-pointer"
                  data-testid="toggle-base-ref-dropdown-btn"
                >
                  <ChevronDownIcon className="size-3.5 opacity-60" />
                </button>

                {isBaseRefDropdownOpen && filteredRefs.length > 0 ? (
                  <div
                    className="absolute left-0 right-0 top-full z-50 mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
                    data-testid="new-workspace-base-ref-dropdown"
                  >
                    {filteredRefs.map((refItem, index) => {
                      const isHighlighted = index === highlightedIndex;
                      const isSelected = baseRef.trim() === refItem;
                      return (
                        <button
                          key={refItem}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setBaseRef(refItem);
                            setIsBaseRefDropdownOpen(false);
                          }}
                          onMouseEnter={() => setHighlightedIndex(index)}
                          className={cn(
                            "w-full flex items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none cursor-pointer transition-colors",
                            isHighlighted || isSelected
                              ? "bg-accent text-accent-foreground font-medium"
                              : "text-foreground hover:bg-accent/50",
                          )}
                          data-testid={`base-ref-option-${refItem}`}
                        >
                          <span className="flex items-center gap-1.5 min-w-0 flex-1 truncate">
                            <GitBranchIcon className="size-3 shrink-0 text-muted-foreground" />
                            <span className="truncate">{refItem}</span>
                          </span>
                          {refItem === "HEAD" ? (
                            <span className="text-[10px] text-muted-foreground/70 uppercase">
                              Default
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                Branch, tag, or commit the new worktree starts from (defaults to HEAD). Click to
                select from repository refs.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="new-workspace-path">Destination Path (Optional)</Label>
              <div className="flex gap-2">
                <Input
                  id="new-workspace-path"
                  data-testid="new-workspace-path-input"
                  placeholder="Default managed worktrees folder"
                  value={path}
                  disabled={pending}
                  onChange={(e) => setPath(e.target.value)}
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={handleBrowse}
                  data-testid="new-workspace-browse-btn"
                >
                  <FolderOpenIcon className="size-4 mr-1.5" />
                  Browse…
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Destination folder path. Leave blank for the managed worktrees directory.
              </p>
            </div>

            {error ? (
              <p className="text-xs text-destructive font-medium" data-testid="new-workspace-error">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending} data-testid="new-workspace-submit-btn">
              {pending ? "Creating…" : "Create Workspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
