import { resolve } from "node:path";

function option(name, fallback) {
	const arg = process.argv.find((value) => value.startsWith(`--${name}=`));
	return arg ? arg.slice(name.length + 3) : fallback;
}

export const site = option("url", process.env.EMDASH_URL);
if (!site) throw new Error("Provide --url=https://your-emdash-site.example or EMDASH_URL");
const origin = new URL(site);
if (origin.origin !== site.replace(/\/$/, "") || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname)))) {
	throw new Error("--url must be an HTTPS origin (HTTP is allowed for localhost only)");
}
export const archive = resolve(option("archive", process.env.SUBSTACK_EXPORT_DIR ?? "substack_export_archive"));
export const urlPattern = option("url-pattern", undefined);
