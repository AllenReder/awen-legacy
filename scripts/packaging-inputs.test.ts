import { describe, expect, it } from "vite-plus/test";

import {
  PACKAGING_INPUT_FILES,
  PACKAGING_INPUT_PREFIXES,
  anyPackagingInput,
  isPackagingInput,
} from "./packaging-inputs.ts";

describe("packaging inputs", () => {
  it.each([
    "apps/desktop/src/window/DesktopWindow.ts",
    "native/trackpad/build/x64/awen-trackpad.node",
    "scripts/stage-desktop-runtime.ts",
    "scripts/release/collect-macos.sh",
    ".github/workflows/build-installers.yml",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "./apps/desktop/src/main.ts",
    "  .github/workflows/ci.yml  ",
  ])("treats %j as a packaging input", (changedPath) => {
    expect(isPackagingInput(changedPath)).toBe(true);
  });

  it.each([
    "apps/web/src/main.tsx",
    "apps/web/src/components/ChatView.test.tsx",
    "apps/server/src/session/AwenSessionService.ts",
    "packages/contracts/src/orchestration.ts",
    "docs/agents/ci.md",
    "README.md",
    "apps/desktop-tooling/src/main.ts",
    "scripts-of-something/run.ts",
    "",
    "   ",
  ])("treats %j as ordinary code", (changedPath) => {
    expect(isPackagingInput(changedPath)).toBe(false);
  });

  it("flags a change set only when it contains a packaging input", () => {
    expect(anyPackagingInput(["apps/web/src/main.tsx", "docs/agents/ci.md"])).toBe(false);
    expect(anyPackagingInput(["apps/web/src/main.tsx", "pnpm-lock.yaml"])).toBe(true);
    expect(anyPackagingInput([])).toBe(false);
  });

  it("keeps the exported lists free of duplicates and trailing slashes on files", () => {
    expect(new Set(PACKAGING_INPUT_PREFIXES).size).toBe(PACKAGING_INPUT_PREFIXES.length);
    expect(new Set(PACKAGING_INPUT_FILES).size).toBe(PACKAGING_INPUT_FILES.length);
    for (const prefix of PACKAGING_INPUT_PREFIXES) {
      expect(prefix.endsWith("/"), prefix).toBe(true);
    }
    for (const file of PACKAGING_INPUT_FILES) {
      expect(file.endsWith("/"), file).toBe(false);
    }
  });
});
