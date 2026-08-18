"use client";

import * as React from "react";
import { Coins, DatabaseZap, Lock, RotateCcw } from "lucide-react";

import { gsap } from "@/lib/gsap";
import { useGsapReveal } from "@/hooks/use-gsap-reveal";

/**
 * The bento band, mirroring the reference layout's mixed-colour tile grid.
 *
 * Each tile states one thing the platform actually does, at the level of
 * detail a technical buyer can check. The claims map to real mechanisms:
 * the LangGraph Postgres checkpointer, per-node token/cost columns, the
 * `reject_audit_log_mutation()` trigger, and AES-256-GCM credential storage.
 * Do not soften these into generic benefit copy — the specificity is the point.
 */
export function PlatformTiles() {
  const rootRef = React.useRef<HTMLElement>(null);

  useGsapReveal(rootRef, () => {
    gsap.from("[data-tile]", {
      y: 34,
      opacity: 0,
      duration: 0.75,
      ease: "power3.out",
      stagger: 0.08,
      scrollTrigger: { trigger: rootRef.current, start: "top 76%", once: true },
      onComplete: () => gsap.set("[data-tile]", { clearProps: "all" }),
    });
  });

  return (
    <section ref={rootRef} id="platform" className="bg-mk-paper px-5 pb-24 sm:pb-32">
      <div className="mx-auto max-w-6xl">
        <div className="mb-10 max-w-2xl">
          <p className="mk-eyebrow text-mk-sky-deep">The platform</p>
          <h2 className="mk-display mt-3 text-[2rem] text-mk-ink sm:text-[2.75rem]">
            Boring where it counts
          </h2>
          <p className="mt-4 text-[1.0625rem] leading-relaxed text-mk-ink-soft">
            The interesting part of an automation platform should be your workflows. Everything
            underneath them should be predictable enough that you stop thinking about it.
          </p>
        </div>

        {/* `[&>article]:min-w-0` is load-bearing, not tidiness.
            A grid item defaults to `min-width: auto`, which means it refuses to
            shrink below its content's min-content width — and the audit tile
            holds a `CREATE TRIGGER` snippet measuring 426px. On a 393px phone
            that forced the whole grid to 474px, which made the DOCUMENT 494px
            wide and left every centred section on the page looking shifted and
            clipped. One missing utility, sitewide symptom.
            The snippet already carries `overflow-x-auto`; this is what lets it
            actually take effect. Found on a real 393px viewport 2026-08-19. */}
        <div className="grid gap-3 [&>article]:min-w-0 sm:grid-cols-2 lg:grid-cols-3">
          {/* Tall focal tile — the Execution Viewer, in miniature. */}
          <article
            data-tile
            className="row-span-2 flex flex-col justify-between rounded-3xl bg-gradient-to-b from-mk-sky-deep to-mk-sky p-6 text-white mk-lift-sky sm:col-span-2 lg:col-span-1"
          >
            <div>
              <DatabaseZap className="size-5 text-mk-sky-pale" aria-hidden />
              <h3 className="mk-display mt-5 text-[1.5rem]">Replay any run</h3>
              <p className="mt-2.5 text-[0.9375rem] leading-relaxed text-white/80">
                Every node writes a row: what went in, what came out, how many tokens it burned and
                what it cost. Open a run from three weeks ago and the whole thing is still there.
              </p>
            </div>

            <ul className="mt-8 flex flex-col gap-px overflow-hidden rounded-xl border border-white/15">
              {[
                { key: "extract_invoice", cost: "$0.0211", tokens: "2,904" },
                { key: "check_amount", cost: "—", tokens: "—" },
                { key: "approval_1", cost: "—", tokens: "—" },
                { key: "post_to_erp", cost: "$0.0073", tokens: "508" },
              ].map((row) => (
                <li
                  key={row.key}
                  className="flex items-center justify-between gap-3 bg-white/10 px-3 py-2 font-[family-name:var(--font-jetbrains-mono)] text-[10.5px] backdrop-blur-sm"
                >
                  <span className="truncate text-white/90">{row.key}</span>
                  <span className="flex shrink-0 gap-3 tabular-nums text-white/70">
                    <span>{row.tokens}</span>
                    <span className="w-14 text-right text-mk-lime">{row.cost}</span>
                  </span>
                </li>
              ))}
            </ul>
          </article>

          {/* Checkpointing. */}
          <article
            data-tile
            className="rounded-3xl border border-[var(--mk-hairline)] bg-white p-6 mk-lift"
          >
            <RotateCcw className="size-5 text-mk-ink-soft" aria-hidden />
            <h3 className="mk-display mt-5 text-[1.375rem] text-mk-ink">Resume, don&apos;t restart</h3>
            <p className="mt-2.5 text-[0.9375rem] leading-relaxed text-mk-ink-soft">
              State is checkpointed to Postgres after every node. A worker can die mid-run and the
              retry picks up at the last completed step — it does not re-call the tool that already
              posted your invoice.
            </p>
          </article>

          {/* Cost. The lime tile from the reference grid. */}
          <article data-tile className="rounded-3xl bg-mk-lime p-6 mk-lift">
            <Coins className="size-5 text-mk-ink/70" aria-hidden />
            <p className="mt-5 font-[family-name:var(--font-jetbrains-mono)] text-[2.5rem] leading-none font-semibold tracking-tight tabular-nums text-mk-ink">
              $0.0284
            </p>
            <h3 className="mt-3 text-[0.9375rem] font-semibold tracking-tight text-mk-ink">
              Median cost per run
            </h3>
            <p className="mt-1.5 text-[0.875rem] leading-relaxed text-mk-ink/70">
              Priced on what your workflows actually consume, at the node. Not per seat, and not
              per &ldquo;task&rdquo; with a definition that changes every quarter.
            </p>
          </article>

          {/* Immutability. The black tile. */}
          <article data-tile className="rounded-3xl bg-mk-ink p-6 mk-lift sm:col-span-2">
            <Lock className="size-5 text-mk-lime" aria-hidden />
            <h3 className="mk-display mt-5 text-[1.375rem] text-white">
              An audit trail nobody can quietly edit
            </h3>
            <p className="mt-2.5 max-w-xl text-[0.9375rem] leading-relaxed text-white/70">
              Approvals, publishes, credential changes and quota rejections all land in one table —
              and the database itself refuses to change them afterwards. Not enforced by the
              application, where a bug or an admin could route around it.
            </p>
            <div className="mt-5 overflow-x-auto rounded-xl border border-white/10 bg-white/5 p-3.5">
              <pre className="font-[family-name:var(--font-jetbrains-mono)] text-[11px] leading-relaxed whitespace-pre text-white/75">
                <span className="text-mk-lime">CREATE TRIGGER</span> audit_logs_no_update{"\n"}
                {"  "}<span className="text-mk-sky-pale">BEFORE UPDATE OR DELETE</span> ON audit_logs{"\n"}
                {"  "}FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();
              </pre>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
