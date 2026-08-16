"use client";

/**
 * AI Text Loading — a shimmering, cycling status line for genuinely slow AI work.
 *
 * Adapted from @kokonutui (MIT, https://kokonutui.com). Three deliberate
 * changes from the upstream snippet, all of them to obey this project's locked
 * design system rather than to improve on the original:
 *
 * 1. **Palette comes from tokens, not hardcoded neutrals.** Upstream ships
 *    `from-neutral-950 ... dark:from-white ...`. Because `--foreground` and
 *    `--muted-foreground` already invert between themes, the token version
 *    needs no `dark:` variant at all — and it inherits the true-black dark
 *    surface this app overrides shadcn's blue-tinted slate with.
 * 2. **`text-base` default, not `text-3xl`.** The design system calls for
 *    macOS System Settings density; a 30px shimmering headline inside a card
 *    reads as a marketing hero. Callers size it up explicitly where the space
 *    justifies it.
 * 3. **`prefers-reduced-motion` is honoured.** The upstream animation is an
 *    infinite loop with no escape, which is exactly the pattern that triggers
 *    vestibular symptoms. Reduced-motion users get the same rotating text with
 *    a static gradient and no sweep.
 *
 * Use it only where the wait is real and multi-second — ingestion and
 * retrieval. For anything sub-second, a Skeleton is the honest primitive; a
 * "Thinking..." that flashes for 200ms is theatre.
 */

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface AITextLoadingProps {
  texts?: string[];
  className?: string;
  interval?: number;
}

export default function AITextLoading({
  texts = ["Thinking...", "Processing...", "Analyzing...", "Computing...", "Almost..."],
  className,
  interval = 1500,
}: AITextLoadingProps) {
  const [currentTextIndex, setCurrentTextIndex] = useState(0);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (texts.length <= 1) return;
    const timer = setInterval(() => {
      setCurrentTextIndex((prevIndex) => (prevIndex + 1) % texts.length);
    }, interval);
    return () => clearInterval(timer);
  }, [interval, texts.length]);

  // Guard against a caller shortening `texts` while mounted — the index would
  // otherwise point past the end and render `undefined`.
  const label = texts[currentTextIndex % texts.length];

  return (
    <div className="flex items-center justify-center py-6" role="status" aria-live="polite">
      <motion.div
        animate={{ opacity: 1 }}
        className="relative px-2"
        initial={{ opacity: 0 }}
        transition={{ duration: 0.3 }}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={label}
            animate={
              reduceMotion
                ? { opacity: 1, y: 0 }
                : { opacity: 1, y: 0, backgroundPosition: ["200% center", "-200% center"] }
            }
            className={cn(
              "flex min-w-max justify-center whitespace-nowrap bg-[length:200%_100%]",
              "bg-gradient-to-r from-foreground via-muted-foreground to-foreground",
              "bg-clip-text text-base font-medium tracking-tight text-transparent",
              className,
            )}
            exit={{ opacity: 0, y: reduceMotion ? 0 : -8 }}
            initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
            transition={{
              opacity: { duration: 0.25, ease: "easeOut" },
              y: { duration: 0.25, ease: "easeOut" },
              backgroundPosition: { duration: 2.5, ease: "linear", repeat: Number.POSITIVE_INFINITY },
            }}
          >
            {label}
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
