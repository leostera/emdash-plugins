import { expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { markdownToPortableText } from "emdash/client";
import { imageFallbacks, parseArchive, toMarkdown } from "./archive.js";

const csv = `post_id,post_date,is_published,email_sent_at,inbox_sent_at,type,audience,title,subtitle,podcast_url\n123.hello-world,2021-02-14T12:00:00.000Z,true,,,newsletter,everyone,Hello world,Welcome,\n`;

test("extracts posts from a wrapped Substack ZIP without reading subscribers", () => {
	const archive = zipSync({
		"export/posts.csv": strToU8(csv),
		"export/posts/123.hello-world.html": strToU8("<p>Good morning</p>"),
		"export/email_list.private.csv": strToU8("email\nprivate@example.test\n"),
	});
	expect(parseArchive(archive)).toEqual([{
		slug: "hello-world", title: "Hello world", subtitle: "Welcome", published: true,
		publishedAt: "2021-02-14T12:00:00.000Z", html: "<p>Good morning</p>", type: "newsletter",
	}]);
});

test("rejects malformed ZIPs before writing content", () => {
	expect(() => parseArchive(strToU8("not a zip"))).toThrow();
	expect(() => parseArchive(zipSync({ "posts.csv": strToU8(csv) }))).toThrow("Missing HTML");
});

test("linked images produce one Portable Text image, not a stray CDN URL paragraph", () => {
	const url = "https://substack-post-media.s3.amazonaws.com/public/images/example.png";
	const cdn = `https://substackcdn.com/image/fetch/w_100/${encodeURIComponent(url)}`;
	const html = `<p>Intro</p><figure><a href="${cdn}"><img src="${url}" alt="Example" /></a></figure>`;
	const blocks = markdownToPortableText(toMarkdown(html));
	expect(blocks.filter((block) => block._type === "image")).toHaveLength(1);
	expect(JSON.stringify(blocks)).not.toContain("substackcdn.com");
	expect(imageFallbacks(html).get(url)).toBe(cdn); // a resized CDN copy is better than a failed import
});
