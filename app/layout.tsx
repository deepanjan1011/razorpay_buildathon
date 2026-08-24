/**
 * The shell. One theme, declared once.
 *
 * WHY THIS EXISTS AT ALL: nothing set a background or a colour, so every page
 * inherited the browser's preference. The upload page had been written against
 * a light background — `#555` labels, `#eee` progress bars — and rendered dark
 * text on dark, with its field labels effectively invisible. That is a contrast
 * failure rather than a taste one, and it was invisible to every test because
 * tests assert markup and not legibility.
 *
 * Tokens rather than per-page hex, so the next page cannot quietly disagree
 * with this one. Deliberately not a design system: six variables and a nav.
 */
export const metadata = {
  title: "agentready",
  description: "Makes a spreadsheet merchant transactable by AI buyers.",
};

const css = `
  :root {
    --bg: #0d0f14;
    --panel: #141821;
    --line: #1f2531;
    --text: #e6e8ee;
    --muted: #8b93a7;
    --dim: #5c6478;
    --accent: #8ecbff;
    --good: #7ee2a8;
    --bad: #ff9db1;
    --warn: #ffc178;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  /* Form controls do not inherit colour, so they render as light-on-light
     unless told otherwise — the other half of the same bug. */
  input, button, select {
    font: inherit;
    color: var(--text);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 8px 10px;
  }
  button { cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--muted); }
  button:disabled { opacity: .5; cursor: default; }
  input[type="file"] { padding: 6px; }
  label { color: var(--text); }
`;

const NAV = [
  ["/", "Overview"],
  ["/upload", "Upload a catalogue"],
  ["/sessions", "Audit trail"],
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* A plain child, not dangerouslySetInnerHTML. The string is a module
            constant with no interpolation, so the two are equivalent here — but
            one of them is a pattern a reviewer has to stop and verify, and the
            other is not. */}
        <style>{css}</style>
      </head>
      <body>
        <nav
          style={{
            borderBottom: "1px solid var(--line)",
            padding: "10px 24px",
            display: "flex",
            gap: 20,
            alignItems: "center",
          }}
        >
          <span style={{ fontWeight: 600, letterSpacing: 0.4 }}>agentready</span>
          {NAV.map(([href, label]) => (
            <a key={href} href={href} style={{ fontSize: 13, textDecoration: "none" }}>
              {label}
            </a>
          ))}
        </nav>
        {children}
      </body>
    </html>
  );
}
