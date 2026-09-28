import { parse } from "csv-parse/browser/esm/sync";
import { unzipSync } from "fflate";
import TurndownService from "turndown";

export interface ArchivePost {
	slug: string;
	title: string;
	subtitle: string;
	published: boolean;
	publishedAt?: string;
	html: string;
	type: string;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_ZIP_BYTES = 32 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 96 * 1024 * 1024;

export function parseArchive(bytes: Uint8Array): ArchivePost[] {
	if (bytes.byteLength > MAX_ZIP_BYTES) throw new Error("This ZIP is over 32 MB; use the CLI for larger exports.");
	let total = 0;
	let entries = 0;
	const files = unzipSync(bytes, {
		filter: (file) => {
			entries++;
			if (entries > 5000) throw new Error("The ZIP contains too many files.");
			const useful = /(?:^|\/)(?:posts\.csv|posts\/[^/]+\.html)$/i.test(file.name);
			if (useful) {
				total += file.originalSize;
				if (total > MAX_UNPACKED_BYTES) throw new Error("The post files exceed the 96 MB safety limit.");
			}
			// Subscriber files are never unpacked or sent to EmDash.
			return useful;
		},
	});
	const csvPaths = Object.keys(files).filter((name) => /(?:^|\/)posts\.csv$/i.test(name));
	if (csvPaths.length !== 1) throw new Error("Expected exactly one posts.csv inside the ZIP.");
	const csvPath = csvPaths[0];
	const base = csvPath.slice(0, -"posts.csv".length);
	const rows = parse(decoder.decode(files[csvPath]), { columns: true, skip_empty_lines: true }) as Array<Record<string, string>>;
	if (!rows.length) throw new Error("posts.csv has no posts.");
	if (rows.length > 2000) throw new Error("The archive has more than 2,000 posts; use the CLI.");
	const seen = new Set<string>();
	return rows.map((row) => {
		const postId = row.post_id;
		if (!/^\d+\.[a-z0-9-]+$/.test(postId)) throw new Error("A post has an invalid export filename.");
		const slug = postId.split(".")[1];
		if (seen.has(slug)) throw new Error(`Duplicate post slug: ${slug}`);
		seen.add(slug);
		const file = files[`${base}posts/${postId}.html`];
		if (!file) throw new Error(`Missing HTML for ${slug}`);
		const published = row.is_published === "true";
		if (published && (!row.title || !row.post_date || Number.isNaN(Date.parse(row.post_date)))) {
			throw new Error(`Published post ${slug} lacks a title or valid publication date.`);
		}
		return {
			slug,
			title: row.title || `Untitled Substack draft ${postId.split(".")[0]}`,
			subtitle: row.subtitle || "",
			published,
			publishedAt: published ? row.post_date : undefined,
			html: decoder.decode(file),
			type: row.type || "newsletter",
		};
	});
}

export function toMarkdown(html: string): string {
	const converter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
	converter.addRule("codeBlocks", {
		filter: (node) => node.nodeName === "PRE",
		replacement: (_content, node) => {
			const code = node.querySelector("code");
			const language = code?.getAttribute("class")?.match(/(?:language|lang)-([\w+-]+)/)?.[1] ?? "";
			return `\n\n\`\`\`${language}\n${(code ?? node).textContent.replace(/\n$/, "")}\n\`\`\`\n\n`;
		},
	});
	// A Substack figure wraps its image in an anchor to the CDN; emitting both
	// creates a broken literal `](https://substackcdn...)` paragraph in EmDash.
	converter.addRule("linkedImages", {
		filter: (node) => node.nodeName === "A" && !!node.querySelector("img") && !node.textContent.trim(),
		replacement: (_content, node) => {
			const image = node.querySelector("img");
			if (!image) return "";
			return `\n\n![${(image.getAttribute("alt") ?? "").replaceAll("]", "")}](${image.getAttribute("src") ?? ""})\n\n`;
		},
	});
	return converter.turndown(html);
}

export function imageFallbacks(html: string): Map<string, string> {
	const fallbacks = new Map<string, string>();
	const urls = [...html.matchAll(/https:\/\/substackcdn\.com\/image\/fetch\/[^"'\s<>]+/g)].map(([url]) => url);
	for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
		const source = tag.match(/\bsrc="([^"]+)"/)?.[1];
		if (!source) continue;
		const fallback = urls.find((candidate) => {
			try { return decodeURIComponent(new URL(candidate).pathname.split("/").at(-1) ?? "") === source; }
			catch { return false; }
		});
		if (fallback) fallbacks.set(source, fallback);
	}
	return fallbacks;
}
