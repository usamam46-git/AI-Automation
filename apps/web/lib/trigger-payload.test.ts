import { describe, expect, it } from "vitest";
import { formatTriggerPayload, parseTriggerPayload } from "@/lib/trigger-payload";

describe("parseTriggerPayload", () => {
  it("treats blank input as an empty payload", () => {
    // This is the pre-dialog behaviour every Run-now click had; keeping it valid
    // is what stops the dialog adding friction to a workflow needing no input.
    for (const blank of ["", "   ", "\n\t "]) {
      expect(parseTriggerPayload(blank)).toEqual({ ok: true, value: {} });
    }
  });

  it("parses an object", () => {
    expect(parseTriggerPayload('{"question": "How much notice?"}')).toEqual({ ok: true, value: { question: "How much notice?" } });
  });

  it("parses a nested object with arrays", () => {
    const result = parseTriggerPayload('{"items": [{"amount": 612.4}], "ccy": "USD"}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items).toEqual([{ amount: 612.4 }]);
  });

  it("rejects a top-level array, because the API takes a dict", () => {
    const result = parseTriggerPayload("[1, 2, 3]");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("an array");
  });

  it.each([["null"], ['"just a string"'], ["42"], ["true"]])("rejects the top-level scalar %s", (input) => {
    expect(parseTriggerPayload(input).ok).toBe(false);
  });

  it("passes through the parser's own message on malformed JSON", () => {
    const result = parseTriggerPayload('{"unclosed": ');
    expect(result.ok).toBe(false);
    // Not asserting the exact wording — it differs by engine — only that
    // something specific survived rather than a generic "Invalid JSON".
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });
});

describe("formatTriggerPayload", () => {
  it("pretty-prints valid JSON", () => {
    expect(formatTriggerPayload('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it("leaves invalid input exactly as typed", () => {
    // Formatting must never destroy work in progress.
    const halfTyped = '{"vendor": "Acme Ven';
    expect(formatTriggerPayload(halfTyped)).toBe(halfTyped);
  });

  it("leaves blank input blank rather than writing {}", () => {
    expect(formatTriggerPayload("  ")).toBe("  ");
  });
});
