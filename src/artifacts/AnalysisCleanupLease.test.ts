import { expect, it } from "vitest";

import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "./AnalysisCleanupLease.js";

it.each(["before release", "after release"])(
  "resolves its originating error bound %s without erasing the cause",
  async (binding) => {
    const cause = new Error("first close failed");
    const error = new ProviderCleanupError(
      "fixture",
      ["owned resource"],
      { reason: cause.message },
      { cause },
    );
    let releases = 0;
    const lease = new AnalysisCleanupLease(async () => {
      releases += 1;
    });
    if (binding === "before release") lease.bindCleanupError(error);
    await lease.release();
    if (binding === "after release") lease.bindCleanupError(error);
    expect(error.cleanupIncomplete).toBe(false);
    expect(error.cause).toBe(cause);
    await lease.release();
    expect(releases).toBe(1);
  },
);

it("retains uncertainty across a failed retry until the same lease releases", async () => {
  const cause = new Error("close still denied");
  const error = new ProviderCleanupError("fixture", ["owned resource"], {});
  let denied = true;
  const lease = new AnalysisCleanupLease(async () => {
    if (denied) throw cause;
  });
  lease.bindCleanupError(error);
  await expect(lease.release()).rejects.toBe(cause);
  expect(error.cleanupIncomplete).toBe(true);
  denied = false;
  await lease.release();
  expect(error.cleanupIncomplete).toBe(false);
});

it("resolves an aggregate only after every bound owner releases", async () => {
  const error = new ProviderCleanupError(
    "fixture",
    ["first resource", "second resource"],
    {},
  );
  const first = new AnalysisCleanupLease(
    async () => undefined,
    ["first resource"],
  );
  const second = new AnalysisCleanupLease(
    async () => undefined,
    ["second resource"],
  );
  new AnalysisCleanupLeaseGroup(error, [first, second]);

  await first.release();
  expect(error.cleanupIncomplete).toBe(true);
  expect(error.cleanupResources).toEqual(["second resource"]);
  await second.release();
  expect(error.cleanupIncomplete).toBe(false);
});

it("deduplicates owners and accounts for owners already released at binding time", async () => {
  const error = new ProviderCleanupError("fixture", ["owned resource"], {});
  const alreadyReleased = new AnalysisCleanupLease(async () => undefined);
  const pending = new AnalysisCleanupLease(async () => undefined);
  await alreadyReleased.release();

  new AnalysisCleanupLeaseGroup(error, [alreadyReleased, pending, pending]);
  expect(error.cleanupIncomplete).toBe(true);
  await pending.release();
  expect(error.cleanupIncomplete).toBe(false);
});

it("does not resolve a cleanup group without exact owners", () => {
  const error = new ProviderCleanupError("fixture", ["unknown owner"], {});
  new AnalysisCleanupLeaseGroup(error, []);
  expect(error.cleanupIncomplete).toBe(true);
});

it("resolves every live retry error bound to one lease", async () => {
  const firstCause = new Error("first admission retry failed");
  const secondCause = new Error("second admission retry failed");
  const firstError = new ProviderCleanupError(
    "fixture",
    ["owned resource"],
    {},
    { cause: firstCause },
  );
  const secondError = new ProviderCleanupError(
    "fixture",
    ["owned resource"],
    {},
    { cause: secondCause },
  );
  const lease = new AnalysisCleanupLease(async () => undefined);
  lease.bindCleanupError(firstError);
  lease.bindCleanupError(secondError);

  await lease.release();
  expect(firstError.cleanupIncomplete).toBe(false);
  expect(secondError.cleanupIncomplete).toBe(false);
  expect(firstError.cause).toBe(firstCause);
  expect(secondError.cause).toBe(secondCause);
});
