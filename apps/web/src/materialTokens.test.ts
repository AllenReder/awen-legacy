// @effect-diagnostics nodeBuiltinImport:off - asserts the CSS token contract from source.
import * as NodeFSP from "node:fs/promises";

import { describe, expect, it } from "vite-plus/test";

const OPAQUE_SURFACE_TOKENS = {
  sidebar: "--material-opaque-sidebar",
  topbar: "--material-opaque-topbar",
  workbench: "--material-opaque-workbench",
  overlay: "--material-opaque-overlay",
} as const;

describe("opaque material tokens", () => {
  it("gives every material region a distinct solid surface", async () => {
    const css = await NodeFSP.readFile(new URL("./index.css", import.meta.url), "utf8");
    const tokenBlock = css.slice(
      css.indexOf("html.material-stage-opaque {"),
      css.indexOf("html.material-stage-opaque .material-surface-sidebar"),
    );

    const values = Object.values(OPAQUE_SURFACE_TOKENS).map((token) => {
      const match = tokenBlock.match(new RegExp(`${token}:\\s*([^;]+);`));
      expect(match, `${token} must be declared in the opaque material stage`).not.toBeNull();
      return match?.[1]?.replace(/\s+/g, " ").trim();
    });

    expect(new Set(values).size).toBe(Object.keys(OPAQUE_SURFACE_TOKENS).length);
    expect(tokenBlock).toMatch(/--material-opaque-stage:\s*color-mix\(/);
    expect(tokenBlock).toMatch(/--material-opaque-edge:\s*color-mix\(/);

    for (const [surface, token] of Object.entries(OPAQUE_SURFACE_TOKENS).filter(
      ([surface]) => surface !== "overlay",
    )) {
      expect(css).toMatch(
        new RegExp(
          `html\\.material-stage-opaque\\s+\\.material-surface-${surface}\\s*\\{[^}]*background:\\s*var\\(${token}\\)`,
          "s",
        ),
      );
    }

    expect(css).toMatch(
      /html\.material-stage-opaque,\s*html\.material-stage-opaque body,\s*html\.material-stage-opaque #root\s*\{[^}]*background:\s*var\(--material-opaque-stage/,
    );
  });
});
describe("shared overlay material", () => {
  it("blurs in-window content independently of native window translucency", async () => {
    const css = await NodeFSP.readFile(new URL("./index.css", import.meta.url), "utf8");
    const block = css.slice(
      css.indexOf(".material-surface-overlay {"),
      css.indexOf("/* Native compositor blur"),
    );
    expect(block).toMatch(/backdrop-filter:\s*blur\(var\(--glass-blur\)\)/);
    expect(block).toMatch(/var\(--overlay-film-opacity, 0.05\)/);
    const roles = css.slice(
      css.indexOf("/* Material roles derive"),
      css.indexOf("/* System accessibility"),
    );
    expect(roles.match(/--overlay-film-opacity:/g)).toHaveLength(1);
    expect(roles).toMatch(/--overlay-film-opacity:\s*var\(--material-overlay-opacity, 0\.05\)/);
    expect(css).not.toContain("--material-overlay-glass-opacity");
    expect(css).not.toMatch(/html\.material-stage-windows \.material-surface-overlay/);
    expect(css).not.toMatch(/html\.material-stage-opaque \.material-surface-overlay\s*\{/);
  });
});

describe("overlay compositing and motion decoupling", () => {
  it("removes double-blur backdrop-filter from modal backdrop scrim", async () => {
    const css = await NodeFSP.readFile(new URL("./index.css", import.meta.url), "utf8");
    const backdropMatch = css.match(/@utility\s+dialog-backdrop\s*\{([^}]+)\}/);
    expect(backdropMatch, "dialog-backdrop utility must exist").not.toBeNull();
    const backdropBody = backdropMatch![1]!;
    expect(backdropBody).not.toMatch(/backdrop-filter:\s*blur/);
    expect(backdropBody).not.toMatch(/-webkit-backdrop-filter:\s*blur/);
    expect(backdropBody).toMatch(/background:\s*rgb\(0\s+0\s+0\s*\/\s*40%\)/);
  });

  it("ensures dialog popup separates static glass frame from transform animation", async () => {
    const dialogStyles = await NodeFSP.readFile(
      new URL("./components/ui/dialog-styles.ts", import.meta.url),
      "utf8",
    );
    expect(
      dialogStyles,
      "popup frame must not combine material-surface-overlay with will-change-transform",
    ).not.toMatch(/material-surface-overlay[^;]+will-change-transform/s);

    const dialogTsx = await NodeFSP.readFile(
      new URL("./components/ui/dialog.tsx", import.meta.url),
      "utf8",
    );
    expect(
      dialogTsx,
      "dialog popup must render GlassBackdrop for frosted material and separate dialog-content for motion",
    ).toMatch(/data-slot="dialog-content"/);
  });

  it("ensures GlassBackdrop carries canonical material-surface-overlay without dead classes", async () => {
    const glassBackdropTsx = await NodeFSP.readFile(
      new URL("./components/ui/GlassBackdrop.tsx", import.meta.url),
      "utf8",
    );
    expect(glassBackdropTsx).toMatch(/material-surface-overlay/);
    expect(glassBackdropTsx).not.toMatch(/popover-backdrop/);
  });

  it("defines unified 5-tier selection tokens in root stylesheet", async () => {
    const css = await NodeFSP.readFile(new URL("./index.css", import.meta.url), "utf8");
    const selectionTokens = [
      "--selection-subtle",
      "--selection",
      "--selection-strong",
      "--selection-hover",
      "--selection-emphasis",
    ];
    for (const token of selectionTokens) {
      expect(css, `${token} must be defined in stylesheet`).toMatch(
        new RegExp(`${token}:\\s*color-mix\\(`),
      );
    }
    for (const token of selectionTokens) {
      const themeToken = `--color-${token.slice(2)}`;
      expect(css, `${themeToken} must be exported in @theme inline`).toMatch(
        new RegExp(`${themeToken}:\\s*var\\(${token}\\)`),
      );
    }
  });
});
