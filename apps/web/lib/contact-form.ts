/**
 * Validation for the marketing contact form.
 *
 * Pure and dependency-free so it can be shared verbatim between the client
 * component and the route handler — the server must never trust the browser's
 * validation, and re-implementing the rules twice is how the two drift.
 */

export interface ContactFormValues {
  name: string;
  email: string;
  company: string;
  teamSize: string;
  message: string;
}

export type ContactFormErrors = Partial<Record<keyof ContactFormValues, string>>;

export const TEAM_SIZES = [
  { value: "1-10", label: "1–10 people" },
  { value: "11-50", label: "11–50 people" },
  { value: "51-200", label: "51–200 people" },
  { value: "201-1000", label: "201–1,000 people" },
  { value: "1000+", label: "More than 1,000" },
] as const;

export const EMPTY_CONTACT_FORM: ContactFormValues = {
  name: "",
  email: "",
  company: "",
  teamSize: "",
  message: "",
};

/**
 * Deliberately permissive: one `@`, something either side, a dot in the
 * domain. Stricter patterns reject valid addresses (plus-tags, new TLDs, long
 * subdomains) and the only authority on deliverability is sending mail.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Free-mail domains. Not rejected — only nudged, since plenty of real leads use them. */
const CONSUMER_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "icloud.com",
  "proton.me",
]);

export function isConsumerEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@")[1];
  return domain ? CONSUMER_DOMAINS.has(domain) : false;
}

export function validateContactForm(values: ContactFormValues): ContactFormErrors {
  const errors: ContactFormErrors = {};

  if (!values.name.trim()) {
    errors.name = "Tell us who you are.";
  } else if (values.name.trim().length > 120) {
    errors.name = "That name is longer than we can store.";
  }

  const email = values.email.trim();
  if (!email) {
    errors.email = "We need somewhere to reply.";
  } else if (!EMAIL.test(email)) {
    errors.email = "That address is missing an @ or a domain.";
  } else if (email.length > 254) {
    errors.email = "That address is longer than we can store.";
  }

  if (values.company.trim().length > 160) {
    errors.company = "That company name is longer than we can store.";
  }

  if (!values.teamSize) {
    errors.teamSize = "Pick the closest range.";
  } else if (!TEAM_SIZES.some((size) => size.value === values.teamSize)) {
    errors.teamSize = "Pick one of the listed ranges.";
  }

  const message = values.message.trim();
  if (!message) {
    errors.message = "Tell us what you are trying to automate.";
  } else if (message.length < 12) {
    errors.message = "A sentence or two helps us route this to the right person.";
  } else if (message.length > 4000) {
    errors.message = "Keep it under 4,000 characters and we will follow up for the rest.";
  }

  return errors;
}

export function hasErrors(errors: ContactFormErrors): boolean {
  return Object.keys(errors).length > 0;
}
