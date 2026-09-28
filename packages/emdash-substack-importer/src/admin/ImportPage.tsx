import { Button } from "@cloudflare/kumo";
import { EmDashClient, markdownToPortableText } from "emdash/client";
import { apiFetch } from "emdash/plugin-utils";
import * as React from "react";

import { imageFallbacks, parseArchive, toMarkdown, type ArchivePost } from "./archive.js";
import "./import.css";

type Phase = "empty" | "reading" | "ready" | "importing" | "done";
type FailedPost = { slug: string; reason: string };
const pluginUrl = "/_emdash/api/plugins/emdash-substack-importer";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await apiFetch(path, init);
	let body: { success?: boolean; data?: T; error?: { message?: string } } | null = null;
	try { body = await response.json(); } catch { /* The host may return a non-JSON error. */ }
	if (!response.ok || body?.success !== true || !body.data) {
		throw new Error(body?.error?.message || `Request failed (HTTP ${response.status})`);
	}
	return body.data;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : "The import failed. Please try again.";
}

/** Import one image via the server: Substack's S3 objects do not permit browser CORS reads. */
async function localizeImages(blocks: ReturnType<typeof markdownToPortableText>, html: string, cache: Map<string, { mediaId: string; url: string }>) {
	const fallback = imageFallbacks(html);
	for (const block of blocks) {
		if (block._type !== "image") continue;
		const asset = block.asset as { url?: string; _ref?: string } | undefined;
		const url = asset?.url?.split(/\s+"/)[0];
		if (!url || !/\.(?:s3\.amazonaws\.com)\/public\/images\//.test(url)) continue;
		let image = cache.get(url);
		if (!image) {
			const result = await request<{ ok: boolean; error?: string; mediaId?: string; url?: string }>(`${pluginUrl}/media/import`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url, fallback: fallback.get(url), alt: block.alt }),
			});
			if (!result.ok || !result.mediaId || !result.url) throw new Error(result.error || "Image could not be copied");
			image = { mediaId: result.mediaId, url: result.url };
			cache.set(url, image);
		}
		block.asset = { ...asset, _ref: image.mediaId, url: image.url };
	}
}

export function ImportPage() {
	const [phase, setPhase] = React.useState<Phase>("empty");
	const [fileName, setFileName] = React.useState("");
	const [posts, setPosts] = React.useState<ArchivePost[]>([]);
	const [existing, setExisting] = React.useState<Set<string>>(new Set());
	const [progress, setProgress] = React.useState({ current: 0, total: 0, imported: 0, skipped: 0 });
	const [failures, setFailures] = React.useState<FailedPost[]>([]);
	const [error, setError] = React.useState("");
	const pause = React.useRef(false);
	const fileInput = React.useRef<HTMLInputElement>(null);

	async function selectFile(file?: File) {
		if (!file) return;
		setError("");
		setPhase("reading");
		setPosts([]);
		setFailures([]);
		try {
			if (!file.name.toLowerCase().endsWith(".zip")) throw new Error("Choose a Substack .zip export.");
			const parsed = parseArchive(new Uint8Array(await file.arrayBuffer()));
			const client = new EmDashClient({ baseUrl: window.location.origin });
			const schema = await client.collection("posts");
			if (!["title", "content", "excerpt"].every((field) => schema.fields.some((f) => f.slug === field))) {
				throw new Error("The posts collection needs title, content, and excerpt fields before importing.");
			}
			const slugs = new Set<string>();
			let cursor: string | undefined;
			do {
				const page = await client.list("posts", { limit: 100, cursor });
				for (const post of page.items) if (post.slug) slugs.add(post.slug);
				cursor = page.nextCursor;
			} while (cursor);
			setPosts(parsed);
			setExisting(slugs);
			setFileName(file.name);
			setProgress({ current: 0, total: parsed.length, imported: 0, skipped: 0 });
			setPhase("ready");
		} catch (cause) {
			setError(message(cause));
			setPhase("empty");
		}
	}

	async function startImport() {
		if (phase !== "ready" || !posts.length) return;
		pause.current = false;
		setPhase("importing");
		setError("");
		const found = new Set(existing);
		const imageCache = new Map<string, { mediaId: string; url: string }>();
		const failed: FailedPost[] = [];
		let imported = 0;
		let skipped = 0;
		for (const [index, post] of posts.entries()) {
			if (pause.current) break;
			if (found.has(post.slug)) {
				skipped++;
			} else {
				try {
					const content = markdownToPortableText(toMarkdown(post.html));
					await localizeImages(content, post.html, imageCache);
					const { item } = await request<{ item: { id: string } }>("/_emdash/api/content/posts", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							data: { title: post.title, content, ...(post.subtitle ? { excerpt: post.subtitle } : {}) },
							slug: post.slug,
							status: "draft",
							...(post.publishedAt ? { createdAt: post.publishedAt, publishedAt: post.publishedAt } : {}),
						}),
					});
					found.add(post.slug);
					if (post.published) {
						await request(`/_emdash/api/content/posts/${encodeURIComponent(item.id)}/publish`, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ publishedAt: post.publishedAt }),
						});
					}
					imported++;
				} catch (cause) {
					failed.push({ slug: post.slug, reason: message(cause) });
				}
			}
			setProgress({ current: index + 1, total: posts.length, imported, skipped });
			setFailures([...failed]);
			// Yield for the progress announcement and the Pause control.
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		setExisting(found);
		setPhase(pause.current ? "ready" : "done");
	}

	const alreadyHere = posts.filter((post) => existing.has(post.slug)).length;
	return (
		<main className="substack-import">
			<header className="substack-import__heading">
				<h1>Import from Substack</h1>
				<p>Move your writing and images into EmDash. Review the archive before anything changes.</p>
			</header>

			<section className="substack-import__section" aria-labelledby="archive-heading">
				<div className="substack-import__section-title"><h2 id="archive-heading">Choose an export</h2><span>ZIP archive</span></div>
				<input ref={fileInput} className="substack-import__file" type="file" accept=".zip,application/zip" aria-label="Substack export ZIP" disabled={phase === "importing" || phase === "reading"} onClick={(event) => { event.currentTarget.value = ""; }} onChange={(event) => void selectFile(event.target.files?.[0])} />
				<div className="substack-import__drop" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (phase !== "importing" && phase !== "reading") void selectFile(event.dataTransfer.files[0]); }}>
					<p>{fileName || "Drop a Substack export ZIP here"}</p>
					<Button type="button" variant="secondary" disabled={phase === "importing" || phase === "reading"} onClick={() => fileInput.current?.click()}>Choose ZIP</Button>
					<small>The ZIP stays in your browser. Subscriber lists are not imported.</small>
				</div>
			</section>

			{phase === "reading" && <p role="status">Reading posts and checking the site…</p>}
			{error && <p className="substack-import__error" role="alert">{error}</p>}

			{(phase === "ready" || phase === "importing" || phase === "done") && (
				<section className="substack-import__section" aria-labelledby="review-heading">
					<div className="substack-import__section-title"><h2 id="review-heading">Review import</h2><span>{posts.length} entries</span></div>
					<dl className="substack-import__summary">
						<div><dt>Published posts</dt><dd>{posts.filter((post) => post.published).length}</dd></div>
						<div><dt>Unpublished drafts</dt><dd>{posts.filter((post) => !post.published).length}</dd></div>
						<div><dt>Already on this site</dt><dd>{alreadyHere}</dd></div>
					</dl>
					<p>Existing slugs are skipped, not overwritten. Original dates and slugs are preserved; images are copied into the Media Library before each post is created. Podcast audio and subscribers are not imported.</p>
					{phase === "ready" && <Button type="button" onClick={() => void startImport()} disabled={alreadyHere === posts.length}>{progress.current > 0 ? "Resume import" : `Import ${posts.length - alreadyHere} entries`}</Button>}
					{phase === "importing" && <Button type="button" variant="secondary" onClick={() => { pause.current = true; }}>Pause after this post</Button>}
					{(phase === "importing" || phase === "done" || progress.current > 0) && (
						<div className="substack-import__progress" role="status" aria-live="polite">
							<progress max={progress.total} value={progress.current} aria-label="Posts processed" />
							<p>{progress.current} of {progress.total} processed · {progress.imported} imported · {progress.skipped} skipped · {failures.length} need attention</p>
						</div>
					)}
					{phase === "done" && <p className="substack-import__complete">Import finished. Review your posts before sharing the site.</p>}
				</section>
			)}

			{failures.length > 0 && <section className="substack-import__section" aria-labelledby="failures-heading"><h2 id="failures-heading">Needs attention</h2><p>These entries were not completed. A post whose publish step failed may be saved as a draft; review it in EmDash before retrying.</p><ul>{failures.map((entry) => <li key={entry.slug}><strong>{entry.slug}</strong><span>{entry.reason}</span></li>)}</ul></section>}
		</main>
	);
}
