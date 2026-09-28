import { definePlugin } from "emdash";
import type { PluginDescriptor } from "emdash";

const id = "emdash-substack-importer";
const version = "0.1.0";

/** Build-time native-plugin descriptor. Not yet wired into a site: the ZIP UI is forthcoming. */
export function substackImporter(): PluginDescriptor {
	return {
		id,
		version,
		format: "native",
		entrypoint: "@leostera/emdash-substack-importer",
	};
}

/** EmDash's native loader imports this named export. */
export function createPlugin() {
	return definePlugin({ id, version });
}

export default createPlugin;
