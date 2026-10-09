/* Persistence for a v86 machine: what the guest writes to its disks and 9p filesystem
   is kept in an IndexedDB database (named by the emulator's `persist`), and put back
   the next time it boots, over the unchanged base image. Only changes are stored, so
   a streamed multi-GB disk costs as much as was written to it, and many machines
   (instances) can share one base image with their own changes each.

   - Disks (hard disks, floppies): every write goes through the disk buffer's set(),
     which we wrap to record the written 256-byte blocks. They're stored in 64KB pages
     ({ data, mask } with a byte per block saying it was written), only the pages
     changed since the last save being rewritten, and re-applied at boot. Reads are
     wrapped too, to lay the written blocks over what comes back: v86's chunked
     (use_parts) disks return the first read of a chunk straight from the network,
     before merging in blocks written to it, so restored changes (all of which land in
     chunks not yet fetched) would otherwise read back as the original image.
   - The 9p filesystem (e.g. Arch's root): v86 keeps only created/modified file data
     locally (unchanged files stay on the server). We store its inode table, plus the
     data of each file changed since the last save, by inode.

   When to save matters: the guest caches writes in its own RAM and updates related
   structures (FAT, directories, a registry hive) in several writes, so a save taken
   mid-burst is a snapshot of a half-done operation, as if the power had been cut
   right then. Windows 9x in particular can fail to boot from one. So changes are
   saved at quiet points: once the guest has gone QUIET ms without writing (giving its
   own write-back cache time to flush too), or after MAX_DIRTY ms for a guest that
   never stops writing. When the page goes away mid-burst, the last quiet save is kept
   rather than replaced by a torn one. Shutting the guest down cleanly is still
   safest. */

const BLOCK = 256, PAGE = 64 * 1024, BLOCKS_PER_PAGE = PAGE / BLOCK;
const QUIET = 2000;      // ms without writes before saving
const MAX_DIRTY = 60000;  // ms of unsaved changes before saving regardless
const FS_SAVE_INTERVAL = 60000; // also catches 9p attribute changes made outside the methods we wrap
const FS_MUTATORS = ['Write', 'CreateFile', 'CreateDirectory', 'CreateSymlink', 'CreateNode', 'CreateBinaryFile',
  'CreateTextFile', 'Unlink', 'Rename', 'Link', 'ChangeSize', 'DeleteData', 'set_data'];

function request(req) {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}

export class V86Persistence {
  /* `diskNames` names drives' changes by what's in them ({ fda: 'media:<id>' }), so
     a floppy keeps its own changes whichever drive it's in, and a different floppy in
     the same drive doesn't get them. Drives not named are keyed by drive ('hda'). */
  constructor(emulator, storeName, { diskNames = {} } = {}) {
    this.emulator = emulator;
    this.storeName = storeName;
    this.diskNames = diskNames;
    this.disks = new Map();   // name -> { buffer, pages: Map(page -> { data, mask }), dirty: Set(page) }
    this.fs = null;           // { fs, dirtyData: Set(inode id), deleted: Set, dirtyTable }
    this.lastWrite = 0;       // when the guest last wrote anything
    this.dirtySince = 0;      // when the oldest unsaved change was made (0: none)
  }

  open() {
    return this.db ??= new Promise((resolve, reject) => {
      let req = indexedDB.open(this.storeName, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('disk'); // `${disk}:${page}` -> { data, mask }; `${disk}:meta` -> { size }
        req.result.createObjectStore('fs');   // 'table' -> inode table etc.; `data:${id}` -> Uint8Array
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /* The machine's writable disks, by name */
  findDisks() {
    let devices = this.emulator.v86.cpu.devices, found = {};
    let ide = devices.ide;
    for (let [channel, name] of [['primary', 'hd'], ['secondary', 'hd2']]) {
      for (let [drive, letter] of [['master', 'a'], ['slave', 'b']]) {
        let iface = ide && ide[channel] && ide[channel][drive];
        if (iface && iface.buffer && !iface.is_atapi) found[name + letter] = iface.buffer;
      }
    }
    (devices.fdc && devices.fdc.drives || []).forEach((d, i) => { if (d && d.buffer) found['fd' + 'ab'[i]] = d.buffer; });
    return found;
  }

  /* Before the machine runs: put back saved changes, then start recording new ones */
  async restore() {
    for (let [drive, buffer] of Object.entries(this.findDisks())) {
      await this.attach(this.diskNames[drive] || drive, buffer);
    }
    let fs = this.emulator.v86.cpu.devices.virtio_9p && this.emulator.v86.cpu.devices.virtio_9p.fs;
    if (fs && fs.inodes && fs.inodes.length > 1) { // an empty share isn't worth keeping
      this.fs = { fs, dirtyData: new Set(), deleted: new Set(), dirtyTable: false };
      await this.restoreFs(await this.open());
      this.trackFs();
    }
  }

  /* Start keeping a disk's changes under `name`: put back what was saved, then
     record new writes. (Also for disks inserted while running.) */
  async attach(name, buffer) {
    await this.save(); // anything pending goes under the old names first
    let disk = { buffer, pages: new Map(), dirty: new Set() };
    this.disks.set(name, disk);
    await this.restoreDisk(await this.open(), name, disk);
    this.trackDisk(disk);
  }
  /* Stop keeping a disk's changes (it was ejected), saving what's pending */
  async detach(name) {
    await this.save();
    this.disks.delete(name);
  }

  async restoreDisk(db, name, disk) {
    let tx = db.transaction('disk'), store = tx.objectStore('disk');
    let meta = await request(store.get(name + ':meta'));
    if (meta && meta.size != disk.buffer.byteLength) {
      // A different image than the changes were made to: they don't apply
      console.warn('Emularity: saved changes for ' + name + ' are for a different disk image; ignoring them');
      return;
    }
    let keys = await request(store.getAllKeys(IDBKeyRange.bound(name + ':', name + ':￿')));
    let applied = 0;
    for (let key of keys) {
      let page = +key.slice(name.length + 1);
      if (!Number.isInteger(page)) continue;
      let record = await request(store.get(key));
      disk.pages.set(page, record);
      for (let b = 0; b < BLOCKS_PER_PAGE; b++) {
        if (!record.mask[b]) continue;
        // Straight into the buffer (before tracking starts, so it isn't a "new" write)
        await new Promise(done => disk.buffer.set(page * PAGE + b * BLOCK, record.data.subarray(b * BLOCK, (b + 1) * BLOCK), done));
        applied++;
      }
    }
    if (applied) console.info('Emularity: restored ' + Math.ceil(applied * BLOCK / 1024) + 'KB of changes to ' + name);
  }
  trackDisk(disk) {
    let buffer = disk.buffer, set = buffer.set.bind(buffer), get = buffer.get.bind(buffer);
    buffer.get = (offset, length, done, options) => get(offset, length, data => {
      this.overlay(disk, offset, data);
      done(data);
    }, options);
    buffer.set = (offset, data, done) => {
      // Copy every written block into its page (writes are whole sectors)
      for (let at = 0; at < data.length; at += BLOCK) {
        let pos = offset + at, page = Math.floor(pos / PAGE), b = (pos % PAGE) / BLOCK | 0;
        let record = disk.pages.get(page);
        if (!record) disk.pages.set(page, record = { data: new Uint8Array(PAGE), mask: new Uint8Array(BLOCKS_PER_PAGE) });
        record.data.set(data.subarray(at, at + BLOCK), b * BLOCK);
        record.mask[b] = 1;
        disk.dirty.add(page);
        this.wrote();
      }
      return set(offset, data, done);
    };
  }

  /* Copy the written blocks within [offset, offset + data.length) into data */
  overlay(disk, offset, data) {
    if (!disk.pages.size) return;
    let end = offset + data.length;
    for (let pos = offset - offset % BLOCK; pos < end; pos += BLOCK) {
      let page = Math.floor(pos / PAGE), record = disk.pages.get(page);
      if (!record) { pos = (page + 1) * PAGE - BLOCK; continue; } // skip the rest of an untouched page
      let b = (pos % PAGE) / BLOCK | 0;
      if (!record.mask[b]) continue;
      // The overlap of this block with the requested range
      let from = Math.max(pos, offset), to = Math.min(pos + BLOCK, end);
      data.set(record.data.subarray(b * BLOCK + (from - pos), b * BLOCK + (to - pos)), from - offset);
    }
  }

  async restoreFs(db) {
    let tx = db.transaction('fs'), store = tx.objectStore('fs');
    let table = await request(store.get('table'));
    if (!table) return;
    let data = [];
    for (let id of table.dataIds) {
      let bytes = await request(store.get('data:' + id));
      if (bytes) data.push([id, bytes]);
    }
    let fs = this.fs.fs;
    fs.set_state([table.inodes, table.qid, data, table.total, table.used]);
    console.info('Emularity: restored the filesystem (' + data.length + ' changed files)');
  }
  trackFs() {
    let state = this.fs, fs = state.fs, persistence = this;
    for (let method of FS_MUTATORS) {
      let original = fs[method];
      if (typeof original != 'function') continue;
      fs[method] = function(id, ...rest) {
        state.dirtyTable = true;
        persistence.wrote();
        if (method == 'set_data') state.dirtyData.add(id);
        if (method == 'DeleteData') { state.dirtyData.delete(id); state.deleted.add(id); }
        return original.call(this, id, ...rest);
      };
    }
  }

  wrote() {
    this.lastWrite = performance.now();
    if (!this.dirtySince) this.dirtySince = this.lastWrite;
  }
  get quiet() { return performance.now() - this.lastWrite >= QUIET; }

  /* Save if it's a good moment: the guest is quiet, or changes have waited too long */
  tick() {
    if (!this.dirtySince || this.saving) return;
    if (this.quiet || performance.now() - this.dirtySince >= MAX_DIRTY) {
      this.save().catch(e => console.warn('Emularity: saving the machine failed', e));
    }
  }

  /* Write out what changed since the last save. A save already under way took its
     snapshot before now, so this one follows it, catching what changed since. */
  async save(force = false) {
    let saving = this.saving = (this.saving || Promise.resolve()).catch(() => {})
      .then(() => this.saveChanges(force))
      .finally(() => { if (this.saving === saving) this.saving = null; });
    return saving;
  }
  async saveChanges(force) {
    let db = await this.open();
    let pending = [...this.disks.values()].some(d => d.dirty.size) || (this.fs && (this.fs.dirtyTable || force));
    if (!pending) return;
    // Take the pending sets now, so writes during the save land in the next one
    let diskWork = [...this.disks].map(([name, disk]) => { let pages = disk.dirty; disk.dirty = new Set(); return { name, disk, pages }; });
    let fsWork = null;
    if (this.fs && (this.fs.dirtyTable || force)) {
      let s = this.fs;
      fsWork = { data: s.dirtyData, deleted: s.deleted };
      s.dirtyData = new Set(); s.deleted = new Set(); s.dirtyTable = false;
    }
    this.dirtySince = 0;
    let tx = db.transaction(['disk', 'fs'], 'readwrite');
    for (let { name, disk, pages } of diskWork) {
      if (!pages.size) continue;
      let store = tx.objectStore('disk');
      store.put({ size: disk.buffer.byteLength }, name + ':meta');
      for (let page of pages) store.put(disk.pages.get(page), name + ':' + page);
    }
    if (fsWork) {
      let fs = this.fs.fs, store = tx.objectStore('fs');
      let state = fs.get_state();
      store.put({
        inodes: state[0].map(inode => inode.get_state()),
        qid: state[1],
        dataIds: state[2].map(([id]) => +id),
        total: state[3],
        used: state[4],
      }, 'table');
      for (let id of fsWork.data) if (fs.inodedata[id]) store.put(fs.inodedata[id], 'data:' + id);
      for (let id of fsWork.deleted) if (!fs.inodedata[id]) store.delete('data:' + id);
    }
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
  }

  start() {
    this.timer = setInterval(() => this.tick(), 500);
    this.fsTimer = setInterval(() => { if (this.quiet) this.save(true).catch(() => {}); }, FS_SAVE_INTERVAL);
    // Leaving: keep the last quiet save rather than one taken mid-burst
    this.onPageHide = () => { if (this.quiet) this.save(); };
    addEventListener('pagehide', this.onPageHide);
  }
  stop() {
    clearInterval(this.timer);
    clearInterval(this.fsTimer);
    removeEventListener('pagehide', this.onPageHide);
    return this.quiet ? this.save() : Promise.resolve();
  }
}
