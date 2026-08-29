"use client";

import * as React from "react";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ConfigNote } from "@/components/workflow-builder/config-field";
import { EdgeConditionForm } from "@/components/workflow-builder/edge-condition-form";
import {
  branchLabel,
  describeRule,
  hasPredicate,
  orderConditionEdges,
  overlapRisk,
} from "@/lib/condition-rules";
import type { BuilderEdge } from "@/lib/graph-mapping";

/**
 * A condition node's routing rules, all in one place.
 *
 * Until now a condition node had NO parameters at all — the panel said "select
 * each edge leaving it", so understanding a branch meant clicking every
 * connector in turn and holding the comparison in your head. The rules live on
 * the edges (they compile into a routing function and never reach
 * `node_handlers.py`), but there is no reason the EDITOR has to be scattered the
 * way the storage is. This is n8n's Switch node, mapped onto the existing
 * per-edge model with no schema change.
 *
 * Branches are listed in **evaluation order** — `lib/condition-rules.ts` mirrors
 * the backend's `_ordered_condition_edges`. Routing is first-match-wins, so
 * showing them in any other order would actively mislead.
 */
export function ConditionRulesForm({
  nodeKey,
  edges,
  onChangeCondition,
}: {
  nodeKey: string;
  /** Every edge leaving this condition node, in graph order. */
  edges: BuilderEdge[];
  onChangeCondition: (edgeId: string, condition: Record<string, unknown> | null) => void;
}) {
  const ordered = React.useMemo(() => orderConditionEdges(edges), [edges]);

  if (ordered.length === 0) {
    return (
      <ConfigNote>
        This condition has no branches yet. Connect it to the steps it should choose between — each connection becomes
        a branch here. A condition node with no outgoing connection fails to compile.
      </ConfigNote>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] leading-snug text-muted-foreground">
        Branches are checked in this order and the <strong className="font-medium text-foreground">first match wins</strong>.
        A branch with no rule always matches, so it acts as the fallback and is always checked last.
      </p>

      {overlapRisk(ordered) ? <OrderWarning /> : null}

      {ordered.map((edge, index) => {
        const condition = edge.data?.condition ?? null;
        const predicated = hasPredicate(condition);
        const label = branchLabel(condition);

        return (
          <section key={edge.id} className="rounded-xl bg-surface-2 p-3">
            <header className="mb-2.5 flex min-w-0 items-center gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-popover text-[10px] font-medium tabular-nums">
                {index + 1}
              </span>
              <span className="flex min-w-0 items-center gap-1 font-mono text-[11px]">
                <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{edge.target}</span>
              </span>
              {label ? (
                <Badge variant="secondary" className="shrink-0">
                  {label}
                </Badge>
              ) : null}
              {!predicated ? (
                <Badge variant="outline" className="ml-auto shrink-0">
                  fallback
                </Badge>
              ) : (
                <span className="ml-auto shrink-0 truncate font-mono text-[10px] text-muted-foreground">
                  {describeRule(condition)}
                </span>
              )}
            </header>

            <EdgeConditionForm
              // Remount per branch: the value editor holds local draft text, and
              // a shared instance would carry one branch's half-typed JSON into
              // the next.
              key={edge.id}
              idPrefix={`${nodeKey}-${edge.target}`}
              condition={condition}
              sourceIsCondition
              onChange={(next) => onChangeCondition(edge.id, next)}
            />
          </section>
        );
      })}
    </div>
  );
}

/**
 * Two predicated branches on one condition node is the classic switch ladder
 * (`> 1000` then `> 100`) and it is NOT safe here — see `lib/condition-rules.ts`
 * for why the engine cannot order them. Nothing else in the product says so.
 */
function OrderWarning() {
  return (
    <div className="flex gap-1.5 rounded-xl bg-status-warn-soft p-2.5 text-[11px] leading-snug text-status-warn">
      <TriangleAlert className="mt-px size-3.5 shrink-0" />
      <span>
        More than one branch has a rule. The engine guarantees only that the fallback is checked last — the order of the
        rules relative to each other can change when the draft is saved. Make the rules mutually exclusive (for example
        <span className="font-mono"> ≥ 1000</span> and <span className="font-mono">&lt; 1000</span>) rather than relying
        on which is checked first.
      </span>
    </div>
  );
}
