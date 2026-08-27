"use client";

import { useRouter } from "next/navigation";
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
