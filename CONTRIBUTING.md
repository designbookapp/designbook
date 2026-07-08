# Contributing to designbook

Thanks for your interest! designbook is early (0.x) and moving fast, so this is a
lightweight process.

## Bugs & feature requests

Open an [issue](https://github.com/designbookapp/designbook/issues). Use the bug or
feature templates — a minimal reproduction (repo, Vite version, config snippet) makes
bugs dramatically faster to fix.

Please **don't open a public issue for security problems** — see the
[security model](https://docs.designbook.app/reference/security/) and report privately
via GitHub's "Report a vulnerability" (Security tab).

## Pull requests

Small, focused PRs are welcome. For anything beyond a bugfix or doc tweak, open an
issue first so we can agree on the direction before you invest time — the APIs are
still shifting between minor versions.

### Setup

```bash
pnpm install
pnpm --filter '@designbookapp/designbook' build        # compile cli/plugin/config + UI to dist
```

### Before you push

```bash
pnpm --filter '@designbookapp/designbook' test:run     # vitest
pnpm --filter '@designbookapp/designbook' check-types  # tsc (node + ui)
pnpm --filter '@designbookapp/designbook' lint:layers  # architecture layer lint
```

CI runs exactly these (see `.github/workflows/ci.yml`), so a green local run should
mean a green PR.

### Trying your change

The fastest loop is the demo app: `examples/demo` consumes the workspace package.
Run its `design` script and the workbench at `http://localhost:8787/` reflects your
changes.

## Code notes

- The npm package is `packages/designbook`: CLI (`src/cli`), Vite plugin + sidecar
  (`src/node`), workbench UI (`src/ui`), public config API (`src/config`).
- `src/config` is pure and framework-free — keep it that way (the layer lint enforces
  the boundaries).
- Docs live in `docs-site/` (Astro Starlight); doc-only PRs are very welcome.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
