import { BaseEmulator } from './base.js'
import { CanvasTerminal } from './canvas-terminal.js'
import { V86Mouse } from './v86-mouse.js'
import { LanConnection } from '../net/lan.js'
import { V86Persistence } from './v86-persist.js'

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

  /* Fixes to v86's CD-ROM drive, which Windows 98's CD driver needs.

     - After a PACKET command, v86 raises an interrupt as it gets ready for the packet.
       A drive only does that if it says so in IDENTIFY ("interrupt DRQ"), and v86's
       says it doesn't, so Windows sends the packet without waiting for one; then the
       stray interrupt reaches its handler, which finds the drive still busy with the
       command and resets it. A disc read from memory answers before the handler runs,
       so it works by luck; one read as it's used (a large image, a bin/cue, or one
       from a URL) answers a moment later, every read is reset, and the disc looks
       empty or unreadable. So the PACKET command raises no interrupt.
     - A drive tells the system its disc was changed by answering the next command
       with UNIT ATTENTION ("medium may have changed"), which is how Windows knows to
       read the new disc. v86 only says so to an ATA GET MEDIA STATUS, which Windows
       doesn't send, so after a swap Windows keeps showing the disc it read first. So
       the first command after a change (other than those that never report one) gets
       that answer. */
  static patchCdrom(cd) {
    if (!cd) return;
    let proto = Object.getPrototypeOf(cd), command = proto.ata_command, handle = proto.atapi_handle;
    if (!command || !handle || handle.emularity) return;
    const PACKET = 0xa0;
    proto.ata_command = function (cmd) {
      if (cmd != PACKET || !this.is_atapi || !this.drive_connected) return command.apply(this, arguments);
      // as v86 does it, but without the interrupt
      this.current_command = cmd;
      this.error_reg = 0;
      this.data_allocate(12);
      this.data_end = 12;
      this.sector_count_reg = 1; // command/data: the packet goes to the drive
      this.status_reg = 0x58;    // ready, DRQ
    };
    const REQUEST_SENSE = 0x03, INQUIRY = 0x12, GET_CONFIGURATION = 0x46, GET_EVENT_STATUS = 0x4a;
    proto.atapi_handle = function () {
      let cmd = this.data[0];
      if (this.medium_changed && this.buffer && ![REQUEST_SENSE, INQUIRY, GET_CONFIGURATION, GET_EVENT_STATUS].includes(cmd)) {
        this.medium_changed = false;
        this.data_pointer = 0;
        this.current_atapi_command = cmd;
        this.atapi_check_condition_response(6, 0x28); // UNIT ATTENTION, medium changed
        this.push_irq();
        return;
      }
      return handle.apply(this, arguments);
    };
    proto.atapi_handle.emularity = true;
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
      wasm_path: this.wasmroot + '/v86.wasm',
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
        V86Emulator.patchCdrom(this.emulator.v86.cpu.devices.cdrom);
        if (this.persist) V86Emulator.setMac(this.emulator.v86.cpu.devices, this.persist);
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
    this.dispatchEvent(new CustomEvent('mediachange', { detail: { drive, current: this.inserted[drive] } }));
  }
  async ejectMedia(drive) {
    let current = this.inserted && this.inserted[drive];
    if (!current || !this.emulator) return;
    if (drive != 'cdrom' && this.persistence) await this.persistence.detach(this.persistKey(drive, current.id));
    this.emulator['eject_' + drive]();
    this.inserted[drive] = null;
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
    this.emulator.stop();
    this.onV86Stopped(); // (if v86 hasn't announced the stop already)
  }

  // Cleanly tear down the machine (the host reloads the page to leave a session, but
  // stop it too so timers/audio don't linger if the element is removed).
  disconnectedCallback() {
    super.disconnectedCallback();
    this.destroyed = true;
    this.stopPersistence();
    try { this.mouse && this.mouse.destroy(); } catch (e) {}
    try { this.lan && this.lan.close(); } catch (e) {}
    try { this.term && this.term.destroy(); } catch (e) {}
    try { this.emulator && this.emulator.destroy && this.emulator.destroy(); } catch (e) {}
  }
}
