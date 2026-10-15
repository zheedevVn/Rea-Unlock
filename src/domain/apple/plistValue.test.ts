import { expect, it } from "vitest";

import { projectPlistValue } from "./plistValue.js";

// Binary decoders build dates from seconds; beyond the Date range they are invalid.
it("projects an unrepresentable date as unknown and counts it", () => {
  expect(
    projectPlistValue({ far: new Date(Number.NaN), near: new Date(0) }),
  ).toEqual({
    value: {
      far: { $plist_type: "date", iso8601: null },
      near: { $plist_type: "date", iso8601: "1970-01-01T00:00:00.000Z" },
    },
    unknownRealCount: 0,
    unknownDateCount: 1,
  });
});

it("rejects excessive plist nesting without exhausting the stack", () => {
  const deep: unknown[] = [];
  let cursor = deep;
  for (let depth = 0; depth < 200; depth += 1) {
    const next: unknown[] = [];
    cursor.push(next);
    cursor = next;
  }
  expect(() => projectPlistValue(deep)).toThrow(RangeError);
});
