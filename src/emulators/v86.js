import { BaseEmulator } from './base.js'
import { CanvasTerminal } from './canvas-terminal.js'
import { V86Mouse } from './v86-mouse.js'
import { LanConnection } from '../net/lan.js'
import { V86Persistence } from './v86-persist.js'
import { FileDisk } from './file-disk.js'
import { PerformanceMeter } from './performance-meter.js'

/* x86 PC emulator, powered by v86 (https://github.com/copy/v86). Unlike the DOSBox /
   MAME emulators, v86 is not an Emscripten module we drive through BaseEmulator's
   script/module pipeline — it's a self-contained library with its own `V86` API. So
   this element reuses BaseEmulator's loading screen, status text and lifecycle events
   but overrides start()/boot() to construct a V86 machine directly.

   Boots a full PC, so it can run Linux (and other x86 OSes) from a CD-ROM (.iso),
   hard-disk image (.img/.raw/.qcow2/…), floppy (.img), a raw kernel (bzimage), or a
   9p root filesystem passed through `v86opts`.

   Display: Emularity exposes a running system as a single <canvas> (hosts use it as a
   WebGL texture). By default that's v86's VGA canvas, with text modes rendered onto it
   too (use_graphical_text) so the same canvas carries the BIOS, a VGA text console, a
   framebuffer console and X. For minimal images that only speak over the serial line,
   set console="serial" to render the serial stream to a CanvasTerminal instead. */
export class V86Emulator extends BaseEmulator {
  wasmscript = 'libv86.js'
  memory_size = 512
  vga_memory_size = 8
  resolution = '800x600'
  v86opts = null  // extra V86 constructor options (filesystem, cmdline, bzimage…)
  media = []      // disks in the drives at boot: [{ drive: 'fda'|'fdb'|'cdrom', id, name, blob | url }]
  hardDisks = null // hard disks kept as files (see file-disk.js): { hda: { path, size }, hdb: ... }

  /* Removable-media drives (see mediaDrives / insertMedia / ejectMedia) */
  static DRIVES = {
    fda: { label: 'Floppy A:', kind: 'floppy' },
    fdb: { label: 'Floppy B:', kind: 'floppy' },
    cdrom: { label: 'CD-ROM', kind: 'cdrom' },
  };

  connectedCallback() {
    super.connectedCallback();
    this.wasmroot = this.getAttribute('wasmroot') ?? '';
    this.image = this.getAttribute('image') ?? null;
    this.imagetype = this.getAttribute('imagetype') ?? null; // cdrom | hda | fda | bzimage
    if (this.hasAttribute('memory')) this.memory_size = parseInt(this.getAttribute('memory'), 10) || this.memory_size;
    if (this.hasAttribute('vgamemory')) this.vga_memory_size = parseInt(this.getAttribute('vgamemory'), 10) || this.vga_memory_size;
    this.serialConsole = (this.getAttribute('console') === 'serial');
    // capturemouse: clicking the screen captures the mouse (pointer lock)
    this.captureMouse = this.hasAttribute('capturemouse');
    // network="lan": plug the network card into the virtual LAN shared by every page
    // on this origin (see src/net/)
    this.network = this.getAttribute('network');
    // On the LAN, the machine is known by `hostname` (made unique there), and
    // described to network viewers by `label`
    this.hostname = this.getAttribute('hostname');
    this.label = this.getAttribute('label');
    // uplink: a JSON file of settings for the LAN's internet uplink (src/net/uplink.js),
    // such as its server and login, kept out of the page itself
    this.uplink = this.getAttribute('uplink');
    this.classList.add('v86');
  }

  // v86 has no Emscripten module, so replace BaseEmulator's start() (which loads a
  // module script and boots an Emscripten runtime) with our own boot path.
  start() {
    if (this.started) return;
    this.started = true;
    if (this.settings) this.setSettings(this.settings);
    this.initLoadingScreen().then(() => this.boot().catch(e => {
      console.error('Emularity: v86 boot failed', e);
      this.setStatus('Failed to start: ' + (e && e.message || e));
    }));
  }

  // Load a UMD script once. If `globalName` is given and already present, skip.
  loadLibrary(url, globalName) {
    return new Promise((resolve, reject) => {
      if (globalName && typeof self !== 'undefined' && self[globalName]) return resolve();
      let s = document.createElement('script');
      s.src = url;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('failed to load ' + url));
      document.head.appendChild(s);
    });
  }

  // v86's ScreenAdapter wants a container holding a text <div> and a graphics <canvas>.
  // With use_graphical_text the div stays hidden and everything is drawn on the canvas.
  buildVga() {
    let container = document.createElement('div');
    container.className = 'v86-screen';
    let textDiv = document.createElement('div');
    textDiv.style.display = 'none';
    let canvas = document.createElement('canvas');
    canvas.className = 'emularity-canvas v86-canvas';
    canvas.tabIndex = 0; // focusable so v86 keyboard/mouse input can target it
    container.appendChild(textDiv);
    container.appendChild(canvas);
    return container;
  }

  // The serial console, rendered to a 2D canvas. xterm is loaded lazily on the first
  // serial byte.
  handleSerialByte(byte) {
    this.term.write(byte); // CanvasTerminal buffers bytes until xterm is attached
    if (this._xtermLoading) return;
    this._xtermLoading = true;
    this.loadLibrary(this.wasmroot + '/xterm.js', 'Terminal')
      .then(() => this.term.attachXterm(self.Terminal))
      .catch(e => console.error('Emularity: xterm (terminal parser) failed to load', e));
  }

  // Resolve the boot medium into a v86 disk-image config. A Blob (uploaded/cached/local
  // file) is handed over as an in-memory buffer; a remote URL streams on demand via HTTP
  // range requests so we don't download the whole image up front.
  async resolveMedia() {
    let media;
    if (this.imageBlob) media = { buffer: await this.imageBlob.arrayBuffer() };
    else if (this.image) media = { url: this.image, async: true };
    else throw new Error('no image provided');
    let type = this.imagetype || this.guessType();
    let cfg = {};
    cfg[type] = media;
    return cfg;
  }
  guessType() {
    let name = (this.imagename || this.image || '').toLowerCase();
    if (/\.iso$/.test(name)) return 'cdrom';
    if (/\.(fda|flp)$/.test(name) || /floppy/.test(name)) return 'fda';
    if (/(bzimage|vmlinuz)/.test(name)) return 'bzimage';
    return 'hda'; // .img/.raw/.qcow2/.hdd and anything else -> hard disk
  }

  /* Fixes to v86's floppy controller, which Windows 98's floppy driver needs. The
     controller dispatches commands through a table it builds when it's created, so the
     fixes go into that table (patching its methods afterwards changes nothing).

     - READ ID finishes when the next sector header passes under the head, so it takes
       a while; v86 finishes it at once, raising the interrupt while the driver is
       still sending the command, before it's ready for it. Windows' handler rejects
       the interrupt, then times out and resets the controller: listing a floppy
       stalls, and reading files fails ("General failure reading drive A"). So, as
       QEMU does, the controller stays busy and finishes 20ms later. (copy/v86#1633)
     - The disk-change line (DIR bit 7) says a disk was swapped since the driver last
       looked; moving the head with a disk in clears it. v86 only clears it when a seek
       lands on a different track, so a RECALIBRATE with the head already on track 0
       leaves it set, and Windows 98 SE, which clears the line with a recalibrate,
       sees every read as happening across a disk change. So a recalibrate with a disk
       in clears it too. */
  static patchFloppyController(fdc) {
    if (!fdc || !fdc.cmd_table || fdc.cmd_table.emularity) return;
    let proto = Object.getPrototypeOf(fdc);
    for (let entry of new Set(fdc.cmd_table)) {
      if (!entry) continue;
      if (entry.handler === proto.exec_read_id) {
        entry.handler = function (args) {
          this.msr &= ~0x80; // busy: not ready for bytes until it's done
          setTimeout(() => proto.exec_read_id.call(this, args), 20);
        };
      } else if (entry.handler === proto.exec_recalibrate) {
        entry.handler = function (args) {
          let drive = this.drives[args[0] & 1];
          if (drive && drive.buffer) drive.media_changed = false;
          return proto.exec_recalibrate.call(this, args);
        };
      }
    }
    fdc.cmd_table.emularity = true;
  }

  /* With ACPI on, the BIOS's ACPI tables (SeaBIOS's, written for QEMU) describe PCI
     hotplug through QEMU's PIIX4 hotplug ports at 0xae00-0xae0f: slots inserted,
     slots removed, eject, removable. v86 doesn't have them, so they read as all ones,
     which says every slot was just removed. Linux then drops the PCI devices it found
     (the IDE controller, network card, VGA...), so it sees no disks or CD drive. Read
     as zeros, they say what's true: nothing was plugged in or out. */
  static patchAcpiHotplug(cpu) {
    let zero = () => 0;
    for (let port = 0xae00; port < 0xae10; port++) cpu.io.register_read(port, {}, zero, zero, zero);
  }

  /* v86 gives its network card a random MAC address each boot, so to the LAN's DHCP
     server every boot is a new machine: it gets a new address, and the old lease is
     held for an hour. A machine that keeps its changes (`persist`, which only one tab
     runs at a time) keeps its MAC too, made from that name. Set before the guest reads
     it; the NE2000 also keeps a copy in its PROM. */
  static setMac(devices, name) {
    let h = 0x811c9dc5; // FNV-1a
    for (let c of new TextEncoder().encode(name)) h = Math.imul(h ^ c, 0x01000193) >>> 0;
    let mac = [0x00, 0x22, 0x15, h >>> 16 & 0xff, h >>> 8 & 0xff, h & 0xff]; // v86's prefix
    let ne2k = devices.net, virtio = devices.virtio_net;
    if (ne2k && ne2k.mac && ne2k.memory) {
      ne2k.mac.set(mac);
      for (let i = 0; i < 6; i++) ne2k.memory[i << 1] = ne2k.memory[i << 1 | 1] = mac[i];
    }
    if (virtio && virtio.mac) virtio.mac.set(mac);
  }

  // When v86 loads a bzimage directly it acts as the bootloader, but it always writes
  // vid_mode=0xFFFF ("normal") into the kernel's setup header and ignores any `vga=` on
  // the command line. `vga=` is a bootloader parameter (the kernel never parses it), so
  // without this the kernel's real-mode setup never sets the VESA mode, vesafb has no
  // framebuffer to bind, and the guest boots with no /dev/fb0. Patch the header the way
  // GRUB/LILO would before the CPU starts.
  applyVgaMode(cmdline) {
    let m = /(?:^|\s)vga=(\S+)/.exec(cmdline || '');
    if (!m) return;
    let named = { normal: 0xFFFF, ext: 0xFFFE, ask: 0xFFFD };
    let mode = named[m[1]] ?? Number(m[1]);
    if (!Number.isInteger(mode) || mode < 0 || mode > 0xFFFF) return;
    const SETUP_HEADER = 0x80000; // where v86 places the kernel's real-mode setup code
    const VID_MODE = 0x1FA;
    let mem8 = this.emulator.v86.cpu.mem8;
    mem8[SETUP_HEADER + VID_MODE] = mode & 0xFF;
    mem8[SETUP_HEADER + VID_MODE + 1] = mode >> 8;
  }

  async boot() {
    this.setStatus('Loading system...');
    await this.loadLibrary(this.wasmroot + '/' + this.wasmscript);
    // A simple image (cdrom/hda/…) is optional: a full distro like Arch instead supplies
    // a lazily-fetched 9p root filesystem + kernel through `v86opts`.
    let media = (this.imageBlob || this.image) ? await this.resolveMedia() : {};
    // Hard disks kept as files. (v86 only has a second hard disk with a first.)
    this.fileDisks = [];
    for (let drive of ['hda', 'hdb']) {
      let disk = this.hardDisks && this.hardDisks[drive];
      if (!disk) continue;
      try {
        media[drive] = await FileDisk.open(disk.path, disk.size);
      } catch (e) {
        this.closeFileDisks();
        throw e;
      }
      this.fileDisks.push(media[drive]);
    }
    if (this.destroyed) return this.closeFileDisks(); // removed while opening them
    // What's in each removable drive: the main image (if it's a floppy or CD), the
    // machine's own config, then the disks asked for at boot (where the drive's free)
    this.inserted = {};
    let named = cfg => cfg.url ? decodeURIComponent(cfg.url.split(/[?#]/)[0].replace(/\/(\.[^/]*)?$/, '$1').split('/').pop()) : 'disk';
    for (let drive in V86Emulator.DRIVES) {
      if (media[drive]) this.inserted[drive] = { id: 'main', name: this.imagename || named(media[drive]) };
      else if (this.v86opts && this.v86opts[drive]) this.inserted[drive] = { id: 'machine', name: named(this.v86opts[drive]) };
    }
    for (let m of this.media || []) {
      if (!V86Emulator.DRIVES[m.drive] || this.inserted[m.drive]) continue;
      media[m.drive] = await this.mediaFile(m);
      this.inserted[m.drive] = { id: m.id, name: m.name };
    }

    let screen = null;
    if (this.serialConsole) {
      this.term = new CanvasTerminal({ onData: d => { if (this.emulator) this.emulator.serial0_send(d); } });
      this.canvas = this.term.canvas;
    } else {
      screen = this.buildVga();
      this.canvas = screen.querySelector('canvas');
    }
    this.appendChild(screen || this.canvas);

    this.setStatus('Booting…');
    let V86 = self.V86 || self.V86Starter;
    let opts = Object.assign({
      // v86_64 keeps RAM above 3 GB in a separate 64-bit wasm memory, in its own build
      // (which v86 would pick itself, but only without a wasm_path)
      wasm_path: this.wasmroot + (this.memory_size > 3072 ? '/v86-mem64.wasm' : '/v86.wasm'),
      bios: { url: this.wasmroot + '/seabios.bin' },
      vga_bios: { url: this.wasmroot + '/vgabios.bin' },
      memory_size: this.memory_size * 1024 * 1024,
      vga_memory_size: this.vga_memory_size * 1024 * 1024,
      autostart: false, // started in onV86Loaded, after patching the kernel header
      disable_speaker: !this.sound,
      disable_mouse: true, // V86Mouse handles the mouse, from our canvas
      // An empty in-memory 9p filesystem the guest can mount (tag "host9p") for
      // host<->guest file exchange (emulator.create_file / read_file).
      filesystem: {},
    }, screen ? { screen: { container: screen, use_graphical_text: true } } : {}, media, this.v86opts || {});
    // v86 boots from a floppy first whenever one's in the drive. Disks added for the
    // machine (this.media) shouldn't change how it boots, so it gets the order it would
    // have without them: hard disk, then floppy, then CD; or CD first if there's no
    // hard disk. (A drive that won't boot is skipped, so a boot floppy still works on a
    // machine with an empty hard disk.)
    let ownFloppy = ['fda', 'fdb'].some(d => this.inserted[d] && (this.inserted[d].id == 'main' || this.inserted[d].id == 'machine'));
    if (!opts.boot_order && (opts.fda || opts.fdb) && !ownFloppy) opts.boot_order = opts.hda ? 0x312 : 0x123;

    this.emulator = new V86(opts);
    if (screen) this.mouse = new V86Mouse(this.emulator, this.canvas, { captureOnClick: this.captureMouse });
    if (this.network == 'lan') this.connectLan();
    this.dispatchEvent(new CustomEvent('preinit'));

    this.emulator.add_listener('download-progress', e => {
      if (e && e.total) this.setStatus('Downloading system… ' + Math.round(e.loaded / e.total * 100) + '%');
    });
    this.emulator.add_listener('download-error', e => this.setStatus('Download failed: ' + (e && e.file_name || '')));
    if (this.serialConsole) this.emulator.add_listener('serial0-output-byte', b => this.handleSerialByte(b));
    this.emulator.add_listener('emulator-loaded', async () => {
      try {
        if (opts.bzimage || opts.bzimage_initrd_from_filesystem) this.applyVgaMode(opts.cmdline);
        V86Emulator.patchFloppyController(this.emulator.v86.cpu.devices.fdc);
        if (opts.acpi) V86Emulator.patchAcpiHotplug(this.emulator.v86.cpu);
        if (this.persist) V86Emulator.setMac(this.emulator.v86.cpu.devices, this.persist);
        this.watchActivity(opts);
        this.watchPerformance();
        if (this.persist) await this.restoreChanges();
        if (this.destroyed) return; // removed while restoring
        this.emulator.run();
      } catch (e) {
        console.error('Emularity: v86 boot failed', e);
        this.setStatus('Failed to start: ' + (e && e.message || e));
      }
    });
    this.emulator.add_listener('emulator-started', () => this.onV86Started());
    this.emulator.add_listener('emulator-stopped', () => this.onV86Stopped());
    this.emulator.add_listener('cpu-event-halt', () => this.onGuestHalt());
  }

  /* ----- Drive lights and the like (see activity.js) ----- */

  /* v86 reports its hard disk, CD and network traffic on its bus, though not which
     disk on a channel; and nothing for floppies. So the disks' and floppy controller's
     own methods are hooked, which also gives floppy motors and head moves. */
  watchActivity(opts) {
    let cpu = this.emulator.v86.cpu, report = (id, type, info) => this.activity.report(id, type, info);
    let devices = [];
    for (let drive of ['fda', 'fdb']) {
      // Every PC here has drive A:; B: only shows once there's a disk for it
      if (drive == 'fda' || this.inserted.fdb) devices.push(this.floppyDevice(drive));
    }
    let ide = cpu.devices.ide, disks = [['hda', ide && ide.primary && ide.primary.master], ['hdb', ide && ide.primary && ide.primary.slave], ['cdrom', ide && ide.secondary && ide.secondary.master]];
    for (let [id, disk] of disks) {
      if (!disk || !disk.drive_connected) continue;
      let cd = id == 'cdrom';
      devices.push(cd
        ? { id, kind: 'cdrom', label: 'CD-ROM', medium: this.inserted.cdrom ? this.inserted.cdrom.name : null, features: ['read'] }
        : { id, kind: 'hdd', label: id == 'hda' ? 'Hard disk' : 'Second hard disk', features: ['read', 'write'] });
      V86Emulator.hook(disk, 'report_read_end', (disk, [bytes], run) => { report(id, 'read', { bytes }); return run(); });
      V86Emulator.hook(disk, 'report_write', (disk, [bytes], run) => { report(id, 'write', { bytes }); return run(); });
    }
    if (opts.filesystem && (opts.filesystem.basefs || opts.filesystem.baseurl)) {
      devices.push({ id: 'fs', kind: 'hdd', label: 'Root filesystem', features: ['read', 'write'] });
      this.emulator.add_listener('9p-read-end', ([, bytes]) => report('fs', 'read', { bytes }));
      this.emulator.add_listener('9p-write-end', ([, bytes]) => report('fs', 'write', { bytes }));
    }
    if (this.network == 'lan' || opts.network_relay_url || opts.net_device) {
      devices.push({ id: 'net0', kind: 'network', label: 'Network', features: ['transmit', 'receive'] });
      this.emulator.add_listener('eth-transmit-end', ([bytes]) => report('net0', 'transmit', { bytes }));
      this.emulator.add_listener('eth-receive-end', ([bytes]) => report('net0', 'receive', { bytes }));
    }

    let fdc = cpu.devices.fdc;
    if (fdc && fdc.drives) {
      let ids = ['fda', 'fdb'], proto = Object.getPrototypeOf(fdc);
      // Head moves: seeks, recalibrates (to track 0), and reads and writes on another
      // track. (The drive's own track number also moves on when a read runs off the
      // end of a track, which the head doesn't, so it's kept here.)
      let head = fdc.drives.map(d => d.curr_track);
      let moveHead = (i, to) => {
        if (head[i] != to) report(ids[i], 'seek', { from: head[i], to });
        head[i] = to;
      };
      for (let entry of new Set(fdc.cmd_table || [])) {
        if (!entry || (entry.name != 'SEEK' && entry.name != 'RECALIBRATE')) continue;
        let handler = entry.handler;
        entry.handler = function (args) {
          moveHead(args[0] & 1, entry.name == 'SEEK' ? args[1] : 0);
          return handler.apply(this, arguments);
        };
      }
      // Reads and writes (args: drive, cylinder, head, first sector, size, last sector...)
      V86Emulator.hook(fdc, 'start_read_write', (fdc, [args, write], run) => {
        let sectors = Math.max(1, (args[5] - args[3] + 1) || 1);
        moveHead(args[0] & 1, args[1]);
        report(ids[args[0] & 1], write ? 'write' : 'read', { bytes: sectors * (128 << (args[4] & 7)) });
        return run();
      });
      // Motors: bits 4 and 5 of the digital output register (port 0x3f2)
      let motors = fdc.dor & 0x30;
      cpu.io.register_write(0x3f2, fdc, function (value) {
        proto.write_reg_dor.call(this, value);
        let changed = (value & 0x30) ^ motors;
        motors = value & 0x30;
        if (changed & 0x10) report('fda', 'motor', { on: !!(motors & 0x10) });
        if (changed & 0x20) report('fdb', 'motor', { on: !!(motors & 0x20) });
      });
    }
    this.activity.setDevices(devices);
  }
  /* Run `fn(object, args, run)` in place of the object's method, where run() calls the
     method. v86's devices are sealed objects, so their methods are replaced on their
     prototypes (once a page), and look up which object they're running on. */
  static hooks = new WeakMap()
  static hook(object, name, fn) {
    let proto = Object.getPrototypeOf(object), method = proto[name];
    if (!method.emularityHooked) {
      let hooks = V86Emulator.hooks;
      proto[name] = function (...args) {
        let h = hooks.get(this);
        return h && h[name] ? h[name](this, args, () => method.apply(this, args)) : method.apply(this, args);
      };
      proto[name].emularityHooked = true;
    }
    let h = V86Emulator.hooks.get(object) || {};
    h[name] = fn;
    V86Emulator.hooks.set(object, h);
  }
  /* CPU graphs (see performance-meter.js). v86 runs the machine in ticks on the page's
     main thread: the time inside them is the load. Between ticks the guest is either
     halted (waiting for an interrupt) or was just paused to let the page run; only the
     halted time is idle for the emulated CPU, along with ticks spent checking timers
     while it stays halted. */
  watchPerformance() {
    let meter = this.meter, v86 = this.emulator.v86, cpu = v86.cpu;
    let halted = false, since = performance.now();
    V86Emulator.hook(v86, 'do_tick', (v86, args, run) => {
      let start = performance.now(), wasHalted = halted;
      if (halted) meter.halted(start - since);
      let result = run();
      let end = performance.now();
      meter.busy(end - start);
      halted = !!cpu.in_hlt[0];
      if (wasHalted && halted) meter.halted(end - start);
      since = end;
      return result;
    });
    let instructions = null;
    meter.sampler = (now, wall) => {
      if (halted) { meter.halted(now - since); since = now; }
      let count = this.emulator.get_instruction_counter() >>> 0;
      let mips = instructions == null ? 0 : ((count - instructions) >>> 0) / wall / 1000;
      instructions = count;
      return { mips };
    };
    meter.setMetrics([PerformanceMeter.CPU, PerformanceMeter.LOAD, PerformanceMeter.MIPS]);
  }
  floppyDevice(drive) {
    let current = this.inserted && this.inserted[drive];
    return { id: drive, kind: 'floppy', label: V86Emulator.DRIVES[drive].label, medium: current ? current.name : null, features: ['read', 'write', 'seek', 'motor'] };
  }

  /* ----- Removable media ----- */

  /* v86's disk-file option for a medium. A CD is read as it's used, from a file or by
     range requests (a bin/cue's blob is a view of its data track: see cue.js); a
     floppy is small, and is read whole. */
  async mediaFile(m) {
    let cd = V86Emulator.DRIVES[m.drive] && V86Emulator.DRIVES[m.drive].kind == 'cdrom';
    if (m.blob && cd) return { buffer: m.blob instanceof File ? m.blob : new File([m.blob], m.name || 'cd.iso'), async: true };
    if (m.blob) return { buffer: await m.blob.arrayBuffer() };
    return cd ? { url: m.url, async: true } : { url: m.url };
  }
  /* The removable drives and what's in them: [{ id, label, kind, current: { id, name } | null }] */
  get mediaDrives() {
    return Object.entries(V86Emulator.DRIVES).map(([id, d]) => ({ id, ...d, current: (this.inserted && this.inserted[id]) || null }));
  }
  /* Changes kept for a floppy follow the disk, not the drive */
  persistKey(drive, id) {
    return !id || id == 'main' || id == 'machine' ? drive : 'media:' + id;
  }
  /* Put a disk in a drive, while running: { id, name, blob | url }. Whatever was in
     the drive is ejected first. */
  async insertMedia(drive, m) {
    if (!this.emulator || !V86Emulator.DRIVES[drive]) throw new Error('no such drive: ' + drive);
    if (this.inserted[drive]) await this.ejectMedia(drive);
    let file = await this.mediaFile({ ...m, drive });
    if (drive == 'cdrom') {
      await this.emulator.set_cdrom(file);
    } else {
      await this.emulator['set_' + drive](file);
      let fdd = this.emulator.v86.cpu.devices.fdc.drives[drive == 'fda' ? 0 : 1];
      // v86 only takes images of standard floppy sizes
      if (!fdd.buffer) throw new Error(m.name + " isn't a floppy disk image this drive can read");
      if (this.persistence) await this.persistence.attach(this.persistKey(drive, m.id), fdd.buffer);
    }
    this.inserted[drive] = { id: m.id, name: m.name };
    this.activity.setDevice(drive == 'cdrom' ? { id: drive, medium: m.name } : this.floppyDevice(drive));
    this.dispatchEvent(new CustomEvent('mediachange', { detail: { drive, current: this.inserted[drive] } }));
  }
  async ejectMedia(drive) {
    let current = this.inserted && this.inserted[drive];
    if (!current || !this.emulator) return;
    if (drive != 'cdrom' && this.persistence) await this.persistence.detach(this.persistKey(drive, current.id));
    this.emulator['eject_' + drive]();
    this.inserted[drive] = null;
    if (this.activity.device(drive)) this.activity.setDevice({ id: drive, medium: null });
    this.dispatchEvent(new CustomEvent('mediachange', { detail: { drive, current: null } }));
  }

  /* With `persist`, the machine's disk and filesystem changes are kept (see
     V86Persistence) in the IndexedDB database of that name. One tab at a time: two
     copies of the same machine writing the same changes would corrupt them.
     Where changes can't be kept (no Web Locks outside a secure context, no IndexedDB
     in some private modes), the machine runs without keeping them. */
  async restoreChanges() {
    if (!(navigator.locks && typeof indexedDB != 'undefined')) {
      console.warn("Emularity: this browser can't keep the machine's changes here (it needs a secure context); they'll be lost when it stops");
      return;
    }
    let held = await new Promise(resolve => {
      navigator.locks.request('emularity-machine:' + this.persist, { ifAvailable: true }, lock => {
        if (!lock || this.destroyed) return resolve(false);
        resolve(true);
        return new Promise(release => { this.releaseLock = release; }); // held until we stop
      });
    });
    if (this.destroyed) return;
    if (!held) throw new Error('this machine is already running in another tab');
    this.setStatus('Restoring saved changes...');
    let diskNames = {};
    for (let drive in this.inserted) if (this.inserted[drive]) diskNames[drive] = this.persistKey(drive, this.inserted[drive].id);
    let persistence = new V86Persistence(this.emulator, this.persist, { diskNames });
    try {
      await persistence.restore();
    } catch (e) {
      console.warn("Emularity: couldn't restore the machine's saved changes; running without keeping changes", e);
      this.unlock();
      return;
    }
    if (this.destroyed) return this.unlock();
    this.persistence = persistence;
    persistence.start();
  }
  /* Stop keeping changes, saving what's pending (all of it, if `final`), and let other
     tabs run the machine */
  async stopPersistence({ final = false } = {}) {
    let persistence = this.persistence;
    this.persistence = null;
    try {
      if (persistence && final) await persistence.save(true);
      if (persistence) await persistence.stop();
    } catch (e) {
      console.warn('Emularity: saving the machine failed', e);
    } finally {
      this.unlock();
    }
  }
  /* Let go of the hard disk files, with everything written */
  closeFileDisks() {
    let disks = this.fileDisks || [];
    this.fileDisks = [];
    return Promise.all(disks.map(d => d.close().catch(e => console.warn('Emularity: closing a hard disk file failed', e))));
  }
  unlock() {
    if (this.releaseLock) this.releaseLock();
    this.releaseLock = null;
  }

  /* Connect network card 0 to the virtual LAN */
  connectLan() {
    if (typeof SharedWorker == 'undefined') {
      console.warn('Emularity: this browser has no SharedWorker, so the virtual LAN is unavailable');
      return;
    }
    this.lan = new LanConnection(frame => this.emulator.bus.send('net0-receive', frame), { name: this.hostname, title: this.label, uplink: this.uplink });
    this.emulator.add_listener('net0-send', frame => this.lan.send(frame));
  }

  /* Capture the mouse (pointer lock) for raw relative movement, like a real mouse.
     Must be called from a user gesture; Escape releases it. */
  lockPointer() {
    return this.mouse ? this.mouse.lock() : Promise.reject(new Error('no mouse'));
  }

  /* ----- Keys the host keeps for itself -----
     Ctrl+Alt+Del, Ctrl+Alt+F1, Alt+Tab, the Windows key... are often caught by the host
     OS or the browser (even in fullscreen with the keyboard locked), so they can be sent
     from here instead, as scancodes (set 1), by name. */
  static SCANCODES = {
    Ctrl: [0x1d], Alt: [0x38], Shift: [0x2a], Win: [0xe0, 0x5b],
    Esc: [0x01], Tab: [0x0f], Backspace: [0x0e], Enter: [0x1c], Space: [0x39], Delete: [0xe0, 0x53],
    F1: [0x3b], F2: [0x3c], F3: [0x3d], F4: [0x3e], F5: [0x3f], F6: [0x40],
    F7: [0x41], F8: [0x42], F9: [0x43], F10: [0x44], F11: [0x57], F12: [0x58],
    D: [0x20], E: [0x12], L: [0x26], N: [0x31], Q: [0x10], R: [0x13], T: [0x14], W: [0x11],
  };
  static MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Win'];
  static release(code) { return code.length == 2 ? [code[0], code[1] | 0x80] : [code[0] | 0x80]; }

  /* Press keys in order and let go in reverse: sendKeys(['Ctrl', 'Alt', 'Delete']).
     Modifiers held with holdKey stay held. */
  sendKeys(names) {
    if (!this.emulator) return;
    let codes = names.map(n => V86Emulator.SCANCODES[n]), held = this.heldKeys || [];
    let down = codes.filter((c, i) => !held.includes(names[i]));
    this.emulator.keyboard_send_scancodes([...down.flat(), ...down.slice().reverse().flatMap(V86Emulator.release)]);
    // These are the "next key" for any held modifiers (Ctrl and Alt held, then F2)
    this.releaseHeldKeys();
  }
  /* Hold a modifier down (or let go of it, if held) until the next key typed on the
     real keyboard is let go: holdKey('Ctrl'), holdKey('Alt'), then F2 on the keyboard */
  holdKey(name) {
    if (!this.emulator || !V86Emulator.MODIFIERS.includes(name)) return;
    let held = this.heldKeys ||= [];
    if (held.includes(name)) {
      held.splice(held.indexOf(name), 1);
      this.emulator.keyboard_send_scancodes(V86Emulator.release(V86Emulator.SCANCODES[name]));
    } else {
      held.push(name);
      this.emulator.keyboard_send_scancodes(V86Emulator.SCANCODES[name]);
    }
    if (held.length && !this.onHeldKeyUp) {
      // After v86 has sent that key's release (its own keyup listener is on window too)
      this.onHeldKeyUp = ev => {
        if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(ev.key)) return;
        setTimeout(() => this.releaseHeldKeys(), 0);
      };
      addEventListener('keyup', this.onHeldKeyUp);
    }
    if (!held.length) this.releaseHeldKeys();
    this.dispatchEvent(new CustomEvent('heldkeyschange', { detail: held.slice() }));
  }
  releaseHeldKeys() {
    let held = this.heldKeys || [];
    if (this.emulator && held.length) this.emulator.keyboard_send_scancodes(held.slice().reverse().flatMap(n => V86Emulator.release(V86Emulator.SCANCODES[n])));
    this.heldKeys = [];
    if (this.onHeldKeyUp) removeEventListener('keyup', this.onHeldKeyUp);
    this.onHeldKeyUp = null;
    if (held.length) this.dispatchEvent(new CustomEvent('heldkeyschange', { detail: [] }));
  }
  /* Give the keyboard back to the machine (after a click on a button outside it) */
  focusScreen() {
    if (this.term) this.term.focus(); else if (this.canvas) this.canvas.focus();
  }

  onV86Started() {
    if (this.running) return;
    this.running = true;
    this.setStatus('Running');
    if (this.splashcanvas && this.splashcanvas.parentNode) this.splashcanvas.parentNode.removeChild(this.splashcanvas);
    if (this.term) this.term.focus(); else this.canvas.focus();
    this.dispatchEvent(new CustomEvent('canvaschange', { detail: this.canvas }));
    this.dispatchEvent(new CustomEvent('run'));
  }

  onV86Stopped() {
    if (this.exited) return;
    this.exited = true;
    this.running = false;
    this.dispatchEvent(new CustomEvent('exit', { detail: { code: 0, shutdown: !!this.shutDown } }));
  }

  /* The guest halted with interrupts off, which nothing can wake it from: it's off.
     v86 doesn't emulate power-off (it has no ACPI by default, and ignores its ACPI
     device's sleep requests), so this is how a shutdown ends: Windows 98 asks the BIOS
     (APM) to power off, and SeaBIOS, with no power to cut, halts the CPU; Linux's
     poweroff without ACPI ends the same way. v86 reports it, then idles forever on a
     blank screen. So save the disks and stop the machine. */
  async onGuestHalt() {
    if (this.exited || this.shutDown || !this.emulator) return;
    this.shutDown = true;
    await this.stopPersistence({ final: true });
    await this.closeFileDisks();
    this.emulator.stop();
    this.onV86Stopped(); // (if v86 hasn't announced the stop already)
  }

  // Cleanly tear down the machine (the host reloads the page to leave a session, but
  // stop it too so timers/audio don't linger if the element is removed).
  disconnectedCallback() {
    super.disconnectedCallback();
    this.destroyed = true;
    if (this.onHeldKeyUp) removeEventListener('keyup', this.onHeldKeyUp);
    this.stopPersistence();
    this.closeFileDisks();
    try { this.mouse && this.mouse.destroy(); } catch (e) {}
    try { this.lan && this.lan.close(); } catch (e) {}
    try { this.term && this.term.destroy(); } catch (e) {}
    try { this.emulator && this.emulator.destroy && this.emulator.destroy(); } catch (e) {}
  }
}
