import type { PluginAdminExports } from "emdash";
import { ImportPage } from "./ImportPage.js";

export const pages: PluginAdminExports["pages"] = {
	"/import": ImportPage,
};
