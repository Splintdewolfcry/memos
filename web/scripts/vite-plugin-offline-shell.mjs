import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Builds the service worker source from the template and the emitted bundle.
 * Exported separately from the plugin so it can be unit tested without Vite.
 *
 * The hash covers the asset name set, so any rebuild that changes a chunk name
 * produces a new cache generation and the activate handler drops the old one.
 */
export function buildServiceWorker(template, bundle) {
  const fileNames = Object.keys(bundle).sort();
  const buildHash = createHash("sha256").update(JSON.stringify(fileNames)).digest("hex").slice(0, 16);

  // Precache the document plus everything under /assets/. Root-level files such
  // as /logo.webp are cached on first use by the runtime handler instead; they
  // are not required to render the shell.
  const precache = ["/index.html", ...fileNames.filter((name) => name.startsWith("assets/")).map((name) => `/${name}`)];

  return template
    .replaceAll("__BUILD_HASH__", buildHash)
    .replace('["__PRECACHE_MANIFEST__"]', JSON.stringify(precache))
    .replace("__PRECACHE_MANIFEST__", JSON.stringify(precache));
}

/** Vite plugin emitting dist/sw.js with the built asset manifest inlined. */
export function offlineShell() {
  return {
    name: "memos-offline-shell",
    apply: "build",
    async generateBundle(_options, bundle) {
      const template = await readFile(resolve(here, "sw.template.js"), "utf8");
      // The worker imports its routing decisions as a module, so ship that file
      // alongside it rather than inlining.
      const routing = await readFile(resolve(here, "sw-routing.mjs"), "utf8");

      this.emitFile({ type: "asset", fileName: "sw-routing.mjs", source: routing });
      this.emitFile({ type: "asset", fileName: "sw.js", source: buildServiceWorker(template, bundle) });
    },
  };
}
