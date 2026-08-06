import { describe, expect, it } from "vitest";
import { fieldsToSchema, schemaToFields, type SchemaField } from "@/lib/output-schema";

function field(name: string, type: SchemaField["type"], nullable = false): SchemaField {
  return { id: 0, name, type, nullable };
}

describe("fieldsToSchema", () => {
  it("emits only type and properties", () => {
    const schema = fieldsToSchema([field("vendor", "string"), field("amount", "number")]);
    expect(Object.keys(schema).sort()).toEqual(["properties", "type"]);
    expect(schema).toEqual({
      type: "object",
      properties: { vendor: { type: "string" }, amount: { type: "number" } },
    });
  });

  it("never emits required or additionalProperties", () => {
    // _normalize_strict_schema injects both deterministically; emitting them
    // here would fight the server for no reason.
    const schema = fieldsToSchema([field("vendor", "string")]) as Record<string, unknown>;
    expect(schema.required).toBeUndefined();
    expect(schema.additionalProperties).toBeUndefined();
  });

  it("expresses optionality as a nullable type, not a required list", () => {
    const schema = fieldsToSchema([field("note", "string", true)]);
    expect(schema.properties.note).toEqual({ type: ["string", "null"] });
  });

  it("skips unnamed rows so a half-typed field is not emitted", () => {
    const schema = fieldsToSchema([field("vendor", "string"), field("  ", "number")]);
    expect(Object.keys(schema.properties)).toEqual(["vendor"]);
  });
});

describe("schemaToFields", () => {
  it("round-trips through fieldsToSchema", () => {
    const fields = [field("vendor", "string"), field("confidence", "number"), field("note", "string", true)];
    const parsed = schemaToFields(fieldsToSchema(fields));
    expect(parsed?.map(({ name, type, nullable }) => ({ name, type, nullable }))).toEqual(
      fields.map(({ name, type, nullable }) => ({ name, type, nullable })),
    );
  });

  it("returns an empty list for a blank schema", () => {
    expect(schemaToFields({ type: "object", properties: {} })).toEqual([]);
    expect(schemaToFields(null)).toEqual([]);
  });

  it("returns null for shapes the field builder cannot represent", () => {
    // Each of these must fall back to the raw JSON editor rather than be
    // silently flattened.
    expect(schemaToFields({ type: "object", properties: { nested: { type: "object", properties: { a: { type: "string" } } } } })).toBeNull();
    expect(schemaToFields({ type: "object", properties: { list: { type: "array", items: { type: "string" } } } })).toBeNull();
    expect(schemaToFields({ anyOf: [{ type: "object", properties: { a: { type: "string" } } }] })).toBeNull();
    expect(schemaToFields({ $defs: {}, type: "object", properties: {} })).toBeNull();
    expect(schemaToFields({ type: "object", properties: { weird: { type: ["string", "number"] } } })).toBeNull();
  });
});
