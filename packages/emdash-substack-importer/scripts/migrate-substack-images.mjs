// Move imported Portable Text images from Substack S3 into EmDash's private R2 bucket.
// Dry-run by default; --apply uploads media and patches only the affected content fields.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { EmDashClient } from "emdash/client";
import { parse } from "csv-parse/sync";
import { site, archive } from "./config.mjs";
const apply = process.argv.includes("--apply");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;
if (!(limit > 0)) throw new Error("--limit must be positive");
const maxBytes = 50 * 1024 * 1024;
const allowedHosts = new Set([
	"substack-post-media.s3.amazonaws.com",
	"bucketeer-e05bbc84-baa3-437e-9518-adb32be77984.s3.amazonaws.com",
]);
const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };
function isSubstackImage(url) {
	if (typeof url !== "string") return false;
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" && allowedHosts.has(parsed.hostname);
	} catch { return false; }
}
function images(blocks) {
	const found = [];
	for (const block of blocks) {
		if (block?._type === "image" && (isSubstackImage(block.asset?.url) || block.asset?.url === "/_emdash/api/media/file/undefined")) found.push(block);
		if (block?._type === "gallery" && Array.isArray(block.images)) found.push(...images(block.images));
		if (block?._type === "columns" && Array.isArray(block.columns)) {
			for (const column of block.columns) if (Array.isArray(column.content)) found.push(...images(column.content));
		}
	}
	return found;
}

const credentialsPath = resolve(homedir(), ".config/emdash/auth.json");
const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
const login = credentials[site];
if (!login?.accessToken) throw new Error(`Log in first: bunx emdash login --url ${site}`);
const client = new EmDashClient({
	baseUrl: site,
	token: login.accessToken,
	refreshToken: login.refreshToken,
	onTokenRefresh: async (accessToken, expiresIn) => {
		credentials[site] = { ...credentials[site], accessToken, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
		await writeFile(credentialsPath, JSON.stringify(credentials, null, 2) + "\n", { mode: 0o600 });
	},
});
const posts = [];
let cursor;
do {
	const page = await client.list("posts", { limit: 100, cursor });
	posts.push(...page.items);
	cursor = page.nextCursor;
} while (cursor);

let mediaCursor;
const mediaByFilename = new Map();
const mediaById = new Map();
if (apply) do {
	const page = await client.mediaList({ limit: 100, cursor: mediaCursor });
	for (const media of page.items) {
		mediaByFilename.set(media.filename, media);
		mediaById.set(media.id, media);
	}
	mediaCursor = page.nextCursor;
} while (mediaCursor);

// Only query posts whose archived HTML contains image tags. This avoids 69 remote
// content reads when most posts have no images and includes both drafts and live posts.
const exportRows = parse(await readFile(resolve(archive, "posts.csv"), "utf8"), { columns: true, skip_empty_lines: true });
const imageSlugs = new Set();
const cdnFallbacks = new Map();
for (const row of exportRows) {
	const html = await readFile(resolve(archive, "posts", `${row.post_id}.html`), "utf8");
	if (/<img\b/i.test(html)) imageSlugs.add(row.post_id.split(".").slice(1).join("."));
	// Some old Substack S3 objects are private, but their public CDN copies still work.
	for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
		const source = tag.match(/\bsrc="([^"]+)"/)?.[1];
		if (!isSubstackImage(source)) continue;
		const variants = [...html.matchAll(/https:\/\/substackcdn\.com\/image\/fetch\/[^"'\s<>]+/g)]
			.map(([url]) => url)
			.filter((url) => {
				try { return decodeURIComponent(new URL(url).pathname.split("/").at(-1)) === source; }
				catch { return false; }
			});
		const fullSize = variants.find((url) => !/[,/]w_\d+/.test(url));
		if (fullSize) cdnFallbacks.set(source, fullSize);
	}
}
const pending = [];
for (const post of posts.filter((post) => imageSlugs.has(post.slug))) {
	const item = await client.get("posts", post.id, { raw: true });
	const found = images(item.data.content ?? []);
	if (found.length) pending.push({ item, count: found.length });
}
console.log(`${pending.length} posts contain ${pending.reduce((sum, p) => sum + p.count, 0)} Substack image blocks.`);
if (!apply) {
	console.log("Dry run: no changes made. Run with --apply to upload and update; --limit=N limits posts.");
	process.exit(0);
}

async function download(url) {
	// Never fetch arbitrary content-controlled URLs or redirect to a different host.
	if (!isSubstackImage(url)) throw new Error("URL is not an allowed Substack image");
	let response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(45_000) });
	if (!response.ok && cdnFallbacks.has(url)) {
		response = await fetch(cdnFallbacks.get(url), { redirect: "error", signal: AbortSignal.timeout(45_000) });
	}
	if (!response.ok) throw new Error(`Image fetch failed: HTTP ${response.status} (${new URL(url).pathname}), CDN fallback: ${cdnFallbacks.has(url)}`);
	const declaredMime = response.headers.get("content-type")?.split(";")[0].toLowerCase();
	if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("Image exceeds 50 MB");
	const chunks = [];
	let total = 0;
	for await (const chunk of response.body) {
		total += chunk.byteLength;
		if (total > maxBytes) throw new Error("Image exceeds 50 MB");
		chunks.push(chunk);
	}
	const bytes = Buffer.concat(chunks);
	// Older S3 uploads sometimes have application/octet-stream despite being images.
	const mime = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? "image/jpeg"
		: bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
		: bytes.toString("ascii", 0, 4) === "GIF8" ? "image/gif"
		: bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp"
		: bytes.toString("ascii", 4, 12).includes("ftypavif") ? "image/avif" : null;
	if (!mime || !extensions[mime]) throw new Error(`Unrecognized image bytes (content type ${declaredMime})`);
	return { bytes, mime, ext: extensions[mime] };
}

let updated = 0, uploaded = 0, reused = 0;
for (const { item } of pending.slice(0, limit)) {
	if (item.status === "published" && item.draftRevisionId) {
		console.log(`SKIP ${item.slug}: an editor has an unpublished draft; don't overwrite it`);
		continue;
	}
	const content = structuredClone(item.data.content);
	for (const block of images(content)) {
		// EmDash's Markdown parser can include an HTML image's optional title in
		// the URL (`image.jpg "caption"`); remove that title before fetching.
		const source = block.asset.url.split(/\s+"/)[0];
		let media;
		if (source === "/_emdash/api/media/file/undefined") {
			media = mediaById.get(block.asset._ref);
			if (!media) throw new Error(`Missing already-uploaded media for ${item.slug}`);
		} else {
			const digest = createHash("sha256").update(source).digest("hex").slice(0, 20);
			const known = [...mediaByFilename.entries()].find(([name]) => name.startsWith(`substack-${digest}.`));
			media = known?.[1];
			if (!media) {
				const { bytes, mime, ext } = await download(source);
				media = await client.mediaUpload(bytes, `substack-${digest}.${ext}`, { alt: block.alt, contentType: mime });
				mediaByFilename.set(media.filename, media);
				mediaById.set(media.id, media);
				uploaded++;
			} else reused++;
		}
		const localUrl = media.url ?? (media.storageKey && `/_emdash/api/media/file/${media.storageKey}`);
		if (!localUrl || !media.id) throw new Error(`Missing media URL for ${item.slug}`);
		block.asset = { ...block.asset, _ref: media.id, url: localUrl };
		// Linked full-size image targets should also point to the local copy when identical to source.
		if (typeof block.link === "string" && block.link === source) block.link = block.asset.url;
		if (block.link && typeof block.link === "object" && block.link.href === source) block.link.href = block.asset.url;
	}
	const edited = await client.update("posts", item.id, { data: { content }, _rev: item._rev });
	if (item.status === "published") await client.publish("posts", edited.id);
	updated++;
	console.log(`${item.status} ${item.slug}: migrated ${images(item.data.content).length} images`);
}
console.log(`Updated ${updated} posts; uploaded ${uploaded} files; reused ${reused} uploaded files.`);
