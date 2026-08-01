import { execSync } from "child_process";
import { createHash } from "crypto";
import { copyFileSync, cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import path from "path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import type { PluginOption } from "vite";

const projectRootDir = path.resolve(__dirname);

// GraphX Studio fork (Track D, D1b): originally unset (Vite's default `base: "/"`).
// Discovered by direct testing, not by reading code: this build's own index.html
// references its bundled assets with root-ABSOLUTE paths (e.g. `/assets/index-*.css`),
// which is exactly right when served from an origin's root but collides with
// whatever ELSE that origin serves at `/assets/*` once this bundle is served from a
// subpath (Studio serves it at `/tools/graphite/`, per TECH-D §3.2, and Studio's own
// vanilla app already owns `/assets/*` at the origin root). Vite's own `base` option
// is the documented mechanism for this (https://vitejs.dev/config/shared-options.html#base)
// -- it rewrites every built asset reference AND exposes `import.meta.env.BASE_URL` for
// runtime code (used below by the service-worker registration patch) to stay consistent
// with wherever this bundle is actually served from. Defaults to "/" (today's unchanged
// standalone behavior) so a plain `cargo run build web` with no env var is a no-op.
const BASE_PATH = process.env.GRAPHITE_BASE_PATH || "/";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
	return {
		base: BASE_PATH,
		plugins: [svelteGlobalStyles(), webkitUserSelectPrefix(), svelte(), staticAssets(), mode !== "native" && thirdPartyLicenses(), mode !== "native" && serviceWorker()],
		resolve: {
			alias: [{ find: /\/..\/branding\/(.*\.svg)/, replacement: path.resolve(projectRootDir, "../branding", "$1?raw") }],
		},
		server: {
			port: 8080,
			host: "0.0.0.0",
		},
	};
});

// Wraps the content of every `<style lang="scss">...</style>` block in Svelte components with `:global { ... }` to work around Svelte's unwanted scoped styles
function svelteGlobalStyles(): PluginOption {
	return {
		name: "svelte-global-styles",
		enforce: "pre",
		transform(code, id) {
			if (!id.endsWith(".svelte")) return;

			return code.replace(/<style(?=\s|>)([^>]*)>(.*?)<\/style>/gs, (_, attrs, content) => `<style${attrs}>\n:global {\n${content}\n}\n</style>`);
		},
	};
}

// Adds the `-webkit-user-select` prefix alongside every `user-select` declaration in Svelte component styles (still required by Safari). Remove when Safari ships the unprefixed version.
// WebKit tracking issue:
//   https://bugs.webkit.org/show_bug.cgi?id=208677
// Included in Interop 2026:
//   https://webkit.org/blog/17818/announcing-interop-2026/#web-compat
//   https://github.com/web-platform-tests/interop/issues/1000#issuecomment-3892214470
// Web platform test for WebKit implementation status:
//   https://wpt.fyi/results/css/css-ui/parsing/user-select-computed.html?label=master&label=experimental&aligned&view=interop&q=label%3Ainterop-2026-webcompat
function webkitUserSelectPrefix(): PluginOption {
	return {
		name: "webkit-user-select-prefix",
		enforce: "pre",
		transform(code, id) {
			if (!id.endsWith(".svelte")) return;

			return code.replace(/<style(?=\s|>)([^>]*)>(.*?)<\/style>/gs, (_, attrs, content) => {
				// The lookbehind requires a property boundary on the left, so it skips `-webkit-`/`-moz-` prefixes, `--custom` properties, and `$scss-variables`.
				// Excluding newlines/braces from the value stops a `user-select` mentioned in a comment from swallowing the following declarations.
				const prefixed = content.replace(/(?<![\w$-])user-select\s*:\s*([^;{}\r\n]+);/g, "-webkit-user-select: $1; user-select: $1;");
				return `<style${attrs}>${prefixed}</style>`;
			});
		},
	};
}

function staticAssets(): PluginOption {
	const STATIC_ASSET_DIRS: { source: string; urlPrefix: string }[] = [
		{ source: "../demo-artwork", urlPrefix: "/demo-artwork" },
		{ source: "../branding/favicons", urlPrefix: "" },
	];

	// MIME types for all file extensions found in the static asset directories
	const MIME_TYPES: Record<string, string> = {
		".graphite": "application/json",
		".ico": "image/x-icon",
		".png": "image/png",
		".svg": "image/svg+xml",
		".webmanifest": "application/manifest+json",
		".xml": "application/xml",
	};

	return {
		name: "static-assets",
		// Dev: serve files from the listed directories via middleware
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				if (!req.url) return next();
				const urlPath = decodeURIComponent(req.url.split("?")[0]);

				const match = STATIC_ASSET_DIRS.find(({ source, urlPrefix }) => {
					if (urlPrefix && !urlPath.startsWith(urlPrefix + "/") && urlPath !== urlPrefix) return false;
					if (!urlPrefix && urlPath.startsWith("/@")) return false;

					const relativePath = urlPrefix ? urlPath.slice(urlPrefix.length) : urlPath;
					const filePath = path.resolve(projectRootDir, source, "." + relativePath);

					const sourceDir = path.resolve(projectRootDir, source) + path.sep;
					if (!filePath.startsWith(sourceDir)) return false;

					return existsSync(filePath) && !statSync(filePath).isDirectory();
				});
				if (!match) return next();
				const { source, urlPrefix } = match;

				const relativePath = urlPrefix ? urlPath.slice(urlPrefix.length) : urlPath;
				const filePath = path.resolve(projectRootDir, source, "." + relativePath);
				const extension = path.extname(filePath).toLowerCase();
				const contentType = MIME_TYPES[extension] || "application/octet-stream";

				res.setHeader("Content-Type", contentType);
				res.end(readFileSync(filePath));
			});
		},
		// Build: copy the listed directories into the output
		writeBundle(options) {
			STATIC_ASSET_DIRS.forEach(({ source, urlPrefix }) => {
				const sourceDir = path.resolve(projectRootDir, source);
				const destinationDir = path.join(options.dir || "dist", urlPrefix);

				if (existsSync(sourceDir)) cpSync(sourceDir, destinationDir, { recursive: true });
			});
		},
	};
}

function thirdPartyLicenses(): PluginOption {
	return {
		name: "third-party-licenses",
		buildStart() {
			try {
				execSync("cargo run -p third-party-licenses", { stdio: "inherit" });
			} catch (e) {
				throw new Error("Failed to generate third-party licenses", { cause: e });
			}
		},
		writeBundle(options) {
			copyFileSync(path.resolve(projectRootDir, "third-party-licenses.txt"), path.join(options.dir || "dist", "third-party-licenses.txt"));

			// GraphX Studio fork (Track D, D1b): Graphite's own top-level LICENSE.txt
			// (Apache-2.0) wasn't previously copied into `dist/` -- only the generated
			// third-party-licenses.txt was. D1b's AC1 requires LICENSE/NOTICE files to ship in
			// the served bundle (asserted by a build test on the studio side), so this fork adds
			// the missing copy step. There's no separate upstream NOTICE file at this pin
			// (Apache-2.0 §4(d) only requires carrying one forward if upstream ships one).
			copyFileSync(path.resolve(projectRootDir, "..", "LICENSE.txt"), path.join(options.dir || "dist", "LICENSE.txt"));
		},
	};
}

function serviceWorker(): PluginOption {
	// Files that should never be precached
	const EXCLUDED_FILES = new Set(["service-worker.js"]);
	const DEFERRED_PREFIXES = ["demo-artwork/", "third-party-licenses.txt", "LICENSE.txt"];

	function collectFiles(directory: string, prefix: string): string[] {
		const results: string[] = [];
		if (!existsSync(directory)) return results;

		readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				results.push(...collectFiles(path.join(directory, entry.name), relativePath));
			} else {
				results.push(relativePath);
			}
		});
		return results;
	}

	function contentHash(filePath: string): string {
		const contents = readFileSync(filePath);
		return createHash("sha256").update(contents).digest("hex").slice(0, 12);
	}

	// Vite appends content hashes to filenames in its build output, like "index-BV2NauF8.js"
	function hasContentHash(fileName: string): boolean {
		return /\w+-[A-Za-z0-9_-]{6,}\.\w+$/.test(fileName);
	}

	return {
		name: "service-worker",
		async writeBundle(options) {
			const outputDir = options.dir || "dist";
			const allFiles = collectFiles(outputDir, "");

			const precacheManifest: { url: string; revision: string | undefined }[] = [];
			const deferredManifest: { url: string; revision: string | undefined }[] = [];

			allFiles.forEach((relativePath) => {
				const fileName = path.basename(relativePath);
				const filePath = path.join(outputDir, relativePath);
				// GraphX Studio fork (Track D, D1b): was hardcoded to `/${relativePath}` --
				// a root-absolute URL, independent of the `base` config above. Under a
				// subpath deployment (Studio serves this at /tools/graphite/) that silently
				// precached the WRONG URLs (colliding with whatever else the origin serves
				// at /assets/*), discovered by directly opening the built bundle at a
				// subpath rather than by reading the code. BASE_PATH already ends with
				// exactly one slash and relativePath never starts with one, so this is a
				// plain concatenation, not a path-join.
				const url = `${BASE_PATH}${relativePath.replace(/\\/g, "/")}`;

				// Skip excluded files
				if (EXCLUDED_FILES.has(fileName)) return;

				// Deferred files are cached in the background after initial load
				if (DEFERRED_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) {
					deferredManifest.push({ url, revision: contentHash(filePath) });
					return;
				}

				// Hashed filenames don't need a revision (the hash is in the URL)
				if (hasContentHash(fileName)) {
					precacheManifest.push({ url, revision: undefined });
				} else {
					precacheManifest.push({ url, revision: contentHash(filePath) });
				}
			});

			// Compute a content hash from both manifests combined
			const allManifestJson = JSON.stringify({ precache: precacheManifest, deferred: deferredManifest });
			const serviceWorkerContentHash = createHash("sha256").update(allManifestJson).digest("hex").slice(0, 12);

			// Read the service worker source and replace placeholder tokens with actual values
			const serviceWorkerSourcePath = path.resolve(projectRootDir, "src/service-worker.js");
			const serviceWorkerSource = readFileSync(serviceWorkerSourcePath, "utf-8");
			const serviceWorkerFinal = serviceWorkerSource
				.replace("self.__PRECACHE_MANIFEST", JSON.stringify(precacheManifest))
				.replace("self.__DEFERRED_CACHE_MANIFEST", JSON.stringify(deferredManifest))
				.replace("self.__SERVICE_WORKER_CONTENT_HASH", JSON.stringify(serviceWorkerContentHash))
				.replace("self.__BASE_PATH", JSON.stringify(BASE_PATH));

			writeFileSync(path.join(outputDir, "service-worker.js"), serviceWorkerFinal);
		},
	};
}
