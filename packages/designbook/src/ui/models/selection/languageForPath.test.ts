import { describe, expect, it } from "vitest";
import { languageForPath } from "@designbook-ui/models/selection/languageForPath";

describe("languageForPath", () => {
  it("maps .css to css", () => {
    expect(languageForPath("src/App.css")).toBe("css");
  });

  it("maps .json to json", () => {
    expect(languageForPath("locales/en-US/app.json")).toBe("json");
  });

  it("maps .ts and .tsx to typescript", () => {
    expect(languageForPath("src/atoms.ts")).toBe("typescript");
    expect(languageForPath("src/atoms.tsx")).toBe("typescript");
  });

  it("maps .js and .jsx to javascript", () => {
    expect(languageForPath("src/atoms.js")).toBe("javascript");
    expect(languageForPath("src/atoms.jsx")).toBe("javascript");
  });

  it("falls back to text for unknown extensions", () => {
    expect(languageForPath("README.md")).toBe("text");
  });
});
