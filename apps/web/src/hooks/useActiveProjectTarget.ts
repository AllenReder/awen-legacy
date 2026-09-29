import { scopeThreadRef } from "@awen/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@awen/contracts";

import { useProjects } from "~/state/entities";

import { useHandleNewThread } from "./useHandleNewThread";
import { useSessionExecutionContext } from "../state/sessionContext";

export interface ActiveProjectTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly projectName: string;
  readonly threadRef: ScopedThreadRef;
}

/**
 * Resolves the project workspace behind the active thread (or draft) so
 * project-scoped surfaces like the file picker and content search know which
 * workspace to query and which thread's right panel opens their results.
 */
export function useActiveProjectTarget(): ActiveProjectTarget | null {
  const { activeDraftThread, activeThread } = useHandleNewThread();
  const projects = useProjects();
  const thread = activeThread ?? activeDraftThread;
  const threadId = activeThread?.id ?? activeDraftThread?.threadId;
  const threadRef = threadId && thread ? scopeThreadRef(thread.environmentId, threadId) : null;
  const context = useSessionExecutionContext(threadRef, thread);
  const project = thread
    ? projects.find(
        (candidate) =>
          candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
      )
    : null;
  const cwd = context.cwd;

  if (!thread || !threadId || !project || !cwd) return null;

  return {
    environmentId: project.environmentId,
    cwd,
    projectName: project.title,
    threadRef: threadRef!,
  };
}
