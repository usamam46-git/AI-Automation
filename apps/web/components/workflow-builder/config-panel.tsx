"use client";

import * as React from "react";
import { CircleAlert, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { AgentConfigForm } from "@/components/workflow-builder/agent-config-form";
import { ConfigNote } from "@/components/workflow-builder/config-field";
import { EdgeConditionForm } from "@/components/workflow-builder/edge-condition-form";
import { SubgraphConfigForm } from "@/components/workflow-builder/subgraph-config-form";
import { ToolConfigForm } from "@/components/workflow-builder/tool-config-form";
import type { KnowledgeBase, Tool } from "@/lib/api";
import type { BuilderGraph } from "@/lib/graph-mapping";
import type { GraphIssue } from "@/lib/graph-validation";
import { NODE_CATALOG } from "@/lib/node-catalog";
import { cn } from "@/lib/utils";
import { useWorkflowBuilderStore } from "@/stores/workflow-builder-store";

export function ConfigPanel({
  graph,
  setGraph,
  issuesByNode,
  tools,
  knowledgeBases,
  readOnly = false,
}: {
  graph: BuilderGraph;
  setGraph: (updater: (graph: BuilderGraph) => BuilderGraph) => void;
  issuesByNode: Map<string, GraphIssue[]>;
  /** The workspace's registry tools, for the tool node's picker. Undefined while loading. */
  tools?: Tool[];
  /** The workspace's knowledge bases, for the retrieval picker. Undefined while loading. */
  knowledgeBases?: KnowledgeBase[];
  readOnly?: boolean;
}) {
  const selectedNodeKey = useWorkflowBuilderStore((state) => state.selectedNodeKey);
  const selectedEdgeId = useWorkflowBuilderStore((state) => state.selectedEdgeId);
  const panelOpen = useWorkflowBuilderStore((state) => state.panelOpen);
  const selectNode = useWorkflowBuilderStore((state) => state.selectNode);

  const node = selectedNodeKey ? graph.nodes.find((item) => item.id === selectedNodeKey) ?? null : null;
  const edge = selectedEdgeId ? graph.edges.find((item) => item.id === selectedEdgeId) ?? null : null;

  if (!panelOpen || (!node && !edge)) return null;

  function updateNodeConfig(nodeKey: string, config: Record<string, unknown>) {
    setGraph((current) => ({
      ...current,
      nodes: current.nodes.map((item) => (item.id === nodeKey ? { ...item, data: { ...item.data, config } } : item)),
    }));
  }

  function updateEdgeCondition(edgeId: string, condition: Record<string, unknown> | null) {
    setGraph((current) => ({
      ...current,
      edges: current.edges.map((item) => (item.id === edgeId ? { ...item, data: { ...item.data, condition } } : item)),
    }));
  }

  function deleteNode(nodeKey: string) {
    setGraph((current) => ({
      nodes: current.nodes.filter((item) => item.id !== nodeKey),
      edges: current.edges.filter((item) => item.source !== nodeKey && item.target !== nodeKey),
    }));
    selectNode(null);
  }

  const entry = node ? NODE_CATALOG[node.data.nodeType] : null;
  const Icon = entry?.icon;
  const issues = node ? issuesByNode.get(node.id) ?? [] : [];
  const sourceNode = edge ? graph.nodes.find((item) => item.id === edge.source) ?? null : null;

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-card">
      <header className="flex items-start gap-2 border-b border-border px-3 py-2.5">
        {entry && Icon ? (
          <span className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg", entry.accent)}>
            <Icon className="size-3.5" />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium leading-tight">{node ? node.id : "Edge"}</h3>
          <p className="truncate text-[11px] leading-tight text-muted-foreground">
            {node ? entry?.label : `${edge?.source} → ${edge?.target}`}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="Close panel"
          onClick={() => selectNode(null)}
        >
          <X className="size-4" />
        </Button>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-3">
          {issues.length > 0 ? (
            <div className="flex flex-col gap-1.5 rounded-xl border border-destructive/40 bg-destructive/5 p-2.5">
              {issues.map((issue) => (
                <p key={issue.rule} className="flex gap-1.5 text-[11px] leading-snug text-destructive">
                  <CircleAlert className="mt-px size-3.5 shrink-0" />
                  <span>{issue.message}</span>
                </p>
              ))}
            </div>
          ) : null}

          {node ? (
            <NodeConfig
              // Remount on selection change: the field editors hold local draft
              // rows, which must not carry over from the previously selected node.
              key={node.id}
              nodeType={node.data.nodeType}
              config={node.data.config ?? {}}
              tools={tools}
              knowledgeBases={knowledgeBases}
              onChange={(config) => updateNodeConfig(node.id, config)}
            />
          ) : edge ? (
            <EdgeConditionForm
              key={edge.id}
              condition={edge.data?.condition ?? null}
              sourceIsCondition={sourceNode?.data.nodeType === "condition"}
              onChange={(condition) => updateEdgeCondition(edge.id, condition)}
            />
          ) : null}
        </div>
      </ScrollArea>

      {node && !readOnly ? (
        <>
          <Separator />
          <div className="p-3">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-start text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => deleteNode(node.id)}
            >
              <Trash2 className="size-3.5" />
              Delete node
            </Button>
          </div>
        </>
      ) : null}
    </aside>
  );
}

function NodeConfig({
  nodeType,
  config,
  tools,
  knowledgeBases,
  onChange,
}: {
  nodeType: keyof typeof NODE_CATALOG;
  config: Record<string, unknown>;
  tools?: Tool[];
  knowledgeBases?: KnowledgeBase[];
  onChange: (next: Record<string, unknown>) => void;
}) {
  switch (nodeType) {
    case "agent":
      return <AgentConfigForm config={config} onChange={onChange} />;
    case "tool":
      return <ToolConfigForm config={config} onChange={onChange} tools={tools} knowledgeBases={knowledgeBases} />;
    case "subgraph":
      return <SubgraphConfigForm config={config} onChange={onChange} />;
    case "condition":
      return (
        <ConfigNote>
          A condition node has no settings of its own. Select each edge leaving it to set that branch&apos;s rule.
        </ConfigNote>
      );
    case "human_approval":
      return (
        <ConfigNote>
          Pauses the run and waits for an approve or reject decision. The approval request carries the outputs of every
          node that ran before it — there is nothing to configure.
        </ConfigNote>
      );
    default:
      return (
        <ConfigNote>
          {nodeType === "start"
            ? "The entry point. The trigger payload arrives here as trigger_payload."
            : "The run completes when it reaches this node."}
        </ConfigNote>
      );
  }
}
