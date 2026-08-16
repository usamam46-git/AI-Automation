"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EMBEDDING_MODELS, type EmbeddingModel, type KnowledgeBase, knowledgeApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Create / rename a knowledge base.
 *
 * **The embedding model is choosable at create and immutable afterwards**, and
 * the dialog says so rather than hiding the control on edit. The backend
 * enforces it (`KnowledgeBaseUpdate` sets `extra="forbid"`), and the reason is
 * worth surfacing: every stored chunk was embedded by that model, and comparing
 * a query embedded by a different one returns plausible cosine numbers with
 * meaningless rankings — no error anywhere. Switching means re-indexing the
 * whole corpus, which is a new KB, not a PATCH.
 */
const MODEL_COPY: Record<EmbeddingModel, { label: string; help: string }> = {
  "text-embedding-3-small": {
    label: "Small — fast and cheap",
    help: "$0.02 per million tokens. The right default while you are still adding and re-adding documents.",
  },
  "text-embedding-3-large": {
    label: "Large — highest quality",
    help: "$0.13 per million tokens. Retrieves better on subtle wording. Stored at the same 1536 dimensions, so it costs no extra space.",
  },
};

export function KnowledgeBaseDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: KnowledgeBase | null;
}) {
  const queryClient = useQueryClient();
  const orgId = useAuthStore((state) => state.orgId);
  const workspaceId = useAppStore((state) => state.currentWorkspaceId);

  const [name, setName] = React.useState("");
  const [model, setModel] = React.useState<EmbeddingModel>("text-embedding-3-small");

  // Reset the form when the dialog opens onto a different subject, using
  // React's sanctioned "adjust state during render" pattern rather than an
  // effect. An effect here fires a second render pass on every open and trips
  // react-hooks/set-state-in-effect; this settles before the browser paints.
  const formSubject = open ? (editing?.id ?? "new") : null;
  const [renderedSubject, setRenderedSubject] = React.useState<string | null>(null);
  if (formSubject !== renderedSubject) {
    setRenderedSubject(formSubject);
    setName(editing?.name ?? "");
    setModel((editing?.embedding_model as EmbeddingModel) ?? "text-embedding-3-small");
  }

  const mutation = useMutation({
    mutationFn: async () => {
      if (editing) return knowledgeApi.update(editing.id, { name: name.trim() });
      if (!workspaceId) throw new Error("Select a workspace first.");
      return knowledgeApi.create({ workspace_id: workspaceId, name: name.trim(), embedding_model: model });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["knowledge-bases", orgId] });
      toast.success(editing ? "Knowledge base renamed" : "Knowledge base created");
      onOpenChange(false);
    },
    onError: (error) =>
      toast.error(getApiErrorMessage(error, editing ? "Could not rename knowledge base" : "Could not create knowledge base")),
  });

  const canSubmit = name.trim().length > 0 && (Boolean(editing) || Boolean(workspaceId)) && !mutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Rename knowledge base" : "New knowledge base"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Only the name can change. The embedding model is fixed for the life of the corpus."
              : "A collection of documents your agents can search and cite."}
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) mutation.mutate();
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="kb-name">Name</Label>
            <Input
              id="kb-name"
              autoFocus
              value={name}
              maxLength={200}
              placeholder="Finance policies"
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          {editing ? (
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <p className="text-xs font-medium">Embedding model</p>
              <p className="mt-1 font-mono text-xs text-muted-foreground">{editing.embedding_model}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                Immutable. Changing it would invalidate every chunk already stored — create a new knowledge base instead.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="kb-model">Embedding model</Label>
              <Select value={model} onValueChange={(value) => setModel(value as EmbeddingModel)}>
                <SelectTrigger id="kb-model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EMBEDDING_MODELS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {MODEL_COPY[value].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{MODEL_COPY[model].help}</p>
              <p className="text-xs text-muted-foreground">This cannot be changed later.</p>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              {editing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
