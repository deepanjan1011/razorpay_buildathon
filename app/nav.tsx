/**
 * The floating nav.
 *
 * A SERVER COMPONENT TAKING `active` AS A PROP, rather than a client component
 * calling `usePathname`. Two reasons, and the second is the real one:
 *
 *  - This repo's tsconfig is `nodenext`, and `next/navigation` type-resolves
 *    only under `bundler`. The import runs fine and fails `npm run typecheck`,
 *    which is the shape of bug this project keeps finding: works where you ran
 *    it, broken in the other environment.
 *  - A three-page site does not need client JavaScript to know which of three
 *    links is current. The page already knows; it can say so.
 */
const NAV = [
  ["/", "Overview", "overview"],
  ["/upload", "Upload", "upload"],
  ["/sessions", "Audit trail", "sessions"],
] as const;

export type NavKey = (typeof NAV)[number][2];

export default function Nav({ active }: { active: NavKey }) {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "20px 16px 8px" }}>
      <nav
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          background: "var(--panel)",
          border: "1px solid var(--line)",
          borderRadius: 999,
          padding: 8,
          // Two shadows: a tight one for the edge, a wide soft one for lift.
          // A single large blur reads as a smudge on a cream ground.
          boxShadow: "0 1px 2px rgba(23,20,15,.05), 0 12px 28px -12px rgba(23,20,15,.18)",
        }}
      >
        {NAV.map(([href, label, key]) => {
          const on = key === active;
          return (
            <a
              key={href}
              href={href}
              style={{
                fontSize: 13,
                fontWeight: on ? 650 : 500,
                textDecoration: "none",
                color: on ? "var(--panel)" : "var(--muted)",
                background: on ? "var(--accent)" : "transparent",
                padding: "8px 16px",
                borderRadius: 999,
                whiteSpace: "nowrap",
              }}
            >
              {label}
            </a>
          );
        })}
      </nav>
    </div>
  );
}
