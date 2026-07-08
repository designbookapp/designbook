/**
 * Stand-in for `next/navigation` when rendering a repo's hooks outside a
 * Next.js app router. Returns safe, static defaults instead of throwing
 * "invariant expected app router to be mounted". Auto-aliased when the target
 * repo depends on `next` (see src/node/userVite.ts).
 */
/**
 * Next.js narrows URLSearchParams by making mutators throw; for canvas
 * rendering a plain readable subclass is enough.
 */
export class ReadonlyURLSearchParams extends URLSearchParams {}

export function usePathname(): string {
  return "/";
}

export function useRouter() {
  return {
    push: () => {},
    replace: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {},
    prefetch: () => {},
  };
}

export function useSearchParams(): ReadonlyURLSearchParams {
  return new ReadonlyURLSearchParams();
}

export function useParams(): Record<string, string | string[]> {
  return {};
}

export function redirect(): never {
  throw new Error(
    "designbook shim: next/navigation redirect() called outside Next.js",
  );
}

export function notFound(): never {
  throw new Error(
    "designbook shim: next/navigation notFound() called outside Next.js",
  );
}
