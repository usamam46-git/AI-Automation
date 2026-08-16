"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { Search, SlidersHorizontal } from "lucide-react";
import AITextLoading from "@/components/ui/ai-text-loading";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type ChunkSearchResult, knowledgeApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api-client";
import { RETRIEVAL_CAPTIONS, formatScore, formatSearchCost } from "@/lib/knowledge";
import { cn } from "@/lib/utils";

/**
 * The retrieval playground — ask a question, see the ranked passages.
 *
 * The highest-value screen in this module, and the one the build plan marks
 * do-not-cut. It is the only place the abstraction becomes concrete: a user who
 * can see *which* passage scored 0.56 and which scored 0.11 understands what
 * their agent will be reasoning over, and can tell "the corpus does not cover
 * this" apart from "the chunking split the answer in half".
 *
 * Two deliberate choices:
 *
 * **The score floor defaults to 0 here, not to the backend's 0.3.** The
 * playground exists to calibrate that number, so it must show the passages the
 * floor would have discarded — otherwise you are tuning a threshold against
 * results it already filtered. The dividing line is drawn visually instead.
 *
 * **The cost of every query is displayed.** Each search is a billable embedding
 * call, and this is a screen people run dozens of queries on while tuning.
 */
const DEFAULT_TOP_K = 5;
const BACKEND_DEFAULT_FLOOR = 0.3;

export function RetrievalPlayground({ kbId, disabled }: { kbId: string; disabled?: boolean }) {
  const [query, setQuery] = React.useState("");
  const [topK, setTopK] = React.useState(DEFAULT_TOP_K);
  const [result, setResult] = React.useState<ChunkSearchResult | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const search = useMutation({
    mutationFn: () => knowledgeApi.search(kbId, { query: query.trim(), top_k: topK, score_floor: 0 }),
    onSuccess: (data) => {
      setResult(data);
      setErrorMessage(null);
    },
    onError: (error) => {
      setResult(null);
      setErrorMessage(getApiErrorMessage(error, "Search failed"));
    },
  });

  const canSearch = query.trim().length > 0 && !disabled && !search.isPending;

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Retrieval playground</h2>
          <p className="text-xs text-muted-foreground">
            Ask what an agent would ask. These are the passages it would reason over.
          </p>
        </div>

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8 shrink-0">
              <SlidersHorizontal className="size-4" />
              <span className="sr-only">Search settings</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64">
            <div className="flex flex-col gap-2">
              <Label htmlFor="top-k">Passages to retrieve</Label>
              <Input
                id="top-k"
                type="number"
                min={1}
                max={20}
                value={topK}
                onChange={(event) => setTopK(Math.max(1, Math.min(20, Number(event.target.value) || DEFAULT_TOP_K)))}
              />
              <p className="text-xs text-muted-foreground">
                Workflows use {DEFAULT_TOP_K} by default. Results below {Math.round(BACKEND_DEFAULT_FLOOR * 100)}% are
                shown here but would be dropped in a real run.
              </p>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSearch) search.mutate();
        }}
      >
        <Input
          value={query}
          disabled={disabled}
          placeholder={disabled ? "Index a document first" : "When does an invoice need approval?"}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit" disabled={!canSearch}>
          <Search className="size-4" />
          Search
        </Button>
      </form>

      {search.isPending ? <AITextLoading texts={RETRIEVAL_CAPTIONS} interval={1200} className="text-sm" /> : null}

      {errorMessage ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{errorMessage}</p>
      ) : null}

      {result && !search.isPending ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              {result.hit_count} {result.hit_count === 1 ? "passage" : "passages"}
            </span>
            <span aria-hidden>·</span>
            <span className="font-mono">{result.embedding_model}</span>
            <span aria-hidden>·</span>
            <span>
              {result.tokens} tokens · {formatSearchCost(result.cost_usd)}
            </span>
          </div>

          {result.hits.length === 0 ? (
            <p className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
              Nothing matched. An agent asking this would be told the knowledge base has no answer — which is the correct
              outcome when the corpus genuinely does not cover it.
            </p>
          ) : (
            result.hits.map((hit) => {
              const belowFloor = hit.score < BACKEND_DEFAULT_FLOOR;
              return (
                <div
                  key={`${hit.document_id}-${hit.chunk_index}`}
                  className={cn(
                    "rounded-lg border p-3 transition-opacity",
                    belowFloor ? "border-dashed border-border bg-muted/20 opacity-60" : "border-border bg-muted/40",
                  )}
                >
                  <div className="mb-1.5 flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-xs font-medium">
                      {hit.document_name}
                      <span className="ml-1.5 font-mono text-muted-foreground">#{hit.chunk_index}</span>
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {formatScore(hit.score)}
                      {belowFloor ? " · below cutoff" : ""}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{hit.content}</p>
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </Card>
  );
}
