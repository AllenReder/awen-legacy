import { beforeEach, expect, it } from "vite-plus/test";
import { scopeProjectRef, scopeThreadRef } from "@awen/client-runtime/environment";
import { AgentSessionId, EnvironmentId, ProjectId, ThreadId, WorkspaceId } from "@awen/contracts";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { getActiveTab } from "./workbenchState";
import { resetWorkbenchStore, useWorkbenchStore } from "./workbenchStore";

const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("thread-empty");
const target = {
  kind: "agentSession" as const,
  environmentId,
  agentSessionId: AgentSessionId.make(threadId),
};

beforeEach(() => {
  resetWorkbenchStore();
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState());
});

it("reopens an empty Agent Session with the same identity and unsent content", async () => {
  const store = useWorkbenchStore.getState();
  store.openTarget(target);
  const ref = scopeThreadRef(environmentId, threadId);
  const composer = useComposerDraftStore.getState();
  composer.setWorkspaceDraftThreadId(
    WorkspaceId.make("workspace"),
    scopeProjectRef(environmentId, ProjectId.make("project")),
    DraftId.make(threadId),
    { threadId },
  );
  composer.setPrompt(ref, "Finish the parser");
  composer.setDraftThreadContext(ref, {
    envMode: "worktree",
    branch: "main",
    startFromOrigin: true,
  });
  const firstPaneId = getActiveTab(useWorkbenchStore.getState()).focusedPaneId;

  await useWorkbenchStore.getState().requestClosePane(firstPaneId);
  useWorkbenchStore.getState().openTarget(target);

  const reopened = getActiveTab(useWorkbenchStore.getState());
  expect(reopened.panes.get(reopened.focusedPaneId)?.target).toEqual(target);
  expect(useComposerDraftStore.getState().getComposerDraft(ref)?.prompt).toBe("Finish the parser");
  expect(useComposerDraftStore.getState().getDraftSessionByRef(ref)).toMatchObject({
    envMode: "worktree",
    branch: "main",
    startFromOrigin: true,
  });
});

it("keeps several empty Agent Sessions independent", () => {
  const second = {
    ...target,
    agentSessionId: AgentSessionId.make("thread-empty-two"),
  };
  useWorkbenchStore.getState().openTarget(target);
  useWorkbenchStore.getState().openTarget(second);
  expect(
    useWorkbenchStore
      .getState()
      .tabs.flatMap((tab) => [...tab.panes.values()].map((view) => view.target)),
  ).toEqual([target, second]);
});
