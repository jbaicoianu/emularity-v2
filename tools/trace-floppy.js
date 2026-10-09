/* Paste into the devtools console while an x86 machine is running in the collection
   player, then reproduce the floppy problem. Logs the floppy controller's commands,
   results, register writes and interrupts to window.fdlog; afterwards run
   copy(fdlog.join('\n')) to copy the log. */
(() => {
  let emu = document.querySelector('emularity-collection-player').emu;
  let fdc = emu.emulator.v86.cpu.devices.fdc, t0 = performance.now();
  let log = window.fdlog = [], last = '', repeats = 0;
  let add = s => {
    if (s == last) { repeats++; return; }
    if (repeats) log.push('      (x' + (repeats + 1) + ')');
    last = s; repeats = 0;
    log.push(((performance.now() - t0) / 1000).toFixed(2) + ' ' + s);
  };
  let hex = a => Array.from(a).map(x => x.toString(16)).join(',');
  for (let c of new Set(fdc.cmd_table)) {
    if (!c || c._traced) continue;
    let h = c.handler;
    c.handler = function (args) { window.fdlogAdd('> ' + c.name + ' ' + hex(args)); return h.call(this, args); };
    c._traced = true;
  }
  // The controller is sealed, so methods are wrapped on its prototype (once: a second
  // paste only re-points the log), and its registers at the I/O ports
  let proto = Object.getPrototypeOf(fdc);
  let wrap = (name, show) => {
    if (proto[name]._traced) return;
    let f = proto[name];
    proto[name] = function (...a) { let r = f.apply(this, a); window.fdlogAdd(show.call(this, a, r)); return r; };
    proto[name]._traced = true;
  };
  window.fdlogAdd = add;
  wrap('enter_result_phase', function (a) { return '< ' + hex(this.response_data.slice(0, a[0])); });
  wrap('raise_irq', function () { return '  irq'; });
  let ports = emu.emulator.v86.cpu.io.ports;
  let port = (n, label, write) => {
    let p = ports[n], key = write ? 'write8' : 'read8', f = p[key];
    if (f._traced) return;
    p[key] = write ? function (v) { window.fdlogAdd('  ' + label + '=' + v.toString(16)); return f.call(this, v); }
                   : function () { let r = f.call(this); window.fdlogAdd('  ' + label + ' -> ' + r.toString(16)); return r; };
    p[key]._traced = true;
  };
  // The data and status registers: every byte in and out
  port(0x3f4, 'MSR', false);
  port(0x3f5, 'FIFO', false);
  port(0x3f5, 'FIFO', true);
  port(0x3f2, 'DOR', true);
  port(0x3f4, 'DSR', true);
  port(0x3f7, 'CCR', true);
  port(0x3f7, 'DIR', false);
  // DMA channel 2 (the floppy's): its byte count, which drivers read back to see how
  // much was transferred, and the status register
  port(0x05, 'DMA2 count', false);
  port(0x08, 'DMA status', false);
  let d = fdc.drives[0];
  add('drive A: type ' + d.drive_type + ', ' + (d.buffer ? d.buffer.byteLength + ' bytes, ' + d.max_track + 'x' + d.max_head + 'x' + d.max_sect : 'empty') + ', media_changed ' + d.media_changed);
  let disks = emu.persistence ? [...emu.persistence.disks].map(([k, v]) => k + ' (' + v.pages.size + ' changed pages)') : [];
  add('saved changes: ' + (disks.join(', ') || 'none'));
  let player = document.querySelector('emularity-collection-player');
  add('machine: ' + JSON.stringify({ ...player.item.record, thumb: undefined }));
  add('browser: ' + navigator.userAgent);
  return 'tracing the floppy controller; reproduce, then: copy(fdlog.join("\\n"))';
})();
