import { expect, it } from "vitest";

import { snapshotEnvironment } from "./snapshotEnvironment.js";

it.each(["linux", "darwin"] as const)(
  "preserves case-sensitive %s variables in an immutable snapshot",
  (platform) => {
    const selected = { PATH: "/chosen/bin", Path: "/other/bin" };
    const snapshot = snapshotEnvironment(selected, platform);
    selected.PATH = "/later/bin";
    expect(snapshot).toEqual({ PATH: "/chosen/bin", Path: "/other/bin" });
    expect(Object.isFrozen(snapshot)).toBe(true);
  },
);

it("canonicalizes selected Windows variables without inheriting ambient values", () => {
  const snapshot = snapshotEnvironment(
    { Path: "C:\\selected", ComSpec: "C:\\selected\\cmd.exe" },
    "win32",
  );
  expect(snapshot).toEqual({
    PATH: "C:\\selected",
    COMSPEC: "C:\\selected\\cmd.exe",
  });
  expect(Object.isFrozen(snapshot)).toBe(true);
});

it("keeps the last caller value for Windows aliases, including undefined", () => {
  const snapshot = snapshotEnvironment(
    {
      PATH: "upper",
      path: "lower",
      COMSPEC: "upper-cmd",
      ComSpec: "mixed-cmd",
      TEMP: "ambient-temp",
      temp: undefined,
    },
    "win32",
  );

  expect(snapshot).toEqual({
    COMSPEC: "mixed-cmd",
    PATH: "lower",
    TEMP: undefined,
  });
  expect(Object.keys(snapshot)).toEqual(["COMSPEC", "PATH", "TEMP"]);
  expect(Object.isFrozen(snapshot)).toBe(true);
});
