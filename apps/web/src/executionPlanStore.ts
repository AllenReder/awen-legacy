import type { ScopedThreadRef, WorkspaceId } from "@awen/contracts";
import { scopedThreadKey } from "@awen/client-runtime/environment";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ExecutionPlan = {
  readonly kind: "create-worktree";
  readonly sourceWorkspaceId: WorkspaceId;
  readonly baseRef: string | null;
  readonly startFromOrigin: boolean;
  readonly branchName: string;
};

/** Editable next-send intent, separate from both committed assignment and composer content. */
export const useExecutionPlanStore = create<{
  plans: Record<string, ExecutionPlan>;
  set: (ref: ScopedThreadRef, plan: ExecutionPlan | null) => void;
}>()(
  persist(
    (set) => ({
      plans: {},
      set: (ref, plan) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          const plans = { ...state.plans };
          if (plan === null) delete plans[key];
          else plans[key] = plan;
          return { plans };
        }),
    }),
    { name: "awen-execution-plans", version: 1 },
  ),
);
