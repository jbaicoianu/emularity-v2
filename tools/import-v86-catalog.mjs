#!/usr/bin/env node
/* Import the machine list from copy.sh/v86 into emulators/v86/catalog.json.

   The list lives in upstream's src/browser/main.js as a JavaScript array (`oses`)
   built with expressions (host + "...", 512 * 1024 * 1024, ternaries), so we cut the
   array's source out and evaluate it in a sandbox here, at import time, rather than
   ever running upstream code in a user's browser.

   Image URLs are written with a "{host}" placeholder, filled in at runtime with
   wherever the images are served from. Entries that restore a saved CPU state are
   skipped: states only load in the exact v86 build that made them. Their "-boot"
   twins, which boot normally, are kept.

   Usage: node tools/import-v86-catalog.mjs [path-or-url-to-main.js] */
import fs from 'fs';
import vm from 'vm';

const SOURCE = process.argv[2] || 'https://raw.githubusercontent.com/copy/v86/master/src/browser/main.js';
const OUT = new URL('../emulators/v86/catalog.json', import.meta.url);

const src = /^https?:/.test(SOURCE) ? await (await fetch(SOURCE)).text() : fs.readFileSync(SOURCE, 'utf8');

// Cut out `const oses = [ ... ];` by bracket matching, skipping strings and comments
let start = src.indexOf('const oses = [');
if (start < 0) throw new Error('machine list (const oses = [...]) not found');
let i = src.indexOf('[', start), depth = 0, quote = null;
for (; i < src.length; i++) {
  let c = src[i];
  if (quote) { if (c == '\\') i++; else if (c == quote) quote = null; continue; }
  if (c == '/' && src[i + 1] == '/') { i = src.indexOf('\n', i); continue; }
  if (c == '/' && src[i + 1] == '*') { i = src.indexOf('*/', i) + 1; continue; }
  if (c == '"' || c == "'" || c == '`') quote = c;
  else if (c == '[') depth++;
  else if (c == ']' && --depth == 0) break;
}
let arraySource = src.slice(src.indexOf('[', start), i + 1);

// ON_LOCALHOST picks image paths under `host` over third-party mirrors
let oses = vm.runInNewContext('(' + arraySource + ')', { host: '{host}', ON_LOCALHOST: true }, { timeout: 1000 });

const MEDIA = ['cdrom', 'hda', 'hdb', 'fda', 'fdb', 'bzimage', 'initrd', 'multiboot'];
let machines = [], seen = new Set();
for (let os of oses) {
  if (os.state) continue;
  let { id, name, homepage, net_device_type, ...config } = os;
  if (net_device_type) config.net_device = { type: net_device_type };
  if (!MEDIA.some(k => config[k]) && !config.filesystem) continue; // nothing to boot
  id = id.replace(/-boot$/, '');
  // Skip duplicates: a "-boot" twin of an entry that no longer has a state, or a
  // fallback that's identical once we pick local image paths
  let key = JSON.stringify(config);
  if (seen.has(id) || seen.has(key)) continue;
  seen.add(id); seen.add(key);
  machines.push({ id, name: name || id, homepage, config });
}

fs.writeFileSync(OUT, JSON.stringify({ source: SOURCE, imported: new Date().toISOString().slice(0, 10), machines }, null, 1) + '\n');
console.log(`Wrote ${machines.length} machines (of ${oses.length} upstream entries) to ${OUT.pathname}`);
