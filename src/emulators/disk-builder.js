/* Build disk images from files: a FAT12 floppy, or an ISO 9660 CD (with Joliet long
   names). Files are [{ path: 'DIR/NAME.EXT', blob, mtime }], with `mtime` in ms.

   The same files always build the same image (sorted entries, dates from the files, a
   volume serial from the label), so changes saved against a built floppy still line
   up the next time it's built. */

/* ----- Names ----- */

const SHORT_OK = /[A-Z0-9!#$%&'()\-@^_`{}~]/;

/* Unique 8.3 names for a directory's entries. `names` are long names; returns the
   short names in the same order, without the dot ("README  TXT"-style is done by the
   caller). `chars` is the allowed-character test, `baseLen`/`extLen` the limits. */
function shortNames(names, { allowed = SHORT_OK, baseLen = 8, extLen = 3 } = {}) {
  let used = new Set(), out = [];
  let clean = s => [...s.toUpperCase()].map(c => allowed.test(c) ? c : '_').join('');
  for (let name of names) {
    let dot = name.lastIndexOf('.');
    let base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot + 1) : '';
    let b = clean(base.replace(/[. ]/g, '')), e = clean(ext.replace(/ /g, '')).slice(0, extLen);
    if (!b) b = '_';
    let exact = b == base.toUpperCase() && b.length <= baseLen && e == ext.toUpperCase() && ext.length <= extLen;
    let candidate = b.slice(0, baseLen) + (e ? '.' + e : '');
    if (!exact || used.has(candidate)) {
      for (let n = 1; ; n++) {
        let tail = '~' + n;
        candidate = b.slice(0, baseLen - tail.length) + tail + (e ? '.' + e : '');
        if (!used.has(candidate)) break;
      }
    }
    used.add(candidate);
    out.push(candidate);
  }
  return out;
}

/* The files as a tree: { dirs: Map(name -> tree), files: [{ name, blob, mtime }] } */
function tree(files) {
  let root = { dirs: new Map(), files: [], mtime: 0 };
  for (let f of files) {
    // "." and ".." would become entries that loop back on themselves; resolve them
    let parts = [];
    for (let part of f.path.replace(/\\/g, '/').split('/')) {
      if (part == '..') parts.pop();
      else if (part && part != '.') parts.push(part);
    }
    let node = root;
    if (!parts.length) continue;
    for (let dir of parts.slice(0, -1)) {
      if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [], mtime: 0 });
      node = node.dirs.get(dir);
      node.mtime = Math.max(node.mtime, f.mtime || 0);
    }
    node.files.push({ name: parts[parts.length - 1], blob: f.blob, mtime: f.mtime || 0 });
    root.mtime = Math.max(root.mtime, f.mtime || 0);
  }
  return root;
}
/* A directory's entries, sorted by name: [{ name, dir?, blob?, mtime }] */
function entries(node) {
  let list = [...[...node.dirs].map(([name, d]) => ({ name, dir: d, mtime: d.mtime })), ...node.files];
  return list.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/* ----- FAT12 floppies ----- */

const FLOPPIES = [
  { size: 1474560, sectors: 2880, spc: 1, root: 224, fat: 9, media: 0xf0, spt: 18, heads: 2 },
  { size: 2949120, sectors: 5760, spc: 2, root: 240, fat: 9, media: 0xf0, spt: 36, heads: 2 },
];
export const MAX_FLOPPY = FLOPPIES[FLOPPIES.length - 1].size;

function dosDateTime(ms) {
  let d = new Date(ms || Date.UTC(1980, 0, 1));
  if (d.getFullYear() < 1980) d = new Date(1980, 0, 1);
  return {
    date: (d.getFullYear() - 1980) << 9 | (d.getMonth() + 1) << 5 | d.getDate(),
    time: d.getHours() << 11 | d.getMinutes() << 5 | d.getSeconds() >> 1,
  };
}

/* 32-byte entries for a directory: long-name entries where needed, then the 8.3 one */
function fatEntries(list) {
  let shorts = shortNames(list.map(e => e.name));
  return list.map((e, i) => {
    let short = shorts[i], dot = short.indexOf('.');
    let raw = new Uint8Array(11).fill(0x20);
    let base = dot < 0 ? short : short.slice(0, dot), ext = dot < 0 ? '' : short.slice(dot + 1);
    for (let j = 0; j < base.length; j++) raw[j] = base.charCodeAt(j);
    for (let j = 0; j < ext.length; j++) raw[8 + j] = ext.charCodeAt(j);
    if (raw[0] == 0xe5) raw[0] = 0x05;
    let records = [];
    if (short != e.name) {
      let sum = 0;
      for (let b of raw) sum = (((sum & 1) << 7) + (sum >> 1) + b) & 0xff;
      let units = [...e.name].map(c => c.charCodeAt(0));
      units.push(0);
      while (units.length % 13) units.push(0xffff);
      let count = units.length / 13;
      for (let n = count; n >= 1; n--) {
        let r = new Uint8Array(32), v = new DataView(r.buffer);
        r[0] = n | (n == count ? 0x40 : 0);
        r[11] = 0x0f;
        r[13] = sum;
        let chunk = units.slice((n - 1) * 13, n * 13);
        [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30].forEach((at, k) => v.setUint16(at, chunk[k], true));
        records.push(r);
      }
    }
    let r = new Uint8Array(32), v = new DataView(r.buffer);
    r.set(raw);
    r[11] = e.dir ? 0x10 : 0x20;
    let { date, time } = dosDateTime(e.mtime);
    v.setUint16(14, time, true); v.setUint16(16, date, true); v.setUint16(18, date, true);
    v.setUint16(22, time, true); v.setUint16(24, date, true);
    if (!e.dir) v.setUint32(28, e.blob.size, true);
    records.push(r);
    // The 8.3 entry is last; the caller fills in its first cluster
    return { entry: e, records, main: r };
  });
}

/* The size (bytes) a FAT12 floppy needs for these files, as clusters of `clusterBytes` */
function floppyNeeds(root, clusterBytes) {
  let clusters = 0, rootEntries = 0;
  let walk = (node, isRoot) => {
    let n = isRoot ? 1 : 2; // the volume label, or "." and ".."
    for (let e of fatEntries(entries(node))) {
      n += e.records.length;
      if (e.entry.dir) walk(e.entry.dir, false);
      else clusters += Math.ceil(e.entry.blob.size / clusterBytes);
    }
    if (isRoot) rootEntries = n;
    else clusters += Math.max(1, Math.ceil(n * 32 / clusterBytes));
  };
  walk(root, true);
  return { clusters, rootEntries };
}

/* Which floppy format the files fit, or null */
export function floppyFormat(files) {
  let root = tree(files);
  return FLOPPIES.find(f => {
    let { clusters, rootEntries } = floppyNeeds(root, f.spc * 512);
    let dataClusters = (f.sectors - 1 - 2 * f.fat - f.root * 32 / 512) / f.spc;
    return clusters <= dataClusters && rootEntries <= f.root;
  }) || null;
}

export async function buildFloppy(files, { label = '' } = {}) {
  let f = floppyFormat(files);
  if (!f) throw new Error(`These files don't fit on a floppy (the most is ${MAX_FLOPPY / 1024} KB)`);
  let root = tree(files);
  let img = new Uint8Array(f.size), view = new DataView(img.buffer);
  let rootSectors = f.root * 32 / 512, dataStart = 1 + 2 * f.fat + rootSectors;
  let clusterBytes = f.spc * 512, next = 2;
  let fat = new Uint16Array((f.sectors - dataStart) / f.spc + 2);
  fat[0] = 0xf00 | f.media; fat[1] = 0xfff;
  let alloc = bytes => {
    let n = Math.max(1, Math.ceil(bytes / clusterBytes)), start = next;
    for (let i = 0; i < n; i++) fat[start + i] = i == n - 1 ? 0xfff : start + i + 1;
    next += n;
    return start;
  };
  let at = c => (dataStart + (c - 2) * f.spc) * 512;

  // Boot sector: not bootable, so the BIOS moves on to the next boot device (int 18h)
  img.set([0xeb, 0x3c, 0x90]);
  img.set([...'EMULARTY'].map(c => c.charCodeAt(0)), 3);
  view.setUint16(11, 512, true); img[13] = f.spc; view.setUint16(14, 1, true); img[16] = 2;
  view.setUint16(17, f.root, true); view.setUint16(19, f.sectors, true); img[21] = f.media;
  view.setUint16(22, f.fat, true); view.setUint16(24, f.spt, true); view.setUint16(26, f.heads, true);
  img[38] = 0x29;
  view.setUint32(39, hash(label + files.length), true);
  let vol = (label.toUpperCase().replace(/[^A-Z0-9_\-]/g, '').slice(0, 11) || 'NO NAME').padEnd(11, ' ');
  img.set([...vol].map(c => c.charCodeAt(0)), 43);
  img.set([...'FAT12   '].map(c => c.charCodeAt(0)), 54);
  img.set([0xcd, 0x18, 0xeb, 0xfe], 62);
  img[510] = 0x55; img[511] = 0xaa;

  let writeDir = async (node, out, self, parent) => {
    let pos = 0;
    if (self) {
      for (let [name, cluster] of [['.', self], ['..', parent]]) {
        let r = new Uint8Array(32).fill(0x20, 0, 11), v = new DataView(r.buffer);
        r.set([...name].map(c => c.charCodeAt(0)));
        r[11] = 0x10;
        let { date, time } = dosDateTime(node.mtime);
        v.setUint16(22, time, true); v.setUint16(24, date, true);
        v.setUint16(26, cluster, true);
        out.set(r, pos); pos += 32;
      }
    } else {
      // The volume label, first in the root
      let r = new Uint8Array(32);
      r.set([...vol].map(c => c.charCodeAt(0)));
      r[11] = 0x08;
      out.set(r, pos); pos += 32;
    }
    let subdirs = [];
    for (let e of fatEntries(entries(node))) {
      for (let r of e.records) { out.set(r, pos); pos += 32; }
      let v = new DataView(out.buffer, out.byteOffset + pos - 32);
      if (e.entry.dir) {
        let n = 2 + fatEntries(entries(e.entry.dir)).reduce((n, x) => n + x.records.length, 0);
        let cluster = alloc(n * 32);
        v.setUint16(26, cluster, true);
        subdirs.push({ node: e.entry.dir, cluster, bytes: Math.max(1, Math.ceil(n * 32 / clusterBytes)) * clusterBytes });
      } else if (e.entry.blob.size) {
        let cluster = alloc(e.entry.blob.size);
        v.setUint16(26, cluster, true);
        img.set(new Uint8Array(await e.entry.blob.arrayBuffer()), at(cluster));
      }
    }
    for (let d of subdirs) await writeDir(d.node, img.subarray(at(d.cluster), at(d.cluster) + d.bytes), d.cluster, self);
  };
  await writeDir(root, img.subarray((1 + 2 * f.fat) * 512, dataStart * 512), 0, 0);

  // FAT12: two entries in every three bytes
  let fatBytes = new Uint8Array(f.fat * 512);
  for (let i = 0; i < fat.length; i++) {
    let o = Math.floor(i * 3 / 2);
    if (i & 1) { fatBytes[o] |= (fat[i] & 0xf) << 4; fatBytes[o + 1] = fat[i] >> 4; }
    else { fatBytes[o] = fat[i] & 0xff; fatBytes[o + 1] |= (fat[i] >> 8) & 0xf; }
  }
  img.set(fatBytes, 512);
  img.set(fatBytes, 512 + f.fat * 512);
  return new Blob([img]);
}

/* ----- ISO 9660 CDs ----- */

const BLOCK = 2048;

function both16(v, at, n) { v.setUint16(at, n, true); v.setUint16(at + 2, n, false); }
function both32(v, at, n) { v.setUint32(at, n, true); v.setUint32(at + 4, n, false); }
function isoDate(ms) {
  // Local time, as on the floppies (DOS shows the time as written)
  let d = new Date(ms || new Date(1980, 0, 1).getTime());
  return [d.getFullYear() - 1900, d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), 0];
}
function volumeDate(ms) {
  let d = new Date(ms || new Date(1980, 0, 1).getTime()), p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}00\0`;
}

export async function buildIso(files, { label = 'CDROM' } = {}) {
  let root = tree(files);
  // Two trees over the same files: ISO 9660 level 1 names (for DOS), and Joliet's
  // UCS-2 long names (for Windows)
  let fileList = [];
  let dirs = { iso: [], joliet: [] }; // breadth-first, for the path tables
  // The same entry objects in both trees, so each file is stored once
  let listed = new Map();
  let listOf = node => {
    if (!listed.has(node)) listed.set(node, entries(node));
    return listed.get(node);
  };
  let isoNames = list => {
    let dirs = shortNames(list.filter(e => e.dir).map(e => e.name), { allowed: /[A-Z0-9_]/, extLen: 0 });
    let files = shortNames(list.filter(e => !e.dir).map(e => e.name), { allowed: /[A-Z0-9_]/ });
    return list.map(e => e.dir ? dirs.shift() : files.shift()).map((s, k) => list[k].dir ? s : s.includes('.') ? s + ';1' : s + '.;1');
  };
  let build = (node, flavour) => {
    let all = [];
    let mk = (node, parent, name) => {
      let d = { node, parent, name, children: [], records: null };
      d.number = all.push(d);
      return d;
    };
    let top = mk(node, null, '');
    for (let i = 0; i < all.length; i++) {
      let d = all[i], list = listOf(d.node);
      let names = flavour == 'iso' ? isoNames(list) : list.map(e => e.name.replace(/[*\/:;?\\]/g, '_').slice(0, 64) + (e.dir ? '' : ';1'));
      let kids = list.map((e, k) => ({ e, id: names[k] }));
      kids.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      for (let { e, id } of kids) {
        if (e.dir) d.children.push({ id, dir: mk(e.dir, d, id), mtime: e.mtime });
        else {
          if (!e.file) { e.file = { blob: e.blob, lba: 0 }; fileList.push(e); }
          d.children.push({ id, file: e.file, mtime: e.mtime });
        }
      }
    }
    dirs[flavour] = all;
    return top;
  };
  build(root, 'iso');
  build(root, 'joliet');

  let encode = (id, flavour) => {
    if (flavour == 'iso') return new Uint8Array([...id].map(c => c.charCodeAt(0)));
    let out = new Uint8Array(id.length * 2), v = new DataView(out.buffer);
    for (let i = 0; i < id.length; i++) v.setUint16(i * 2, id.charCodeAt(i), false);
    return out;
  };
  let record = (idBytes, lba, size, isDir, mtime) => {
    let len = 33 + idBytes.length + (idBytes.length % 2 == 0 ? 1 : 0);
    let r = new Uint8Array(len), v = new DataView(r.buffer);
    r[0] = len;
    both32(v, 2, lba); both32(v, 10, size);
    r.set(isoDate(mtime), 18);
    r[25] = isDir ? 2 : 0;
    both16(v, 28, 1);
    r[32] = idBytes.length;
    r.set(idBytes, 33);
    return r;
  };
  // A directory's size: its records packed into blocks, none crossing a block boundary
  let dirSize = (d, flavour) => {
    let lens = [34, 34, ...d.children.map(c => { let n = encode(c.id, flavour).length; return 33 + n + (n % 2 == 0 ? 1 : 0); })];
    let blocks = 1, used = 0;
    for (let l of lens) { if (used + l > BLOCK) { blocks++; used = 0; } used += l; }
    return blocks * BLOCK;
  };
  let pathTable = (flavour, bigEndian) => {
    let parts = [];
    for (let d of dirs[flavour]) {
      let id = d.parent ? encode(d.name, flavour) : new Uint8Array([0]);
      let r = new Uint8Array(8 + id.length + (id.length % 2)), v = new DataView(r.buffer);
      r[0] = id.length;
      v.setUint32(2, d.lba, !bigEndian);
      v.setUint16(6, d.parent ? d.parent.number : 1, !bigEndian);
      r.set(id, 8);
      parts.push(r);
    }
    let out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)), at = 0;
    for (let p of parts) { out.set(p, at); at += p.length; }
    return out;
  };

  // Layout: descriptors at 16-18, path tables, directories, then file data
  let lba = 19;
  let ptSize = flavour => { for (let d of dirs[flavour]) d.lba = 0; return pathTable(flavour, false).length; };
  let pt = {};
  for (let flavour of ['iso', 'joliet']) {
    pt[flavour] = { size: ptSize(flavour), l: lba };
    lba += Math.ceil(pt[flavour].size / BLOCK);
    pt[flavour].m = lba;
    lba += Math.ceil(pt[flavour].size / BLOCK);
  }
  for (let flavour of ['iso', 'joliet']) {
    for (let d of dirs[flavour]) { d.size = dirSize(d, flavour); d.lba = lba; lba += d.size / BLOCK; }
  }
  for (let e of fileList) { e.file.lba = e.file.blob.size ? lba : 0; lba += Math.ceil(e.file.blob.size / BLOCK); }
  let total = lba;

  let dirBytes = (d, flavour) => {
    let out = new Uint8Array(d.size), at = 0;
    let put = r => { if (at % BLOCK + r.length > BLOCK) at = Math.ceil(at / BLOCK) * BLOCK; out.set(r, at); at += r.length; };
    put(record(new Uint8Array([0]), d.lba, d.size, true, d.node.mtime));
    let p = d.parent || d;
    put(record(new Uint8Array([1]), p.lba, p.size, true, p.node.mtime));
    for (let c of d.children) {
      if (c.dir) put(record(encode(c.id, flavour), c.dir.lba, c.dir.size, true, c.mtime));
      else put(record(encode(c.id, flavour), c.file.lba, c.file.blob.size, false, c.mtime));
    }
    return out;
  };
  let descriptor = (type, flavour) => {
    let b = new Uint8Array(BLOCK), v = new DataView(b.buffer);
    let text = (at, len, s) => { let e = flavour == 'joliet' ? encode(s.slice(0, len / 2).padEnd(len / 2, ' '), 'joliet') : new Uint8Array([...s.slice(0, len).padEnd(len, ' ')].map(c => c.charCodeAt(0))); b.set(e, at); };
    b[0] = type; b.set([...'CD001'].map(c => c.charCodeAt(0)), 1); b[6] = 1;
    text(8, 32, '');
    text(40, 32, flavour == 'joliet' ? label : label.toUpperCase().replace(/[^A-Z0-9_]/g, '_'));
    both32(v, 80, total);
    if (flavour == 'joliet') b.set([0x25, 0x2f, 0x45], 88); // UCS-2 level 3
    both16(v, 120, 1); both16(v, 124, 1); both16(v, 128, BLOCK);
    both32(v, 132, pt[flavour].size);
    v.setUint32(140, pt[flavour].l, true);
    v.setUint32(148, pt[flavour].m, false);
    let top = dirs[flavour][0];
    b.set(record(new Uint8Array([0]), top.lba, top.size, true, root.mtime), 156);
    for (let [at, len] of [[190, 128], [318, 128], [446, 128], [574, 128], [702, 37], [739, 37], [776, 37]]) text(at, len, '');
    let date = volumeDate(root.mtime);
    for (let at of [813, 830]) b.set([...date].map(c => c.charCodeAt(0)), at);
    for (let at of [847, 864]) b.set([...'0000000000000000\0'].map(c => c.charCodeAt(0)), at);
    b[881] = 1;
    return b;
  };

  let parts = [new Uint8Array(16 * BLOCK), descriptor(1, 'iso'), descriptor(2, 'joliet')];
  let term = new Uint8Array(BLOCK);
  term[0] = 255; term.set([...'CD001'].map(c => c.charCodeAt(0)), 1); term[6] = 1;
  parts.push(term);
  let padded = bytes => { let out = new Uint8Array(Math.ceil(bytes.length / BLOCK) * BLOCK); out.set(bytes); return out; };
  for (let flavour of ['iso', 'joliet']) {
    parts.push(padded(pathTable(flavour, false)), padded(pathTable(flavour, true)));
  }
  for (let flavour of ['iso', 'joliet']) for (let d of dirs[flavour]) parts.push(dirBytes(d, flavour));
  for (let e of fileList) {
    let size = e.file.blob.size;
    if (!size) continue;
    parts.push(e.file.blob);
    if (size % BLOCK) parts.push(new Uint8Array(BLOCK - size % BLOCK));
  }
  return new Blob(parts);
}
