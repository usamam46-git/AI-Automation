/**
 * lib/trigger-payload.ts — parse the JSON a user types into the Run dialog.
 *
 * `POST /workflows/{id}/run` has accepted a `trigger_payload` since the
 * executions module landed, and until now nothing in the UI ever sent one —
 * every "Run now" posted `{}`. That gap was found on day 1 of the 15-day plan
 * and it is not cosmetic: an agent node whose `input_fields` is
 * `["trigger_payload"]` gets an empty object, so a manually-triggered extraction
 * workflow has nothing to extract and the model fills the silence by inventing a
 * document. This module is the client half of closing it.
 *
 * Pure (no React, no network) so it stays vitest-covered.
 */

export type TriggerPayloadParse =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Turn the textarea's contents into a payload, or into a message to show.
 *
 * Three rules, each with a reason:
 *
 * - **Blank is valid and means `{}`.** That is exactly what every Run-now click
 *   sent before this dialog existed, so the zero-input path must stay
 *   frictionless — an HR-assistant style workflow with a static query needs no
 *   payload at all.
 * - **The top level must be an object.** `RunTriggerRequest.trigger_payload` is
 *   `dict | None`, so an array or a bare scalar is a 422 from FastAPI. Catching
 *   it here turns a confusing server error into a sentence next to the field.
 * - **Errors name the position.** `JSON.parse`'s own message already carries it
 *   and is more useful than anything paraphrased, so it is passed through
 *   rather than replaced with "Invalid JSON".
 */
export function parseTriggerPayload(raw: string): TriggerPayloadParse {
  const text = raw.trim();
  if (text === "") return { ok: true, value: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not parse this as JSON." };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const kind = Array.isArray(parsed) ? "an array" : parsed === null ? "null" : `a ${typeof parsed}`;
    return { ok: false, error: `The payload must be a JSON object — this is ${kind}. Wrap it, e.g. {"items": [...]}.` };
  }

  return { ok: true, value: parsed as Record<string, unknown> };
}

/** Pretty-print for the "format" affordance. Returns the input untouched if it
 *  does not parse, so the button can never destroy what someone is mid-way
 *  through typing. */
export function formatTriggerPayload(raw: string): string {
  const parsed = parseTriggerPayload(raw);
  if (!parsed.ok) return raw;
  if (raw.trim() === "") return raw;
  return JSON.stringify(parsed.value, null, 2);
}
