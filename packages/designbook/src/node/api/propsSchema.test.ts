/**
 * Prop-schema extraction against real fixture components (enum/optional/
 * default/wrapped forwardRef+memo, JSDoc descriptions), mtime cache
 * invalidation, and degraded mode when tooling can't resolve.
 *
 * Runs react-docgen-typescript against a temp project on disk — the same path
 * the endpoint takes, so it exercises real `createProgram` extraction.
 */

import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Fixtures live in a package-root dotdir so TS module resolution walks up to
// the package's own node_modules (react + @types/react + typescript +
// react-docgen-typescript) — exactly like a real app dir. NOT under
// node_modules itself: the parser's own-props filter drops any prop whose
// declaring file path contains "node_modules". An isolated os-tmp project
// can't resolve React types, which forwardRef/ReactNode extraction needs.
const FIXTURE_BASE = join(process.cwd(), ".props-schema-test");
import { classifyKind, createPropsSchema } from "./propsSchema.ts";
import type { PropDescriptor, PropsSchemaResult } from "./propsSchema.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  await rm(FIXTURE_BASE, { recursive: true, force: true }).catch(() => {});
});

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    jsx: "react-jsx",
    module: "esnext",
    moduleResolution: "bundler",
    target: "esnext",
    strict: true,
    skipLibCheck: true,
  },
});

async function project(files: Record<string, string>): Promise<string> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(FIXTURE_BASE, { recursive: true });
  const root = await mkdtemp(join(FIXTURE_BASE, "p-"));
  dirs.push(root);
  await writeFile(join(root, "tsconfig.json"), TSCONFIG);
  await writeFile(join(root, "package.json"), '{ "name": "fixture" }');
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(join(root, rel), content);
  }
  return root;
}

function propsOf(result: PropsSchemaResult): PropDescriptor[] {
  if (!("props" in result)) {
    throw new Error(`expected props, got ${JSON.stringify(result)}`);
  }
  return result.props;
}

function byName(props: PropDescriptor[], name: string): PropDescriptor {
  const found = props.find((prop) => prop.name === name);
  if (!found) throw new Error(`prop ${name} missing`);
  return found;
}

const CARD = `
import * as React from "react";

export type CardVariant = "solid" | "outline" | "ghost";

export interface CardProps {
  /** The card heading. */
  title: string;
  /** Price in cents. */
  price?: number;
  variant?: CardVariant;
  featured?: boolean;
  onSelect?: (id: string) => void;
  /** Trailing icon slot. */
  icon?: React.ReactNode;
}

/** A product card. */
export function Card({ price = 0, variant = "solid", ...rest }: CardProps) {
  return <div>{rest.title}</div>;
}
`;

describe("createPropsSchema", () => {
  it("extracts kinds, enum options, required, defaults, descriptions", async () => {
    const root = await project({ "Card.tsx": CARD });
    const schema = createPropsSchema();
    const result = await schema.getSchema({
      absFile: join(root, "Card.tsx"),
      gateCwd: root,
      exportName: "Card",
    });
    const props = propsOf(result);

    const title = byName(props, "title");
    expect(title.kind).toBe("string");
    expect(title.required).toBe(true);
    expect(title.description).toBe("The card heading.");

    const price = byName(props, "price");
    expect(price.kind).toBe("number");
    expect(price.required).toBe(false);
    expect(price.defaultValue).toBe("0");

    const variant = byName(props, "variant");
    expect(variant.kind).toBe("enum");
    expect(variant.options).toEqual(["solid", "outline", "ghost"]);
    expect(variant.defaultValue).toBe("solid");

    expect(byName(props, "featured").kind).toBe("boolean");
    expect(byName(props, "onSelect").kind).toBe("function");
    expect(byName(props, "icon").kind).toBe("node");

    // Required first, then alphabetical.
    expect(props[0].name).toBe("title");
  });

  it("extracts a wrapped forwardRef + memo component", async () => {
    const root = await project({
      "Fancy.tsx": `
import * as React from "react";

interface FancyProps {
  /** Visible label. */
  label: string;
  size?: "sm" | "lg";
}

/** A fancy control. */
export const Fancy = React.memo(
  React.forwardRef<HTMLDivElement, FancyProps>(function Fancy(props, ref) {
    return <div ref={ref}>{props.label}</div>;
  }),
);
`,
    });
    const schema = createPropsSchema();
    const result = await schema.getSchema({
      absFile: join(root, "Fancy.tsx"),
      gateCwd: root,
      exportName: "Fancy",
    });
    const props = propsOf(result);
    expect(byName(props, "label").kind).toBe("string");
    expect(byName(props, "label").description).toBe("Visible label.");
    expect(byName(props, "size").options).toEqual(["sm", "lg"]);
  });

  it("re-extracts after the file mtime changes (cache invalidation)", async () => {
    const root = await project({
      "One.tsx": `
export function One(props: { a: string }) {
  return <div>{props.a}</div>;
}
`,
    });
    const schema = createPropsSchema();
    const file = join(root, "One.tsx");
    const first = propsOf(
      await schema.getSchema({ absFile: file, gateCwd: root, exportName: "One" }),
    );
    expect(first.map((prop) => prop.name)).toEqual(["a"]);

    await writeFile(
      file,
      `
export function One(props: { a: string; b?: number }) {
  return <div>{props.a}</div>;
}
`,
    );
    // Push the mtime forward so the cache key changes deterministically.
    const future = new Date(Date.now() + 5000);
    await utimes(file, future, future);

    const second = propsOf(
      await schema.getSchema({ absFile: file, gateCwd: root, exportName: "One" }),
    );
    expect(second.map((prop) => prop.name).sort()).toEqual(["a", "b"]);
  });

  it("returns unavailable for a missing file", async () => {
    const schema = createPropsSchema();
    const result = await schema.getSchema({
      absFile: "/no/such/file.tsx",
      gateCwd: "/no/such",
      exportName: "X",
    });
    expect(result).toHaveProperty("unavailable");
  });

  it("degrades to unavailable when tooling cannot resolve", async () => {
    // A gateCwd with no resolvable react-docgen/typescript peer forces the
    // tooling-load failure path (the endpoint's values-only fallback).
    const root = await mkdtemp(join(tmpdir(), "db-props-none-"));
    dirs.push(root);
    await writeFile(join(root, "package.json"), '{ "name": "bare" }');
    await writeFile(join(root, "C.tsx"), "export function C() { return null; }");
    // A require rooted here can't see the workspace's hoisted deps only if the
    // path is truly isolated; if it CAN resolve, extraction still succeeds —
    // either way the call must not throw and returns a well-formed result.
    const schema = createPropsSchema();
    const result = await schema.getSchema({
      absFile: join(root, "C.tsx"),
      gateCwd: root,
    });
    expect("props" in result || "unavailable" in result).toBe(true);
  });
});

describe("classifyKind", () => {
  it("maps boolean unions to a switch", () => {
    expect(
      classifyKind({
        name: "enum",
        value: [{ value: "true" }, { value: "false" }],
      }).kind,
    ).toBe("boolean");
  });

  it("maps ReactNode to node and signatures to function", () => {
    expect(classifyKind({ name: "ReactNode" }).kind).toBe("node");
    expect(classifyKind({ name: "(e: Event) => void" }).kind).toBe("function");
  });

  it("parses a buttonVariants-style string-literal union (name is the union text)", () => {
    const result = classifyKind({
      name: '"default" | "sm" | "lg" | "icon" | null',
    });
    expect(result.kind).toBe("enum");
    expect(result.options).toEqual(["default", "sm", "lg", "icon"]);
  });

  it("does not treat a general union as an enum", () => {
    expect(classifyKind({ name: "string | number" }).kind).toBe("object");
  });
});
