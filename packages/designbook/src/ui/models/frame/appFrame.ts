/**
 * Pure helpers for the App page's frame cell.
 *
 * The frame cell is a same-origin `<iframe>` of the running app: `buildFrameSrc`
 * turns a free-typed, workbench-relative path into the iframe `src`, carrying
 * the `?__designbook_frame=1` marker the boot module's recursion guard checks
 * (see `frameGuard.ts` in the node package — the guard predicate is mirrored
 * there, not imported, since it runs in the browser before any module graph
 * exists).
 */

/** Query param the frame cell's `src` carries — kept in sync with `frameGuard.ts`. */
const FRAME_QUERY_PARAM = "__designbook_frame";

/** Route the App page shows on a direct workbench visit (not via expand-from-strip). */
const DEFAULT_APP_PATH = "/";

/** Normalize a free-typed path into a same-origin absolute path (leading "/"). */
function normalizeAppPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return DEFAULT_APP_PATH;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** Split a `pathname[?search]` string into its two parts (search sans "?"). */
function splitPathAndSearch(pathWithSearch: string): [string, string] {
  const index = pathWithSearch.indexOf("?");
  if (index === -1) return [pathWithSearch, ""];
  return [pathWithSearch.slice(0, index), pathWithSearch.slice(index + 1)];
}

/**
 * Build the iframe `src` for a workbench-relative path: normalizes it and
 * appends the recursion-guard query param, preserving any query the path
 * already carries.
 */
function buildFrameSrc(path: string): string {
  const [pathname, search] = splitPathAndSearch(normalizeAppPath(path));
  const params = new URLSearchParams(search);
  params.set(FRAME_QUERY_PARAM, "1");
  return `${pathname}?${params.toString()}`;
}

/** Strip the recursion-guard query param back off — for display and "open in tab". */
function stripFrameParam(pathWithSearch: string): string {
  const [pathname, search] = splitPathAndSearch(pathWithSearch);
  const params = new URLSearchParams(search);
  params.delete(FRAME_QUERY_PARAM);
  const rest = params.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}

export {
  DEFAULT_APP_PATH,
  FRAME_QUERY_PARAM,
  buildFrameSrc,
  normalizeAppPath,
  stripFrameParam,
};
