"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  BookText,
  Boxes,
  BrainCircuit,
  FileSignature,
  GitCommitVertical,
  Lock,
  MessagesSquare,
  Repeat,
  ScrollText,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import DisplayCards from "@/components/ui/display-cards";

/**
 * Agents — the one nav row that leads somewhere unbuilt.
 *
 * ## Why this page exists at all
 *
 * The sidebar carried a dead `Agents · Soon` row: a label with a badge and no
 * href. A disabled nav item is the worst of both worlds — it occupies the same
 * visual weight as a working destination, teaches the reader nothing, and the
 * only information it carries ("later") is the one thing they already assumed.
 * This page replaces it with the honest version: what an agent is in this
 * product *today*, where you actually build one, and what the `agents` module
 * will add when it lands.
 *
 * ## The rule this page follows
 *
 * **Nothing here is aspirational without saying so.** Every claim under "What
 * you can build today" links to a surface that exists and works; everything
 * under "Where this is going" is explicitly marked as not built, and carries
 * the real engineering reason rather than a roadmap quarter. The ReAct card in
 * particular states the actual blocker — an agent's own tool calls have no node
 * in the graph, so `validate_mutating_approval` structurally cannot see them —
 * because that constraint IS the product's argument, and softening it into
 * "coming soon" would sell the opposite of what this platform is for.
 *
 * ## Design notes
 *
 * `DisplayCards` is the 21st.dev-derived stack already vendored in
 * `components/ui/display-cards.tsx`, used the same way the Knowledge empty
 * state uses it: decorative, above the fold, never carrying data anyone has to
 * read precisely (it is skewed 8 degrees). No new dependency — the 21st.dev MCP
 * in `.mcp.json` has never been authenticated, so its components are adapted by
 * hand onto the locked oklch tokens, which is the same call this repo made when
 * it first dropped that MCP.
 */

/** Things an agent node can already do, each pointing at a surface that works. */
const TODAY = [
  {
    icon: BrainCircuit,
    title: "Reason over a payload",
    body: "An agent node reads whatever you map into it — the trigger payload, another node's output — and returns a typed object you define field by field. Structured output is mandatory, not optional: there is no free-text mode.",
    href: "/workflows",
    cta: "Open the builder",
  },
  {
    icon: BookText,
    title: "Answer from your own documents",
    body: "Put a knowledge_search tool in front of an agent and it answers from your corpus instead of its training data, citing the chunk it used. Cosine retrieval over pgvector, scoped to your organisation.",
    href: "/knowledge",
    cta: "Knowledge bases",
  },
  {
    icon: Wrench,
    title: "Call a reviewed tool",
    body: "Tools are registered once and referenced by nodes, so the endpoint, headers and write flag are set in one reviewed place. A node may wire per-use values, never re-point the target.",
    href: "/tools",
    cta: "Tool registry",
  },
  {
    icon: ShieldCheck,
    title: "Stop and ask a human",
    body: "Any step that writes to an external system must sit downstream of a human approval node, or the workflow refuses to publish. The reviewer sees a sentence derived from real upstream values, never an invented figure.",
    href: "/executions",
    cta: "Recent runs",
  },
];

/** Unbuilt work, each with the actual reason rather than a date. */
const NEXT = [
  {
    icon: Boxes,
    title: "Reusable agent definitions",
    status: "Schema exists, no service",
    body: "Today an agent node carries its model, prompt and output schema inline, so two nodes that should share a definition drift apart silently. The agents and agent_versions tables are already in the database; what is missing is the module that resolves an agent_id into the shape node handlers already accept — which is why the node config was written that way in the first place.",
  },
  {
    icon: Repeat,
    title: "Agents that choose their own tools",
    status: "Deliberately deferred",
    body: "The OpenAI function-call array is already built and tested. The loop is not, and the blocker is a design question rather than effort: tool calls an agent emits have no node in the graph, so the publish-time approval walk structurally cannot see them. Shipping it without a runtime refusal would hollow out the one guarantee this product makes.",
    accent: true,
  },
  {
    icon: MessagesSquare,
    title: "Conversational sessions",
    status: "Not started",
    body: "A chat surface where an agent holds context across turns, backed by the agent_memory table and its vector column. The retrieval half of that is live already; the session and memory-write half is not.",
  },
  {
    icon: GitCommitVertical,
    title: "Composition via subgraphs",
    status: "Palette only",
    body: "The subgraph node type is in the builder palette and raises if it is ever invoked. Calling one published workflow from another is the natural way to reuse an approved review chain, and it needs its own recursion and quota rules before it can be safe.",
  },
];

export default function AgentsPage() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-10 p-6">
      {/* Hero ---------------------------------------------------------- */}
      <Card className="flex flex-col items-center gap-8 overflow-hidden px-6 py-12">
        <div className="w-full max-w-lg pb-16 pt-2">
          <DisplayCards
            cards={[
              { icon: <ScrollText className="size-3.5" />, title: "Extract", description: "Payload into typed fields", meta: "Agent" },
              { icon: <FileSignature className="size-3.5" />, title: "Check policy", description: "Cites the rule it used", meta: "Retrieval" },
              { icon: <Lock className="size-3.5" />, title: "Ask a human", description: "Holds the write", meta: "Approval gate" },
            ]}
          />
        </div>

        <div className="flex max-w-xl flex-col items-center gap-3 text-center">
          <Badge variant="soon">Preview</Badge>
          <h2 className="text-xl font-medium tracking-tight">Agents are already running here — they just don&apos;t have a page yet</h2>
          <p className="text-sm text-muted-foreground">
            Every reasoning step in this product is an agent node inside a workflow, with a model, a prompt and a schema
            it must return. What this section will add is somewhere to define one <em>once</em> and reuse it, rather than
            configuring it per node. Until then, everything below is live and worth using.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
            <Button asChild size="sm"><Link href="/workflows">Build a workflow<ArrowRight className="size-4" /></Link></Button>
            <Button asChild size="sm" variant="outline"><Link href="/executions">Watch a run</Link></Button>
          </div>
        </div>
      </Card>

      {/* Today --------------------------------------------------------- */}
      <section className="space-y-4">
        <div>
          <h3 className="text-base font-medium tracking-tight">What you can build today</h3>
          <p className="text-sm text-muted-foreground">Each of these is a node type in the builder, working now.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {TODAY.map((item) => {
            const Icon = item.icon;
            return (
              <Card key={item.title} className="flex flex-col gap-3 p-4">
                <span className="inline-flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Icon className="size-4" />
                </span>
                <div className="space-y-1">
                  <p className="text-sm font-medium tracking-tight">{item.title}</p>
                  <p className="text-sm text-muted-foreground">{item.body}</p>
                </div>
                <Link
                  href={item.href}
                  className="mt-auto inline-flex items-center gap-1 text-sm font-medium text-foreground underline-offset-4 hover:underline"
                >
                  {item.cta}
                  <ArrowRight className="size-3.5" />
                </Link>
              </Card>
            );
          })}
        </div>
      </section>

      {/* Next ---------------------------------------------------------- */}
      <section className="space-y-4">
        <div>
          <h3 className="text-base font-medium tracking-tight">Where this is going</h3>
          <p className="text-sm text-muted-foreground">
            None of this is built. Each one carries the reason it isn&apos;t, because a roadmap without reasons is a wish list.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {NEXT.map((item) => {
            const Icon = item.icon;
            return (
              <Card key={item.title} className="flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <span className="inline-flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Icon className="size-4" />
                  </span>
                  <Badge variant="soon">{item.status}</Badge>
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium tracking-tight">{item.title}</p>
                  <p className="text-sm text-muted-foreground">{item.body}</p>
                </div>
                {item.accent ? (
                  <p className="mt-auto border-l-2 border-border pl-3 text-xs text-muted-foreground">
                    This is the one item on the list we are in no hurry to ship badly.
                  </p>
                ) : null}
              </Card>
            );
          })}
        </div>
      </section>
    </div>
  );
}
