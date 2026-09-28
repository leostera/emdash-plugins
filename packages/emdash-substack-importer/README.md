# EmDash Substack Importer

Native EmDash plugin scaffold plus the extracted Substack migration CLI. **The drop-a-ZIP admin experience is not implemented yet.** Do not register the plugin in a production site expecting a working upload screen.

## Run the existing migration CLI

Unzip your Substack export to a directory containing `posts.csv` and `posts/*.html`. It may also contain `email_list.*.csv`, which the CLI **never reads**. Keep it outside Git. The site must already have a `posts` collection, a `content` Portable Text field, an `excerpt` field, and routes for its chosen URL pattern.

```bash
bun install
bunx emdash login --url https://example.com
bun --filter @leostera/emdash-substack-importer import:substack --url=https://example.com --archive=/private/path/to/export
# After reviewing the dry run:
bun --filter @leostera/emdash-substack-importer import:substack --url=https://example.com --archive=/private/path/to/export --apply
bun --filter @leostera/emdash-substack-importer migrate:images --url=https://example.com --archive=/private/path/to/export --apply
bun --filter @leostera/emdash-substack-importer cleanup:images --url=https://example.com --archive=/private/path/to/export --apply
```

`--url-pattern=/{slug}` on the import command is optional; use it only if your actual Astro pages serve posts at the root. Commands are dry-run by default. Re-running skips existing slugs and already-migrated image blocks. Unpublished posts remain drafts. The importer preserves exported publish timestamps and imports image references through EmDash media storage. The cleanup removes paragraphs produced by Substack's linked-image HTML when converting to Portable Text.

## Native plugin roadmap

1. Add an authenticated, admin-only React page with ZIP upload, validation, analysis, and a review/confirmation screen.
2. Stage archive contents securely and process posts/media in bounded, resumable batches. Plugin route request bodies are limited to 8 MiB (multipart parts to 1 MiB); larger exports need a direct-to-storage upload path rather than sending the whole ZIP to a plugin route. Preserve timestamps, slugs, draft state, and media references without overwriting existing posts.
3. Show progress, conflicts, and a receipt; test on Cloudflare Workers and Node.js. Do not silently import subscriber email addresses or send any emails—newsletter migration requires an explicit destination and consent review.

A native plugin is required for the planned React admin and large-file orchestration. Unlike sandboxed plugins, native packages run with the site's authority, so only install code from a trusted source. The plugin is not registered in `leostera.com` while these features are unfinished.
