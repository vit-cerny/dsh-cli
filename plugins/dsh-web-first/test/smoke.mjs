import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [manifestText, patchText, readme, icon, enText, zhText] = await Promise.all([
  readFile(new URL("package.json", root), "utf8"),
  readFile(new URL("cordis.patch.yml", root), "utf8"),
  readFile(new URL("README.md", root), "utf8"),
  readFile(new URL("icon.svg", root), "utf8"),
  readFile(new URL("locale/en.json", root), "utf8"),
  readFile(new URL("locale/zh.json", root), "utf8"),
]);
const manifest = JSON.parse(manifestText);
const en = JSON.parse(enText);
const zh = JSON.parse(zhText);

assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
assert.ok(manifest.exports["./locale/*.json"]);
assert.equal(manifest.exports["./icon"], "./icon.svg");
assert.ok(manifest.files.includes("locale/*.json"));
assert.ok(manifest.files.includes("icon.svg"));
assert.match(patchText, /-\s*id:\s*web\b/);
assert.match(patchText, /searchProvider:\s*deepseek-search-api/);
assert.match(patchText, /fetchProvider:\s*deepseek-fetch-api/);
assert.match(patchText, /-\s*id:\s*tool-web\b[\s\S]*?disabled:\s*false/);
assert.match(patchText, /name:\s*['"]?dsh-web-first['"]?/);
for (const locale of [en, zh]) {
  assert.ok(locale.meta.title);
  assert.ok(locale.meta.description);
}
assert.match(en.meta.description, /Plugins.*Web search/);
assert.match(readme, /credential store, outside the profile settings file/i);
assert.match(icon, /<svg\b/);
assert.doesNotMatch(patchText, /apiKey\s*:/i);

const { apply } = await import(new URL("lib/index.js", root));
let section;
let cleanup;
let disposed = false;
apply({
  inject: (services, callback) => {
    assert.deepEqual(services, ["systemPrompt"]);
    callback({
      systemPrompt: {
        getSectionOrder: (name) => name === "TOOL_WEB_SEARCH" ? 2000 : undefined,
        section: (value) => {
          section = value;
          return () => { disposed = true; };
        },
      },
      effect: (register) => {
        cleanup = register();
        return () => cleanup?.();
      },
    });
  },
});
assert.equal(section.name, "web:first");
assert.equal(section.order, 2000);
assert.match(section.text, /prior art/i);
assert.match(section.text, /report the failure instead of guessing/i);
assert.match(section.text, /agent-reach doctor/i);
assert.doesNotMatch(section.text, /agent-reach github search/i);
assert.match(section.text, /untrusted external data/i);
assert.equal(typeof cleanup, "function");
cleanup();
assert.equal(disposed, true);
console.log("dsh-web-first smoke test passed");
