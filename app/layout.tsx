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
    --bg: #f7f0e4;
    --panel: #fffcf7;
    --line: #e7dcc9;
    --text: #17140f;
    --muted: #6e6559;
    --dim: #988c7c;
    --accent: #e1532a;
    --good: #1b7a4c;
    --bad: #b23a1f;
    --warn: #8a6410;
    /* Tints for status chips. Light backgrounds, not dark ones — a chip is a
       label, not a panel, and it must read against the card it sits on. */
    --good-bg: #e4efe4;
    --bad-bg: #fbe4de;
    --warn-bg: #f7ebd5;
    --neutral-bg: #f2e9da;
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

  /* CARDS CARRY THE LAYOUT, not borders. On a cream ground a hairline plus a
     very soft shadow separates a panel; a heavy border reads as a table. */
  .card {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: 0 1px 2px rgba(23, 20, 15, .04);
  }
  /* Small uppercase mono for field labels. Carries the hierarchy so the type
     scale does not have to shout — the numbers stay the loud thing. */
  .eyebrow {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    letter-spacing: .09em;
    text-transform: uppercase;
    color: var(--muted);
  }
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
  button { cursor: pointer; border-radius: 8px; }
  button:hover:not(:disabled) { border-color: var(--muted); }
  button:disabled { opacity: .5; cursor: default; }
  input[type="file"] { padding: 6px; }
  label { color: var(--text); }
`;

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
        {children}
      </body>
    </html>
  );
}
