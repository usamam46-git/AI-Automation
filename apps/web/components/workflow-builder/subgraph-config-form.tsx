"use client";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ConfigNote, Field, FieldGroup } from "@/components/workflow-builder/config-field";

/**
 * `subgraph_handler` raises NodeNotImplementedError and reads no config at all.
 * The one field here is forward-looking, and the node is badged accordingly so
 * nobody publishes a graph expecting it to run.
 */
export function SubgraphConfigForm({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const workflowId = typeof config.workflow_id === "string" ? config.workflow_id : "";

  return (
    <FieldGroup title="Subgraph">
      <div>
        <Badge variant="archived">Not executable yet</Badge>
      </div>
      <ConfigNote>
        A run that reaches this node fails. The handler is still a stub — this reference is stored for when it lands.
      </ConfigNote>
      <Field label="Workflow ID" htmlFor="subgraph-workflow-id">
        <Input
          id="subgraph-workflow-id"
          value={workflowId}
          placeholder="00000000-0000-0000-0000-000000000000"
          onChange={(event) => onChange({ ...config, workflow_id: event.target.value })}
          className="h-8 font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  );
}
