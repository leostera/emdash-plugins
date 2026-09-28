# EmDash plugins

A Bun workspace of EmDash plugins. Each directory under `packages/` is a separate plugin package.

| Package | Status |
| --- | --- |
| [`emdash-substack-importer`](packages/emdash-substack-importer/) | Native ZIP-import admin page with preview, progress, content and image migration; CLI remains available. Not yet deployed to a site. |

```bash
bun install
bun run typecheck
bun run build
```

No exported archives, subscriber lists, login credentials, or uploaded media belong in this repository.
