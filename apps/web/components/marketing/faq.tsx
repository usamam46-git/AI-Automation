"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

/**
 * Questions a technical buyer actually asks, answered specifically.
 *
 * Each answer is checkable against the running product. Where something is not
 * built yet it says so plainly — an FAQ that overclaims is the fastest way to
 * lose the kind of buyer this page is written for.
 */
const FAQS = [
  {
    q: "What happens if the model gets something wrong?",
    a: "It gets caught before it matters. Agent nodes return typed objects against a schema you declare, so a malformed answer fails the node rather than flowing downstream as plausible text. Anything that then writes to a real system sits behind an approval, and the approval screen shows you the upstream node's actual output as the evidence — not a summary of it.",
  },
  {
    q: "Can I skip the approval step for workflows I trust?",
    a: "For read-only work, yes — nothing forces a checkpoint into a workflow that only fetches and reports. But a workflow containing a tool marked as mutating cannot be published without at least one approval node somewhere upstream of it. Publishing returns an error naming the offending nodes. It is a property of the platform, not a setting.",
  },
  {
    q: "Which systems does it connect to?",
    a: "Anything with an HTTP API, through the tool registry — you register the endpoint, method and auth once, then reference it from any workflow. Purpose-built ERP connectors are on the roadmap rather than shipped; today an ERP integration is an HTTP tool you configure yourself.",
  },
  {
    q: "Do you train on our data?",
    a: "No. Model calls are stateless and carry only the fields your workflow passes them. You can also bring your own OpenAI key, in which case the calls bill to your account and run under your own data-retention agreement — the key is encrypted with AES-256-GCM and there is no code path that decrypts and returns it, even to you.",
  },
  {
    q: "How is one customer's data kept away from another's?",
    a: "Two layers. Every query is scoped by the organisation on the authenticated session, never by anything a client can send. Underneath that, Postgres row-level security enforces the same boundary at the database, so a missed scope in application code fails closed rather than leaking.",
  },
  {
    q: "What happens if a run fails halfway through?",
    a: "Execution state is checkpointed after every node, so a retry resumes at the last completed step instead of replaying from the trigger. That matters most for the nodes you would least like to run twice — a tool that already posted a payment is not re-invoked.",
  },
  {
    q: "Is there an audit trail we can give an auditor?",
    a: "Yes, and it is append-only at the database level: publishes, approvals, rejections, credential changes and quota rejections all write rows that Postgres itself refuses to update or delete. Each row carries the actor and their IP. Exporting to your SIEM is not built yet — today it is queryable through the API.",
  },
] as const;

export function Faq() {
  return (
    <section id="faq" className="bg-mk-paper px-5 pb-24 sm:pb-32">
      <div className="mx-auto grid max-w-5xl gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <p className="mk-eyebrow text-mk-sky-deep">Questions</p>
          <h2 className="mk-display mt-3 text-[2rem] text-mk-ink sm:text-[2.5rem]">
            The ones that come up
          </h2>
          <p className="mt-4 text-[0.9375rem] leading-relaxed text-mk-ink-soft">
            Something missing? The answer is probably specific to your stack —
            <a href="#contact" className="ml-1 font-medium text-mk-sky-deep underline underline-offset-4">
              ask us directly
            </a>
            .
          </p>
        </div>

        <Accordion type="single" collapsible defaultValue="faq-0" className="w-full">
          {FAQS.map((item, i) => (
            <AccordionItem key={item.q} value={`faq-${i}`}>
              <AccordionTrigger>{item.q}</AccordionTrigger>
              <AccordionContent>{item.a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}
