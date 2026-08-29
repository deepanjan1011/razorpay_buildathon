"use client";

import { useRouter } from "next/navigation.js";
import { useTransition } from "react";

export function TransitionLink({ 
  href, 
  className, 
  style, 
  children,
  pendingText,
  ...rest
}: { 
  href: string;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
  pendingText?: string;
} & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <a
      href={href}
      className={className}
      {...rest}
      style={{
        ...style,
        opacity: isPending ? 0.6 : (style?.opacity ?? 1),
        pointerEvents: isPending ? "none" : "auto",
        transition: "opacity 0.2s ease, background 0.2s ease, border 0.2s ease",
      }}
      onClick={(e) => {
        // LET THE BROWSER HAVE THE CLICKS THAT ARE NOT NAVIGATION. An
        // unconditional preventDefault swallowed ⌘/Ctrl-click, middle-click and
        // shift-click, so "open this session in a new tab" — the obvious move
        // when comparing two refusals — silently did nothing at all. Anything
        // carrying a modifier, or any button other than the primary one, is the
        // browser's to handle; only a plain left click becomes a soft
        // navigation.
        if (e.defaultPrevented) return;
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        startTransition(() => {
          router.push(href, { scroll: false });
        });
      }}
    >
      {isPending && pendingText ? pendingText : children}
    </a>
  );
}
