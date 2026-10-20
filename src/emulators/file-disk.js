/* Hard disks kept as files in the browser's origin private file system (OPFS).

   A FileDisk is a disk for v86 (pass it as `hda`/`hdb`): it reads and writes the file
   in place, through a worker (file-disk-worker.js), so nothing builds up in memory
   however much the guest writes, and changes are kept as they're made, like a real
   disk's. The file holds the disk's bytes as they are, so it's a raw disk image any
   emulator can use (see exportDisk). It only grows as far as the guest has written;
   the rest of the disk reads as zeros.

   Only one FileDisk can have a file open at a time (in any tab): opening one that's
   in use fails. */
import { sparseFile } from './disk-image.js';

/* A file in OPFS, by "dir/sub/name" path */
export async function opfsFile(path, create = false) {
  let parts = path.split('/'), dir = await navigator.storage.getDirectory();
  for (let name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create });
  return dir.getFileHandle(parts[parts.length - 1], { create });
}

class DiskWorker {
  constructor() {
    this.worker = new Worker(new URL('./file-disk-worker.js', import.meta.url), { type: 'module' });
    this.calls = new Map();
    this.nextId = 1;
    this.worker.onmessage = ({ data }) => {
      let call = this.calls.get(data.id);
      if (!data.id) {
        if (data.error) console.error('Emularity: writing a disk file failed:', data.error);
        return;
      }
      if (data.progress) { if (call && call.onProgress) call.onProgress(...data.progress); return; }
      this.calls.delete(data.id);
      if (!call) return;
      if (data.error) call.reject(new Error(data.error));
      else call.resolve(data);
    };
  }
  call(msg, transfer = [], onProgress = null) {
    let id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }
  /* Sent without waiting for an answer (writes: errors are logged) */
  send(msg, transfer = []) {
    this.worker.postMessage(msg, transfer);
  }
  terminate() {
    this.worker.terminate();
  }
}

export class FileDisk {
  keepsOwnChanges = true; // for V86Persistence: this disk needs no saving
  onload = null;
  onprogress = null;

  /* The disk at `path`, `size` bytes long */
  static async open(path, size) {
    let disk = new FileDisk(path, size);
    try {
      await disk.worker.call({ op: 'open', path });
    } catch (e) {
      disk.worker.terminate();
      if (e.message == 'in use') throw new Error('this hard disk is in use in another tab');
      throw e;
    }
    return disk;
  }
  constructor(path, size) {
    this.path = path;
    this.byteLength = size;
    this.worker = new DiskWorker();
  }

  /* ----- v86's disk buffer interface ----- */

  load() {
    if (this.onload) this.onload(Object.create(null));
  }
  get(start, length, done) {
    this.worker.call({ op: 'read', offset: start, length }).then(r => done(r.data), e => {
      console.error('Emularity: reading the disk file failed', e);
      done(new Uint8Array(length));
    });
  }
  set(start, data, done) {
    // v86 may reuse `data` once this returns, so it goes as a copy
    let copy = data.slice();
    if (this.cache) this.updateCache(start, copy);
    this.worker.send({ op: 'write', offset: start, data: copy }, [copy.buffer]);
    done();
  }
  /* Before booting, v86 reads the first sector this way, then gets it back with
     get_from_cache to take the disk's geometry from its partition table. So what's
     read here is kept (and kept up to date by writes). */
  get_and_cache(start, length, done) {
    this.get(start, length, data => {
      this.cache = { start, data: data.slice() };
      done(data);
    });
  }
  get_from_cache(start, length) {
    let c = this.cache;
    if (!c || start < c.start || start + length > c.start + c.data.length) return undefined;
    return c.data.slice(start - c.start, start - c.start + length);
  }
  updateCache(start, data) {
    let c = this.cache, from = Math.max(start, c.start), to = Math.min(start + data.length, c.start + c.data.length);
    if (from < to) c.data.set(data.subarray(from - start, to - start), from - c.start);
  }
  get_state() { return [[]]; }  // nothing to put in a saved state: it's all in the file
  set_state() {}
  get_buffer(done) { done(); }

  /* ----- Keeping it ----- */

  flush() {
    return this.worker.call({ op: 'flush' });
  }
  /* Let go of the file (after writing everything sent so far) */
  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await this.worker.call({ op: 'close' }); }
    finally { this.worker.terminate(); }
  }
}

/* ----- Disk files ----- */

/* How much of the disk has been written (the file's size), or 0 if there's no file */
export async function diskUsage(path) {
  try { return (await (await opfsFile(path)).getFile()).size; }
  catch (e) { return 0; }
}

/* Delete a disk file (or a folder of them) */
export async function removeDisk(path) {
  let parts = path.split('/'), dir = await navigator.storage.getDirectory();
  try {
    for (let name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name);
    await dir.removeEntry(parts[parts.length - 1], { recursive: true });
  } catch (e) {
    if (e.name != 'NotFoundError') throw e;
  }
}

/* Copy a disk file (neither may be open). A missing source copies as an empty disk. */
export async function copyDisk(from, to, onProgress) {
  try { await opfsFile(from); }
  catch (e) { await removeDisk(to); return; }
  let worker = new DiskWorker();
  try { await worker.call({ op: 'copy', from, to }, [], onProgress); }
  catch (e) { throw new Error(e.message == 'in use' ? 'the hard disk is in use (is the machine running in another tab?)' : e.message); }
  finally { worker.terminate(); }
}

/* The whole disk as a raw image (a File of `size` bytes) */
export async function diskImage(path, size, name = 'disk.img') {
  let file;
  try { file = await (await opfsFile(path)).getFile(); }
  catch (e) { file = new Blob([]); }
  return sparseFile(file, size, name);
}

/* Save the whole disk as a raw image file, where the user chooses (or as a download,
   where the browser can't ask). Fails if the disk is in use: an image taken while the
   machine runs would be half old, half new. Returns false if the user cancelled. */
export async function exportDisk(path, size, name = 'disk.img', onProgress = null) {
  let inUse = e => e.message == 'in use' ? new Error('the hard disk is in use. Shut the machine down first (is it running in another tab?)') : e;
  if (window.showSaveFilePicker) {
    let handle;
    try {
      handle = await showSaveFilePicker({ suggestedName: name, types: [{ description: 'Raw disk image', accept: { 'application/octet-stream': ['.img'] } }] });
    } catch (e) {
      if (e.name == 'AbortError') return false;
      throw e;
    }
    let worker = new DiskWorker();
    try { await worker.call({ op: 'export', from: path, to: handle, size }, [], onProgress); }
    catch (e) { throw inUse(e); }
    finally { worker.terminate(); }
    return true;
  }
  // A download reads the file after this returns, so just check nothing has it open
  let worker = new DiskWorker();
  try { await worker.call({ op: 'open', path }); await worker.call({ op: 'close' }); }
  catch (e) { throw inUse(e); }
  finally { worker.terminate(); }
  let a = document.createElement('a');
  a.href = URL.createObjectURL(await diskImage(path, size, name));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return true;
}
