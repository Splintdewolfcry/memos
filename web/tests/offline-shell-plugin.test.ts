import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs Vite plugin
import { buildServiceWorker } from "../scripts/vite-plugin-offline-shell.mjs";

const template = readFileSync(resolve(__dirname, "../scripts/sw.template.js"), "utf8");

describe("offline shell plugin", () => {
  const bundle = {
    "index.html": { type: "asset", fileName: "index.html" },
    "assets/index-abc123.js": { type: "asset", fileName: "assets/index-abc123.js" },
    "assets/index-def456.css": { type: "asset", fileName: "assets/index-def456.css" },
    "assets/lazy-chunk-789.js": { type: "asset", fileName: "assets/lazy-chunk-789.js" },
  };

  it("precaches the shell and every emitted asset", () => {
    const output = buildServiceWorker(template, bundle);

    expect(output).toContain('"/index.html"');
    expect(output).toContain('"/assets/index-abc123.js"');
    expect(output).toContain('"/assets/lazy-chunk-789.js"');
    expect(output).not.toContain("__PRECACHE_MANIFEST__");
  });

  it("replaces the build hash with a stable digest", () => {
    const output = buildServiceWorker(template, bundle);

    expect(output).not.toContain("__BUILD_HASH__");
    const expected = createHash("sha256")
      .update(JSON.stringify([...Object.keys(bundle)].sort()))
      .digest("hex")
      .slice(0, 16);
    expect(output).toContain(expected);
  });

  it("produces the same hash for the same asset set", () => {
    expect(buildServiceWorker(template, bundle)).toBe(buildServiceWorker(template, { ...bundle }));
  });
});
