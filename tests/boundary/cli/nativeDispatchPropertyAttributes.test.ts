import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { machoWithPropertyAttributes } from "../../fixtures/objcPropertyMacho.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

describe.skipIf(process.platform !== "darwin")(
  "native dispatch property attributes",
  () => {
    cliTest.for([
      ["complete nonatomic", "Tq,N", "nonatomic", false, "complete"],
      ["complete default", 'T@"NSString",C', "atomic", false, "complete"],
      ["unfinished quote", 'T@"NSString', null, null, "partial"],
      ["unfinished quote after R", 'R,T@"NSString', null, true, "partial"],
    ] as const)(
      "reports established property flags only for $0 attributes",
      async ([, attributes, atomicity, readonly, facet], { cli }) => {
        const directory = await createTestTempDirectory("rea-objc-property-");
        const path = join(directory, "fixture.bin");
        await writeFile(path, machoWithPropertyAttributes(attributes));
        const output = await cli.run({
          arguments: ["inspect-native-dispatch-metadata", path, "--json"],
          environment: { REA_LOG_LEVEL: "silent" },
        });
        expect(output.exitCode).toBe(0);
        const property = {
          atomicity,
          is_readonly: readonly,
          attributes: expect.arrayContaining([
            { name: "T", value: expect.any(String) },
          ]),
        };
        expect(output.json).toMatchObject({
          normalized_result: {
            result: {
              objc_classes: [
                {
                  name: "Fixture",
                  properties: [
                    { name: "first", ...property },
                    { name: "second", ...property },
                  ],
                },
              ],
              coverage: expect.arrayContaining([
                expect.objectContaining({
                  facet: "objc_properties_categories",
                  status: facet,
                  reason:
                    facet === "partial"
                      ? expect.stringContaining(
                          "property_attributes_incomplete",
                        )
                      : null,
                }),
              ]),
            },
          },
        });
      },
    );
  },
);

describe.skipIf(process.platform !== "darwin")(
  "native dispatch property record isolation",
  () => {
    cliTest.for([
      [
        "an unmapped name pointer",
        { secondNameOffset: 0x2000 },
        "first",
        "0x100000518",
      ],
      ["an empty name", { firstName: "" }, "second", "0x100000508"],
    ] as const)(
      "retains the valid sibling of a property with $0",
      async ([, layout, kept, location], { cli }) => {
        const directory = await createTestTempDirectory("rea-objc-property-");
        const path = join(directory, "fixture.bin");
        await writeFile(path, machoWithPropertyAttributes("Tq,N", layout));
        const output = await cli.run({
          arguments: ["inspect-native-dispatch-metadata", path, "--json"],
          environment: { REA_LOG_LEVEL: "silent" },
        });
        expect(output.exitCode).toBe(0);
        expect(output.json).toMatchObject({
          normalized_result: {
            result: {
              objc_classes: [
                {
                  name: "Fixture",
                  properties: [{ name: kept, atomicity: "nonatomic" }],
                },
              ],
              coverage: expect.arrayContaining([
                expect.objectContaining({
                  facet: "objc_properties_categories",
                  status: "partial",
                  reason: expect.stringContaining(
                    `property_decode_failed at ${location}: Fixture: property`,
                  ),
                }),
              ]),
            },
          },
        });
      },
    );
  },
);
