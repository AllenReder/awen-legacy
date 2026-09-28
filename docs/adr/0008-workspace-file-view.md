# Self-contained Workspace File View with safe save and dirty guards

View identity and reuse decisions are superseded by [ADR-0028](0028-pane-view-catalog.md) and #156/#168.

The File View is an integrated Workspace View that occupies a single Pane, combining directory tree navigation with active file preview and editing. Opening files from the tree switches the active file in-place within the Pane rather than creating new Panes. File mutations use explicit save with content-hash optimistic concurrency control, and unsaved changes are protected by modal confirmation guards on file switch and Pane close.

## Status

Accepted (C18 / #19).

## Context

Awen workspaces require file browsing, inspection, and editing without depending on an active Agent Session. In `awen`, file browsing was coupled to an active chat thread drawer (`ChatView`), which violated `ADR 0002`'s boundary rule that "File and Git presentation are Workspace Views". Furthermore, in a BSP/scrolling multi-pane workbench, opening every clicked file into a separate layout Pane would fragment and overwhelm the workbench. Additionally, previous file writing was a silent, debounced blind overwrite without optimistic concurrency checks, risking data loss when external processes (agents, git operations, or external editors) modified files on disk.

## Considered Options

- **Pane-per-file (Split per file)**: Every clicked file creates or splits a new Pane. Rejected because casual browsing quickly explodes the layout and disrupts the user's window structure.
- **Nested Tab strip inside File Pane**: The File Pane maintains its own internal tab strip of open files (like Monocode's `FilePaneTab`). Rejected because `ADR 0001` explicitly pruned nested layout tabs in favor of Awen's top-level global Tabs.
- **Self-contained File View with in-place switching**: One Pane houses the tree and current file. Tree clicks switch the displayed file in-place. Unsaved edits trigger a confirmation guard before switching or closing. Save uses explicit `Cmd+S` and server-side content-hash verification.

## Decision

Adopt the self-contained File View:

1. **ViewTarget**: Defined as `{ kind: "workspace", definitionId: "fileView", environmentId, workspaceId, initialPath?, revealLine? }`. One File View exists per Workspace per Tab.
2. **In-place switching**: Clicking a file in the integrated tree switches the active file in the same Pane.
3. **Sidebar entry**: Workspace context menu provides "Browse Files", opening or focusing the Workspace's File View.
4. **Safe save**: `ProjectReadFileResult` returns `contentHash`; `ProjectWriteFileInput` verifies `expectedContentHash`. Conflict triggers explicit diff/overwrite/reload options without losing drafts.
5. **Dirty guards**: Unsaved edits trigger modal confirmation on file switch and on Workbench Pane close.
6. **Editor lifecycle & comment isolation**: In the standalone Workspace File View, code review comment annotations and gutter line utilities are disabled because there is no attached chat session target (`composerDraftTarget`). The editor instance is bound strictly to file identity and isolated from debounced auto-save coordinators, with in-memory draft tracking that does not re-render or invalidate the editor's live DOM and caret.
