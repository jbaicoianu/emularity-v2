/* A text terminal that renders to a single 2D <canvas>.

   Emularity's contract is that a running system is exposed as one canvas (hosts use it
   as a WebGL texture — e.g. rendering an emulator onto a 3D surface). A serial/text
   console therefore has to be a canvas too, not xterm.js's DOM/`<div>` output. So we
   use xterm.js purely as a headless VT/ANSI parser — it keeps the cell grid, colours,
   cursor and escape handling correct — and paint that grid onto our own 2D canvas.
   Keyboard input is captured on the canvas and mapped back to a byte stream. */

const ANSI16 = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
];
function rgbHex(r, g, b) { return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1); }
function buildPalette() {
  let p = ANSI16.slice();
  let levels = [0, 95, 135, 175, 215, 255];
  for (let i = 0; i < 216; i++) p[16 + i] = rgbHex(levels[(i / 36 | 0) % 6], levels[(i / 6 | 0) % 6], levels[i % 6]);
  for (let i = 0; i < 24; i++) { let v = 8 + i * 10; p[232 + i] = rgbHex(v, v, v); }
  return p;
}
const PALETTE = buildPalette();

// Map a keydown to the bytes a terminal sends for it (enough for an interactive shell).
function keyToBytes(ev) {
  let k = ev.key;
  if (ev.ctrlKey && k.length === 1) {
    let c = k.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) return String.fromCharCode(c - 64); // Ctrl-@ .. Ctrl-_
    if (k === ' ') return '\x00';
  }
  if (ev.altKey && k.length === 1) return '\x1b' + k; // Alt = ESC-prefixed
  switch (k) {
    case 'Enter': return '\r';
    case 'Backspace': return '\x7f';
    case 'Tab': return '\t';
    case 'Escape': return '\x1b';
    case 'ArrowUp': return '\x1b[A'; case 'ArrowDown': return '\x1b[B';
    case 'ArrowRight': return '\x1b[C'; case 'ArrowLeft': return '\x1b[D';
    case 'Home': return '\x1b[H'; case 'End': return '\x1b[F';
    case 'PageUp': return '\x1b[5~'; case 'PageDown': return '\x1b[6~';
    case 'Insert': return '\x1b[2~'; case 'Delete': return '\x1b[3~';
  }
  return k.length === 1 ? k : null;
}

export class CanvasTerminal {
  constructor(opts = {}) {
    this.cols = opts.cols || 80;
    this.rows = opts.rows || 30;
    this.fontSize = opts.fontSize || 15;
    this.fontFamily = opts.fontFamily || 'monospace';
    this.bg = opts.background || '#101010';
    this.fg = opts.foreground || '#d0d0d0';
    this.cursorColor = opts.cursor || '#d0d0d0';
    this.onData = opts.onData || (() => {});

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'emularity-canvas v86-term-canvas';
    this.canvas.tabIndex = 0;
    this.ctx = this.canvas.getContext('2d', { alpha: false });

    this._measure();
    this.canvas.width = this.cols * this.cw;
    this.canvas.height = this.rows * this.ch;

    this._buf = [];       // bytes buffered until xterm is attached
    this._term = null;
    this._raf = 0;

    this.canvas.addEventListener('keydown', ev => {
      let data = keyToBytes(ev);
      if (data != null) { ev.preventDefault(); this.onData(data); }
    });
    this._paint(); // initial clear
  }

  _measure() {
    this.ctx.font = this.fontSize + 'px ' + this.fontFamily;
    this.cw = Math.ceil(this.ctx.measureText('W').width);
    this.ch = Math.ceil(this.fontSize * 1.25);
  }

  // Attach the xterm.js Terminal class (a runtime-loaded UMD global). xterm is opened on
  // an offscreen host purely so it initializes its parser/buffer; nothing of xterm's own
  // rendering is shown — we read term.buffer and paint it ourselves.
  attachXterm(Terminal) {
    let term = new Terminal({
      cols: this.cols, rows: this.rows, scrollback: 0, convertEol: false,
      allowProposedApi: true, fontSize: this.fontSize,
      theme: { background: this.bg, foreground: this.fg },
    });
    let host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:-99999px;top:0;width:1px;height:1px;overflow:hidden;visibility:hidden';
    document.body.appendChild(host);
    term.open(host);
    // Repaint when the PARSER finishes a write (onWriteParsed), not on xterm's own
    // render: its DOM renderer is on an offscreen/hidden host and may never fire
    // onRender, whereas onWriteParsed tracks buffer changes regardless of rendering.
    if (term.onWriteParsed) term.onWriteParsed(() => this._schedule());
    else term.onRender(() => this._schedule());
    this._host = host;
    this._term = term;
    if (this._buf.length) { term.write(Uint8Array.from(this._buf)); this._buf.length = 0; }
    this._schedule();
  }

  write(data) {
    if (this._term) { this._term.write(typeof data === 'number' ? Uint8Array.of(data) : data); return; }
    if (typeof data === 'number') this._buf.push(data); else for (let b of data) this._buf.push(b);
  }
  focus() { this.canvas.focus(); }

  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._paint(); });
  }

  _color(cell, fg) {
    if (fg ? cell.isFgDefault() : cell.isBgDefault()) return fg ? this.fg : this.bg;
    if (fg ? cell.isFgRGB() : cell.isBgRGB()) return rgbHex((cell[fg ? 'getFgColor' : 'getBgColor']() >> 16) & 255, (cell[fg ? 'getFgColor' : 'getBgColor']() >> 8) & 255, cell[fg ? 'getFgColor' : 'getBgColor']() & 255);
    return PALETTE[cell[fg ? 'getFgColor' : 'getBgColor']()] || (fg ? this.fg : this.bg);
  }

  _paint() {
    let ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.fillStyle = this.bg;
    ctx.fillRect(0, 0, W, H);
    let term = this._term;
    if (!term) return;
    let buf = term.buffer.active;
    ctx.textBaseline = 'top';
    let cw = this.cw, ch = this.ch, cell;
    for (let row = 0; row < this.rows; row++) {
      let line = buf.getLine(buf.viewportY + row);
      if (!line) continue;
      for (let col = 0; col < this.cols; col++) {
        cell = line.getCell(col, cell);
        if (!cell) continue;
        let width = cell.getWidth();
        if (width === 0) continue; // trailing half of a wide glyph
        let fg = this._color(cell, true), bg = this._color(cell, false);
        if (cell.isInverse()) { let t = fg; fg = bg; bg = t; }
        let x = col * cw, y = row * ch;
        if (bg !== this.bg) { ctx.fillStyle = bg; ctx.fillRect(x, y, cw * width, ch); }
        let chars = cell.getChars();
        if (chars && chars !== ' ') {
          ctx.font = (cell.isBold() ? 'bold ' : '') + this.fontSize + 'px ' + this.fontFamily;
          ctx.fillStyle = fg;
          ctx.fillText(chars, x, y);
        }
      }
    }
    // Cursor (block). cursorY is relative to the viewport top.
    ctx.fillStyle = this.cursorColor;
    ctx.globalAlpha = 0.6;
    ctx.fillRect(buf.cursorX * cw, buf.cursorY * ch, cw, ch);
    ctx.globalAlpha = 1;
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    try { this._term && this._term.dispose(); } catch (e) {}
    try { this._host && this._host.remove(); } catch (e) {}
  }
}
