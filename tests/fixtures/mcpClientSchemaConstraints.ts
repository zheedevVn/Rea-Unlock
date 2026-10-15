import {
  schemaArrays,
  schemaChildren,
  schemaMaps,
} from "../../src/contracts/inputSchemaPresentation.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** VS Code Copilot requires truthy items even for Draft 2020-12 tuples. */
export const arrayItemSchemaError = (
  schema: unknown,
  path: string,
): string | undefined => {
  if (!isRecord(schema)) return undefined;
  if (schema.type === "array" && !schema.items)
    return `${path}: tool parameters array type must have items`;
  for (const [key, value] of Object.entries(schema)) {
    const children =
      schemaMaps.has(key) && isRecord(value)
        ? Object.entries(value).map(
            ([name, child]) => [`${key}.${name}`, child] as const,
          )
        : (schemaArrays.has(key) || schemaChildren.has(key)) &&
            Array.isArray(value)
          ? value.map(
              (child: unknown, index) => [`${key}.${index}`, child] as const,
            )
          : schemaChildren.has(key)
            ? [[key, value] as const]
            : [];
    for (const [suffix, child] of children) {
      const error = arrayItemSchemaError(child, `${path}.${suffix}`);
      if (error !== undefined) return error;
    }
  }
  return undefined;
};
