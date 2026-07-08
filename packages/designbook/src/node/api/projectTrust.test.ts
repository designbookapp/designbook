/**
 * Project-trust default (product backlog #4, launch-minimal): designbook
 * passes an explicit `SettingsManager` into `createAgentSession()` so the
 * project defaults to UNTRUSTED — a repo's `.pi/settings.json` and
 * `.pi/extensions/*.ts` must not load unless `--trust-project` is passed.
 *
 * This test exercises the SDK primitive designbook's fix relies on
 * (`SettingsManager.create(cwd, agentDir, { projectTrusted })`) directly,
 * since that's the pure seam: `createApi()` itself has side effects (reads
 * the real `~/.pi/agent/auth.json`, etc.) that make it a poor unit-test
 * target. See `src/node/api/api.ts`'s `createSession()`.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

describe("SettingsManager project trust (default-untrusted fix)", () => {
  let projectDir: string;
  let agentDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "designbook-trust-project-"));
    agentDir = mkdtempSync(join(tmpdir(), "designbook-trust-agent-"));
    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pi", "settings.json"),
      JSON.stringify({ defaultModel: "should-not-load" }),
    );
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("does NOT load .pi/settings.json when projectTrusted is false (designbook's default)", () => {
    const manager = SettingsManager.create(projectDir, agentDir, {
      projectTrusted: false,
    });
    expect(manager.isProjectTrusted()).toBe(false);
    expect(manager.getProjectSettings()).toEqual({});
    expect(manager.getDefaultModel()).toBeUndefined();
  });

  it("DOES load .pi/settings.json when projectTrusted is true (--trust-project)", () => {
    const manager = SettingsManager.create(projectDir, agentDir, {
      projectTrusted: true,
    });
    expect(manager.isProjectTrusted()).toBe(true);
    expect(manager.getProjectSettings()).toEqual({
      defaultModel: "should-not-load",
    });
    expect(manager.getDefaultModel()).toBe("should-not-load");
  });

  it("defaults to trusted when no options are passed (why designbook must pass an explicit settingsManager)", () => {
    const manager = SettingsManager.create(projectDir, agentDir);
    expect(manager.isProjectTrusted()).toBe(true);
  });
});
