/* The worker behind a FileDisk (see file-disk.js): a file in the origin private file
   system (OPFS), read and written in place through a synchronous access handle,
   which only dedicated workers can have. Messages are handled in the order they're
   sent, so a read sees every write sent before it.

   Messages, each answered with { id, ... } (or { id, error }):
   - { op: 'open', path }: open (creating) the file, for exclusive use; -> { size }
   - { op: 'read', offset, length } -> { data } (past the end of the file reads as zeros)
   - { op: 'write', offset, data }: not answered unless it fails
   - { op: 'flush' } -> {}
   - { op: 'close' } -> {}: flushes and lets go of the file
   - { op: 'copy', from, to }: copy one file to another (neither open) -> { size },
     reporting { id, progress: [done, total] } along the way
   - { op: 'export', from, to, size }: write the disk at `from` (not open), as a raw
     image `size` bytes long, to `to`, a file handle from the save picker -> {},
     reporting progress the same way. The disk stays locked meanwhile, so the machine
     can't start (and change it) halfway through. */
import { opfsFile } from './file-disk.js';

let handle = null, flushTimer = null;

function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (handle) handle.flush();
}

async function copy(id, from, to) {
  let source = await (await opfsFile(from)).createSyncAccessHandle();
  try {
    let dest = await (await opfsFile(to, true)).createSyncAccessHandle();
    try {
      let size = source.getSize(), chunk = new Uint8Array(4 << 20);
      dest.truncate(0);
      for (let at = 0; at < size; at += chunk.length) {
        let n = source.read(chunk, { at });
        // Runs of zeros are left as holes: unwritten parts of a disk read as zeros
        let view = chunk.subarray(0, n);
        if (view.some(b => b)) dest.write(view, { at });
        postMessage({ id, progress: [at + n, size] });
      }
      dest.truncate(size);
      dest.flush();
      return { size };
    } finally {
      dest.close();
    }
  } finally {
    source.close();
  }
}

async function exportTo(id, from, to, size) {
  let source = null;
  try { source = await (await opfsFile(from)).createSyncAccessHandle(); }
  catch (e) { if (e.name != 'NotFoundError') throw e; } // never written: all zeros
  try {
    let out = await to.createWritable();
    try {
      let have = source ? source.getSize() : 0, chunk = new Uint8Array(4 << 20);
      for (let at = 0; at < have; at += chunk.length) {
        let n = source.read(chunk, { at }), view = chunk.subarray(0, n);
        // Runs of zeros are skipped: the file reads as zeros where nothing's written
        if (view.some(b => b)) await out.write({ type: 'write', position: at, data: view });
        postMessage({ id, progress: [at + n, size] });
      }
      await out.truncate(size);
      await out.close();
    } catch (e) {
      try { await out.abort(); } catch (e2) {}
      throw e;
    }
    postMessage({ id, progress: [size, size] });
    return {};
  } finally {
    if (source) source.close();
  }
}

onmessage = async ({ data: msg }) => {
  let { id, op } = msg;
  try {
    if (op == 'write') {
      handle.write(msg.data, { at: msg.offset });
      // Written data reaches the file at once; flushing makes it durable, a little later
      if (!flushTimer) flushTimer = setTimeout(flush, 1000);
    } else if (op == 'read') {
      let data = new Uint8Array(msg.length);
      handle.read(data, { at: msg.offset });
      postMessage({ id, data }, [data.buffer]);
    } else if (op == 'open') {
      handle = await (await opfsFile(msg.path, true)).createSyncAccessHandle();
      postMessage({ id, size: handle.getSize() });
    } else if (op == 'flush') {
      flush();
      postMessage({ id });
    } else if (op == 'close') {
      if (handle) { flush(); handle.close(); handle = null; }
      postMessage({ id });
    } else if (op == 'copy') {
      postMessage({ id, ...await copy(id, msg.from, msg.to) });
    } else if (op == 'export') {
      postMessage({ id, ...await exportTo(id, msg.from, msg.to, msg.size) });
    }
  } catch (e) {
    postMessage({ id, op, error: e.name == 'NoModificationAllowedError' ? 'in use' : String(e && e.message || e) });
  }
};
