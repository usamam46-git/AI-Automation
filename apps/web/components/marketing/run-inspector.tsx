"use client";

import * as React from "react";
import { ArrowRight, Check, CircleAlert, Clock3, ShieldCheck, Webhook } from "lucide-react";

import type { InspectorView } from "@/lib/run-film";
import { AgentThinking } from "@/components/marketing/agent-thinking";
import { cn } from "@/lib/utils";

/** Shared caption above every inspector body. */
function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <p className="mk-eyebrow mb-4 text-mk-ink-soft">{children}</p>
  );
}

function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("font-[family-name:var(--font-jetbrains-mono)]", className)}>{children}</span>
  );
}

/**
 * The right-hand panel of the run film. One view per beat.
 *
 * Every view is laid out to roughly the same optical weight so the panel does
 * not jolt in height as the scrub advances — the parent also holds a min
 * height for the same reason. A panel that resizes under a pinned section
 * makes the whole film feel unstable.
 */
export function RunInspector({ inspector }: { inspector: InspectorView }) {
  switch (inspector.view) {
    case "payload":
      return (
        <div>
          <Kicker>Inbound trigger</Kicker>
          <div className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1">
            <ShieldCheck className="size-3 text-emerald-600" aria-hidden />
            <span className="text-[11px] font-semibold text-emerald-700">{inspector.signature}</span>
          </div>
          <div className="rounded-xl border border-[var(--mk-hairline)] bg-mk-mist/60 p-3.5">
            <div className="mb-2 flex items-center gap-1.5 text-mk-ink-soft">
              <Webhook className="size-3.5" aria-hidden />
              <Mono className="text-[10px]">POST /api/v1/triggers/workflows/…</Mono>
            </div>
            <dl className="flex flex-col gap-1.5">
              {Object.entries(inspector.body).map(([key, value]) => (
                <div key={key} className="flex items-baseline justify-between gap-4">
                  <dt>
                    <Mono className="text-[11px] text-mk-ink-soft">{key}</Mono>
                  </dt>
                  <dd className="min-w-0 truncate text-right">
                    <Mono className="text-[11px] text-mk-ink">{String(value)}</Mono>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      );

    case "thinking":
      return (
        <div>
          <Kicker>Agent node</Kicker>
          <AgentThinking model={inspector.model} lines={inspector.lines} />
        </div>
      );

    case "fields":
      return (
        <div>
          <Kicker>Structured output</Kicker>
          <ul className="flex flex-col gap-px overflow-hidden rounded-xl border border-[var(--mk-hairline)]">
            {inspector.fields.map((field) => (
              <li
                key={field.label}
                className="flex items-baseline justify-between gap-4 bg-white px-3.5 py-2.5"
              >
                <Mono className="text-[11px] text-mk-ink-soft">{field.label}</Mono>
                <span className="flex min-w-0 items-center gap-1.5">
                  <Mono className="truncate text-[12px] font-medium text-mk-ink">{field.value}</Mono>
                  {field.confident ? (
                    <Check className="size-3 shrink-0 text-emerald-600" aria-label="High confidence" />
                  ) : (
                    <CircleAlert className="size-3 shrink-0 text-amber-500" aria-label="Flagged for review" />
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] leading-relaxed text-mk-ink-soft">
            Fields the schema declared. Anything the model was unsure of is flagged rather than
            guessed.
          </p>
        </div>
      );

    case "route":
      return (
        <div>
          <Kicker>Condition</Kicker>
          <div className="rounded-xl border border-[var(--mk-hairline)] bg-mk-mist/60 p-3.5">
            <Mono className="text-[12px] text-mk-ink">{inspector.expression}</Mono>
          </div>
          <div className="mt-4 flex flex-col gap-2">
            <div className="flex items-center gap-2 rounded-xl border border-mk-sky/35 bg-mk-sky-mist px-3.5 py-2.5">
              <ArrowRight className="size-3.5 shrink-0 text-mk-sky-deep" aria-hidden />
              <Mono className="text-[12px] font-medium text-mk-sky-deep">{inspector.taken}</Mono>
              <span className="ml-auto text-[10px] font-semibold text-mk-sky-deep">taken</span>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-[var(--mk-hairline)] px-3.5 py-2.5 opacity-50">
              <ArrowRight className="size-3.5 shrink-0 text-mk-ink-soft" aria-hidden />
              <Mono className="text-[12px] text-mk-ink-soft">{inspector.other}</Mono>
            </div>
          </div>
        </div>
      );

    case "approval":
      return (
        <div>
          <Kicker>Human approval</Kicker>
          <div className="rounded-2xl border-2 border-amber-300 bg-amber-50/70 p-4">
            <div className="mb-3 flex items-center gap-1.5">
              <Clock3 className="size-3.5 text-amber-600" aria-hidden />
              <span className="text-[10px] font-semibold tracking-wide text-amber-700 uppercase">
                Run paused
              </span>
            </div>
            <p className="text-[1.0625rem] leading-snug font-semibold tracking-tight text-mk-ink">
              Post {inspector.amount} to {inspector.vendor}?
            </p>
            <p className="mt-1.5 text-[11px] text-mk-ink-soft">
              Evidence from <Mono className="text-[10px]">{inspector.requester}</Mono>
            </p>
            <div className="mt-4 flex gap-2">
              <span className="flex-1 rounded-lg bg-mk-ink py-2 text-center text-[12px] font-semibold text-white">
                Approve
              </span>
              <span className="rounded-lg border border-[var(--mk-hairline)] bg-white px-4 py-2 text-[12px] font-medium text-mk-ink-soft">
                Reject
              </span>
            </div>
          </div>
        </div>
      );

    case "receipt":
      return (
        <div>
          <Kicker>Tool call</Kicker>
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
            <div className="mb-3 flex items-center gap-1.5">
              <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500/15">
                <Check className="size-3 text-emerald-600" aria-hidden />
              </span>
              <span className="text-[10px] font-semibold tracking-wide text-emerald-700 uppercase">
                Written
              </span>
            </div>
            <dl className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-[11px] text-mk-ink-soft">Reference</dt>
                <dd>
                  <Mono className="text-[12px] font-medium text-mk-ink">{inspector.reference}</Mono>
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-[11px] text-mk-ink-soft">System</dt>
                <dd>
                  <Mono className="text-[12px] text-mk-ink">{inspector.system}</Mono>
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-[11px] text-mk-ink-soft">Posted</dt>
                <dd>
                  <Mono className="text-[12px] text-mk-ink">{inspector.postedAt}</Mono>
                </dd>
              </div>
            </dl>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-mk-ink-soft">
            The call is recorded before it is made, so a tool that fails mid-flight still leaves a
            trace.
          </p>
        </div>
      );

    case "summary":
      return (
        <div>
          <Kicker>Run complete</Kicker>
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: "Tokens", value: inspector.tokens.toLocaleString("en-US") },
              { label: "Cost", value: inspector.cost },
              { label: "Duration", value: inspector.duration },
            ].map((stat) => (
              <div
                key={stat.label}
                className="rounded-xl border border-[var(--mk-hairline)] bg-white px-3 py-3.5"
              >
                <p className="text-[10px] font-medium text-mk-ink-soft">{stat.label}</p>
                <Mono className="mt-1 block text-[15px] font-semibold tabular-nums text-mk-ink">
                  {stat.value}
                </Mono>
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-xl bg-mk-ink p-4">
            <p className="text-[12px] leading-relaxed text-white/85">
              Every node above is now a row you can open — inputs, outputs, tokens and cost, kept
              per run.
            </p>
          </div>
        </div>
      );
  }
}
