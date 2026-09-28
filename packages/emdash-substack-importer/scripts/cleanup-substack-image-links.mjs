// Remove broken "image wrapper" paragraphs left by EmDash's Markdown importer.
// The original <a><img></a> produced both a correct image and a stray ](Substack CDN URL) paragraph.
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { EmDashClient } from "emdash/client";
import { parse } from "csv-parse/sync";
import { site, archive } from "./config.mjs";
const apply = process.argv.includes("--apply");
const authFile = resolve(homedir(), ".config/emdash/auth.json");
const auth = JSON.parse(await readFile(authFile, "utf8"));
const login = auth[site];
if (!login?.accessToken) throw new Error(`Log in first: bunx emdash login --url ${site}`);
const client = new EmDashClient({
	baseUrl: site,
	token: login.accessToken,
	refreshToken: login.refreshToken,
	onTokenRefresh: async (accessToken, expiresIn) => {
		auth[site] = { ...auth[site], accessToken, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
		await writeFile(authFile, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
	},
});

function isImportArtifact(block) {
	if (block?._type !== "block" || block.style !== "normal") return false;
	const text = (block.children ?? []).map((span) => span.text ?? "").join("");
	return /^\]\(https:\/\/substackcdn\.com\/image\/fetch\/.*\)$/.test(text);
}
const posts = [];
let cursor;
do {
	const page = await client.list("posts", { limit: 100, cursor });
	posts.push(...page.items);
	cursor = page.nextCursor;
} while (cursor);
const rows = parse(await readFile(resolve(archive, "posts.csv"), "utf8"), { columns: true, skip_empty_lines: true });
const imageSlugs = new Set();
for (const row of rows) {
	const html = await readFile(resolve(archive, "posts", `${row.post_id}.html`), "utf8");
	if (/<img\b/i.test(html)) imageSlugs.add(row.post_id.split(".").slice(1).join("."));
}
let found = 0, removed = 0, skipped = 0;
for (const post of posts.filter((post) => imageSlugs.has(post.slug))) {
	const item = await client.get("posts", post.id, { raw: true });
	const content = item.data.content;
	if (!Array.isArray(content)) continue;
	const count = content.filter(isImportArtifact).length;
	if (!count) continue;
	found += count;
	if (item.status === "published" && item.draftRevisionId) {
		console.log(`SKIP ${item.slug}: unpublished editor changes; ${count} linked-image artifacts`);
		skipped += count;
		continue;
	}
	console.log(`${item.slug}: ${count} linked-image artifacts${apply ? " removed" : " (dry run)"}`);
	if (!apply) continue;
	const updated = await client.update("posts", item.id, {
		data: { content: content.filter((block) => !isImportArtifact(block)) },
		_rev: item._rev,
	});
	if (item.status === "published") await client.publish("posts", updated.id);
	removed += count;
}
console.log(`${apply ? `Removed ${removed} of ${found}` : `Found ${found}`} artifacts; ${skipped} skipped on posts with unpublished changes.`);
