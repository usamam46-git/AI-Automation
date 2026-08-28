/**
 * lib/node-output-shape.ts — what a node is EXPECTED to produce, with no run.
 *
 * This is what makes the node detail view useful on a workflow that has never
 * executed: the Output panel shows the declared shape, and the Input panel shows
 * the declared shape of whatever feeds this node. Every path here is the real
 * dotted state path, so it is draggable into a parameter exactly like a path
 * read off real run data.
 *
 * **This file MIRRORS `apps/api/src/graphs/node_handlers.py`.** Each shape below
 * is the handler's literal return value, and the two must change together. The
 * source of truth for every one of them:
 *
 * | node                    | writes to `node_outputs[<key>]`                                  |
 * |-------------------------|------------------------------------------------------------------|
 * | `agent`                 | `result.parsed` — the node's own `output_schema` properties       |
 * | `human_approval`        | the resume payload: `{decision, comment?}`                         |
 * | tool `http_request`     | `{status_code, body}` — headers are deliberately never echoed      |
 * | tool `erp_connector`    | `{posted, confirmation_id, action, payload}`                       |
 * | tool `knowledge_search` | `{query, hit_count, hits[]}`                                       |
 * | tool `notify`           | `{queued, notification_id, channel}` — never `delivered`           |
 * | `start` / `end`         | nothing — both handlers return `{}`                                |
 * | `condition`             | nothing — it never executes; it compiles into a routing function   |
 * | `subgraph`              | nothing — the handler raises `NodeNotImplementedError`             |
 *
 * `start` is the one node whose panel is not about `node_outputs` at all: what
 * downstream nodes read from it is `trigger_payload`, so its shape is derived
 * from the sample payload on the node and rooted at `trigger_payload`.
 */

import { describeValue, type PreviewNode } from "@/lib/data-preview";
import type { NodeType } from "@/lib/api";

export type OutputShape = {
  /** Empty when the node declares nothing — `note` then says why. */
  fields: PreviewNode[];
  /**
   * Set when there is nothing to show. Distinguishes "this node writes no state
   * at all" (permanent, structural) from "it will, once you configure it".
   */
  note: string | null;
  /** True when the node structurally never writes to state. */
  writesNothing: boolean;
};

/** The key a node's own sample/config lives under. Ignored by the backend. */
export const SAMPLE_PAYLOAD_KEY = "sample_payload";

const NOTHING = (note: string): OutputShape => ({ fields: [], note, writesNothing: true });

export type ShapeInput = {
  nodeKey: string;
  nodeType: NodeType;
  config: Record<string, unknown>;
  /** Registry tool types by id, so a `tool_id`-only node still gets a shape. */
  toolTypes?: ReadonlyMap<string, string>;
};

export function nodeOutputShape({ nodeKey, nodeType, config, toolTypes }: ShapeInput): OutputShape {
  const root = `node_outputs.${nodeKey}`;

  switch (nodeType) {
    case "start":
      return sampleTriggerShape(config);

    case "end":
      return NOTHING("The run completes here. An end node writes nothing to state.");

    case "condition":
      return NOTHING(
        "A condition node never executes — it compiles into a routing function on its incoming edge, so it writes nothing to state.",
      );

    case "subgraph":
      return NOTHING("Subgraph nodes are not executable yet, so nothing is written to state.");

    case "human_approval":
      return shapeOf({ decision: "approved", comment: null }, root);

    case "agent":
      return agentShape(config, root);

    case "tool":
      return toolShape(config, root, toolTypes);
  }
}

/**
 * The start node's panel describes `trigger_payload`, not `node_outputs.start_1`.
 *
 * `config.sample_payload` is a key the BACKEND IGNORES — node `config` is
 * free-form JSONB with no `extra="forbid"`, and `start_handler` returns `{}`
 * without reading it. It exists purely so the builder can show, and let you drag
 * from, the shape a run will actually deliver.
 */
function sampleTriggerShape(config: Record<string, unknown>): OutputShape {
  const sample = config[SAMPLE_PAYLOAD_KEY];
  if (sample === null || sample === undefined || typeof sample !== "object") {
    return {
      fields: [],
      note: "Add a sample trigger payload below to see the fields every downstream node can read.",
      writesNothing: false,
    };
  }
  return { fields: describeValue(sample, "trigger_payload"), note: null, writesNothing: false };
}

/**
 * An agent's output IS its `output_schema` — the LLM is called in strict mode,
 * so what comes back has exactly those properties. Derived from the schema
 * rather than from an example, because the schema is authoritative and already
 * on the node.
 */
function agentShape(config: Record<string, unknown>, root: string): OutputShape {
  const schema = config.output_schema;
  const properties =
    schema !== null && typeof schema === "object"
      ? (schema as Record<string, unknown>).properties
      : undefined;

  if (properties === null || properties === undefined || typeof properties !== "object") {
    return {
      fields: [],
      note: "Define this agent's output schema to see the fields it will produce.",
      writesNothing: false,
    };
  }

  const entries = Object.entries(properties as Record<string, unknown>);
  if (entries.length === 0) {
    return {
      fields: [],
      note: "This agent's output schema has no properties yet.",
      writesNothing: false,
    };
  }

  return {
    fields: entries.map(([name, property]) => ({
      key: name,
      path: `${root}.${name}`,
      kind: schemaKind(property),
      value: null,
      addressable: !name.includes("."),
      children: [],
    })),
    note: null,
    writesNothing: false,
  };
}

/**
 * A JSON Schema property's type, as a preview kind.
 *
 * Optionality is expressed as a nullable type (`["string", "null"]`) — strict
 * mode makes every declared property required, which is why `lib/output-schema.ts`
 * emits no `required` array. So the non-null member is the type to show.
 */
function schemaKind(property: unknown): PreviewNode["kind"] {
  if (property === null || typeof property !== "object") return "null";
  const declared = (property as Record<string, unknown>).type;
  const first = Array.isArray(declared)
    ? declared.find((entry) => entry !== "null")
    : declared;

  switch (first) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    case "object":
      return "object";
    default:
      return "null";
  }
}

/**
 * Tool output depends on the tool TYPE, resolved the way the backend resolves
 * it: inline `tool_type` first, then the registry row behind `tool_id`.
 * `_tool_config` reads `tool_type` before anything else, so a node carrying both
 * is an inline node with a dead `tool_id` — reading them in the other order here
 * would describe a call that never happens.
 */
function toolShape(
  config: Record<string, unknown>,
  root: string,
  toolTypes: ReadonlyMap<string, string> | undefined,
): OutputShape {
  const inline = typeof config.tool_type === "string" ? config.tool_type : null;
  const registryId = typeof config.tool_id === "string" ? config.tool_id : null;
  const toolType = inline ?? (registryId ? (toolTypes?.get(registryId) ?? null) : null);

  switch (toolType) {
    case "http_request":
      // `body` is whatever the endpoint returned — JSON when it parsed, the raw
      // text when it did not — so it is deliberately left unshaped here.
      return shapeOf({ status_code: 200, body: {} }, root);

    case "erp_connector":
      return shapeOf(
        { posted: true, confirmation_id: "MOCK-…", action: String(config.action ?? ""), payload: {} },
        root,
      );

    case "knowledge_search":
      return shapeOf(
        {
          query: "",
          hit_count: 0,
          hits: [{ document_id: "", document_name: "", chunk_index: 0, content: "", score: 0 }],
        },
        root,
      );

    case "notify":
      // Always `queued`, never `delivered`: delivery is asynchronous so that a
      // Slack outage cannot fail a run whose work is already signed off.
      return shapeOf({ queued: true, notification_id: "", channel: String(config.channel ?? "in_app") }, root);

    default:
      return {
        fields: [],
        note: registryId
          ? "Pick a tool that still exists to see what this step produces."
          : "Choose a tool type to see what this step produces.",
        writesNothing: false,
      };
  }
}

function shapeOf(example: Record<string, unknown>, root: string): OutputShape {
  return { fields: describeValue(example, root), note: null, writesNothing: false };
}

/**
 * The nodes whose output feeds this one.
 *
 * n8n's input panel shows the previous node's output, and that is what this
 * returns — except that **condition nodes are walked THROUGH, not shown**. A
 * condition never executes and writes nothing to state, so a node sitting behind
 * one would otherwise get an input panel that is permanently empty while the
 * data it actually reads sits one step further back.
 *
 * Forward references are excluded deliberately: a path to a node that has not
 * run yet resolves to null at run time and nothing anywhere reports it.
 */
export function inputSourcesFor(
  nodeKey: string,
  graph: {
    nodes: readonly { id: string; nodeType: NodeType }[];
    edges: readonly { source: string; target: string }[];
  },
): string[] {
  const typeOf = new Map(graph.nodes.map((node) => [node.id, node.nodeType]));
  const sources: string[] = [];
  const emitted = new Set<string>();
  // Bounded by the visited set, so a cyclic draft cannot spin here.
  const visited = new Set<string>([nodeKey]);
  const queue = [nodeKey];

  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    for (const edge of graph.edges) {
      if (edge.target !== current) continue;
      const source = edge.source;
      if (!typeOf.has(source) || visited.has(source)) continue;
      visited.add(source);

      if (typeOf.get(source) === "condition") {
        queue.push(source);
        continue;
      }
      if (!emitted.has(source)) {
        emitted.add(source);
        sources.push(source);
      }
    }
  }

  return sources;
}
