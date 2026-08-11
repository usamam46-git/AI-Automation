"use client";

import * as React from "react";
import { ArrowRight, Check, Loader2 } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  EMPTY_CONTACT_FORM,
  TEAM_SIZES,
  type ContactFormErrors,
  type ContactFormValues,
  hasErrors,
  isConsumerEmail,
  validateContactForm,
} from "@/lib/contact-form";
import { cn } from "@/lib/utils";

const CONTACT_EMAIL = "hello@orkest.ai";

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1.5 text-[0.8125rem] text-red-600">
      {message}
    </p>
  );
}

const fieldClass =
  "h-11 rounded-xl border-[var(--mk-hairline)] bg-white text-[0.9375rem] shadow-none focus-visible:border-mk-sky focus-visible:ring-3 focus-visible:ring-mk-sky/25";

export function Contact() {
  const [values, setValues] = React.useState<ContactFormValues>(EMPTY_CONTACT_FORM);
  const [errors, setErrors] = React.useState<ContactFormErrors>({});
  const [status, setStatus] = React.useState<"idle" | "sending" | "sent" | "failed">("idle");

  const set = <K extends keyof ContactFormValues>(key: K, value: ContactFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    // Clear only the field being edited. Re-running the whole validation on
    // every keystroke would light up fields the visitor has not reached yet.
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found = validateContactForm(values);
    setErrors(found);
    if (hasErrors(found)) return;

    setStatus("sending");
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      // 503 means the endpoint has no destination configured. It is not the
      // visitor's problem to solve, but it must not look like success either —
      // the failed state gives them a working email address.
      setStatus(response.ok ? "sent" : "failed");
    } catch {
      setStatus("failed");
    }
  };

  if (status === "sent") {
    return (
      <section id="contact" className="bg-mk-paper px-5 pb-24 sm:pb-32">
        <div className="mx-auto max-w-2xl rounded-3xl border border-[var(--mk-hairline)] bg-white p-10 text-center mk-lift">
          <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-emerald-500/12">
            <Check className="size-5 text-emerald-600" aria-hidden />
          </span>
          <h2 className="mk-display mt-5 text-[1.75rem] text-mk-ink">Message received</h2>
          <p className="mt-3 text-[0.9375rem] leading-relaxed text-mk-ink-soft">
            We read every one of these ourselves. Expect a reply at{" "}
            <span className="font-medium text-mk-ink">{values.email}</span> within a working day.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section id="contact" className="bg-mk-paper px-5 pb-24 sm:pb-32">
      <div className="mx-auto grid max-w-5xl gap-10 rounded-3xl border border-[var(--mk-hairline)] bg-white p-7 mk-lift sm:p-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-14">
        <div>
          <p className="mk-eyebrow text-mk-sky-deep">Talk to us</p>
          <h2 className="mk-display mt-3 text-[2rem] text-mk-ink sm:text-[2.25rem]">
            Bring us your worst process
          </h2>
          <p className="mt-4 text-[0.9375rem] leading-relaxed text-mk-ink-soft">
            The month-end close nobody wants to own. The approval chain that lives in a spreadsheet.
            Describe it and we will tell you honestly whether Orkest is the right tool for it — and
            if it is not, what is.
          </p>
          <p className="mt-6 text-[0.875rem] text-mk-ink-soft">
            Or write to{" "}
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="font-medium text-mk-sky-deep underline underline-offset-4"
            >
              {CONTACT_EMAIL}
            </a>
          </p>
        </div>

        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="contact-name" className="mb-1.5 text-[0.875rem] text-mk-ink">
                Name
              </Label>
              <Input
                id="contact-name"
                value={values.name}
                onChange={(e) => set("name", e.target.value)}
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? "contact-name-error" : undefined}
                className={fieldClass}
                autoComplete="name"
              />
              <FieldError id="contact-name-error" message={errors.name} />
            </div>

            <div>
              <Label htmlFor="contact-email" className="mb-1.5 text-[0.875rem] text-mk-ink">
                Work email
              </Label>
              <Input
                id="contact-email"
                type="email"
                value={values.email}
                onChange={(e) => set("email", e.target.value)}
                aria-invalid={Boolean(errors.email)}
                aria-describedby={errors.email ? "contact-email-error" : undefined}
                className={fieldClass}
                autoComplete="email"
              />
              <FieldError id="contact-email-error" message={errors.email} />
              {!errors.email && values.email && isConsumerEmail(values.email) ? (
                <p className="mt-1.5 text-[0.8125rem] text-mk-ink-soft">
                  A work address gets you a faster, more specific answer.
                </p>
              ) : null}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="contact-company" className="mb-1.5 text-[0.875rem] text-mk-ink">
                Company <span className="text-mk-ink-soft">(optional)</span>
              </Label>
              <Input
                id="contact-company"
                value={values.company}
                onChange={(e) => set("company", e.target.value)}
                className={fieldClass}
                autoComplete="organization"
              />
              <FieldError id="contact-company-error" message={errors.company} />
            </div>

            <div>
              <Label htmlFor="contact-team-size" className="mb-1.5 text-[0.875rem] text-mk-ink">
                Team size
              </Label>
              <Select value={values.teamSize} onValueChange={(v) => set("teamSize", v)}>
                <SelectTrigger
                  id="contact-team-size"
                  aria-invalid={Boolean(errors.teamSize)}
                  className={cn(fieldClass, "w-full")}
                >
                  <SelectValue placeholder="Select a range" />
                </SelectTrigger>
                <SelectContent className="rounded-xl">
                  {TEAM_SIZES.map((size) => (
                    <SelectItem key={size.value} value={size.value}>
                      {size.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError id="contact-team-size-error" message={errors.teamSize} />
            </div>
          </div>

          <div>
            <Label htmlFor="contact-message" className="mb-1.5 text-[0.875rem] text-mk-ink">
              What are you trying to automate?
            </Label>
            <Textarea
              id="contact-message"
              rows={4}
              value={values.message}
              onChange={(e) => set("message", e.target.value)}
              aria-invalid={Boolean(errors.message)}
              aria-describedby={errors.message ? "contact-message-error" : undefined}
              placeholder="We process about 400 vendor invoices a month and three people touch every one of them…"
              className="resize-none rounded-xl border-[var(--mk-hairline)] bg-white text-[0.9375rem] shadow-none focus-visible:border-mk-sky focus-visible:ring-3 focus-visible:ring-mk-sky/25"
            />
            <FieldError id="contact-message-error" message={errors.message} />
          </div>

          {status === "failed" ? (
            <div
              role="alert"
              className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-[0.875rem] leading-relaxed text-amber-900"
            >
              We could not deliver that. Send it to{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold underline underline-offset-4">
                {CONTACT_EMAIL}
              </a>{" "}
              and it will reach the same people.
            </div>
          ) : null}

          <button
            type="submit"
            disabled={status === "sending"}
            className="group mt-1 inline-flex h-12 items-center justify-center gap-2 rounded-full bg-mk-ink px-6 text-[0.9375rem] font-semibold tracking-tight text-white transition-colors outline-none hover:bg-mk-ink/90 focus-visible:ring-3 focus-visible:ring-mk-sky/40 disabled:opacity-60"
          >
            {status === "sending" ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Sending
              </>
            ) : (
              <>
                Send message
                <ArrowRight className="size-4 transition-transform duration-300 group-hover:translate-x-0.5" aria-hidden />
              </>
            )}
          </button>
        </form>
      </div>
    </section>
  );
}
