# Examples & fixtures

`demo` is the showcase app. The rest are minimal fixtures exercising specific
integration paths — kept here so they're all in one place and stay runnable
against the current workspace build (`@designbookapp/designbook: workspace:*`, no stale
tarballs).

Build designbook first: `pnpm --filter '@designbookapp/designbook' build` (from repo root).

| Dir | Purpose | App port | Sidecar | Run |
| --- | --- | --- | --- | --- |
| `demo` | Full showcase (host mode; shop app) | 3010 | 8787 | `pnpm demo` / `pnpm demo:lan` (root) |
| `i18n-app` | react-i18next fixture — page text tool, locale writes | 3015 | 8794 | `pnpm example:i18n` (root) |
| `tw4-app` | Tailwind v4 fixture — `:root` token forwarding into shadow cells | 3016 | 8795 | `pnpm example:tw4` (root) |
| `init-app` | `designbook init` target — fresh Vite app for exercising init/codegen | 3014 | 8793 | `pnpm example:init` (root) |

Notes:

- Sidecar API also listens directly on sidecar port + 1 (`--api-port`).
- These are fixtures, not docs — for setup guidance see the
  [documentation site](https://docs.designbook.app).
