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
    <div className="animate-in" style={{ display: "flex", justifyContent: "center", padding: "24px 16px 12px" }}>
      <nav
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: "rgba(255, 255, 255, 0.75)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          border: "1px solid rgba(232, 227, 220, 0.8)",
          borderRadius: 999,
          padding: 8,
          boxShadow: "0 4px 6px -1px rgba(26, 24, 21, 0.05), 0 12px 28px -12px rgba(26, 24, 21, 0.15)",
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
                fontWeight: on ? 600 : 500,
                textDecoration: "none",
                color: on ? "var(--panel)" : "var(--muted)",
                background: on ? "var(--text)" : "transparent",
                padding: "8px 18px",
                borderRadius: 999,
                whiteSpace: "nowrap",
                transition: "all 0.2s ease",
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
