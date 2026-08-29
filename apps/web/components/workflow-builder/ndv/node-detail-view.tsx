"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, LoaderCircle, Play, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AgentConfigForm } from "@/components/workflow-builder/agent-config-form";
import { ConfigNote } from "@/components/workflow-builder/config-field";
import { SubgraphConfigForm } from "@/components/workflow-builder/subgraph-config-form";
import { ToolConfigForm } from "@/components/workflow-builder/tool-config-form";
import { ConditionRulesForm } from "@/components/workflow-builder/ndv/condition-rules-form";
import { DataPanel, type PanelData } from "@/components/workflow-builder/ndv/data-panel";
import {
  FieldSourcesProvider,
  flattenPathOptions,
  type FieldSources,
} from "@/components/workflow-builder/ndv/field-sources-context";
import { StartSampleForm } from "@/components/workflow-builder/ndv/start-sample-form";
import type { KnowledgeBase, NodeType, Tool } from "@/lib/api";
import type { BuilderGraph } from "@/lib/graph-mapping";
import type { GraphIssue } from "@/lib/graph-validation";
import { NODE_CATALOG } from "@/lib/node-catalog";
import { inputSourcesFor, nodeOutputShape } from "@/lib/node-output-shape";
import { renameNodeKey, validateNodeKey } from "@/lib/node-rename";
import { ancestorsOf } from "@/lib/state-path";
import { useRunOverlay } from "@/components/workflow-builder/run-overlay-context";
import { executionsApi, type NodeExecution } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useWorkflowBuilderStore } from "@/stores/workflow-builder-store";

/**
 * The node detail view — INPUT | PARAMETERS | OUTPUT, full screen.
 *
 * This replaces the 320px right-hand config column. The column could show what
 * a node's settings were; it could not show what data arrives, what leaves, or
 * where a `node_outputs.…` path comes from, and those are the three things
 * someone who does not write code actually needs.
 *
 * The parameter forms in the middle column are the EXISTING ones, unchanged.
 * They construct exactly the shapes `_agent_config` / `_tool_config` accept in
 * `apps/api/src/graphs/node_handlers.py`, and that contract is not something to
 * re-derive while moving a panel.
 */
export function NodeDetailView({
  graph,
  setGraph,
  issuesByNode,
  tools,
  knowledgeBases,
  onTestStep,
  testStepPending = false,
}: {
  graph: BuilderGraph;
  setGraph: (updater: (graph: BuilderGraph) => BuilderGraph) => void;
  issuesByNode: Map<string, GraphIssue[]>;
  tools?: Tool[];
  knowledgeBases?: KnowledgeBase[];
  /** Run the graph up to and including this node. */
  onTestStep?: (untilNodeKey: string) => void;
  testStepPending?: boolean;
}) {
  const detailNodeKey = useWorkflowBuilderStore((state) => state.detailNodeKey);
  const closeDetail = useWorkflowBuilderStore((state) => state.closeDetail);
  const openDetail = useWorkflowBuilderStore((state) => state.openDetail);
  const selectNode = useWorkflowBuilderStore((state) => state.selectNode);

  const node = detailNodeKey ? (graph.nodes.find((item) => item.id === detailNodeKey) ?? null) : null;
  const runData = useRunNodeOutputs();

  /**
   * Escape closes the view from anywhere.
   *
   * It used to be a `onKeyDown` on the dialog element, which only fires while
   * focus is inside it — so after clicking a button and moving the mouse away,
   * Escape did nothing and the modal felt stuck. Observed in a browser.
   * The node-key field still stops propagation on its own Escape, so the first
   * press there reverts the rename instead of discarding the panel.
   */
  React.useEffect(() => {
    if (!detailNodeKey) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDetail();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeDetail, detailNodeKey]);

  // Registry tool types, so a `tool_id`-only node still gets an output shape.
  const toolTypes = React.useMemo(
    () => (tools ? new Map(tools.map((tool) => [tool.id, tool.tool_type])) : undefined),
    [tools],
  );

  if (!node) return null;

  const entry = NODE_CATALOG[node.data.nodeType];
  const Icon = entry.icon;
  const config = node.data.config ?? {};
  const issues = issuesByNode.get(node.id) ?? [];

  function updateConfig(next: Record<string, unknown>) {
    setGraph((current) => ({
      ...current,
      nodes: current.nodes.map((item) =>
        item.id === node!.id ? { ...item, data: { ...item.data, config: next } } : item,
      ),
    }));
  }

  function updateEdgeCondition(edgeId: string, condition: Record<string, unknown> | null) {
    setGraph((current) => ({
      ...current,
      edges: current.edges.map((item) =>
        item.id === edgeId ? { ...item, data: { ...item.data, condition } } : item,
      ),
    }));
  }

  /** A rename rewrites edges and every `node_outputs.<key>` path — the detail
   *  view has to follow the node to its new key or it would close itself. */
  function renameNode(oldKey: string, newKey: string) {
    setGraph((current) => renameNodeKey(current, oldKey, newKey));
    openDetail(newKey);
  }

  function deleteNode() {
    setGraph((current) => ({
      nodes: current.nodes.filter((item) => item.id !== node!.id),
      edges: current.edges.filter((item) => item.source !== node!.id && item.target !== node!.id),
    }));
    closeDetail();
    selectNode(null);
  }

  const outgoing = graph.edges.filter((edge) => edge.source === node.id);
  const fieldSources = buildFieldSources(graph, node.id, toolTypes);
  const outputShape = nodeOutputShape({
    nodeKey: node.id,
    nodeType: node.data.nodeType,
    config,
    toolTypes,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6">
      {/* Dimmed, unlike the node picker's transparent backdrop: this IS a modal
          moment — it takes the whole screen and the canvas is not usable behind it. */}
      <div
        className="absolute inset-0 bg-foreground/20 backdrop-blur-[2px]"
        onClick={closeDetail}
        aria-hidden
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${node.id} settings`}
        className="relative flex h-full max-h-[52rem] w-full max-w-[86rem] flex-col overflow-hidden rounded-2xl bg-popover shadow-pop"
      >
        <header className="flex shrink-0 items-start gap-2.5 px-4 py-3">
          <span className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg", entry.accent)}>
            <Icon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <NodeKeyField
              key={node.id}
              nodeKey={node.id}
              existingKeys={graph.nodes.map((item) => item.id)}
              onRename={renameNode}
            />
            <p className="truncate px-1 text-[11px] leading-tight text-muted-foreground">{entry.description}</p>
          </div>
          {onTestStep ? (
            <Button
              size="sm"
              className="h-8 shrink-0"
              disabled={testStepPending}
              onClick={() => onTestStep(node!.id)}
            >
              {testStepPending ? <LoaderCircle className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              Test step
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={deleteNode}
          >
            <Trash2 className="size-3.5" />
            Delete
          </Button>
          <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label="Close" onClick={closeDetail}>
            <X className="size-4" />
          </Button>
        </header>

        <div className="h-px shrink-0 bg-border" />

        <div className="grid min-h-0 flex-1 grid-cols-1 divide-border md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,1fr)] md:divide-x">
          <InputColumn graph={graph} nodeKey={node.id} toolTypes={toolTypes} runData={runData} />

          <section className="flex min-h-0 min-w-0 flex-col">
            <header className="flex min-h-9 shrink-0 items-center px-3">
              <h3 className="app-eyebrow">Parameters</h3>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-1">
              {issues.length > 0 ? (
                <div className="mb-3 flex flex-col gap-1.5 rounded-xl bg-status-bad-soft p-2.5">
                  {issues.map((issue) => (
                    <p key={issue.rule} className="flex gap-1.5 text-[11px] leading-snug text-status-bad">
                      <CircleAlert className="mt-px size-3.5 shrink-0" />
                      <span>{issue.message}</span>
                    </p>
                  ))}
                </div>
              ) : null}

              <FieldSourcesProvider sources={fieldSources}>
                <NodeParameters
                  // Remount on node change: every row editor holds local draft
                  // state that must not carry over between nodes.
                  key={node.id}
                  nodeKey={node.id}
                  nodeType={node.data.nodeType}
                  config={config}
                  outgoing={outgoing}
                  tools={tools}
                  knowledgeBases={knowledgeBases}
                  onChangeConfig={updateConfig}
                  onChangeCondition={updateEdgeCondition}
                />
              </FieldSourcesProvider>
            </div>
          </section>

          <DataPanel
            title="Output"
            subtitle={runData.outputs.has(node.id) ? "from this run" : outputShape.writesNothing ? "writes no state" : "expected"}
            // Real data when this run produced some, the declared shape
            // otherwise. Real values beat a schema every time — they are what
            // someone came to check.
            data={outputData(node.id, runData, outputShape)}
            note={runData.outputs.has(node.id) ? null : outputShape.note}
            emptyLabel="This step produces nothing downstream steps can read."
          />
        </div>
      </div>
    </div>
  );
}

/**
 * This run's real per-node output, when a run is on screen.
 *
 * The overlay poll deliberately carries no input/output blobs (that is the
 * point of `GET /executions/{id}/status`), so the full rows are fetched
 * separately and only while the detail view is open. Keyed on the run's status
 * so it refetches as the run progresses and then settles.
 */
type RunNodeData = {
  outputs: Map<string, unknown>;
  resolvedInputs: Map<string, Record<string, unknown>>;
};

const EMPTY_RUN_DATA: RunNodeData = { outputs: new Map(), resolvedInputs: new Map() };

function useRunNodeOutputs(): RunNodeData {
  const overlay = useRunOverlay();

  const query = useQuery({
    queryKey: ["builder-run-detail", overlay?.runId ?? null, overlay?.status ?? null],
    queryFn: () => executionsApi.get(overlay!.runId),
    enabled: Boolean(overlay?.runId),
  });

  return React.useMemo(() => {
    if (!query.data) return EMPTY_RUN_DATA;

    const outputs = new Map<string, unknown>();
    const resolvedInputs = new Map<string, Record<string, unknown>>();

    // Append-only rows: a later attempt supersedes an earlier one.
    const byNode = new Map<string, NodeExecution>();
    for (const execution of query.data.node_executions) {
      const existing = byNode.get(execution.node_key);
      if (!existing || execution.attempt >= existing.attempt) byNode.set(execution.node_key, execution);
    }

    for (const [nodeKey, execution] of byNode) {
      // `output` is the handler's whole return value, whose `node_outputs`
      // channel carries the ACCUMULATED map for the entire run — index into it
      // rather than showing every node's state on every node's panel.
      const channel = execution.output?.node_outputs;
      if (channel && typeof channel === "object" && nodeKey in (channel as Record<string, unknown>)) {
        outputs.set(nodeKey, (channel as Record<string, unknown>)[nodeKey]);
      }
      if (execution.input) resolvedInputs.set(nodeKey, execution.input);
    }

    return { outputs, resolvedInputs };
  }, [query.data]);
}

function outputData(nodeKey: string, runData: RunNodeData, shape: ReturnType<typeof nodeOutputShape>): PanelData | null {
  if (runData.outputs.has(nodeKey)) {
    return { mode: "value", value: runData.outputs.get(nodeKey), rootPath: `node_outputs.${nodeKey}` };
  }
  return shape.fields.length > 0 ? { mode: "shape", fields: shape.fields } : null;
}

/**
 * Every path this node may legitimately read, for the picker and the checks.
 *
 * Two sources, and the second is easy to forget: the upstream steps' declared
 * outputs, AND `trigger_payload`, which every node can read at any depth. The
 * trigger's shape comes from the START node's sample payload, which is the only
 * description of it that exists anywhere — nothing else in the product knows
 * what a webhook will deliver.
 *
 * `ancestors` is what makes the forward-reference warning possible, and it is
 * computed over the real edges rather than assumed from left-to-right position.
 */
function buildFieldSources(
  graph: BuilderGraph,
  nodeKey: string,
  toolTypes: ReadonlyMap<string, string> | undefined,
): FieldSources {
  const ancestors = ancestorsOf(nodeKey, graph.edges);
  const options: FieldSources["options"] = [];

  for (const start of graph.nodes) {
    if (start.data.nodeType !== "start") continue;
    const shape = nodeOutputShape({
      nodeKey: start.id,
      nodeType: "start",
      config: start.data.config ?? {},
      toolTypes,
    });
    options.push(...flattenPathOptions(shape.fields, "trigger payload"));
  }

  for (const key of ancestors) {
    const source = graph.nodes.find((item) => item.id === key);
    if (!source || source.data.nodeType === "start") continue;
    const shape = nodeOutputShape({
      nodeKey: source.id,
      nodeType: source.data.nodeType,
      config: source.data.config ?? {},
      toolTypes,
    });
    options.push(...flattenPathOptions(shape.fields, source.id));
  }

  return {
    options,
    context: { nodeKeys: new Set(graph.nodes.map((item) => item.id)), ancestors },
  };
}

/**
 * The Input column: what the previous step hands this one.
 *
 * With several sources (branches converging) each gets its own panel rather than
 * being merged — they are separate `node_outputs.<key>` roots, and merging them
 * would invent a shape no path can address.
 */
function InputColumn({
  graph,
  nodeKey,
  toolTypes,
  runData,
}: {
  graph: BuilderGraph;
  nodeKey: string;
  toolTypes?: ReadonlyMap<string, string>;
  runData: RunNodeData;
}) {
  const sources = React.useMemo(
    () =>
      inputSourcesFor(nodeKey, {
        nodes: graph.nodes.map((node) => ({ id: node.id, nodeType: node.data.nodeType })),
        edges: graph.edges,
      }),
    [graph.edges, graph.nodes, nodeKey],
  );

  if (sources.length === 0) {
    return (
      <DataPanel
        title="Input"
        data={null}
        emptyLabel="Nothing feeds this step yet. Connect a step to its left, and what that step produces appears here."
      />
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-col divide-y divide-border overflow-y-auto">
      {sources.map((source) => {
        const node = graph.nodes.find((item) => item.id === source);
        if (!node) return null;
        const shape = nodeOutputShape({
          nodeKey: node.id,
          nodeType: node.data.nodeType,
          config: node.data.config ?? {},
          toolTypes,
        });
        const hasRun = runData.outputs.has(source);

        return (
          <div key={source} className="flex min-h-0 shrink-0 flex-col">
            <DataPanel
              title="Input"
              subtitle={hasRun ? `from ${source} · this run` : `from ${source}`}
              data={outputData(source, runData, shape)}
              note={hasRun ? null : shape.note}
              emptyLabel={`${source} produces nothing that can be referenced.`}
            />
          </div>
        );
      })}
    </div>
  );
}

function NodeParameters({
  nodeKey,
  nodeType,
  config,
  outgoing,
  tools,
  knowledgeBases,
  onChangeConfig,
  onChangeCondition,
}: {
  nodeKey: string;
  nodeType: NodeType;
  config: Record<string, unknown>;
  outgoing: BuilderGraph["edges"];
  tools?: Tool[];
  knowledgeBases?: KnowledgeBase[];
  onChangeConfig: (next: Record<string, unknown>) => void;
  onChangeCondition: (edgeId: string, condition: Record<string, unknown> | null) => void;
}) {
  switch (nodeType) {
    case "agent":
      return <AgentConfigForm config={config} onChange={onChangeConfig} />;

    case "tool":
      return (
        <ToolConfigForm config={config} onChange={onChangeConfig} tools={tools} knowledgeBases={knowledgeBases} />
      );

    case "subgraph":
      return <SubgraphConfigForm config={config} onChange={onChangeConfig} />;

    case "start":
      return <StartSampleForm config={config} onChange={onChangeConfig} />;

    case "condition":
      return <ConditionRulesForm nodeKey={nodeKey} edges={outgoing} onChangeCondition={onChangeCondition} />;

    case "human_approval":
      return (
        <ConfigNote>
          The run pauses here until someone approves or rejects. The approval request carries the outputs of every step
          that ran before it, so there is nothing to configure — and deliberately no message field: the sentence a
          reviewer sees is derived from the real values, never hand-written.
        </ConfigNote>
      );

    default:
      return <ConfigNote>The run completes when it reaches this step.</ConfigNote>;
  }
}

/**
 * The node key, edited in place. Committed on Enter or blur, never per
 * keystroke: each commit rewrites the whole graph, and a per-keystroke rename
 * would rewrite downstream state paths against half-typed keys. Escape reverts.
 */
function NodeKeyField({
  nodeKey,
  existingKeys,
  onRename,
}: {
  nodeKey: string;
  existingKeys: string[];
  onRename: (oldKey: string, newKey: string) => void;
}) {
  const [draft, setDraft] = React.useState(nodeKey);
  const [error, setError] = React.useState<string | null>(null);

  function commit() {
    const next = draft.trim();
    if (next === nodeKey) {
      setDraft(nodeKey);
      setError(null);
      return;
    }
    const problem = validateNodeKey(next, nodeKey, existingKeys);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    onRename(nodeKey, next);
  }

  return (
    <>
      <Input
        value={draft}
        aria-label="Node key"
        aria-invalid={error !== null}
        spellCheck={false}
        className="h-7 border-transparent bg-transparent px-1 font-mono text-sm font-medium shadow-none hover:border-input focus-visible:border-input"
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            // Stop the dialog's own Escape handler: the first press should undo
            // the edit, not throw away the whole panel.
            event.stopPropagation();
            event.preventDefault();
            setDraft(nodeKey);
            setError(null);
          }
        }}
      />
      {error ? <p className="px-1 text-[11px] leading-tight text-destructive">{error}</p> : null}
    </>
  );
}
