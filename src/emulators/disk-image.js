/* Random access to disk images, wherever they live, and sparse disks for v86. */

/* read(offset, length) -> Promise<Uint8Array> for an image: a Blob/File, or a v86
   disk config ({ url, size, fixed_chunk_size, use_parts } as in v86's catalog, or a
   plain URL served with range requests). Reads go through a chunk cache, fetching a
   few chunks ahead, since images are mostly read front to back.

   For a remote image, read.prefetch(ranges, onProgress) downloads the chunks covering
   [{ offset, length }...] ahead of time, several at once and in disk order, keeping
   them (as Blobs, which the browser can keep on disk) for the reads that follow. */
export function imageReader(source, { chunkSize = 256 * 1024, readAhead = 8 } = {}) {
  let fetchChunk;
  if (source instanceof Blob) {
    chunkSize = 4 << 20;
    fetchChunk = async i => new Uint8Array(await source.slice(i * chunkSize, (i + 1) * chunkSize).arrayBuffer());
  } else {
    let cfg = typeof source == 'string' ? { url: source } : source;
    if (cfg.use_parts) {
      chunkSize = cfg.fixed_chunk_size || chunkSize;
      // v86's part names: <base><start>-<end><ext>, with "-" after a base not ending in "/"
      let ext = (cfg.url.match(/\.[^.\/]+(\.zst)?$/) || [''])[0];
      if (ext.endsWith('.zst')) throw new Error("Compressed disk images can't be resized");
      let base = cfg.url.slice(0, cfg.url.length - ext.length);
      if (!base.endsWith('/')) base += '-';
      fetchChunk = async i => {
        let res = await fetch(`${base}${i * chunkSize}-${(i + 1) * chunkSize}${ext}`);
        if (!res.ok) throw new Error('HTTP ' + res.status + ' reading the disk image');
        return new Uint8Array(await res.arrayBuffer());
      };
    } else {
      chunkSize = 1 << 20;
      fetchChunk = async i => {
        let res = await fetch(cfg.url, { headers: { Range: `bytes=${i * chunkSize}-${(i + 1) * chunkSize - 1}` } });
        if (res.status != 206) throw new Error(res.ok ? "The disk image's server doesn't support range requests" : 'HTTP ' + res.status + ' reading the disk image');
        return new Uint8Array(await res.arrayBuffer());
      };
    }
  }
  let cache = new Map(), order = [], stored = new Map();
  let chunk = i => {
    if (stored.has(i)) return stored.get(i).arrayBuffer().then(b => new Uint8Array(b));
    if (!cache.has(i)) {
      cache.set(i, fetchChunk(i));
      order.push(i);
      while (order.length > readAhead * 4) cache.delete(order.shift());
    }
    return cache.get(i);
  };
  let read = async (offset, length) => {
    let out = new Uint8Array(length), first = Math.floor(offset / chunkSize);
    // (After a prefetch, everything wanted is here already)
    if (!stored.size) for (let i = first + 1; i <= first + readAhead; i++) chunk(i).catch(() => {}); // past the end is fine
    for (let at = 0; at < length;) {
      let i = Math.floor((offset + at) / chunkSize), o = offset + at - i * chunkSize;
      let data = await chunk(i);
      let n = Math.min(chunkSize - o, length - at);
      if (o + n > data.length) throw new Error('Read past the end of the disk image');
      out.set(data.subarray(o, o + n), at);
      at += n;
    }
    return out;
  };
  if (!(source instanceof Blob)) {
    read.prefetch = async (ranges, onProgress = () => {}, concurrency = 6) => {
      let wanted = new Set();
      for (let { offset, length } of ranges) {
        for (let i = Math.floor(offset / chunkSize); i * chunkSize < offset + length; i++) wanted.add(i);
      }
      let queue = [...wanted].filter(i => !stored.has(i)).sort((a, b) => a - b), done = 0;
      let worker = async () => {
        while (queue.length) {
          let i = queue.shift();
          stored.set(i, new Blob([await fetchChunk(i)]));
          onProgress(++done, wanted.size);
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
    };
  }
  return read;
}

/* A File of `size` bytes: `prefix`, then zeros. The zeros are one small Blob repeated,
   so nothing that size is ever allocated. Given to v86 as { buffer: file, async: true },
   it's read on demand, with writes kept in memory (and by persistence). */
export function sparseFile(prefix, size, name = 'disk.img') {
  const ZEROS = 1 << 20;
  let zeros = new Blob([new Uint8Array(ZEROS)]);
  let parts = [prefix], rest = size - prefix.size;
  for (; rest >= ZEROS; rest -= ZEROS) parts.push(zeros);
  if (rest > 0) parts.push(zeros.slice(0, rest));
  return new File(parts, name);
}
