/* BIN/CUE CD images, read in place.

   A .bin holds a CD's raw sectors: 2352 bytes each, the 2048 bytes of data wrapped in
   a sync pattern, header, and error correction. Emulators that read ISOs want just the
   2048-byte data. sectorView() gives a File that looks like the ISO, made on demand
   from slices of the .bin, so nothing is copied or converted: reading part of the
   view reads only the sectors it covers. */

const ISO_SECTOR = 2048;

// Where a track's 2048 bytes of data sit in each of its sectors
const MODES = {
  'MODE1/2048': { size: 2048, offset: 0 },
  'MODE1/2352': { size: 2352, offset: 16 },  // sync, header
  'MODE2/2048': { size: 2048, offset: 0 },
  'MODE2/2336': { size: 2336, offset: 8 },   // XA subheader
  'MODE2/2352': { size: 2352, offset: 24 },  // sync, header, XA subheader
  'CDI/2352': { size: 2352, offset: 24 },
  'AUDIO': { size: 2352, offset: 0 },
};

/* A cue sheet's files and tracks: [{ name, tracks: [{ number, mode, index: { n: frame } }] }] */
export function parseCue(text) {
  let files = [], track = null;
  for (let line of text.split(/\r?\n/)) {
    let words = line.trim().match(/"[^"]*"|\S+/g);
    if (!words) continue;
    let cmd = words[0].toUpperCase();
    if (cmd == 'FILE') {
      // FILE name type, though the type is sometimes left out
      let name = words.length > 2 ? words.slice(1, -1).join(' ') : words[1] || '';
      files.push({ name: name.replace(/^"|"$/g, ''), tracks: [] });
    } else if (cmd == 'TRACK' && files.length) {
      track = { number: parseInt(words[1], 10), mode: (words[2] || '').toUpperCase(), index: {} };
      files[files.length - 1].tracks.push(track);
    } else if (cmd == 'INDEX' && track) {
      let [m, s, f] = (words[2] || '').split(':').map(Number);
      track.index[parseInt(words[1], 10)] = (m * 60 + s) * 75 + f;
    }
  }
  return files;
}

/* The cue sheet's data track, as a File of 2048-byte sectors. `getFile(name)` finds a
   file the cue names (a Blob), or returns null. */
export function cueImage(text, getFile, name = 'cd.iso') {
  let earlier = false; // a track before this one
  for (let file of parseCue(text)) {
    let tracks = file.tracks;
    for (let i = 0; i < tracks.length; i++, earlier = true) {
      let mode = MODES[tracks[i].mode];
      if (!mode || tracks[i].mode == 'AUDIO') continue;
      // Its filesystem counts sectors from the start of the disc, which a view of
      // the track alone doesn't
      if (earlier) throw new Error("The cue sheet's data track comes after its audio tracks (as on a CD-Extra), which isn't supported");
      let blob = getFile(file.name);
      if (!blob) throw new Error(`The cue sheet's data file "${file.name}" is missing`);
      // Tracks in one file are back to back; assume they share a sector size (a file
      // of mixed sizes would need each track's size to place the next)
      let first = tracks[i].index[1] ?? tracks[i].index[0] ?? 0;
      let next = tracks[i + 1], nextStart = next && (next.index[0] ?? next.index[1]);
      let end = nextStart != null ? nextStart * mode.size : blob.size;
      let start = first * mode.size;
      return sectorView(blob.slice(start, Math.min(end, blob.size)), mode, name);
    }
  }
  throw new Error('The cue sheet has no data track');
}

/* A .bin with no cue sheet: raw sectors if it starts with a sector's sync pattern, else
   taken to be plain 2048-byte sectors (an ISO by another name) */
export async function binImage(blob, name = 'cd.iso') {
  let head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  let sync = head[0] == 0 && head[11] == 0 && head.subarray(1, 11).every(b => b == 0xff);
  if (!sync) return new File([blob], name);
  let mode = head[15] == 2 ? 'MODE2/2352' : 'MODE1/2352', image = sectorView(blob, MODES[mode], name);
  image.mode = mode; // for a cue sheet to go with it
  return image;
}

/* The data in a run of raw sectors, as a File */
export function sectorView(blob, { size, offset }, name = 'cd.iso') {
  if (size == ISO_SECTOR) return new File([blob], name);
  return new SectorFile(blob, size, offset, name);
}

/* A File whose bytes are the 2048-byte data of each sector of `source`. Only size and
   slice() are its own; a slice is a real Blob, of slices of the source. */
class SectorFile extends File {
  #source; #size; #offset; #length;
  constructor(source, size, offset, name) {
    super([], name);
    this.#source = source;
    this.#size = size;
    this.#offset = offset;
    this.#length = Math.floor(source.size / size) * ISO_SECTOR;
  }
  get size() { return this.#length; }
  slice(start = 0, end = this.#length, type = '') {
    let clamp = n => n < 0 ? Math.max(0, this.#length + n) : Math.min(n, this.#length);
    start = clamp(start); end = clamp(end);
    let parts = [];
    for (let at = start; at < end;) {
      let sector = Math.floor(at / ISO_SECTOR), within = at - sector * ISO_SECTOR;
      let n = Math.min(ISO_SECTOR - within, end - at);
      let from = sector * this.#size + this.#offset + within;
      parts.push(this.#source.slice(from, from + n));
      at += n;
    }
    return new Blob(parts, { type });
  }
  // Read the whole thing (as v86 does for a small disk, or DOSBox for any)
  arrayBuffer() { return this.slice().arrayBuffer(); }
  stream() { return this.slice().stream(); }
  text() { return this.slice().text(); }
}
