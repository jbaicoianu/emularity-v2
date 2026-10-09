import { BaseEmulator } from './base.js'

/* <emularity-libretro>: runs a libretro core (an emulator built against the libretro
   API: Mesen and FCEUmm for the NES, and many more systems) compiled with our
   frontend (libretro/frontend.c) by tools/build-libretro-core.sh.

     <emularity-libretro wasmroot="../emulators/libretro" core="mesen"
                         rom="game.nes" persist="saves-key"></emularity-libretro>

   `core` picks <wasmroot>/<core>_libretro.js; the game comes from `rom` (a URL) or a
   `romBlob` property (with `romname` for its file name). Save RAM (battery-backed
   cartridge saves) persists in an IndexedDB database named by `persist`, if given
   (so deleting that database resets the game's saves, as for the other emulators).

   Like the other emulators it reuses BaseEmulator's loading screen and events, and
   exposes the running system as one <canvas>. Frames are paced by
   requestAnimationFrame at the core's frame rate, nudged by how much audio is
   buffered so sound neither starves nor lags. Input is the keyboard (see KEYS) and
   any gamepads, in the standard layout. */

// libretro joypad button ids (RETRO_DEVICE_ID_JOYPAD_*)
const B = 0, Y = 1, SELECT = 2, START = 3, UP = 4, DOWN = 5, LEFT = 6, RIGHT = 7, A = 8, X = 9, L = 10, R = 11, L2 = 12, R2 = 13, L3 = 14, R3 = 15;

/* Keyboard -> joypad 1. On a NES pad: Z = B, X = A, Enter = Start, Shift = Select. */
const KEYS = {
  ArrowUp: UP, ArrowDown: DOWN, ArrowLeft: LEFT, ArrowRight: RIGHT,
  KeyZ: B, KeyX: A, KeyA: Y, KeyS: X, KeyQ: L, KeyW: R,
  Enter: START, ShiftRight: SELECT, ShiftLeft: SELECT, Backspace: SELECT,
};
/* Standard-layout gamepad buttons -> joypad buttons (by position: the bottom face
   button is libretro's B, the right one A, as on a SNES pad) */
const PAD = [B, A, Y, X, L, R, L2, R2, SELECT, START, L3, R3, UP, DOWN, LEFT, RIGHT];

/* The audio output: a ring buffer in an AudioWorklet, fed stereo frames from the main
   thread. It plays silence when it runs dry, and reports how full it is. */
const AUDIO_WORKLET = `
class LibretroAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(sampleRate * 2 * 2); // 1s of stereo
    this.read = this.write = 0;
    this.port.onmessage = ev => {
      let data = ev.data, n = this.buffer.length;
      if (this.available() + data.length >= n) return; // overfull: drop (we're behind)
      for (let i = 0; i < data.length; i++) this.buffer[(this.write + i) % n] = data[i];
      this.write = (this.write + data.length) % n;
    };
  }
  available() { return (this.write - this.read + this.buffer.length) % this.buffer.length; }
  process(inputs, outputs) {
    let [left, right] = outputs[0], n = this.buffer.length;
    for (let i = 0; i < left.length; i++) {
      if (this.available() >= 2) {
        left[i] = this.buffer[this.read];
        right[i] = this.buffer[(this.read + 1) % n];
        this.read = (this.read + 2) % n;
      } else {
        left[i] = right[i] = 0;
      }
    }
    if ((currentFrame & 0x3ff) < left.length) this.port.postMessage(this.available() / 2 / sampleRate);
    return true;
  }
}
registerProcessor('libretro-audio', LibretroAudio);
`;

export class LibretroEmulator extends BaseEmulator {
  core = null
  rom = null
  romname = null
  romBlob = null

  connectedCallback() {
    super.connectedCallback();
    this.wasmroot = this.getAttribute('wasmroot') ?? '';
    this.core = this.getAttribute('core');
    this.rom = this.getAttribute('rom');
    this.romname = this.getAttribute('romname');
    this.classList.add('libretro');
  }

  // Not an Emscripten module driven through BaseEmulator's pipeline: replace start()
  start() {
    if (this.started) return;
    this.started = true;
    if (this.settings) this.setSettings(this.settings);
    this.initLoadingScreen().then(() => this.boot().catch(e => {
      console.error('Emularity: libretro core failed to start', e);
      this.setStatus('Failed to start: ' + (e && e.message || e));
    }));
  }

  async boot() {
    if (!this.core) throw new Error('no core given');
    this.setStatus('Loading emulator...');
    let base = new URL(this.wasmroot + '/', location.href).href;
    let { default: createCore } = await import(base + this.core + '_libretro.js');
    let m = this.module = await createCore({
      locateFile: file => base + file,
      print: text => console.log('[' + this.core + ']', text),
      printErr: text => console.warn('[' + this.core + ']', text),
    });

    let name = this.romname || (this.rom ? this.rom.split(/[?#]/)[0].split('/').pop() : 'game');
    let bytes = this.romBlob ? new Uint8Array(await this.romBlob.arrayBuffer()) : await this.fetchRom(this.rom);
    this.setStatus('Starting...');
    for (let dir of ['/system', '/save', '/game']) m.FS.mkdir(dir);
    // The game goes in the filesystem for cores that load by path, and in memory for
    // the rest
    let path = '/game/' + name.replace(/[^\w.-]/g, '_');
    m.FS.writeFile(path, bytes);
    let data = m._malloc(bytes.length);
    m.HEAPU8.set(bytes, data);
    if (!m._emu_load(m.stringToNewUTF8(path), data, bytes.length)) {
      throw new Error((m.UTF8ToString(m._emu_library_name()) || this.core) + " couldn't load " + name);
    }
    this.fps = m._emu_fps() || 60;
    await this.restoreSaveRam();

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'emularity-canvas libretro-canvas';
    this.canvas.tabIndex = 0;
    this.ctx = this.canvas.getContext('2d');
    this.appendChild(this.canvas);
    this.setupInput();
    await this.setupAudio(m._emu_sample_rate() || 48000);
    if (this.destroyed) { // removed while it was starting
      try { this.audioContext && this.audioContext.close(); } catch (e) {}
      return;
    }

    if (this.splashcanvas && this.splashcanvas.parentNode) this.splashcanvas.remove();
    this.running = true;
    this.setStatus('Running');
    this.canvas.focus();
    this.dispatchEvent(new CustomEvent('canvaschange', { detail: this.canvas }));
    this.dispatchEvent(new CustomEvent('run'));
    this.startLoop();
    this.saveTimer = setInterval(() => this.persistSaveRam(), 5000);
    this.onPageHide = () => this.persistSaveRam();
    addEventListener('pagehide', this.onPageHide);
  }

  async fetchRom(url) {
    if (!url) throw new Error('no game given');
    let res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' loading ' + url);
    let total = +res.headers.get('Content-Length') || 0, loaded = 0, chunks = [];
    for (let reader = res.body.getReader(); ;) {
      let { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (total) this.setStatus('Loading game... ' + Math.round(loaded / total * 100) + '%');
    }
    let out = new Uint8Array(loaded), at = 0;
    for (let c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  /* ----- Running ----- */

  startLoop() {
    let start = performance.now(), done = 0;
    let loop = now => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      // Frames due by now at the core's rate; if we fell far behind (a hidden tab,
      // a stall), skip ahead rather than racing to catch up
      let due = Math.floor((now - start) * this.fps / 1000) - done;
      if (due > 4) { start = now; done = 0; due = 1; }
      // Keep ~50-100ms of audio queued: run an extra frame when it's running low,
      // hold one back when it's piling up
      if (this.audioBuffered != null) {
        if (this.audioBuffered < 0.05) due++;
        else if (this.audioBuffered > 0.12 && due > 0) due--;
      }
      for (let i = 0; i < due; i++) { this.pollGamepads(); this.runFrame(); }
      done += due;
    };
    this.raf = requestAnimationFrame(loop);
  }
  runFrame() {
    let m = this.module;
    m._emu_run();
    if (m._emu_frame_ready()) this.drawFrame();
    let frames = m._emu_audio_frames();
    if (frames && this.audioNode) {
      let samples = m.HEAP16.subarray(m._emu_audio() >> 1, (m._emu_audio() >> 1) + frames * 2);
      let out = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768;
      this.audioNode.port.postMessage(out, [out.buffer]);
    }
  }
  drawFrame() {
    let m = this.module, w = m._emu_frame_width(), h = m._emu_frame_height();
    if (this.canvas.width != w || this.canvas.height != h) {
      this.canvas.width = w;
      this.canvas.height = h;
      // Show it at the core's aspect ratio (e.g. 4:3 for the NES's 256x240)
      this.canvas.style.aspectRatio = String(m._emu_aspect_ratio());
      this.dispatchEvent(new CustomEvent('canvaschange', { detail: this.canvas }));
    }
    let pixels = new Uint8ClampedArray(m.HEAPU8.buffer, m._emu_frame(), w * h * 4);
    this.ctx.putImageData(new ImageData(pixels, w, h), 0, 0);
  }

  async setupAudio(sampleRate) {
    try {
      // Run the audio context at the core's own rate, so no resampling is needed
      let ctx = this.audioContext = new AudioContext({ sampleRate });
      let url = URL.createObjectURL(new Blob([AUDIO_WORKLET], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.audioNode = new AudioWorkletNode(ctx, 'libretro-audio', { outputChannelCount: [2] });
      this.audioNode.port.onmessage = ev => { this.audioBuffered = ev.data; };
      this.audioNode.connect(ctx.destination);
      if (!this.sound) ctx.suspend();
      // Browsers only start audio after a user gesture
      let resume = () => { if (this.sound !== false && ctx.state == 'suspended') ctx.resume(); };
      resume();
      this.canvas.addEventListener('pointerdown', resume);
      this.canvas.addEventListener('keydown', resume);
    } catch (e) {
      console.warn('Emularity: no audio', e);
    }
  }

  /* ----- Input ----- */

  setupInput() {
    this.keyButtons = 0;
    this.padButtons = [0, 0, 0, 0];
    let onKey = down => ev => {
      let button = KEYS[ev.code];
      if (button === undefined) return;
      ev.preventDefault();
      if (down) this.keyButtons |= 1 << button; else this.keyButtons &= ~(1 << button);
      this.sendButtons();
    };
    this.canvas.addEventListener('keydown', onKey(true));
    this.canvas.addEventListener('keyup', onKey(false));
    this.canvas.addEventListener('blur', () => { this.keyButtons = 0; this.sendButtons(); });
    this.canvas.addEventListener('pointerdown', () => this.canvas.focus());
  }
  pollGamepads() {
    if (!navigator.getGamepads) return;
    let pads = [...navigator.getGamepads()].filter(Boolean);
    for (let port = 0; port < 4; port++) {
      let pad = pads[port], mask = 0;
      if (pad) {
        pad.buttons.forEach((b, i) => { if (b.pressed && PAD[i] !== undefined) mask |= 1 << PAD[i]; });
        let [x = 0, y = 0] = pad.axes;
        if (x < -0.5) mask |= 1 << LEFT; else if (x > 0.5) mask |= 1 << RIGHT;
        if (y < -0.5) mask |= 1 << UP; else if (y > 0.5) mask |= 1 << DOWN;
      }
      this.padButtons[port] = mask;
    }
    this.sendButtons();
  }
  sendButtons() {
    if (!this.module) return;
    for (let port = 0; port < 4; port++) {
      let mask = this.padButtons[port] | (port == 0 ? this.keyButtons : 0);
      this.module._emu_set_buttons(port, mask);
    }
  }

  /* ----- Save RAM ----- */

  openSaves() {
    return new Promise((resolve, reject) => {
      let req = indexedDB.open(this.persist, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('saves');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  saveRam() {
    let m = this.module, size = m._emu_save_ram_size();
    return size ? m.HEAPU8.subarray(m._emu_save_ram(), m._emu_save_ram() + size) : null;
  }
  async restoreSaveRam() {
    let ram = this.saveRam();
    if (!this.persist || !ram) return;
    try {
      let db = await this.openSaves();
      let saved = await new Promise((resolve, reject) => {
        let req = db.transaction('saves').objectStore('saves').get('saveram');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      if (saved && saved.length == ram.length) ram.set(saved);
      this.lastSaved = ram.slice();
    } catch (e) {
      console.warn('Emularity: could not restore saved game', e);
    }
  }
  async persistSaveRam() {
    let ram = this.saveRam();
    if (!this.persist || !ram) return;
    if (this.lastSaved && this.lastSaved.every((b, i) => b == ram[i])) return; // unchanged
    let copy = ram.slice();
    this.lastSaved = copy;
    try {
      let db = await this.openSaves();
      let tx = db.transaction('saves', 'readwrite');
      tx.objectStore('saves').put(copy, 'saveram');
      tx.oncomplete = () => db.close();
    } catch (e) {
      console.warn('Emularity: could not save the game', e);
    }
  }

  /* Reset the console */
  reset() {
    if (this.module) this.module._emu_reset();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.destroyed = true;
    this.running = false;
    cancelAnimationFrame(this.raf);
    clearInterval(this.saveTimer);
    if (this.onPageHide) { this.persistSaveRam(); removeEventListener('pagehide', this.onPageHide); }
    try { this.audioContext && this.audioContext.close(); } catch (e) {}
  }
}
