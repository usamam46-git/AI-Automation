import { cn } from "@/lib/utils";

/**
 * The Orkest mark: three nodes and the edge between them, with the middle node
 * held open as a ring.
 *
 * The open node is the human-approval gate — the same idea the whole landing
 * page argues, compressed into 24 pixels. It inherits `currentColor` so the
 * nav can flip it white-on-sky to ink-on-paper without a second asset.
 */
export function OrkestMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={cn("shrink-0", className)}
    >
      <path
        d="M6 6.5h4.5a3 3 0 0 1 0 6H6M13.5 12.5H18"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        opacity="0.35"
      />
      <circle cx="5" cy="6.5" r="2.25" fill="currentColor" />
      <circle cx="12" cy="12" r="3.25" stroke="currentColor" strokeWidth="1.75" />
      <circle cx="19" cy="17.5" r="2.25" fill="currentColor" />
      <path
        d="M12 15.25v.5a2 2 0 0 0 2 2h2.75"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        opacity="0.35"
      />
    </svg>
  );
}
