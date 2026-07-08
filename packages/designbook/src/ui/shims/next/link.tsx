/**
 * Stand-in for `next/link` when rendering a repo's components inside the
 * designbook workbench — there's no Next.js router to attach to. Renders a
 * plain anchor and drops Next-only props. Auto-aliased when the target repo
 * depends on `next` (see src/node/userVite.ts); a user/sidecar alias for
 * `next/link` overrides this.
 */
import { forwardRef } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";

export type LinkProps = {
  href: string;
  shallow?: boolean;
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
  passHref?: boolean;
  legacyBehavior?: boolean;
  children?: ReactNode;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">;

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  {
    href,
    shallow: _shallow,
    prefetch: _prefetch,
    replace: _replace,
    scroll: _scroll,
    passHref: _passHref,
    legacyBehavior: _legacyBehavior,
    children,
    ...rest
  },
  ref,
) {
  return (
    <a ref={ref} href={href} {...rest}>
      {children}
    </a>
  );
});

export default Link;
