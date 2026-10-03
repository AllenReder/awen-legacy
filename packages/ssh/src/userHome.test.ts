import { assert, describe, it } from "@effect/vitest";

import { resolveUserHome } from "./userHome.ts";

const userInfoWithHome = (homedir: string) => () => ({ homedir });

describe("resolveUserHome", () => {
  it("prefers USERPROFILE on Windows", () => {
    assert.equal(
      resolveUserHome(
        "win32",
        { HOME: "C:\\stale-home", USERPROFILE: "C:\\Users\\Awen" },
        userInfoWithHome("C:\\Users\\Fallback"),
      ),
      "C:\\Users\\Awen",
    );
  });

  it("falls back to the OS user home on Windows without USERPROFILE", () => {
    assert.equal(
      resolveUserHome("win32", { HOME: "C:\\stale-home" }, userInfoWithHome("C:\\Users\\Awen")),
      "C:\\Users\\Awen",
    );
  });

  it("uses HOME on POSIX", () => {
    assert.equal(
      resolveUserHome("linux", { HOME: "/home/awen" }, userInfoWithHome("/home/fallback")),
      "/home/awen",
    );
  });

  it("falls back to the OS user home on POSIX without HOME", () => {
    assert.equal(resolveUserHome("darwin", {}, userInfoWithHome("/Users/Awen")), "/Users/Awen");
  });
});
