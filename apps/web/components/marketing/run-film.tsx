"use client";

import * as React from "react";
import { Check, CircleCheck, GitBranch, Sparkles, UserCheck, Webhook, Wrench } from "lucide-react";

import { gsap, ScrollTrigger } from "@/lib/gsap";
import { usePrefersReducedMotion } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import {
  FILM_BEATS,
  FILM_NODES,
  type FilmNodeKind,
  type FilmNodeState,
  beatIndexAtProgress,
  nodeStatesAtBeat,
  runStatusLabel,
} from "@/lib/run-film";
import { RunInspector } from "@/components/marketing/run-inspector";

const NODE_ICON: Record<FilmNodeKind, React.ComponentType<{ className?: string }>> = {
  trigger: Webhook,
  agent: Sparkles,
  condition: GitBranch,
  human_approval: UserCheck,
  tool: Wrench,
  end: CircleCheck,
};

const STATE_DOT: Record<FilmNodeState, string> = {
  pending: "border-mk-ink/15 bg-white",
  running: "border-mk-sky bg-mk-sky",
  waiting: "border-amber-400 bg-amber-400",
  succeeded: "border-emerald-500 bg-emerald-500",
};

function NodeRow({
  index,
  total,
  label,
  nodeKey,
  kind,
  state,
}: {
  index: number;
  total: number;
  label: string;
  nodeKey: string;
  kind: FilmNodeKind;
  state: FilmNodeState;
}) {
  const Icon = NODE_ICON[kind];
  const active = state === "running" || state === "waiting";

  return (
    <li className="relative flex gap-3">
      {/* Connector. Drawn behind the dot and stopped short of the last row so
          the chain reads as finished rather than trailing off. */}
      {index < total - 1 ? (
        <span
          aria-hidden
          className={cn(
            "absolute left-[11px] top-6 h-[calc(100%-8px)] w-px transition-colors duration-500",
            state === "succeeded" ? "bg-emerald-500/35" : "bg-mk-ink/10",
          )}
        />
      ) : null}

      <span
        aria-hidden
        className={cn(
          "relative z-10 mt-1 flex size-[23px] shrink-0 items-center justify-center rounded-full border-2 transition-all duration-500",
          STATE_DOT[state],
        )}
      >
        {state === "succeeded" ? (
          <Check className="size-3 text-white" />
        ) : active ? (
          <span className="size-1.5 animate-pulse rounded-full bg-white" />
        ) : null}
      </span>

      <span
        className={cn(
          "flex min-w-0 flex-col pb-5 transition-opacity duration-500",
          state === "pending" ? "opacity-40" : "opacity-100",
        )}
      >
        <span className="flex items-center gap-1.5">
          <Icon
            className={cn(
              "size-3.5 shrink-0 transition-colors duration-500",
              state === "waiting"
                ? "text-amber-600"
                : state === "pending"
                  ? "text-mk-ink-soft"
                  : "text-mk-sky-deep",
            )}
          />
          <span className="truncate text-[0.875rem] font-medium tracking-tight text-mk-ink">
            {label}
          </span>
        </span>
        <span className="mt-0.5 truncate font-[family-name:var(--font-jetbrains-mono)] text-[10px] text-mk-ink-soft">
          {nodeKey}
        </span>
      </span>
    </li>
  );
}

/**
 * The scroll-scrubbed run film — the page's signature element.
 *
 * ## How it is driven
 *
 * One ScrollTrigger scrubs 0→1 across the section and maps that onto a beat
 * index via `beatIndexAtProgress`. React state holds only the *discrete* beat
 * (seven changes across the whole scroll, so re-rendering on it is cheap); the
 * continuous progress bar is written straight to the DOM in `onUpdate`,
 * because putting a 0–1 float into `setState` would re-render the tree on
 * every frame of every scroll.
 *
 * ## Why the pin is conditional
 *
 * Pinning is desktop-only. On a phone the pin fights the browser's collapsing
 * address bar — every collapse is a resize, every resize re-measures the pin,
 * and the section visibly jumps on the first flick. Below `lg` the same
 * trigger runs unpinned: the beats advance as the section travels through the
 * viewport, which needs no measurement stability at all.
 *
 * With `prefers-reduced-motion` no trigger is created whatsoever. The stepper
 * buttons below the panel become the only control, which is why they are real
 * `<button>`s rather than decorative dots — they are the accessible path
 * through the story, not an ornament.
 */
export function RunFilm() {
  const sectionRef = React.useRef<HTMLElement>(null);
  const pinRef = React.useRef<HTMLDivElement>(null);
  const progressRef = React.useRef<HTMLSpanElement>(null);
  const triggerRef = React.useRef<ScrollTrigger | null>(null);

  const [beatIndex, setBeatIndex] = React.useState(0);
  const reducedMotion = usePrefersReducedMotion();

  React.useEffect(() => {
    if (reducedMotion) return;
    const section = sectionRef.current;
    const pin = pinRef.current;
    if (!section || !pin) return;

    const ctx = gsap.context(() => {
      const desktop = window.matchMedia("(min-width: 1024px)").matches;

      const trigger = ScrollTrigger.create({
        trigger: section,
        start: desktop ? "top top" : "top 72%",
        end: desktop
          ? () => `+=${window.innerHeight * (FILM_BEATS.length - 1) * 0.62}`
          : "bottom 40%",
        pin: desktop ? pin : false,
        pinSpacing: desktop,
        scrub: 0.4,
        invalidateOnRefresh: true,
        onUpdate: (self) => {
          // Continuous value → straight to the DOM, never through React.
          if (progressRef.current) {
            progressRef.current.style.transform = `scaleX(${Math.min(Math.max(self.progress, 0), 1)})`;
          }
          // Discrete value → React, but only on an actual change. Without this
          // guard every scroll frame would schedule a render of the panel.
          const next = beatIndexAtProgress(self.progress);
          setBeatIndex((current) => (current === next ? current : next));
        },
      });

      triggerRef.current = trigger;
    }, section);

    return () => {
      triggerRef.current = null;
      ctx.revert();
    };
  }, [reducedMotion]);

  const beat = FILM_BEATS[beatIndex];
  const states = nodeStatesAtBeat(beatIndex);

  /** Stepper. Scrolls the page when scrubbing is live so the two never disagree. */
  const goToBeat = (index: number) => {
    const trigger = triggerRef.current;
    if (!trigger) {
      setBeatIndex(index);
      return;
    }
    const ratio = index / (FILM_BEATS.length - 1);
    window.scrollTo({
      top: trigger.start + (trigger.end - trigger.start) * ratio,
      behavior: "smooth",
    });
  };

  return (
    <section
      ref={sectionRef}
      id="how-it-works"
      className="relative border-t border-[var(--mk-hairline)] bg-mk-paper"
    >
      <div ref={pinRef} className="flex min-h-[100svh] flex-col justify-center px-5 py-16 lg:py-0">
        <div className="mx-auto w-full max-w-5xl">
          <div className="mb-8 text-center lg:mb-10">
            <p className="mk-eyebrow text-mk-sky-deep">One run, start to finish</p>
            <h2 className="mk-display mx-auto mt-3 max-w-2xl text-[2rem] text-mk-ink sm:text-[2.75rem]">
              Scroll to watch it work
            </h2>
          </div>

          {/* The panel. Deliberately styled as the product's own Execution
              Viewer rather than as a marketing illustration. */}
          <div className="overflow-hidden rounded-3xl border border-[var(--mk-hairline)] bg-white mk-lift">
            <div className="flex items-center gap-3 border-b border-[var(--mk-hairline)] px-4 py-3 sm:px-5">
              <span className="flex gap-1.5" aria-hidden>
                <span className="size-2.5 rounded-full bg-[#FF5F57]" />
                <span className="size-2.5 rounded-full bg-[#FEBC2E]" />
                <span className="size-2.5 rounded-full bg-[#28C840]" />
              </span>
              <span className="ml-1 truncate font-[family-name:var(--font-jetbrains-mono)] text-[11px] text-mk-ink-soft">
                run_a41f8c · invoice_approval
              </span>
              <span
                className={cn(
                  "ml-auto shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-tight transition-colors duration-500",
                  beat.runStatus === "waiting_approval"
                    ? "bg-amber-400/15 text-amber-700"
                    : beat.runStatus === "completed"
                      ? "bg-emerald-500/15 text-emerald-700"
                      : "bg-mk-sky/15 text-mk-sky-deep",
                )}
              >
                {runStatusLabel(beat.runStatus)}
              </span>
            </div>

            <div className="grid gap-0 sm:grid-cols-[minmax(190px,0.8fr)_1.2fr]">
              <ol className="border-b border-[var(--mk-hairline)] p-4 sm:border-b-0 sm:border-r sm:p-5">
                {FILM_NODES.map((node, i) => (
                  <NodeRow
                    key={node.key}
                    index={i}
                    total={FILM_NODES.length}
                    label={node.label}
                    nodeKey={node.key}
                    kind={node.kind}
                    state={states[node.key]}
                  />
                ))}
              </ol>

              {/* `min-h` holds the panel steady as views of different natural
                  height swap in — without it the pinned section resizes and
                  the whole film feels like it is breathing. */}
              <div className="min-h-[300px] p-4 sm:p-5">
                <div key={beat.id} className="animate-in fade-in slide-in-from-bottom-2 duration-500">
                  <RunInspector inspector={beat.inspector} />
                </div>
              </div>
            </div>

            <div className="h-0.5 w-full bg-mk-mist">
              <span
                ref={progressRef}
                aria-hidden
                className="block h-full origin-left scale-x-0 bg-mk-sky"
                style={reducedMotion ? { transform: "scaleX(1)" } : undefined}
              />
            </div>
          </div>

          {/* The caption carries the argument. It changes per beat and the
              approval beat is the one the whole page is built around. */}
          <div className="mx-auto mt-7 flex max-w-2xl flex-col items-center gap-5">
            <p
              key={beat.id}
              className={cn(
                "animate-in fade-in min-h-[3.5rem] text-center text-[1.0625rem] leading-relaxed duration-500 sm:text-[1.125rem]",
                beat.runStatus === "waiting_approval"
                  ? "font-semibold tracking-tight text-mk-ink"
                  : "text-mk-ink-soft",
              )}
            >
              {beat.caption}
            </p>

            <ol className="flex items-center gap-1.5">
              {FILM_BEATS.map((step, i) => (
                <li key={step.id}>
                  <button
                    type="button"
                    onClick={() => goToBeat(i)}
                    aria-current={i === beatIndex ? "step" : undefined}
                    className={cn(
                      "block h-1.5 rounded-full transition-all duration-300 outline-none focus-visible:ring-3 focus-visible:ring-mk-sky/40",
                      i === beatIndex ? "w-7 bg-mk-ink" : "w-1.5 bg-mk-ink/20 hover:bg-mk-ink/40",
                    )}
                  >
                    <span className="sr-only">
                      Step {i + 1} of {FILM_BEATS.length}: {step.caption}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}
