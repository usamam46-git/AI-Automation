import { NextResponse } from "next/server";

import {
  EMPTY_CONTACT_FORM,
  type ContactFormValues,
  hasErrors,
  validateContactForm,
} from "@/lib/contact-form";

/**
 * Contact form endpoint.
 *
 * **This deliberately fails loudly when unconfigured.** A landing-page contact
 * form that renders a cheerful "thanks, we'll be in touch" while dropping the
 * submission on the floor loses real leads silently, and nobody notices until
 * someone asks why the inbox is empty. So with no destination configured this
 * returns 503 and the form shows the visitor an email address instead.
 *
 * To turn it on, set `CONTACT_WEBHOOK_URL` to anything that accepts a JSON
 * POST — a Slack incoming webhook, a Zapier/Make catch hook, or an internal
 * service. It is read at request time rather than module scope so the value
 * can be rotated without a rebuild.
 *
 * Not a `NEXT_PUBLIC_` variable: it must stay server-side, or the URL ships to
 * the browser and anyone can post to your Slack channel.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const raw = body as Partial<ContactFormValues> | null;
  // Re-validate server-side with the same rules the form used. The browser's
  // pass is a convenience; this one is the authority.
  const values: ContactFormValues = {
    ...EMPTY_CONTACT_FORM,
    name: typeof raw?.name === "string" ? raw.name : "",
    email: typeof raw?.email === "string" ? raw.email : "",
    company: typeof raw?.company === "string" ? raw.company : "",
    teamSize: typeof raw?.teamSize === "string" ? raw.teamSize : "",
    message: typeof raw?.message === "string" ? raw.message : "",
  };

  const errors = validateContactForm(values);
  if (hasErrors(errors)) {
    return NextResponse.json({ errors }, { status: 422 });
  }

  const destination = process.env.CONTACT_WEBHOOK_URL;
  if (!destination) {
    console.warn(
      "[contact] CONTACT_WEBHOOK_URL is not set — the submission was rejected rather than dropped.",
    );
    return NextResponse.json(
      { error: "The contact form is not connected to a destination yet." },
      { status: 503 },
    );
  }

  try {
    const response = await fetch(destination, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "orkest-marketing-contact",
        submittedAt: new Date().toISOString(),
        ...values,
      }),
      // Without a timeout a hung destination holds the request open until the
      // platform's own limit, which surfaces to the visitor as a dead button.
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      console.error("[contact] destination responded %s", response.status);
      return NextResponse.json({ error: "The destination rejected the message." }, { status: 502 });
    }
  } catch (error) {
    console.error("[contact] failed to reach destination", error);
    return NextResponse.json({ error: "Could not reach the destination." }, { status: 502 });
  }

  return NextResponse.json({ ok: true }, { status: 202 });
}
