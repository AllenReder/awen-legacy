import { beforeEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId, WorkspaceId } from "@awen/contracts";
import { scopedThreadKey } from "@awen/client-runtime/environment";
import { useExecutionPlanStore } from "./executionPlanStore";

const ref = { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("session") };
const plan = {
  kind: "create-worktree" as const,
  sourceWorkspaceId: WorkspaceId.make("workspace"),
  baseRef: "main",
  startFromOrigin: false,
  branchName: "awen/retry",
};
beforeEach(() => useExecutionPlanStore.setState({ plans: {} }));
describe("next-send execution plan", () => {
  it("preserves the operation branch on base changes and removes the plan on current-checkout selection", () => {
    const store = useExecutionPlanStore.getState();
    store.set(ref, plan);
    store.set(ref, { ...plan, baseRef: "test" });
    expect(useExecutionPlanStore.getState().plans[scopedThreadKey(ref)]?.branchName).toBe(
      "awen/retry",
    );
    store.set(ref, null);
    expect(useExecutionPlanStore.getState().plans[scopedThreadKey(ref)]).toBeUndefined();
  });
  it("keeps identical Thread ids in different Environments independent", () => {
    const remote = { ...ref, environmentId: EnvironmentId.make("remote") };
    useExecutionPlanStore.getState().set(ref, plan);
    useExecutionPlanStore.getState().set(remote, { ...plan, baseRef: "remote-base" });
    useExecutionPlanStore.getState().set(ref, null);
    expect(useExecutionPlanStore.getState().plans[scopedThreadKey(remote)]?.baseRef).toBe(
      "remote-base",
    );
  });
});
