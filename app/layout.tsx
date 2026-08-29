/**
 * The shell. One theme, declared once.
 */
import Nav from "./nav.tsx";

export const metadata = {
  title: "agentready",
  description: "Makes a spreadsheet merchant transactable by AI buyers.",
};

const css = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

  :root {
    /* Premium Light Mode Palette (No blue/purple) */
    --bg: #f8f6f2; /* Soft warm light background */
    --panel: #ffffff; /* Crisp white for cards/panels */
    --line: #e8e3dc; /* Subtle warm borders */
    
    --text: #1a1815; /* Rich dark brown/black */
    --muted: #736b5f; /* Elegant warm gray */
    --dim: #a69e90;
    
    /* Warm/earthy semantic colors */
    --accent: #eb5e28; /* Premium warm coral/orange */
    --accent-hover: #d35222;
    --good: #24824d; /* Forest green */
    --bad: #d13a1e; /* Crisp crimson */
    --warn: #a67c00; /* Deep amber */
    
    /* Subtle tints for statuses */
    --good-bg: #eaf3ed;
    --bad-bg: #fbedea;
    --warn-bg: #fcf4e3;
    --neutral-bg: #f2efe9;
  }
  
  * { box-sizing: border-box; }
  
  html, body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  
  a { color: var(--accent); transition: color 0.2s ease; }
  a:hover { color: var(--accent-hover); }
  
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

  /* CARDS */
  .card {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 16px;
    box-shadow: 0 12px 32px -8px rgba(26, 24, 21, 0.08), 0 4px 12px -4px rgba(26, 24, 21, 0.04);
    transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.2s ease;
  }
  
  a.card:hover, button.card:hover, .card-interactive:hover {
    transform: translateY(-2px);
    box-shadow: 0 10px 15px -3px rgba(26, 24, 21, 0.06), 0 4px 6px -2px rgba(26, 24, 21, 0.04);
    border-color: rgba(235, 94, 40, 0.2);
  }
  
  /* TYPOGRAPHY */
  .eyebrow {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
    font-weight: 500;
  }
  
  /* PILLS / GHOST BUTTONS */
  .pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 500;
    text-decoration: none;
    color: var(--muted);
    background: var(--panel);
    border: 1px solid var(--line);
    padding: 8px 16px;
    border-radius: 999px;
    transition: all 0.2s ease;
    cursor: pointer;
  }
  .pill:hover {
    border-color: rgba(235, 94, 40, 0.4);
    color: var(--text);
  }
  .pill[data-active="true"] {
    background: var(--text);
    color: var(--panel);
    border-color: var(--text);
    font-weight: 600;
  }

  /* FORM CONTROLS */
  input, button, select {
    font: inherit;
    color: var(--text);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 10px 14px;
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
  }
  
  input:focus, select:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(235, 94, 40, 0.1);
  }
  
  button { 
    cursor: pointer; 
    border-radius: 999px; 
    font-weight: 500;
  }
  button:hover:not(:disabled) { border-color: var(--muted); }
  button:disabled { opacity: 0.5; cursor: default; }
  input[type="file"] { padding: 8px; }
  label { color: var(--text); font-weight: 500; }
  
  /* ANIMATIONS */
  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  
  @keyframes slide-up {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
  
  .animate-in {
    animation: slide-up 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style>{css}</style>
      </head>
      <body>
        <Nav />
        {children}
      </body>
    </html>
  );
}
