import { describe, expect, it } from "vitest";
import { parseCliArgs, DEFAULT_PORT } from "./cli.ts";

describe("parseCliArgs", () => {
  it("defaults to port 8791 and all cases", () => {
    const options = parseCliArgs([]);
    expect(options.port).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(8791);
    expect(options.cases).toBeUndefined();
    expect(options.vision).toBe(false);
    expect(options.approve).toEqual([]);
  });

  it("parses --port with a space or = form", () => {
    expect(parseCliArgs(["--port", "8801"]).port).toBe(8801);
    expect(parseCliArgs(["--port=8801"]).port).toBe(8801);
  });

  it("rejects an invalid port", () => {
    expect(() => parseCliArgs(["--port", "0"])).toThrow(/invalid port/);
    expect(() => parseCliArgs(["--port", "abc"])).toThrow(/invalid port/);
  });

  it("collects repeated and comma-separated --case filters", () => {
    expect(parseCliArgs(["--case", "solid-bg", "--case", "text-basic"]).cases).toEqual(
      ["solid-bg", "text-basic"],
    );
    expect(parseCliArgs(["--case", "solid-bg,token-colors"]).cases).toEqual([
      "solid-bg",
      "token-colors",
    ]);
  });

  it("parses --vision and --vision all", () => {
    const flagged = parseCliArgs(["--vision"]);
    expect(flagged.vision).toBe(true);
    expect(flagged.visionAll).toBe(false);
    const all = parseCliArgs(["--vision", "all"]);
    expect(all.vision).toBe(true);
    expect(all.visionAll).toBe(true);
  });

  it("parses --approve id, list, and bare (all)", () => {
    expect(parseCliArgs(["--approve", "solid-bg"]).approve).toEqual(["solid-bg"]);
    expect(parseCliArgs(["--approve", "a,b"]).approve).toEqual(["a", "b"]);
    const bare = parseCliArgs(["--approve"]);
    expect(bare.approveAll).toBe(true);
    expect(parseCliArgs(["--approve", "all"]).approveAll).toBe(true);
  });

  it("parses --keep-results and --help", () => {
    expect(parseCliArgs(["--keep-results"]).keepResults).toBe(true);
    expect(parseCliArgs(["--help"]).help).toBe(true);
    expect(parseCliArgs(["-h"]).help).toBe(true);
  });

  it("throws on an unknown argument", () => {
    expect(() => parseCliArgs(["--nope"])).toThrow(/Unknown argument/);
  });
});
