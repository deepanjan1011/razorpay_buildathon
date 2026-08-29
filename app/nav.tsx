/**
 * The floating nav.
 *
 * RENDERED ONCE, IN THE LAYOUT. It used to be placed by each page, taking an
 * `active` prop — which meant five containers with four different top paddings,
 * and on /upload a nav centred inside a 680px column rather than the page. The
 * position drifted because nothing held it still. A layout holds it still by
 * construction, and a new page cannot forget to include it.
 *
 * A CLIENT COMPONENT AGAIN, because the layout cannot know which link is
 * current and `usePathname` can. The import carries its extension —
 * `next/navigation.js` — since this repo's `nodenext` resolution finds the
 * declaration file beside it while the bundler finds the module; without it,
 * typecheck fails on a page that runs perfectly.
 */
"use client";

import { usePathname } from "next/navigation.js";

/** Ordered as the story runs: what it is, put a sheet in, what it became, what it decided. */
const NAV = [
  ["/", "Overview", "overview"],
  ["/upload", "Upload", "upload"],
  ["/catalogue", "Catalogue", "catalogue"],
  ["/sessions", "Audit trail", "sessions"],
] as const;

export default function Nav() {
  const path = usePathname();

  return (
    // STICKY, and the wrapper stays transparent on purpose: the pill already
    // carries a translucent background and a blur, so content passing beneath
    // it reads as passing beneath glass. A solid bar here would paint a strip
    // across the page and undo that.
    <div
      className="animate-in"
      style={{
        display: "flex",
        justifyContent: "center",
        padding: "24px 16px 12px",
        position: "sticky",
        top: 0,
        // Above cards and their hover transforms, below nothing else — there
        // are no modals on this site to lose a stacking contest with.
        zIndex: 50,
      }}
    >
      <nav
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          // 0.75 was fine over a static page and failed the moment the nav
          // became sticky: table rows passing underneath stayed legible
          // through it, so the pill read as overlapping text rather than as
          // glass. Opaque enough to sit on top of content, translucent enough
          // that the blur still does something.
          background: "rgba(255, 255, 255, 0.94)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          border: "1px solid rgba(232, 227, 220, 0.8)",
          borderRadius: 999,
          padding: 8,
          boxShadow: "0 4px 6px -1px rgba(26, 24, 21, 0.05), 0 12px 28px -12px rgba(26, 24, 21, 0.15)",
        }}
      >
        {NAV.map(([href, label, key]) => {
          // Exact match for "/", prefix for the rest — otherwise every route
          // matches the root and the pill never leaves Overview.
          const on = href === "/" ? path === "/" : path.startsWith(href);
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
