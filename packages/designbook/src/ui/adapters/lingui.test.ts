import { describe, expect, it } from "vitest";
import { linguiAdapter, type LinguiI18n } from "./lingui";
import {
  decodeMarker,
  getMarkerEntry,
} from "@designbook-ui/models/text/i18nMarkers";

const SENTINEL_START = "⁡";

/**
 * A minimal stand-in for `@lingui/core`'s `I18n`, reproducing the two behaviors
 * the adapter depends on: `_` echoes the id when a message is missing, and `t`
 * is a pre-bound alias of the original `_` (the aliasing gotcha the patch must
 * handle).
 */
function makeFakeI18n(
  locale = "en",
  messages: Record<string, unknown> = {},
): LinguiI18n {
  const inst: LinguiI18n = {
    locale,
    messages,
    _(id) {
      const key = typeof id === "string" ? id : (id as { id?: string }).id;
      const message = key ? this.messages[key] : undefined;
      return typeof message === "string" ? message : key;
    },
    t(id, values, opts) {
      return this._(id, values, opts);
    },
    load(localeOrMessages, msgs) {
      const table =
        typeof localeOrMessages === "string"
          ? { [localeOrMessages]: msgs }
          : (localeOrMessages as Record<string, Record<string, unknown>>);
      for (const [loc, mm] of Object.entries(table)) {
        if (loc === this.locale) Object.assign(this.messages, mm);
      }
    },
  };
  inst.t = inst._.bind(inst);
  return inst;
}

function countMarkers(text: string): number {
  return [...text].filter((ch) => ch === SENTINEL_START).length;
}

const catalogPath = "packages/lib/translations/{locale}/web.po";

describe("linguiAdapter option parsing", () => {
  it("exposes the lingui adapter name", () => {
    const adapter = linguiAdapter({ i18n: makeFakeI18n(), catalogPath });
    expect(adapter.name).toBe("lingui");
    expect(typeof adapter.resolveText).toBe("function");
    expect(typeof adapter.previewText).toBe("function");
  });
});

describe("linguiAdapter marker seam", () => {
  it("appends a decodable marker whose entry round-trips to the msgid", async () => {
    const i18n = makeFakeI18n();
    const adapter = linguiAdapter({ i18n, catalogPath });
    await adapter.setup?.();

    const rendered = i18n._("Close") as string;
    // Displayed text is unchanged apart from the invisible marker.
    expect(rendered.startsWith("Close")).toBe(true);

    const index = decodeMarker(rendered);
    expect(index).not.toBeUndefined();
    const entry = getMarkerEntry(index!);
    expect(entry?.resolvedKey).toBe("Close");
    // Namespace is derived from the catalog filename "web.po".
    expect(entry?.namespace).toBe("web");
  });

  it("marks the pre-bound `t` alias too", async () => {
    const i18n = makeFakeI18n();
    await linguiAdapter({ i18n, catalogPath }).setup?.();

    const rendered = i18n.t("Save changes") as string;
    const index = decodeMarker(rendered);
    expect(getMarkerEntry(index!)?.resolvedKey).toBe("Save changes");
  });

  it("honors an explicit namespace override", async () => {
    const i18n = makeFakeI18n();
    await linguiAdapter({ i18n, catalogPath, namespace: "custom" }).setup?.();

    const rendered = i18n._("Namespaced") as string;
    const entry = getMarkerEntry(decodeMarker(rendered)!);
    expect(entry?.namespace).toBe("custom");
  });

  it("is idempotent — a second setup does not double-mark", async () => {
    const i18n = makeFakeI18n();
    const adapter = linguiAdapter({ i18n, catalogPath });
    await adapter.setup?.();
    await adapter.setup?.();

    const rendered = i18n._("Once") as string;
    expect(countMarkers(rendered)).toBe(1);
  });

  it("leaves non-string / empty results untouched", async () => {
    const i18n = makeFakeI18n();
    await linguiAdapter({ i18n, catalogPath }).setup?.();

    // Empty result -> no marker appended (would be an un-hittable dangling marker).
    expect(countMarkers(i18n._("") as string)).toBe(0);
  });

  it("reflects the resolved translation for a loaded message", async () => {
    const i18n = makeFakeI18n("en", { Close: "Close" });
    await linguiAdapter({ i18n, catalogPath }).setup?.();

    i18n.load({ en: { Close: "Dismiss" } });
    const rendered = i18n._("Close") as string;
    expect(rendered.startsWith("Dismiss")).toBe(true);
    expect(getMarkerEntry(decodeMarker(rendered)!)?.resolvedKey).toBe("Close");
  });
});
