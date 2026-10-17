import { describe, expect, it } from "vitest";

import {
  parseAmStartOutput,
  parseWmDensityOutput,
  parseWindowFocusOutput,
} from "./AdbShellOutput.js";

describe("parseWindowFocusOutput", () => {
  it("separates missing declarations from explicit absence and retains source lines", () => {
    expect(parseWindowFocusOutput("no declarations\n")).toEqual({
      focusedWindow: null,
      focusedApp: null,
    });
    expect(
      parseWindowFocusOutput("  mCurrentFocus=null\nmFocusedApp=null\n"),
    ).toEqual({
      focusedWindow: { value: null, rawLine: "  mCurrentFocus=null" },
      focusedApp: { value: null, rawLine: "mFocusedApp=null" },
    });
  });

  it("does not reinterpret later declarations after the first explicitly absent one", () => {
    expect(
      parseWindowFocusOutput(
        "mCurrentFocus=null\nmCurrentFocus=Window{later}\nmFocusedApp=ActivityRecord{current}\n",
      ),
    ).toEqual({
      focusedWindow: { value: null, rawLine: "mCurrentFocus=null" },
      focusedApp: {
        value: "ActivityRecord{current}",
        rawLine: "mFocusedApp=ActivityRecord{current}",
      },
    });
  });
});

describe("parseWmDensityOutput", () => {
  it("reads labeled physical and override densities", () => {
    expect(
      parseWmDensityOutput("Physical density: 420\nOverride density: 480\n"),
    ).toEqual({ physical: 420, override: 480 });
    expect(parseWmDensityOutput("Physical density: 420\n")).toEqual({
      physical: 420,
      override: null,
    });
  });

  // Older builds print the physical density as a bare number
  // (zheedevVn/Rea-Unlock#3942); it must not be lost as an unread declaration.
  it("reads a bare numeric density as the physical density", () => {
    expect(parseWmDensityOutput("420\n")).toEqual({
      physical: 420,
      override: null,
    });
    expect(parseWmDensityOutput("420\r\n")).toEqual({
      physical: 420,
      override: null,
    });
  });

  it("prefers a labeled physical density over a bare number", () => {
    expect(parseWmDensityOutput("560\nPhysical density: 420\n")).toEqual({
      physical: 420,
      override: null,
    });
  });

  it("reports no density for unrecognized output", () => {
    expect(parseWmDensityOutput("")).toEqual({
      physical: null,
      override: null,
    });
    expect(parseWmDensityOutput("420dpi\n")).toEqual({
      physical: null,
      override: null,
    });
  });
});

const starting =
  "Starting: Intent { act=android.intent.action.MAIN cmp=com.example/.Main }";

describe("parseAmStartOutput", () => {
  it("recognizes a CRLF wait-timeout report", () => {
    expect(
      parseAmStartOutput(
        `${starting}\r\nStatus: timeout\r\nActivity: com.example/.Main\r\nComplete\r\n`,
      ),
    ).toMatchObject({
      status: "refused",
      activity: "com.example/.Main",
      reportedStatus: "timeout",
      reason: "am start reported status: timeout",
    });
  });

  it("treats every non-ok status as refusal, including a later status after ok", () => {
    expect(
      parseAmStartOutput(`${starting}\nStatus: ok\nStatus: timeout\n`),
    ).toMatchObject({
      status: "refused",
      reportedStatus: "timeout",
      reason: "am start reported status: timeout",
    });
    expect(
      parseAmStartOutput(`${starting}\nStatus: future-value\n`),
    ).toMatchObject({
      status: "refused",
      reportedStatus: "future-value",
    });
  });

  it("gives hard errors in either stream priority over status and attempt", () => {
    expect(
      parseAmStartOutput(
        `${starting}\nStatus: timeout\nActivity: com.example/.Main\n`,
        "Exception: Activity class does not exist\n",
      ),
    ).toEqual({
      status: "refused",
      startedActivity: "act=android.intent.action.MAIN cmp=com.example/.Main",
      activity: "com.example/.Main",
      reportedStatus: "timeout",
      reason: "Activity class does not exist",
    });
    expect(
      parseAmStartOutput(
        `${starting}\nStatus: ok\nError: Activity class does not exist\n`,
      ),
    ).toMatchObject({
      status: "refused",
      reason: "Activity class does not exist",
    });
  });

  it("keeps Starting-only output compatible and refuses no-attempt output", () => {
    expect(parseAmStartOutput(starting)).toMatchObject({
      status: "started",
      reportedStatus: null,
      activity: null,
    });
    expect(
      parseAmStartOutput("Status: ok\nWarning: Activity not started\n"),
    ).toMatchObject({
      status: "refused",
      startedActivity: null,
      reportedStatus: "ok",
    });
  });
});
