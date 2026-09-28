import { definePlugin, definePluginRoute } from "emdash";
import type { PluginDescriptor } from "emdash";

const id = "emdash-substack-importer";
const version = "0.2.0";
const entrypoint = "@leostera/emdash-substack-importer";
const adminEntry = `${entrypoint}/admin`;
const sourceHosts = new Set([
	"substack-post-media.s3.amazonaws.com",
	"bucketeer-e05bbc84-baa3-437e-9518-adb32be77984.s3.amazonaws.com",
]);
const mimeTypes: Record<string, string> = {
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
};

export function substackImporter(): PluginDescriptor {
	return { id, version, format: "native", entrypoint, adminEntry };
}

function verifiedSource(value: unknown): URL | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && sourceHosts.has(url.hostname) ? url : null;
	} catch { return null; }
}

function verifiedFallback(value: unknown, source: string): URL | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.hostname !== "substackcdn.com" || !url.pathname.startsWith("/image/fetch/")) return null;
		return decodeURIComponent(url.pathname.split("/").at(-1) ?? "") === source ? url : null;
	} catch { return null; }
}

function imageMime(bytes: Uint8Array): string | null {
	if (bytes.length < 12) return null;
	const prefix = new TextDecoder("ascii").decode(bytes.subarray(0, 12));
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return mimeTypes.jpeg;
	if ([137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) return mimeTypes.png;
	if (prefix.startsWith("GIF8")) return mimeTypes.gif;
	if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") return mimeTypes.webp;
	if (prefix.slice(4, 12).includes("ftypavif")) return mimeTypes.avif;
	return null;
}

export function createPlugin() {
	return definePlugin({
		id,
		version,
		capabilities: ["media:write", "network:request"],
		allowedHosts: [...sourceHosts, "substackcdn.com"],
		admin: {
			entry: adminEntry,
			pages: [{ path: "/import", label: "Substack Import", icon: "upload-simple" }],
		},
		routes: {
			"media/import": definePluginRoute({
				permission: "plugins:manage",
				methods: ["POST"],
				request: { body: "json", maxBytes: 4096 },
				handler: async (ctx) => {
					const input = ctx.input;
					if (!input || typeof input !== "object") return { ok: false, error: "Invalid image request" };
					const { url, fallback, alt } = input as Record<string, unknown>;
					const source = verifiedSource(url);
					if (!source || (alt !== undefined && typeof alt !== "string")) return { ok: false, error: "Image URL is not a supported Substack host" };
					const backup = verifiedFallback(fallback, source.href);
					if (fallback && !backup) return { ok: false, error: "Invalid fallback URL" };
					if (!ctx.http || !ctx.media?.upload) return { ok: false, error: "Media storage is unavailable" };
					try {
						let response = await ctx.http.fetch(source.href);
						if (!response.ok && backup) response = await ctx.http.fetch(backup.href);
						if (!response.ok) return { ok: false, error: `Image download failed (HTTP ${response.status})` };
						const bytes = new Uint8Array(await response.arrayBuffer());
						const mime = imageMime(bytes);
						if (!mime) return { ok: false, error: "Downloaded file is not a supported image" };
						const ext = mime.split("/")[1] === "jpeg" ? "jpg" : mime.split("/")[1];
						const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source.href));
						const name = [...new Uint8Array(digest)].slice(0, 10).map((n) => n.toString(16).padStart(2, "0")).join("");
						const uploaded = await ctx.media.upload(`substack-${name}.${ext}`, mime, bytes.buffer as ArrayBuffer);
						return { ok: true, mediaId: uploaded.mediaId, url: uploaded.url };
					} catch (error) {
						ctx.log.warn("Image import failed", { reason: error instanceof Error ? error.message : "Unknown error" });
						return { ok: false, error: "Image could not be copied; try again or import it manually" };
					}
				},
			}),
		},
	});
}

export default createPlugin;
