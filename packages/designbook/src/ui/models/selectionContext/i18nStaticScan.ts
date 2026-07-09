/**
 * Static i18next-usage scanner for the selection-context i18n contributor
 * (PREVIEW — docs/specs/selection-context.md).
 *
 * Pure source-text scan (regex, no AST — fine for preview) over the i18next
 * call shapes:
 *   - `t("key")` / `t('key')` / `` t(`key`) `` (static template);
 *   - `<Trans i18nKey="key">` / `i18nKey='key'`;
 *   - `` t(`…${expr}…`) `` — DYNAMIC template keys, flagged non-enumerable.
 *
 * `\bt\(` requires a word boundary before `t`, so `split(`, `format(` etc.
 * don't match, while `i18n.t(` and bare `t(` do.
 */

type StaticI18nScan = {
  /** Static keys, deduped, in order of first appearance. */
  keys: string[];
  /** Dynamic template-key snippets (non-enumerable), deduped. */
  dynamic: string[];
};

const T_DOUBLE = /\bt\(\s*"((?:[^"\\]|\\.)+)"/g;
const T_SINGLE = /\bt\(\s*'((?:[^'\\]|\\.)+)'/g;
const T_TEMPLATE_STATIC = /\bt\(\s*`([^`$]+)`/g;
const T_TEMPLATE_DYNAMIC = /\bt\(\s*(`[^`]*\$\{[^`]*`)/g;
const TRANS_KEY = /<Trans[^>]*\si18nKey\s*=\s*(?:"([^"]+)"|'([^']+)')/g;

function collect(regex: RegExp, source: string, groupCount = 1): string[] {
  const out: string[] = [];
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source))) {
    for (let group = 1; group <= groupCount; group++) {
      if (match[group]) out.push(match[group]);
    }
  }
  return out;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Scan one source file's text for i18next key usage. */
function scanI18nSource(source: string): StaticI18nScan {
  const keys = dedupe([
    ...collect(T_DOUBLE, source),
    ...collect(T_SINGLE, source),
    ...collect(T_TEMPLATE_STATIC, source),
    ...collect(TRANS_KEY, source, 2),
  ]);
  const dynamic = dedupe(collect(T_TEMPLATE_DYNAMIC, source)).map(
    (snippet) => `t(${snippet})`,
  );
  return { keys, dynamic };
}

/** Merge multiple file scans, preserving order and deduping. */
function mergeScans(scans: StaticI18nScan[]): StaticI18nScan {
  return {
    keys: dedupe(scans.flatMap((scan) => scan.keys)),
    dynamic: dedupe(scans.flatMap((scan) => scan.dynamic)),
  };
}

/** Strip an `ns:` prefix so static keys compare against marker keys. */
function baseKey(key: string): string {
  const separator = key.indexOf(":");
  return separator > -1 ? key.slice(separator + 1) : key;
}

export { baseKey, mergeScans, scanI18nSource };
export type { StaticI18nScan };
