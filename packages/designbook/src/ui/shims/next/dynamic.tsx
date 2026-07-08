/**
 * Stand-in for `next/dynamic`: no webpack/Turbopack loadable-components
 * pipeline here, so this just wraps the loader in `React.lazy` + `Suspense`.
 * Handles both `() => import(...)` (module with a `default` export) and a
 * loader that resolves directly to a component. `ssr: false` is a no-op —
 * there's no SSR pass to skip inside the workbench. Auto-aliased when the
 * target repo depends on `next` (see src/node/userVite.ts).
 */
import { lazy, Suspense, type ComponentType } from "react";

export type DynamicOptions = {
  loading?: ComponentType;
  ssr?: boolean;
};

type DynamicLoader<P> = () => Promise<
  { default: ComponentType<P> } | ComponentType<P>
>;

function dynamic<P extends object = object>(
  loader: DynamicLoader<P>,
  options?: DynamicOptions,
) {
  const LazyComponent = lazy(async () => {
    const mod = await loader();
    const Component =
      typeof mod === "function" ? mod : (mod as { default: ComponentType<P> }).default;
    return { default: Component };
  });

  const Loading = options?.loading;

  function DynamicComponent(props: P) {
    return (
      <Suspense fallback={Loading ? <Loading /> : null}>
        <LazyComponent {...props} />
      </Suspense>
    );
  }

  return DynamicComponent;
}

export default dynamic;
