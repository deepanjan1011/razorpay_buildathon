/** Minimal root layout — Next requires one. Phase 6 owns how this looks. */
export const metadata = { title: "agentready" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
