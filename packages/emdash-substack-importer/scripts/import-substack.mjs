// Import Substack's posts.csv and matching posts/*.html into EmDash.
// Dry-run by default; --apply writes to the production site. Subscriber emails are never read.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parse } from "csv-parse/sync";
import TurndownService from "turndown";
import { EmDashClient } from "emdash/client";
import { site, archive, urlPattern } from "./config.mjs";
const apply = process.argv.includes("--apply");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;
if (!(limit > 0)) throw new Error("--limit must be a positive number");

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.addRule("codeBlocks", {
	filter: (node) => node.nodeName === "PRE",
	replacement: (_content, node) => {
		const code = node.querySelector("code");
		const language = code?.getAttribute("class")?.match(/(?:language|lang)-([\w+-]+)/)?.[1] ?? "";
		const body = (code ?? node).textContent.replace(/\n$/, "");
		return `\n\n\`\`\`${language}\n${body}\n\`\`\`\n\n`;
	},
});

const rows = parse(await readFile(resolve(archive, "posts.csv"), "utf8"), { columns: true, skip_empty_lines: true });
const posts = [];
for (const row of rows) {
	const slug = row.post_id.split(".").slice(1).join(".");
	if (!slug || !/^[a-z0-9-]+$/.test(slug)) throw new Error(`Unrecognized slug: ${row.post_id}`);
	const published = row.is_published === "true";
	if (published && (!row.title || !row.post_date)) throw new Error(`Incomplete published post: ${slug}`);
	const html = await readFile(resolve(archive, "posts", `${row.post_id}.html`), "utf8");
	const content = turndown.turndown(html);
	posts.push({
		slug,
		published,
		publishedAt: row.post_date || undefined,
		type: row.type,
		data: {
			title: row.title || `Untitled Substack draft ${row.post_id.split(".")[0]}`,
			content,
			...(row.subtitle ? { excerpt: row.subtitle } : {}),
		},
	});
}
const slugs = new Set(posts.map((p) => p.slug));
if (slugs.size !== posts.length) throw new Error("Duplicate Substack slugs");
console.log(`Archive: ${posts.length} entries (${posts.filter((p) => p.published).length} published, ${posts.filter((p) => !p.published).length} drafts; ${posts.filter((p) => p.type === "podcast").length} podcasts).`);
if (!apply) {
	console.log("Dry run: no changes made. Run with --apply to import; --limit=N tests a small batch.");
	process.exit(0);
}

// Authenticated through the user's EmDash CLI login. Do not print or commit these credentials.
const credentialsPath = resolve(homedir(), ".config/emdash/auth.json");
const allCredentials = JSON.parse(await readFile(credentialsPath, "utf8"));
const credentials = allCredentials[site];
if (!credentials?.accessToken) throw new Error(`Log in first: bunx emdash login --url ${site}`);
const client = new EmDashClient({
	baseUrl: site,
	token: credentials.accessToken,
	refreshToken: credentials.refreshToken,
	onTokenRefresh: async (accessToken, expiresIn) => {
		allCredentials[site] = { ...allCredentials[site], accessToken, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
		await Bun.write(credentialsPath, JSON.stringify(allCredentials, null, 2) + "\n");
	},
});

// Optional: align EmDash's content URL pattern with the host site's actual Astro routes.
if (urlPattern) {
	const { item: collection } = await client.request("GET", "/schema/collections/posts?includeFields=true");
	if (collection.urlPattern !== urlPattern) {
		await client.request("PUT", "/schema/collections/posts", { urlPattern });
		console.log(`Updated live posts URL pattern to ${urlPattern}.`);
	}
}

const existing = new Set();
let cursor;
do {
	const page = await client.list("posts", { limit: 100, cursor });
	for (const item of page.items) existing.add(item.slug);
	cursor = page.nextCursor;
} while (cursor);

let imported = 0, skipped = 0;
for (const post of posts) {
	if (imported >= limit) break;
	if (existing.has(post.slug)) { skipped++; continue; }
	// EmDashClient converts Markdown to Portable Text before sending the request.
	// REST additionally accepts historical createdAt/publishedAt (Admin role required).
	const item = await client.create("posts", {
		data: post.data,
		slug: post.slug,
		...(post.publishedAt ? { createdAt: post.publishedAt, publishedAt: post.publishedAt } : {}),
	});
	if (post.published) {
		await client.request("POST", `/content/posts/${encodeURIComponent(item.id)}/publish`, { publishedAt: post.publishedAt });
	}
	imported++;
	existing.add(post.slug);
	console.log(`${post.published ? "published" : "draft"} ${post.slug}`);
}
console.log(`Imported ${imported}; skipped ${skipped} existing posts.`);
