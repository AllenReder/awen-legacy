import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@awen/client-runtime/environment";
import { squashAtomCommandFailure } from "@awen/client-runtime/state/runtime";
import {
  AgentSessionId,
  DEFAULT_SERVER_SETTINGS,
  workspaceIdForAwenProject,
  type ScopedProjectRef,
  type ThreadId,
} from "@awen/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { DraftId, type DraftThreadEnvMode, useComposerDraftStore } from "../composerDraftStore";
import { newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import { getProjectOrderKey } from "../logicalProject";
import { resolveProjectSettings } from "@awen/shared/projectSettings";
import { resolveDefaultThreadEnvMode } from "@awen/shared/threadEnvMode";
import { normalizeProjectPathForComparison } from "@awen/shared/path";
import {
  readProjects,
  readThreadShell,
  useAwenProjects,
  useProjects,
  useThread,
} from "../state/entities";
import { resolveNewDraftStartFromOrigin } from "../lib/chatThreadActions";
import { readAwenProjectFileDefaultThreadEnvMode } from "../lib/awenProjectFileDefaults";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { NO_PROVIDER_MODEL_SELECTION } from "../providerInstances";
import { useWorkbenchStore } from "../workbench/workbenchStore";

interface NewThreadWorkspaceOptions {
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
  startFromOrigin?: boolean;
  replace?: boolean;
}

/** Create an ordinary durable Session before opening its composer. */
export function useNewThreadHandler() {
  const environmentServerConfigs = useAtomValue(environmentServerConfigsAtom);
  const awenProjects = useAwenProjects();
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const router = useRouter();

  return useCallback(
    async (
      projectRef: ScopedProjectRef,
      options?: NewThreadWorkspaceOptions,
    ): Promise<{ draftId: DraftId; threadId: ThreadId } | null> => {
      const project = readProjects().find(
        (candidate) =>
          candidate.environmentId === projectRef.environmentId &&
          candidate.id === projectRef.projectId,
      );
      if (!project) return null;
      const awenProject = awenProjects.find(
        (candidate) =>
          candidate.environmentId === projectRef.environmentId &&
          candidate.workspaces.some(
            (workspace) => workspace.awenProjectId === projectRef.projectId,
          ),
      );
      const projectWorkspaces =
        awenProject?.workspaces.filter(
          (workspace) => workspace.awenProjectId === projectRef.projectId,
        ) ?? [];
      const selectedWorkspace = options?.worktreePath
        ? projectWorkspaces.find(
            (workspace) =>
              normalizeProjectPathForComparison(workspace.workspaceRoot) ===
              normalizeProjectPathForComparison(options.worktreePath!),
          )
        : null;
      const workspace = selectedWorkspace ??
        projectWorkspaces.find((candidate) => candidate.role === "main") ??
        projectWorkspaces[0] ?? {
          id: workspaceIdForAwenProject(projectRef.projectId),
          workspaceRoot: project.workspaceRoot,
          role: "main" as const,
        };

      const serverSettings =
        environmentServerConfigs.get(projectRef.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS;
      const projectSettings = resolveProjectSettings(serverSettings, project.id, project);
      const currentParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
      const currentRoute = resolveThreadRouteTarget(currentParams);
      const currentShell =
        currentRoute?.kind === "server" ? readThreadShell(currentRoute.threadRef) : null;
      const selectedModel =
        projectSettings.settings.defaultModelSelection ?? currentShell?.modelSelection ?? null;
      const modelSelection = selectedModel ?? NO_PROVIDER_MODEL_SELECTION;
      const runtimeMode = projectSettings.settings.defaultRuntimeMode;
      const interactionMode = currentShell?.interactionMode ?? "default";
      const projectEnvMode =
        projectSettings.sources.defaultThreadEnvMode === "project"
          ? projectSettings.settings.defaultThreadEnvMode
          : undefined;
      const envMode =
        options?.envMode ??
        (await resolveDefaultThreadEnvMode({
          projectSetting: projectEnvMode,
          projectFile:
            projectEnvMode == null
              ? await readAwenProjectFileDefaultThreadEnvMode(
                  project.environmentId,
                  project.workspaceRoot,
                )
              : null,
          globalDefault: projectSettings.settings.defaultThreadEnvMode,
        }));
      const threadId = newThreadId();
      // The composer store still holds pending send options, keyed by the same
      // durable Thread identity. It never owns a separate navigation target.
      const draftId = DraftId.make(threadId);
      const createdAt = new Date().toISOString();
      const store = useComposerDraftStore.getState();
      store.setWorkspaceDraftThreadId(workspace.id, projectRef, draftId, {
        threadId,
        createdAt,
        branch: options?.branch ?? null,
        worktreePath: options?.worktreePath ?? null,
        envMode,
        startFromOrigin:
          options?.startFromOrigin ??
          resolveNewDraftStartFromOrigin({
            envMode,
            newWorktreesStartFromOrigin: projectSettings.settings.newWorktreesStartFromOrigin,
          }),
        runtimeMode,
        interactionMode,
      });
      store.applyStickyState(draftId);
      if (selectedModel) {
        store.setModelSelection(draftId, selectedModel, { replaceOptions: true });
      }

      const result = await createThread({
        environmentId: projectRef.environmentId,
        input: {
          threadId,
          projectId: projectRef.projectId,
          title: "New Agent Session",
          modelSelection,
          runtimeMode,
          interactionMode,
          branch: options?.branch ?? null,
          worktreePath:
            options?.worktreePath !== undefined
              ? options.worktreePath
              : workspace.role === "main"
                ? null
                : workspace.workspaceRoot,
          createdAt,
        },
      });
      if (result._tag === "Failure") {
        store.clearDraftThread(draftId);
        throw squashAtomCommandFailure(result);
      }
      useWorkbenchStore.getState().openTarget({
        kind: "agentSession",
        environmentId: projectRef.environmentId,
        agentSessionId: AgentSessionId.make(threadId),
      });
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: projectRef.environmentId, threadId },
        replace: options?.replace ?? false,
      });
      return { draftId, threadId };
    },
    [awenProjects, createThread, environmentServerConfigs, router],
  );
}

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const activeThread = useThread(routeThreadRef);
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useProjects();
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
      getPreferenceIds: (project) => [
        getProjectOrderKey(project),
        legacyProjectCwdPreferenceKey(project.workspaceRoot),
      ],
    });
  }, [projectOrder, projects]);
  const handleNewThread = useNewThreadHandler();

  return {
    activeDraftThread,
    activeThread,
    defaultProjectRef: orderedProjects[0]
      ? scopeProjectRef(orderedProjects[0].environmentId, orderedProjects[0].id)
      : null,
    handleNewThread,
    routeDraftId,
    routeThreadRef,
  };
}
