import path from "path";
import url from "url";

/**
 * Get the __dirname of a module.
 * Useful because __dirname is not available in ES modules.
 *
 * @param module This should be `import.meta`
 * @returns The __dirname of the module.
 */
export function getDirName(module: ImportMeta): string {
	return path.dirname(url.fileURLToPath(module.url));
}
