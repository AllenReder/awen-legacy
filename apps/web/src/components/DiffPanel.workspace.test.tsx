import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId, WorkspaceId } from "@awen/contracts";

const mockStatusQuery = {
  data: { isRepo: true, hasWorkingTreeChanges: true },
  isPending: false,
  error: null,
};

const mockDiffPreviewQuery = {
  data: {
    cwd: "/repos/ws-1",
    sources: [
      {
        id: "src-1",
        kind: "working-tree" as const,
        title: "Working tree",
        baseRef: null,
        headRef: "HEAD",
        diff: "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n",
        diffHash: "hash-1",
        truncated: false,
      },
    ],
  },
  isPending: false,
  error: null,
  refresh: vi.fn(),
};

vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

vi.mock("../hooks/useLocalStorage", () => ({
  useLocalStorage: (_key: string, initial: unknown) => [initial, vi.fn()],
}));

vi.mock("../hooks/useSettings", () => ({
  useClientSettings: () => ({
    diffLayout: "unified",
    wordWrap: false,
    diffIgnoreWhitespace: false,
    timestampFormat: "relative",
  }),
  useUpdateClientSettings: () => vi.fn(),
}));

vi.mock("../state/entities", () => ({
  useThread: () => null,
  useThreadShell: () => null,
  useProject: () => null,
  useAwenProjects: () => [],
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => null,
  useAtomRefresh: () => vi.fn(),
}));

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

vi.mock("../state/query", () => ({
  useEnvironmentQuery: (query: unknown) => {
    if (!query) return { data: null, isPending: false, error: null };
    const label = Array.isArray((query as any)?.label)
      ? (query as any).label[0]
      : (query as any)?.label;
    if (typeof label === "string" && label.includes("vcs:status")) {
      return mockStatusQuery;
    }
    return mockDiffPreviewQuery;
  },
}));

vi.mock("./diffs/AnnotatableCodeView", () => ({
  AnnotatableCodeView: (props: any) => (
    <div data-testid="annotatable-code-view" data-section-id={props.sectionId}>
      {props.files?.length} files
    </div>
  ),
}));

vi.mock("./ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => <div data-testid="dropdown-menu">{children}</div>,
  DropdownMenuTrigger: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: any) => <div onClick={onClick}>{children}</div>,
  DropdownMenuSub: ({ children }: any) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: any) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ render }: any) => render,
  TooltipPopup: ({ children }: any) => <div>{children}</div>,
}));

import DiffPanel from "./DiffPanel";

describe("DiffPanel in workspaceScope mode", () => {
  let renderer!: ReactTestRenderer;

  afterEach(async () => {
    await act(() => renderer?.unmount());
    vi.clearAllMocks();
  });

  it("renders working tree diff in workspaceScope mode without requiring an active thread", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    const workspaceScope = {
      environmentId: "local" as EnvironmentId,
      workspaceId: "ws-1" as WorkspaceId,
      cwd: "/repos/ws-1",
    };

    await act(() => {
      renderer = create(
        <DiffPanel
          mode="embedded"
          workspaceScope={workspaceScope}
          initialGitScope="unstaged"
          workspaceMutationId={null}
        />,
      );
    });

    const trigger = renderer.root.findByProps({ "aria-label": "Diff scope: Working tree" });
    expect(trigger).toBeDefined();

    const codeView = renderer.root.findByProps({ "data-testid": "annotatable-code-view" });
    expect(codeView).toBeDefined();
    expect(codeView.props["data-section-id"]).toBe("unstaged");
  });

  it("displays non-git repository message when workspace is not a git repo", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    mockStatusQuery.data.isRepo = false;

    const workspaceScope = {
      environmentId: "local" as EnvironmentId,
      workspaceId: "ws-non-git" as WorkspaceId,
      cwd: "/repos/non-git",
    };

    await act(() => {
      renderer = create(
        <DiffPanel
          mode="embedded"
          workspaceScope={workspaceScope}
          initialGitScope="unstaged"
          workspaceMutationId={null}
        />,
      );
    });

    expect(
      renderer.root.findByProps({
        children: "Diffs are unavailable because this workspace is not a git repository.",
      }),
    ).toBeDefined();

    mockStatusQuery.data.isRepo = true;
  });
});
