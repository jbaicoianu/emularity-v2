/* Repack a FAT16 hard disk image onto a bigger disk.

   A FAT16 partition can't grow in place: a bigger one needs bigger clusters and a
   bigger FAT, which moves everything after it. So this builds a new image instead:
   the same MBR (boot code, with the partition stretched to fill the disk), the same
   boot sector (its BPB updated), and every file and directory copied across with its
   directory entries intact (long names, attributes, dates), packed in order from the
   start of the data area.

   Everything written sits at the front of the new disk; the rest is zeros. The result
   is that prefix, as Blob parts in order, and the full disk size: a 2 GB disk holding
   200 MB of files is stored as about 200 MB.

   FAT16 tops out at 65524 clusters of 32 KB, just under 2 GB; Windows 9x can't use
   bigger clusters. Bigger disks would need FAT32. */

const SECTOR = 512;
// v86's hard disk geometry
const HEADS = 16, SPT = 63, CYLINDER = HEADS * SPT;
export const MAX_FAT16_BYTES = 65524 * 32768;

/* Where an image's FAT16 partition is, or null if it hasn't one we can repack */
export function findFat16(mbr) {
  if (mbr[510] != 0x55 || mbr[511] != 0xaa) return null;
  let view = new DataView(mbr.buffer, mbr.byteOffset);
  for (let i = 0; i < 4; i++) {
    let e = 446 + 16 * i, type = mbr[e + 4];
    // FAT16 <32M, FAT16, FAT16 LBA
    if (type == 0x04 || type == 0x06 || type == 0x0e) return { index: i, type, lba: view.getUint32(e + 8, true), sectors: view.getUint32(e + 12, true) };
  }
  return null;
}

/* A disk size rounded down to whole cylinders, as the new disk will be */
export function roundDiskSize(size) {
  return Math.floor(size / SECTOR / CYLINDER) * CYLINDER * SECTOR;
}

/* The largest disk (in bytes) a FAT16 partition starting at sector 63 can fill */
export function maxDiskSize() {
  return Math.floor((MAX_FAT16_BYTES / SECTOR + 63) / CYLINDER) * CYLINDER * SECTOR;
}

/* read(offset, length) -> Promise<Uint8Array> reads the source image. `size` is the
   new disk's size in bytes (rounded down to whole cylinders). Returns { parts, length,
   byteLength }: the image's first `length` bytes as Blob parts, and its full size. */
export async function repackFat16({ read, size, onProgress = () => {} }) {
  let mbr = await read(0, SECTOR);
  let part = findFat16(mbr);
  if (!part) throw new Error("This disk image doesn't have a FAT16 partition to resize");
  // The partition grows to fill the disk, over where any other would be
  for (let i = 0; i < 4; i++) {
    if (i != part.index && mbr[446 + 16 * i + 4]) throw new Error('This disk image has more than one partition, so it can\'t be resized');
  }

  // ----- the source filesystem -----
  let boot = await read(part.lba * SECTOR, SECTOR);
  let bv = new DataView(boot.buffer, boot.byteOffset);
  let src = {
    spc: boot[13], reserved: bv.getUint16(14, true), fats: boot[16], rootEntries: bv.getUint16(17, true),
    fatSectors: bv.getUint16(22, true), sectors: bv.getUint16(19, true) || bv.getUint32(32, true),
  };
  if (bv.getUint16(11, true) != SECTOR || !src.fatSectors) throw new Error('Unsupported FAT layout');
  let srcBase = part.lba * SECTOR;
  let srcFat = await read(srcBase + src.reserved * SECTOR, src.fatSectors * SECTOR);
  let srcFatView = new DataView(srcFat.buffer, srcFat.byteOffset);
  let srcRootSectors = Math.ceil(src.rootEntries * 32 / SECTOR);
  let srcRoot = srcBase + (src.reserved + src.fats * src.fatSectors) * SECTOR;
  let srcData = srcRoot + srcRootSectors * SECTOR;
  let srcClusterBytes = src.spc * SECTOR;
  let srcClusters = Math.floor((src.sectors - (srcData - srcBase) / SECTOR) / src.spc);
  let next = c => srcFatView.getUint16(c * 2, true);
  let chain = start => {
    let runs = [], c = start, seen = 0;
    while (c >= 2 && c < srcClusters + 2 && seen++ < srcClusters) {
      let last = runs[runs.length - 1];
      if (last && last.start + last.count == c) last.count++;
      else runs.push({ start: c, count: 1 });
      c = next(c);
    }
    return runs;
  };
  let readChain = async (start, length) => {
    let out = new Uint8Array(length), at = 0;
    for (let run of chain(start)) {
      if (at >= length) break;
      let n = Math.min(run.count * srcClusterBytes, length - at);
      out.set(await read(srcData + (run.start - 2) * srcClusterBytes, n), at);
      at += n;
    }
    return out;
  };
  // How much there is to copy, for progress
  let used = 0, ranges = [];
  for (let c = 2; c < srcClusters + 2; c++) {
    if (!next(c)) continue;
    used++;
    let offset = srcData + (c - 2) * srcClusterBytes, last = ranges[ranges.length - 1];
    if (last && last.offset + last.length == offset) last.length += srcClusterBytes;
    else ranges.push({ offset, length: srcClusterBytes });
  }
  let usedBytes = used * srcClusterBytes, copied = 0;
  // Files are copied in directory order, all over the disk: a remote image is quicker
  // to fetch up front, in disk order. Progress is the fetch, then the copy.
  let total = usedBytes;
  if (read.prefetch) {
    total *= 2;
    ranges.push({ offset: srcRoot, length: srcRootSectors * SECTOR });
    await read.prefetch(ranges, (done, of) => onProgress(done / of * usedBytes, total));
  }
  let base = total - usedBytes;

  // ----- the new layout -----
  let diskSectors = roundDiskSize(size) / SECTOR;
  let partSectors = diskSectors - 63;
  if (partSectors < src.sectors) throw new Error("The new disk can't be smaller than the original");
  let rootSectors = srcRootSectors, reserved = src.reserved, fats = src.fats;
  let spc = src.spc, fatSectors, clusters;
  for (;;) {
    // FAT size and cluster count depend on each other; iterate to a fit
    fatSectors = 1;
    for (let i = 0; i < 4; i++) {
      clusters = Math.floor((partSectors - reserved - fats * fatSectors - rootSectors) / spc);
      fatSectors = Math.ceil((clusters + 2) * 2 / SECTOR);
    }
    clusters = Math.floor((partSectors - reserved - fats * fatSectors - rootSectors) / spc);
    // The iteration can settle a sector short of holding every cluster: grow it to fit
    while ((clusters + 2) * 2 > fatSectors * SECTOR) {
      fatSectors++;
      clusters = Math.floor((partSectors - reserved - fats * fatSectors - rootSectors) / spc);
    }
    if (clusters <= 65524) break;
    if (spc >= 64) throw new Error('FAT16 disks can be at most ' + (maxDiskSize() >> 20) + ' MB');
    spc *= 2;
  }
  let clusterBytes = spc * SECTOR;
  if (clusterBytes < srcClusterBytes) throw new Error('Unexpected cluster size');

  // ----- copy the tree -----
  let fat = new Uint16Array(clusters + 2);
  fat[0] = 0xff00 | boot[21]; fat[1] = 0xffff;
  let nextFree = 2;
  let parts = []; // { cluster, data } in cluster order; directories are filled in later
  let alloc = bytes => {
    let n = Math.max(1, Math.ceil(bytes / clusterBytes));
    if (nextFree + n > clusters + 2) throw new Error("The files don't fit on the new disk");
    let start = nextFree;
    for (let i = 0; i < n; i++) fat[start + i] = i == n - 1 ? 0xffff : start + i + 1;
    nextFree += n;
    return { start, n };
  };

  /* Copy a directory's entries (a Uint8Array of them) into `out`, copying what they
     point at. `self` and `parent` are the new clusters for "." and "..". */
  let copyDir = async (entries, out, self, parent) => {
    let dirs = [];
    for (let i = 0; i + 32 <= entries.length; i += 32) {
      let e = entries.subarray(i, i + 32);
      if (e[0] == 0) break;
      out.set(e, i);
      if (e[0] == 0xe5) continue;
      let attr = e[11];
      if (attr == 0x0f || attr & 0x08) continue; // long name, volume label
      let ev = new DataView(out.buffer, out.byteOffset + i);
      let start = new DataView(e.buffer, e.byteOffset).getUint16(26, true);
      if (e[0] == 0x2e) { // "." and ".."
        ev.setUint16(26, e[1] == 0x2e ? parent : self, true);
        continue;
      }
      if (attr & 0x10) {
        dirs.push({ start, ev });
      } else {
        let length = new DataView(e.buffer, e.byteOffset).getUint32(28, true);
        if (!length || start < 2) { ev.setUint16(26, 0, true); continue; }
        let { start: to } = alloc(length);
        ev.setUint16(26, to, true);
        let data = await readChain(start, length);
        let padded = new Uint8Array(Math.ceil(length / clusterBytes) * clusterBytes);
        padded.set(data);
        parts.push({ cluster: to, data: new Blob([padded]) });
        copied += Math.ceil(length / srcClusterBytes) * srcClusterBytes;
        onProgress(base + Math.min(copied, usedBytes), total);
      }
    }
    // Subdirectories, after their parent's entries are in place
    for (let { start, ev } of dirs) {
      let runs = chain(start), length = runs.reduce((n, r) => n + r.count, 0) * srcClusterBytes;
      let entries = await readChain(start, length);
      let { start: to, n } = alloc(length);
      ev.setUint16(26, to, true);
      let buf = new Uint8Array(n * clusterBytes);
      parts.push({ cluster: to, data: buf });
      copied += length;
      await copyDir(entries, buf, to, self);
    }
  };
  let rootIn = await read(srcRoot, rootSectors * SECTOR);
  let rootOut = new Uint8Array(rootSectors * SECTOR);
  await copyDir(rootIn, rootOut, 0, 0);
  onProgress(total, total);

  // ----- assemble -----
  let newMbr = mbr.slice();
  let e = 446 + 16 * part.index, mv = new DataView(newMbr.buffer);
  let chs = lba => {
    let c = Math.floor(lba / CYLINDER), h = Math.floor(lba / SPT) % HEADS, s = lba % SPT + 1;
    if (c > 1023) { c = 1023; h = HEADS - 1; s = SPT; }
    return [h, s | (c >> 8) << 6, c & 0xff];
  };
  newMbr.set(chs(63), e + 1);
  newMbr.set(chs(diskSectors - 1), e + 5);
  mv.setUint32(e + 8, 63, true);
  mv.setUint32(e + 12, partSectors, true);
  // big partitions need LBA addressing
  if (diskSectors > 1024 * CYLINDER) newMbr[e + 4] = 0x0e;
  else if (part.type == 0x04 && partSectors >= 65536) newMbr[e + 4] = 0x06;

  let newBoot = boot.slice(), nb = new DataView(newBoot.buffer);
  newBoot[13] = spc;
  nb.setUint16(19, 0, true);
  nb.setUint16(22, fatSectors, true);
  nb.setUint16(24, SPT, true);
  nb.setUint16(26, HEADS, true);
  nb.setUint32(28, 63, true);
  nb.setUint32(32, partSectors, true);

  // Sectors between the MBR and the partition, as they were
  let gap = await read(SECTOR, (63 - 1) * SECTOR);
  let reservedRest = reserved > 1 ? await read(srcBase + SECTOR, (reserved - 1) * SECTOR) : new Uint8Array(0);
  let fatBytes = new Uint8Array(fatSectors * SECTOR);
  fatBytes.set(new Uint8Array(fat.buffer, 0, Math.min(fat.byteLength, fatBytes.length)));
  let blobParts = [newMbr, gap, newBoot, reservedRest];
  for (let i = 0; i < fats; i++) blobParts.push(fatBytes);
  blobParts.push(rootOut);
  parts.sort((a, b) => a.cluster - b.cluster);
  for (let p of parts) blobParts.push(p.data instanceof Blob ? p.data : new Blob([p.data]));
  let length = (63 + reserved + fats * fatSectors + rootSectors) * SECTOR + (nextFree - 2) * clusterBytes;
  return { parts: blobParts, length, byteLength: diskSectors * SECTOR, clusterBytes };
}
