# EmDash plugins

A Bun workspace of EmDash plugins. Each directory under `packages/` is a separate plugin package.

| Package | Status |
| --- | --- |
| [`emdash-substack-importer`](packages/emdash-substack-importer/) | Native plugin scaffold; migration CLI extracted and working. ZIP-upload admin UI is not implemented yet. |

```bash
bun install
bun run typecheck
bun run build
```

No exported archives, subscriber lists, login credentials, or uploaded media belong in this repository.
