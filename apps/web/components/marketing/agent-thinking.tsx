"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/hooks/use-media-query";

/**
 * Agent thinking loader.
 *
 * Two signals rather than one: a three-dot pulse that says "working", and a
 * cycling list of the steps the agent is actually taking. The second matters —
 * an indeterminate spinner tells a prospect nothing, whereas "Resolving vendor
 * against ledger" tells them what the product does.
 *
 * The cycle is a plain interval, not GSAP: it drives React state (the visible
 * line index) rather than a transform, and mixing the two schedulers for one
 * counter buys nothing.
 */
export function AgentThinking({
  model,
  lines,
  className,
}: {
  model: string;
  lines: readonly string[];
  className?: string;
}) {
  const [active, setActive] = React.useState(0);
  const reducedMotion = usePrefersReducedMotion();

  React.useEffect(() => {
    // With reduced motion the list is shown complete and static instead of
    // animating — the information survives, the movement does not.
    if (reducedMotion || lines.length <= 1) return;
    const id = window.setInterval(() => {
      setActive((i) => (i + 1) % lines.length);
    }, 1400);
    return () => window.clearInterval(id);
  }, [lines.length, reducedMotion]);

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className={cn(
                "size-1.5 rounded-full bg-mk-sky",
                !reducedMotion && "animate-bounce",
              )}
              style={reducedMotion ? undefined : { animationDelay: `${i * 140}ms`, animationDuration: "1s" }}
            />
          ))}
        </span>
        <span className="font-[family-name:var(--font-jetbrains-mono)] text-[11px] text-mk-ink-soft">
          {model}
        </span>
      </div>

      <ul className="flex flex-col gap-2" aria-live="polite">
        {lines.map((line, i) => {
          const done = !reducedMotion && i < active;
          const current = reducedMotion || i === active;
          return (
            <li
              key={line}
              className={cn(
                "flex items-center gap-2 text-[0.8125rem] transition-all duration-500",
                current ? "text-mk-ink" : done ? "text-mk-ink-soft" : "text-mk-ink-soft/45",
              )}
            >
              <span
                className={cn(
                  "size-1 shrink-0 rounded-full transition-colors duration-500",
                  current ? "bg-mk-sky" : done ? "bg-mk-ink-soft/40" : "bg-mk-ink-soft/20",
                )}
                aria-hidden
              />
              {line}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
