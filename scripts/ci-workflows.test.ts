// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");
const WORKFLOW_DIRECTORY = NodePath.join(REPO_ROOT, ".github", "workflows");
const INSTALLER_WORKFLOW = "build-installers.yml";
const PINNED_ACTION = /# v?\d+\.\d+\.\d+/u;

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly env?: Record<string, string>;
}

interface WorkflowJob {
  readonly name?: string;
  readonly uses?: string;
  readonly env?: Record<string, string>;
  readonly steps?: readonly WorkflowStep[];
  readonly "timeout-minutes"?: number;
}

interface WorkflowDocument {
  readonly env?: Record<string, string>;
  readonly jobs?: Record<string, WorkflowJob>;
}

interface WorkflowFile {
  readonly name: string;
  readonly text: string;
  readonly document: WorkflowDocument;
}

function readWorkflows(): WorkflowFile[] {
  return NodeFS.readdirSync(WORKFLOW_DIRECTORY)
    .filter((file) => file.endsWith(".yml"))
    .sort()
    .map((file) => {
      const text = NodeFS.readFileSync(NodePath.join(WORKFLOW_DIRECTORY, file), "utf8");
      return { name: file, text, document: parse(text) as WorkflowDocument };
    });
}

function jobsOf(workflow: WorkflowFile): [string, WorkflowJob][] {
  return Object.entries(workflow.document.jobs ?? {});
}

function stepsOf(workflow: WorkflowFile): { job: string; step: WorkflowStep }[] {
  return jobsOf(workflow).flatMap(([job, definition]) =>
    (definition.steps ?? []).map((step) => ({ job, step })),
  );
}

const workflows = readWorkflows();

describe("workflow credentials", () => {
  // An empty `APPLE_*` variable at job level is what broke the alpha.3 release:
  // The signing tool saw the variable, tried to notarize an ad-hoc build, and failed.
  it("never puts an Apple variable at workflow or job level", () => {
    for (const workflow of workflows) {
      const workflowEnv = Object.keys(workflow.document.env ?? {});
      expect(
        workflowEnv.filter((key) => key.startsWith("APPLE_")),
        workflow.name,
      ).toEqual([]);
      for (const [job, definition] of jobsOf(workflow)) {
        const jobEnv = Object.keys(definition.env ?? {});
        expect(
          jobEnv.filter((key) => key.startsWith("APPLE_")),
          `${workflow.name}#${job}`,
        ).toEqual([]);
      }
    }
  });

  it("reads Apple secrets in the signing step only", () => {
    const referencing = workflows.flatMap((workflow) =>
      stepsOf(workflow)
        .filter(({ step }) =>
          Object.values(step.env ?? {}).some((value) => value.includes("secrets.APPLE_")),
        )
        .map(({ job, step }) => ({ workflow: workflow.name, job, name: step.name })),
    );
    expect(referencing).toEqual([
      { workflow: INSTALLER_WORKFLOW, job: "desktop-macos", name: "Configure macOS signing" },
    ]);
  });

  it("exports credentials only after the ad-hoc path has exited", () => {
    const signing = workflows
      .flatMap((workflow) => stepsOf(workflow))
      .find(({ step }) => step.name === "Configure macOS signing");
    const script = signing?.step.run ?? "";
    const adhocExit = script.indexOf("mode=adhoc");
    const firstExport = script.search(/echo "APPLE_[A-Z_]+=\$/u);
    expect(adhocExit).toBeGreaterThan(-1);
    expect(firstExport).toBeGreaterThan(adhocExit);
    expect(script).toContain('echo "mode=developer-id" >> "$GITHUB_OUTPUT"');
  });
});

describe("workflow structure", () => {
  it("keeps a timeout on every job that runs steps", () => {
    for (const workflow of workflows) {
      for (const [job, definition] of jobsOf(workflow)) {
        if (definition.uses !== undefined) continue;
        expect(definition["timeout-minutes"], `${workflow.name}#${job}`).toBeGreaterThan(0);
      }
    }
  });

  it("pins every action to a commit with its version beside it", () => {
    for (const workflow of workflows) {
      for (const line of workflow.text.split("\n")) {
        const match = /^\s*(?:- )?uses:\s*(\S+)\s*(#.*)?$/u.exec(line);
        if (match === null) continue;
        const reference = match[1] ?? "";
        if (reference.startsWith("./")) continue;
        expect(reference, `${workflow.name}: ${reference}`).toMatch(
          /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u,
        );
        expect(
          PINNED_ACTION.test(match[2] ?? ""),
          `${workflow.name}: ${reference} needs a # vX.Y.Z comment`,
        ).toBe(true);
      }
    }
  });

  it("builds the installers in one workflow that both callers share", () => {
    const installers = workflows.find((workflow) => workflow.name === INSTALLER_WORKFLOW);
    expect(installers, `${INSTALLER_WORKFLOW} is missing`).toBeDefined();
    expect(installers?.text).toContain("node scripts/stage-desktop-runtime.ts --platform");

    for (const workflow of workflows) {
      if (workflow.name === INSTALLER_WORKFLOW) continue;
      expect(workflow.text.includes("stage-desktop-runtime.ts"), workflow.name).toBe(false);
    }

    for (const caller of ["ci.yml", "release.yml"]) {
      const workflow = workflows.find((candidate) => candidate.name === caller);
      if (workflow === undefined) throw new Error(`${caller} is missing`);
      const calls = jobsOf(workflow).map(([, definition]) => definition.uses);
      expect(calls, caller).toContain(`./.github/workflows/${INSTALLER_WORKFLOW}`);
    }
  });
  it("requires native macOS runners and a final verified artifact before publishing", () => {
    const installers = workflows.find((workflow) => workflow.name === INSTALLER_WORKFLOW)!;
    expect(installers.text).toContain("runner: macos-15-intel");
    expect(installers.text).toContain("runner: macos-15");
    expect(installers.text).toContain("runs-on: windows-2025");
    expect(installers.text).toContain("assets.mjs assemble");
    const release = workflows.find((workflow) => workflow.name === "release.yml")!;
    expect(release.text).toContain("name: release-assets");
    expect(release.text).toContain("assets.mjs verify");
    expect(release.text).toContain("--draft=false");
    expect(release.text.indexOf("gh release upload")).toBeLessThan(
      release.text.indexOf("--draft=false"),
    );
    expect(release.text).not.toContain("pnpm install");
  });
  it("installs Linux native dependencies before desktop tests and rejects skipped checks", () => {
    const ci = workflows.find((workflow) => workflow.name === "ci.yml")!;
    const shell = ci.document.jobs?.["desktop-shell"]?.steps ?? [];
    expect(
      shell.findIndex((step) => step.name === "Install Linux desktop dependencies"),
    ).toBeLessThan(shell.findIndex((step) => step.name === "Test the desktop shell"));
    expect(ci.text).not.toContain("success|skipped");
  });
});
