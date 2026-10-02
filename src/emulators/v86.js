import { BaseEmulator } from './base.js'
import { CanvasTerminal } from './canvas-terminal.js'
import { V86Mouse } from './v86-mouse.js'

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

    this.emulator = new V86(opts);
    if (screen) this.mouse = new V86Mouse(this.emulator, this.canvas, { captureOnClick: this.captureMouse });
    this.dispatchEvent(new CustomEvent('preinit'));

    this.emulator.add_listener('download-progress', e => {
      if (e && e.total) this.setStatus('Downloading system… ' + Math.round(e.loaded / e.total * 100) + '%');
    });
    this.emulator.add_listener('download-error', e => this.setStatus('Download failed: ' + (e && e.file_name || '')));
    if (this.serialConsole) this.emulator.add_listener('serial0-output-byte', b => this.handleSerialByte(b));
    this.emulator.add_listener('emulator-loaded', () => {
      if (opts.bzimage || opts.bzimage_initrd_from_filesystem) this.applyVgaMode(opts.cmdline);
      this.emulator.run();
    });
    this.emulator.add_listener('emulator-started', () => this.onV86Started());
    this.emulator.add_listener('emulator-stopped', () => this.onV86Stopped());
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
    this.dispatchEvent(new CustomEvent('exit', { detail: { code: 0 } }));
  }

  // Cleanly tear down the machine (the host reloads the page to leave a session, but
  // stop it too so timers/audio don't linger if the element is removed).
  disconnectedCallback() {
    try { this.mouse && this.mouse.destroy(); } catch (e) {}
    try { this.term && this.term.destroy(); } catch (e) {}
    try { this.emulator && this.emulator.destroy && this.emulator.destroy(); } catch (e) {}
  }
}
