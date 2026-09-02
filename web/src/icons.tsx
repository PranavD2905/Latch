/** One stroke weight, one corner style, one 24-grid — the dashboard's icon vocabulary. */
function Icon({ children, size = 16, strokeWidth = 1.7 }: { children: React.ReactNode; size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
}

export const LedgerIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M8 8h8M8 12h8M8 16h5" />
  </Icon>
)
export const InstitutionIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <path d="M3 10 12 4l9 6" />
    <path d="M5 10v9M10 10v9M14 10v9M19 10v9M3 21h18" />
  </Icon>
)
export const ListIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
  </Icon>
)
export const CalendarIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </Icon>
)
export const BlockedIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m6 6 12 12" />
  </Icon>
)
export const RupeeFlowIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <path d="M7 5h10M7 9h10M13.5 5c2.5 0 3.5 1.5 3.5 4s-2 4-5 4H7l7 6" />
  </Icon>
)
export const ShieldIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6l7-3z" />
  </Icon>
)
export const RefundIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </Icon>
)
export const SlidersIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2" />
    <circle cx="16" cy="6" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="16" cy="18" r="2" />
  </Icon>
)
export const TagIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9-9-9z" />
    <circle cx="7.5" cy="7.5" r="1.3" />
  </Icon>
)
export const SearchIcon = (p: { size?: number }) => (
  <Icon {...p} strokeWidth={2}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </Icon>
)
export const ChevronRight = (p: { size?: number }) => (
  <Icon {...p} strokeWidth={2}>
    <path d="m9 18 6-6-6-6" />
  </Icon>
)
export const ChevronLeft = (p: { size?: number }) => (
  <Icon {...p} strokeWidth={2}>
    <path d="m15 18-6-6 6-6" />
  </Icon>
)
export const ChevronDown = (p: { size?: number }) => (
  <Icon {...p} strokeWidth={2}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
)
export const XIcon = (p: { size?: number }) => (
  <Icon {...p} strokeWidth={2.4}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Icon>
)
export const CheckCircleIcon = (p: { size?: number }) => (
  <Icon {...p} strokeWidth={2}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 12 2.5 2.5 4.5-5" />
  </Icon>
)
export const InfoCircleIcon = (p: { size?: number }) => (
  <Icon {...p} strokeWidth={2}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16v-4M12 8h.01" />
  </Icon>
)
export const AlertIcon = (p: { size?: number }) => (
  <Icon {...p} strokeWidth={2}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4M12 17h.01" />
  </Icon>
)
export const ExternalIcon = (p: { size?: number }) => (
  <Icon {...p} strokeWidth={2}>
    <path d="M14 4h6v6M20 4l-8.5 8.5" />
    <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
  </Icon>
)
export const BellIcon = (p: { size?: number }) => (
  <Icon {...p}>
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 7-3 9h18c0-2-3-2-3-9" />
    <path d="M10.3 21a2 2 0 0 0 3.4 0" />
  </Icon>
)
export const PulseIcon = (p: { size?: number }) => (
  <Icon {...p} strokeWidth={2}>
    <path d="M2 12h4l3-8 4 16 3-8h6" />
  </Icon>
)
