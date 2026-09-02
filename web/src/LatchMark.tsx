/**
 * The Latch mark: something held between two bounds.
 *
 * Square brackets are the notation for a closed interval, which is exactly
 * what this product enforces — every action in the trail carries a `bound`
 * with a ceiling and the headroom left inside it. The element between them
 * is the action, held. Three masses and no letterform, so it survives a
 * 16px favicon and doesn't compete with the wordmark beside it.
 *
 * Rejected on the way here: a stepped ascent under a ceiling (read as a
 * generic growth chart), and an enclosure closed by a standing bar (read as
 * a battery icon at display sizes).
 */
export function LatchMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M9 4.6H5.2v14.8H9" />
      <path d="M15 4.6h3.8v14.8H15" />
      <rect x="10.4" y="8.6" width="3.2" height="6.8" rx="1.6" fill="currentColor" stroke="none" />
    </svg>
  )
}
