/**
 * Pure translation between an agent node's `output_schema` and the flat field
 * rows the visual builder edits. Kept out of the component so it can be tested
 * without a DOM.
 *
 * Emits ONLY `type` and `properties`. It must never emit `required` or
 * `additionalProperties`: `_normalize_strict_schema` in
 * apps/api/src/core/llm_client.py injects both deterministically, and OpenAI's
 * strict mode admits exactly one valid form.
 *
 * There is deliberately no "required" concept — strict mode makes every declared
 * property required, so optionality is a nullable type (`["string", "null"]`).
 */

export const SCALAR_TYPES = ["string", "number", "integer", "boolean"] as const;
export type ScalarType = (typeof SCALAR_TYPES)[number];

export type SchemaField = { id: number; name: string; type: ScalarType; nullable: boolean };

export type OutputSchema = { type: "object"; properties: Record<string, unknown> };

/** Returns null when the schema is richer than flat field rows can express. */
export function schemaToFields(schema: Record<string, unknown> | null | undefined): SchemaField[] | null {
  if (!schema || typeof schema !== "object") return [];
  const record = schema as Record<string, unknown>;
  if (record.$defs || record.anyOf || record.oneOf || record.allOf) return null;

  const properties = record.properties;
  if (properties === undefined) return [];
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return null;

  const fields: SchemaField[] = [];
  let id = 0;
  for (const [name, raw] of Object.entries(properties as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const property = raw as Record<string, unknown>;
    if (property.properties || property.items) return null;

    const type = property.type;
    if (typeof type === "string") {
      if (!SCALAR_TYPES.includes(type as ScalarType)) return null;
      fields.push({ id: id++, name, type: type as ScalarType, nullable: false });
      continue;
    }
    if (Array.isArray(type) && type.length === 2 && type.includes("null")) {
      const base = type.find((entry) => entry !== "null");
      if (typeof base !== "string" || !SCALAR_TYPES.includes(base as ScalarType)) return null;
      fields.push({ id: id++, name, type: base as ScalarType, nullable: true });
      continue;
    }
    return null;
  }
  return fields;
}

export function fieldsToSchema(fields: SchemaField[]): OutputSchema {
  const properties: Record<string, unknown> = {};
  for (const field of fields) {
    const name = field.name.trim();
    if (!name) continue;
    properties[name] = { type: field.nullable ? [field.type, "null"] : field.type };
  }
  return { type: "object", properties };
}
