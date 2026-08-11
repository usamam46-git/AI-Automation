"use client";

import * as React from "react";
import { Accordion as AccordionPrimitive } from "radix-ui";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Built on the unified `radix-ui` package, matching the `radix-nova` style the
 * rest of `components/ui/` uses — not the per-primitive `@radix-ui/react-*`
 * packages the 21st.dev snippets assume, none of which are installed here.
 */
function Accordion({ ...props }: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />;
}

function AccordionItem({
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn("border-b border-[var(--mk-hairline)] last:border-b-0", className)}
      {...props}
    />
  );
}

function AccordionTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "group flex flex-1 items-start justify-between gap-6 rounded-lg py-5 text-left",
          "text-[1.0625rem] font-medium tracking-tight text-mk-ink",
          "outline-none transition-colors hover:text-mk-sky-deep",
          "focus-visible:ring-3 focus-visible:ring-mk-sky/40",
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDown
          aria-hidden
          className="mt-0.5 size-5 shrink-0 text-mk-ink-soft transition-transform duration-200 ease-out group-data-[state=open]:rotate-180"
        />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

function AccordionContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down"
      {...props}
    >
      <div className={cn("pb-5 pr-10 text-[0.9375rem] leading-relaxed text-mk-ink-soft", className)}>
        {children}
      </div>
    </AccordionPrimitive.Content>
  );
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
