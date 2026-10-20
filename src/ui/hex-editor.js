/* <emularity-hex-editor>: a hex editor for one file's bytes, in the classic layout:
   offsets, the bytes in hex, and the same bytes as characters (by default as DOS shows
   them, code page 437).

     let editor = document.createElement('emularity-hex-editor');
     editor.open(bytes, { name: 'SAVE.DAT', compare: original, compareLabel: 'The original' });
     editor.onsave = async bytes => { ...keep them... };

   Typing in either column overwrites bytes, or inserts them in insert mode (the Insert
   key). It has undo and redo, a selection (copied and pasted as hex or as text,
   depending on the column), find (text, hex bytes or numbers), go to offset, and an
   inspector that shows and edits the numbers at the cursor. Bytes changed since the
   last save are drawn in yellow; with a comparison loaded (the file's original, or any
   file from the computer), the bytes that differ from it are marked in red, and
   Alt+Up/Down step between them: handy for finding where a game keeps a value, by
   comparing saves from before and after it changes.

   Only the rows on screen are drawn, so big files scroll as fast as small ones.
   Emits 'modifiedchange' when the bytes become different from (or the same as) the
   last saved ones. */

const ROW = 16;

/* Code page 437: what DOS draws for each byte */
const CP437 = [...(
  ' ☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼' +
  Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('') + '⌂' +
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '
)];
const CP437_BYTE = new Map(CP437.map((ch, i) => [ch, i]));

const hex = (n, digits = 2) => n.toString(16).toUpperCase().padStart(digits, '0');

/* A whole number typed in: "-12", "0x1F", "$1F" or "-0x1F" (or null) */
function parseInteger(text) {
  let m = text.trim().match(/^(-?)(0x[0-9a-f]+|\$[0-9a-f]+|[0-9]+)$/i);
  if (!m) return null;
  let v = BigInt(m[2].replace('$', '0x'));
  return m[1] ? -v : v;
}

/* The numbers the inspector shows: [label, bytes, DataView type] */
const NUMBERS = [
  ['Unsigned 8-bit', 1, 'Uint8'], ['Signed 8-bit', 1, 'Int8'],
  ['Unsigned 16-bit', 2, 'Uint16'], ['Signed 16-bit', 2, 'Int16'],
  ['Unsigned 32-bit', 4, 'Uint32'], ['Signed 32-bit', 4, 'Int32'],
  ['Unsigned 64-bit', 8, 'BigUint64'], ['Signed 64-bit', 8, 'BigInt64'],
  ['Float 32-bit', 4, 'Float32'], ['Float 64-bit', 8, 'Float64'],
];

const STYLE = `
emularity-hex-editor {
  display: flex; flex-direction: column; min-height: 0; min-width: 0;
  container-type: inline-size;
  font-size: 13px; color: #ddd; background: #0b0b0b;
  border: 1px solid #333; border-radius: 6px; overflow: hidden;
  --hx-accent: #49c8d7;
}
emularity-hex-editor[hidden] { display: none; }
/* (Doubled classes: stronger than a page's own form styles) */
.hx-root.hx-root :is(button, select, input:not([type="checkbox"])) {
  display: inline-block; width: auto; box-sizing: border-box;
  font: inherit; font-size: 12px; color: #ddd; background: #161616;
  border: 1px solid #444; border-radius: 4px; padding: .15em .45em; margin: 0;
}
.hx-root.hx-root label { display: inline-flex; align-items: center; gap: .3em; margin: 0; font-size: 12px; color: #aaa; white-space: nowrap; }
emularity-hex-editor button { cursor: pointer; }
emularity-hex-editor button:hover:not(:disabled) { border-color: var(--hx-accent); color: var(--hx-accent); }
emularity-hex-editor button:disabled { opacity: .4; cursor: default; }
emularity-hex-editor button.hx-primary { border-color: var(--hx-accent); color: var(--hx-accent); }
emularity-hex-editor input[type="checkbox"] { padding: 0; }
.hx-toolbar { display: flex; flex-wrap: wrap; gap: .3em .5em; align-items: center; padding: .35em .5em; border-bottom: 1px solid #2a2a2a; background: #111; }
.hx-group { display: inline-flex; gap: .2em; align-items: center; }
.hx-grow { flex: 1; }
.hx-root.hx-root .hx-toolbar input:not([type="checkbox"]) { width: 8em; }
.hx-root.hx-root [hidden] { display: none !important; }
.hx-find-count, .hx-diff-count { font-size: 12px; color: #888; white-space: nowrap; }
.hx-body { flex: 1; display: flex; min-height: 0; }
.hx-view {
  flex: 1; display: flex; flex-direction: column; min-width: 0; position: relative;
  font-family: ui-monospace, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace;
  overflow-x: auto; cursor: text;
}
.hx-header, .hx-row { display: flex; white-space: pre; height: 1.5em; line-height: 1.5em; }
.hx-header { color: #667; border-bottom: 1px solid #222; flex: none; user-select: none; }
.hx-header .hx-colcur { color: var(--hx-accent); }
.hx-off { flex: none; width: 8ch; padding-left: 1ch; color: #6a9; }
.hx-header .hx-off { color: #667; }
.hx-hex { display: flex; flex: none; }
.hx-b { width: 3ch; text-align: center; }
.hx-b:nth-child(8) { margin-right: 1ch; }
.hx-asc { display: flex; flex: none; margin-left: 1ch; padding: 0 1ch; border-left: 1px solid #262626; }
.hx-c { width: 1ch; text-align: center; }
.hx-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; min-height: 0; outline: none; min-width: max-content; }
.hx-rows { position: sticky; top: 0; overflow: hidden; }
.hx-row.hx-gone { visibility: hidden; }
.hx-zero { color: #4a4a4a; }
.hx-dirty { color: #ffcf5c; font-weight: bold; }
.hx-diff { background: rgba(255, 70, 70, .28); }
.hx-match { background: rgba(80, 150, 255, .35); }
.hx-hover { background: #2c2c2c; }
.hx-sel { background: #284b73; color: #fff; }
.hx-cur { outline: 1px solid #777; outline-offset: -1px; }
.hx-view.hx-focused .hx-cur.hx-act { background: var(--hx-accent); color: #000; outline: none; }
.hx-view.hx-focused .hx-cur.hx-act.hx-nib { background: linear-gradient(90deg, transparent 50%, var(--hx-accent) 50%); color: inherit; }
.hx-input { position: absolute; left: 0; top: 0; width: 1px; height: 1px; opacity: 0; border: 0; padding: 0; resize: none; pointer-events: none; }
.hx-inspector { flex: none; width: 15em; border-left: 1px solid #2a2a2a; overflow: auto; padding: .4em .5em; font-size: 12px; background: #0e0e0e; }
.hx-inspector h4 { margin: .3em 0 .4em; font-size: 12px; font-weight: normal; color: #aaa; display: flex; justify-content: space-between; align-items: center; }
.hx-inspector table { width: 100%; border-collapse: collapse; }
.hx-inspector td { padding: .1em 0; }
.hx-root.hx-root .hx-inspector td { font-size: 12px; }
.hx-inspector td:first-child { color: #888; padding-right: .5em; white-space: nowrap; }
.hx-root.hx-root .hx-inspector td input { width: 100%; font-family: ui-monospace, Consolas, monospace; }
.hx-inspector td input:disabled { opacity: .4; }
.hx-inspector .hx-tools { margin-top: .6em; display: flex; flex-wrap: wrap; gap: .3em; align-items: center; }
.hx-root.hx-root .hx-inspector .hx-tools input { width: 5em; font-family: ui-monospace, Consolas, monospace; }
.hx-inspector .hx-help { color: #666; line-height: 1.5; margin-top: .8em; }
.hx-status { padding: .25em .6em; border-top: 1px solid #2a2a2a; color: #999; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: #111; }
.hx-status b { color: #ddd; font-weight: normal; }
.hx-status .hx-warn { color: #ffcf5c; }
/* Too narrow for the inspector beside the bytes: it goes below them */
@container (max-width: 820px) {
  .hx-body { flex-direction: column; }
  .hx-inspector { width: auto; max-height: 35%; border-left: none; border-top: 1px solid #2a2a2a; }
  .hx-inspector table { display: grid; grid-template-columns: repeat(auto-fill, minmax(13em, 1fr)); gap: 0 1em; }
  .hx-inspector tbody { display: contents; }
  .hx-inspector tr { display: flex; align-items: center; }
  .hx-inspector td:first-child { width: 7.5em; }
  .hx-inspector td:last-child { flex: 1; }
  .hx-inspector .hx-help { display: none; }
}
`;
let styled = false;

export class HexEditor extends HTMLElement {
  data = new Uint8Array(0);   // the bytes, as edited
  saved = new Uint8Array(0);  // as last saved (or opened)
  dirty = new Uint8Array(0);  // 1 for each byte changed since then
  compare = null;             // bytes to mark differences from, or null
  name = 'file.bin';
  readOnly = false;
  onsave = null;              // async (bytes) => {}: Save is offered when set
  cursor = 0;                 // may be data.length: the place to add bytes at the end
  nibble = 0;                 // in the hex column: 1 once the high digit has been typed
  pane = 'hex';               // the column typed into: 'hex' or 'text'
  anchor = null;              // the selection's other end (inclusive), or null for none
  insert = false;
  cp437 = true;
  bigEndian = false;
  undoStack = [];
  redoStack = [];
  savedAt = 0;                // undoStack's length when last saved (-1: out of reach)
  matches = [];               // the find matches' offsets
  matchLength = 0;
  top = 0;                    // the first row on screen

  connectedCallback() {
    if (this.built) return;
    this.built = true;
    this.classList.add('hx-root');
    if (!styled) {
      styled = true;
      let style = document.createElement('style');
      style.textContent = STYLE;
      document.head.append(style);
    }
    this.innerHTML = `
      <div class="hx-toolbar">
        <span class="hx-group">
          <button data-cmd="undo" title="Undo (Ctrl+Z)">↶</button>
          <button data-cmd="redo" title="Redo (Ctrl+Y)">↷</button>
        </span>
        <label title="An offset: 0x1A0, 1A0h or $1A0 are hex, 416 is decimal; +10 or -0x10 move from the cursor">Go to <input type="text" class="hx-goto" placeholder="0x0"></label>
        <span class="hx-group">
          <select class="hx-find-mode" title="What to look for">
            <option value="text">Text</option>
            <option value="itext">Text, any case</option>
            <option value="hex">Hex bytes</option>
            <option value="1">8-bit number</option>
            <option value="2">16-bit number</option>
            <option value="4">32-bit number</option>
          </select>
          <input type="search" class="hx-find" placeholder="Find (Ctrl+F)">
          <button data-cmd="findprev" title="Previous match (Shift+F3)">◀</button>
          <button data-cmd="findnext" title="Next match (F3)">▶</button>
          <span class="hx-find-count"></span>
        </span>
        <span class="hx-group">
          <select class="hx-compare" title="Mark the bytes that differ from another version of the file"></select>
          <button data-cmd="diffprev" title="Previous difference (Alt+↑)">◀</button>
          <button data-cmd="diffnext" title="Next difference (Alt+↓)">▶</button>
          <span class="hx-diff-count"></span>
        </span>
        <span class="hx-grow"></span>
        <span class="hx-group">
          <button data-cmd="mode" class="hx-mode" title="Whether typing replaces bytes or inserts new ones (Insert key)">Overwrite</button>
          <label title="Show bytes as DOS draws them (code page 437), or as plain ASCII"><input type="checkbox" class="hx-cp437" checked> DOS characters</label>
        </span>
        <span class="hx-group">
          <button data-cmd="download" title="Save a copy to your computer">⬇</button>
          <button data-cmd="revert" title="Throw away the changes since the last save">Revert</button>
          <button data-cmd="save" class="hx-primary" title="Save (Ctrl+S)">Save</button>
        </span>
      </div>
      <div class="hx-body">
        <div class="hx-view">
          <div class="hx-header"></div>
          <div class="hx-scroll"><div class="hx-rows"></div><div class="hx-spacer"></div></div>
          <textarea class="hx-input" aria-label="Hex editor" spellcheck="false" autocomplete="off"></textarea>
        </div>
        <div class="hx-inspector">
          <h4><span class="hx-insp-at"></span><label><input type="checkbox" class="hx-be"> Big-endian</label></h4>
          <table><tbody></tbody></table>
          <div class="hx-tools">
            <span>Fill the selection with</span>
            <input type="text" class="hx-fill" placeholder="00" title="Hex bytes, repeated over the selection">
            <button data-cmd="fill">Fill</button>
          </div>
          <div class="hx-help">
            Tab switches between the hex and text columns.
            Shift+arrows or dragging selects; Ctrl+C / Ctrl+V copy and paste it as hex or as text.
            Edit a number above and press Enter to write it at the cursor.
          </div>
        </div>
      </div>
      <div class="hx-status"></div>
      <input type="file" class="hx-compare-file" hidden>`;
    let $ = sel => this.querySelector(sel);
    this.view = $('.hx-view');
    this.scroller = $('.hx-scroll');
    this.rowsEl = $('.hx-rows');
    this.spacer = $('.hx-spacer');
    this.input = $('.hx-input');
    this.status = $('.hx-status');

    // The column header, and the inspector's rows
    let header = $('.hx-header');
    header.innerHTML = `<span class="hx-off">Offset</span><span class="hx-hex">${Array.from({ length: ROW }, (_, j) => `<span class="hx-b">${hex(j)}</span>`).join('')}</span><span class="hx-asc">${Array.from({ length: ROW }, (_, j) => `<span class="hx-c">${hex(j, 1)}</span>`).join('')}</span>`;
    this.headerCells = [...header.querySelectorAll('.hx-b')];
    let tbody = $('.hx-inspector tbody');
    let rows = [['Binary', 1, 'bits'], ...NUMBERS, ['Character', 1, 'char']];
    this.inspector = rows.map(([label, size, type]) => {
      let tr = document.createElement('tr');
      tr.innerHTML = `<td>${label}</td><td><input type="text"></td>`;
      tbody.append(tr);
      let input = tr.querySelector('input');
      let field = { size, type, input };
      input.addEventListener('keydown', ev => {
        if (ev.key == 'Enter') { ev.preventDefault(); this.writeNumber(field); }
        if (ev.key == 'Escape') { ev.preventDefault(); input.blur(); this.renderInspector(); this.focus(); }
      });
      input.addEventListener('blur', () => this.renderInspector());
      return field;
    });

    // Toolbar
    this.querySelector('.hx-toolbar').addEventListener('click', ev => this.command(ev.target.closest('button')?.dataset.cmd));
    $('.hx-tools button').addEventListener('click', () => this.fill());
    $('.hx-cp437').addEventListener('change', ev => { this.cp437 = ev.target.checked; this.render(); });
    $('.hx-be').addEventListener('change', ev => { this.bigEndian = ev.target.checked; this.renderInspector(); this.search(); });
    let goto = $('.hx-goto');
    goto.addEventListener('keydown', ev => {
      if (ev.key != 'Enter') return;
      let at = this.parseOffset(goto.value);
      if (at == null) { goto.setCustomValidity('Not an offset'); goto.reportValidity(); return; }
      goto.setCustomValidity('');
      this.anchor = null;
      this.moveTo(at);
      this.focus();
    });
    let find = $('.hx-find');
    find.addEventListener('input', () => { clearTimeout(this.findTimer); this.findTimer = setTimeout(() => this.search(), 200); });
    find.addEventListener('keydown', ev => {
      if (ev.key == 'Enter') { ev.preventDefault(); this.search(); this.findNext(ev.shiftKey ? -1 : 1); }
    });
    $('.hx-find-mode').addEventListener('change', () => this.search());
    $('.hx-compare').addEventListener('change', ev => this.chooseCompare(ev.target.value));
    $('.hx-compare-file').addEventListener('change', async ev => {
      let file = ev.target.files[0];
      ev.target.value = '';
      if (!file) { this.updateCompareSelect(); return; }
      this.compares.file = { label: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
      this.chooseCompare('file');
    });

    // The bytes: mouse
    this.scroller.addEventListener('scroll', () => this.onScroll());
    this.view.addEventListener('mousedown', ev => this.onMouseDown(ev));
    this.view.addEventListener('mouseover', ev => this.onHover(ev));
    this.view.addEventListener('mouseleave', () => this.onHover(null));
    // ...and keyboard, through a hidden textarea (so copy and paste work)
    this.input.addEventListener('keydown', ev => this.onKey(ev));
    this.input.addEventListener('focus', () => this.view.classList.add('hx-focused'));
    this.input.addEventListener('blur', () => this.view.classList.remove('hx-focused'));
    this.input.addEventListener('copy', ev => this.onCopy(ev, false));
    this.input.addEventListener('cut', ev => this.onCopy(ev, true));
    this.input.addEventListener('paste', ev => this.onPaste(ev));

    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(this.scroller);
    this.compares = {};
    this.updateCompareSelect();
    this.layout();
  }
  disconnectedCallback() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    this.built = false;
  }

  /* ----- The file ----- */

  /* Show `bytes` (the editor keeps its own copy). Options: name (for downloads),
     compare and compareLabel (a version to mark differences from, e.g. the original;
     shown from the start if `showCompare`), readOnly. */
  open(bytes, { name = 'file.bin', compare = null, compareLabel = 'The original', showCompare = false, readOnly = false } = {}) {
    this.data = new Uint8Array(bytes);
    this.saved = this.data.slice();
    this.dirty = new Uint8Array(this.data.length);
    this.name = name;
    this.readOnly = readOnly;
    this.undoStack = [];
    this.redoStack = [];
    this.savedAt = 0;
    this.cursor = 0;
    this.nibble = 0;
    this.anchor = null;
    this.top = 0;
    this.compares = compare ? { given: { label: compareLabel, bytes: compare } } : {};
    this.compare = this.compareKey = null;
    this.message = null;
    this.querySelector('.hx-goto').value = '';
    this.updateCompareSelect();
    if (compare && showCompare) this.chooseCompare('given');
    this.search();
    this.layout();
    this.scroller.scrollTop = 0;
    this.render();
    this.emitModified();
  }
  get modified() { return this.undoStack.length !== this.savedAt; }
  get bytes() { return this.data.slice(); }

  async save() {
    if (!this.onsave || this.readOnly) return;
    let bytes = this.data.slice();
    let button = this.querySelector('[data-cmd="save"]');
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      await this.onsave(bytes);
      this.saved = bytes;
      this.dirty = new Uint8Array(this.data.length);
      this.savedAt = this.undoStack.length;
      this.flash('Saved');
    } catch (e) {
      console.error(e);
      this.flash('Saving failed: ' + e.message, true);
    } finally {
      button.textContent = 'Save';
      this.render();
      this.emitModified();
    }
  }
  revert() {
    if (!this.modified) return;
    if (!confirm('Throw away the changes made since the last save?')) return;
    this.data = this.saved.slice();
    this.dirty = new Uint8Array(this.data.length);
    this.undoStack = [];
    this.redoStack = [];
    this.savedAt = 0;
    this.cursor = Math.min(this.cursor, this.maxCursor);
    this.anchor = null;
    this.changed();
  }
  download() {
    let a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([this.data]));
    a.download = this.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  emitModified() {
    let modified = this.modified;
    if (modified !== this.wasModified) {
      this.wasModified = modified;
      this.dispatchEvent(new CustomEvent('modifiedchange', { detail: modified }));
    }
  }
  /* A passing message in the status line */
  flash(message, warn = false) {
    this.message = { text: message, warn };
    clearTimeout(this.messageTimer);
    this.messageTimer = setTimeout(() => { this.message = null; this.renderStatus(); }, 3000);
    this.renderStatus();
  }

  /* ----- Editing ----- */

  /* Replace `count` bytes at `at` with `bytes`: every edit goes through here, so it
     can be undone. `merge` folds it into the last edit, if that was at the same place
     (the second hex digit typed into a byte). */
  splice(at, count, bytes, merge = false) {
    if (this.readOnly) return;
    let last = this.undoStack[this.undoStack.length - 1];
    if (merge && last && last.at == at && last.inserted.length == bytes.length && count == bytes.length && this.undoStack.length != this.savedAt) {
      this.data.set(bytes, at);
      this.dirty.fill(1, at, at + bytes.length);
      last.inserted = bytes.slice();
    } else {
      let entry = { at, removed: this.data.slice(at, at + count), removedDirty: this.dirty.slice(at, at + count), inserted: bytes.slice() };
      this.apply(at, count, bytes, new Uint8Array(bytes.length).fill(1));
      if (this.savedAt > this.undoStack.length) this.savedAt = -1; // the saved state was undone past: no way back to it now
      this.undoStack.push(entry);
      this.redoStack = [];
    }
    this.changed();
  }
  apply(at, count, bytes, dirty) {
    this.version = (this.version || 0) + 1;
    if (count == bytes.length) {
      this.data.set(bytes, at);
      this.dirty.set(dirty, at);
      return;
    }
    let join = (a, mid) => {
      let out = new Uint8Array(a.length - count + mid.length);
      out.set(a.subarray(0, at));
      out.set(mid, at);
      out.set(a.subarray(at + count), at + mid.length);
      return out;
    };
    this.data = join(this.data, bytes);
    this.dirty = join(this.dirty, dirty);
  }
  undo() {
    let e = this.undoStack.pop();
    if (!e) return;
    this.apply(e.at, e.inserted.length, e.removed, e.removedDirty);
    this.redoStack.push(e);
    this.anchor = null;
    this.cursor = Math.min(e.at, this.maxCursor);
    this.nibble = 0;
    this.changed();
  }
  redo() {
    let e = this.redoStack.pop();
    if (!e) return;
    this.apply(e.at, e.removed.length, e.inserted, new Uint8Array(e.inserted.length).fill(1));
    this.undoStack.push(e);
    this.anchor = null;
    this.cursor = Math.min(e.at + e.inserted.length, this.maxCursor);
    this.nibble = 0;
    this.changed();
  }
  /* After the bytes change */
  changed() {
    this.cursor = Math.min(this.cursor, this.maxCursor);
    this.layout();
    if (this.querySelector('.hx-find').value) this.search(false);
    this.ensureVisible(this.cursor);
    this.render();
    this.emitModified();
  }
  get selection() {
    if (this.anchor == null) return null;
    let start = Math.min(this.anchor, this.cursor), end = Math.min(Math.max(this.anchor, this.cursor) + 1, this.data.length);
    return end > start ? { start, end } : null;
  }
  /* What typing a character does */
  type(key) {
    if (this.readOnly) return;
    let sel = this.selection;
    if (sel) { this.cursor = sel.start; this.anchor = null; this.nibble = 0; }
    let at = this.cursor, n = this.data.length, adding = this.insert || at >= n;
    if (this.pane == 'hex') {
      let digit = parseInt(key, 16);
      if (isNaN(digit) || key.length != 1) return;
      if (this.nibble == 0) {
        let byte = adding ? digit << 4 : (digit << 4) | (this.data[at] & 0x0f);
        this.splice(at, adding ? 0 : 1, Uint8Array.of(byte));
        this.nibble = 1;
        this.render();
      } else {
        this.splice(at, 1, Uint8Array.of((this.data[at] & 0xf0) | digit), true);
        this.nibble = 0;
        this.moveTo(at + 1);
      }
    } else {
      let byte = this.charByte(key);
      if (byte == null) return;
      this.splice(at, adding ? 0 : 1, Uint8Array.of(byte));
      this.moveTo(at + 1);
    }
  }
  charByte(ch) {
    if (this.cp437 && CP437_BYTE.has(ch)) return CP437_BYTE.get(ch);
    let code = ch.charCodeAt(0);
    return ch.length == 1 && code < 256 ? code : null;
  }
  charOf(byte) {
    if (this.cp437) return byte == 0 ? '·' : CP437[byte];
    return byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '·';
  }
  /* Delete the selection, or one byte (before the cursor, for Backspace) */
  remove(before) {
    if (this.readOnly) return;
    let sel = this.selection;
    if (sel) {
      this.anchor = null;
      this.cursor = sel.start;
      this.splice(sel.start, sel.end - sel.start, new Uint8Array(0));
    } else if (before) {
      if (this.cursor == 0) return;
      this.cursor--;
      this.splice(this.cursor, 1, new Uint8Array(0));
    } else if (this.cursor < this.data.length) {
      this.splice(this.cursor, 1, new Uint8Array(0));
    }
    this.nibble = 0;
  }
  /* Put bytes at the cursor: over the selection, inserted (in insert mode), or over
     what's there (and past the end, if they run over) */
  put(bytes) {
    if (this.readOnly || !bytes.length) return;
    let sel = this.selection, at = sel ? sel.start : this.cursor;
    let count = sel ? sel.end - sel.start : this.insert ? 0 : Math.min(bytes.length, this.data.length - at);
    this.anchor = null;
    this.splice(at, count, bytes);
    this.moveTo(at + bytes.length);
  }
  fill() {
    let pattern = HexEditor.parseHex(this.querySelector('.hx-fill').value || '00');
    let sel = this.selection;
    if (!pattern || !pattern.length) { this.flash('Fill with hex bytes, like 00 or FF 7F', true); return; }
    if (!sel) { this.flash('Select the bytes to fill first', true); return; }
    let bytes = new Uint8Array(sel.end - sel.start);
    for (let i = 0; i < bytes.length; i++) bytes[i] = pattern[i % pattern.length];
    let anchor = this.anchor, cursor = this.cursor;
    this.splice(sel.start, bytes.length, bytes);
    this.anchor = anchor;
    this.cursor = cursor;
    this.render();
    this.focus();
  }
  /* The inspector's field was edited: write it at the cursor */
  writeNumber(field) {
    let text = field.input.value.trim(), at = this.cursor, bytes = new Uint8Array(field.size);
    let view = new DataView(bytes.buffer);
    try {
      if (at + field.size > this.data.length) throw new Error(`There aren't ${field.size} bytes from the cursor`);
      if (field.type == 'bits') {
        if (!/^[01]{1,8}$/.test(text)) throw new Error('Type up to 8 ones and zeros');
        bytes[0] = parseInt(text, 2);
      } else if (field.type == 'char') {
        let byte = this.charByte(text);
        if (text.length != 1 || byte == null) throw new Error('Type one character');
        bytes[0] = byte;
      } else if (field.type.startsWith('Float')) {
        let v = Number(text);
        if (text == '' || isNaN(v) && text.toLowerCase() != 'nan') throw new Error('Not a number');
        view['set' + field.type](0, v, !this.bigEndian);
      } else {
        let big = field.type.startsWith('Big'), v = parseInteger(text);
        if (v == null) throw new Error('Not a whole number');
        let bits = BigInt(field.size * 8), signed = !/Uint/.test(field.type);
        let min = signed ? -(1n << (bits - 1n)) : 0n, max = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
        // Either reading of the bytes is fine to type in (-1 for FF, say)
        if (v < -(1n << (bits - 1n)) || v > (1n << bits) - 1n) throw new Error(`Must be from ${min} to ${max}`);
        v = BigInt.asUintN(Number(bits), v);
        if (big) view.setBigUint64(0, v, !this.bigEndian);
        else view['setUint' + field.size * 8](0, Number(v), !this.bigEndian);
      }
    } catch (e) {
      field.input.setCustomValidity(e.message);
      field.input.reportValidity();
      return;
    }
    field.input.setCustomValidity('');
    this.splice(at, field.size, bytes);
    this.render();
    this.flash(`Wrote ${field.size} byte${field.size > 1 ? 's' : ''} at ${hex(at, 6)}`);
  }

  /* ----- Moving around ----- */

  get maxCursor() { return this.readOnly ? Math.max(0, this.data.length - 1) : this.data.length; }
  get rowCount() { return Math.floor(this.data.length / ROW) + 1; }
  moveTo(at, extend = false) {
    if (extend) { if (this.anchor == null) this.anchor = this.cursor; }
    else this.anchor = null;
    this.cursor = Math.max(0, Math.min(at, this.maxCursor));
    this.nibble = 0;
    this.ensureVisible(this.cursor);
    this.render();
  }
  focus() { this.input.focus({ preventScroll: true }); }
  /* "0x1A0", "1A0h", "$1A0", "1a0" (hex, having a letter), "416" (decimal), "+16", "-0x10" */
  parseOffset(text) {
    let m = text.trim().match(/^([+-]?)\s*(0x[0-9a-f]+|\$[0-9a-f]+|[0-9a-f]+h|[0-9]*[a-f][0-9a-f]*|[0-9]+)$/i);
    if (!m) return null;
    let s = m[2], v;
    if (/^0x/i.test(s)) v = parseInt(s.slice(2), 16);
    else if (s[0] == '$') v = parseInt(s.slice(1), 16);
    else if (/h$/i.test(s)) v = parseInt(s.slice(0, -1), 16);
    else if (/[a-f]/i.test(s)) v = parseInt(s, 16);
    else v = parseInt(s, 10);
    return m[1] == '+' ? this.cursor + v : m[1] == '-' ? this.cursor - v : v;
  }
  onKey(ev) {
    let ctrl = ev.ctrlKey || ev.metaKey, shift = ev.shiftKey, k = ev.key, page = Math.max(1, this.visibleRows - 1) * ROW;
    let handled = true;
    let row = this.cursor - this.cursor % ROW;
    if (ctrl && !ev.altKey) {
      switch (k.toLowerCase()) {
        case 'z': shift ? this.redo() : this.undo(); break;
        case 'y': this.redo(); break;
        case 'a': this.anchor = 0; this.cursor = Math.max(0, this.data.length - 1); this.render(); break;
        case 's': this.save(); break;
        case 'f': this.querySelector('.hx-find').select(); break;
        case 'g': this.querySelector('.hx-goto').select(); break;
        case 'home': this.moveTo(0, shift); break;
        case 'end': this.moveTo(this.data.length, shift); break;
        // Copy, cut and paste happen through their events
        default: handled = false;
      }
    } else if (ev.altKey && (k == 'ArrowUp' || k == 'ArrowDown')) {
      this.findDifference(k == 'ArrowUp' ? -1 : 1);
    } else {
      switch (k) {
        case 'ArrowLeft':
          if (this.pane == 'hex' && this.nibble == 1 && !shift) { this.nibble = 0; this.render(); }
          else this.moveTo(this.cursor - 1, shift);
          break;
        case 'ArrowRight': this.moveTo(this.cursor + 1, shift); break;
        case 'ArrowUp': this.moveTo(this.cursor - ROW, shift); break;
        case 'ArrowDown': this.moveTo(Math.min(this.cursor + ROW, this.maxCursor), shift); break;
        case 'PageUp': this.setTop(this.top - this.visibleRows + 1); this.moveTo(this.cursor - page, shift); break;
        case 'PageDown': this.setTop(this.top + this.visibleRows - 1); this.moveTo(Math.min(this.cursor + page, this.maxCursor), shift); break;
        case 'Home': this.moveTo(row, shift); break;
        case 'End': this.moveTo(Math.min(row + ROW - 1, this.maxCursor), shift); break;
        case 'Tab': this.pane = this.pane == 'hex' ? 'text' : 'hex'; this.nibble = 0; this.render(); break;
        case 'Insert': this.command('mode'); break;
        case 'Backspace':
          if (this.insert || this.selection) this.remove(true);
          else this.moveTo(this.cursor - 1);
          break;
        case 'Delete': this.remove(false); break;
        case 'F3': this.findNext(shift ? -1 : 1); break;
        case 'Escape':
          if (this.selection) { this.anchor = null; this.render(); }
          else handled = false; // let it close whatever the editor is in
          break;
        default:
          if (k.length == 1 && !ev.altKey) this.type(k);
          else handled = false;
      }
    }
    if (handled) { ev.preventDefault(); ev.stopPropagation(); }
  }
  onCopy(ev, cut) {
    let sel = this.selection || (this.cursor < this.data.length ? { start: this.cursor, end: this.cursor + 1 } : null);
    ev.preventDefault();
    if (!sel) return;
    let bytes = this.data.subarray(sel.start, sel.end);
    let text = this.pane == 'hex'
      ? [...bytes].map(b => hex(b)).join(' ')
      : [...bytes].map(b => this.cp437 ? CP437[b] : String.fromCharCode(b)).join('');
    ev.clipboardData.setData('text/plain', text);
    if (cut && !this.readOnly) {
      this.anchor = sel.start;
      this.cursor = sel.end - 1;
      this.remove(false);
    }
    this.flash(`Copied ${bytes.length} byte${bytes.length == 1 ? '' : 's'} as ${this.pane == 'hex' ? 'hex' : 'text'}`);
  }
  onPaste(ev) {
    ev.preventDefault();
    let text = ev.clipboardData.getData('text/plain');
    if (!text) return;
    let bytes;
    if (this.pane == 'hex') {
      bytes = HexEditor.parseHex(text);
      if (!bytes) { this.flash('That isn’t hex (switch to the text column with Tab to paste text)', true); return; }
    } else {
      bytes = Uint8Array.from([...text].map(ch => this.charByte(ch) ?? 0x3f));
    }
    this.put(bytes);
  }
  /* "4D 5A 90", "4d5a90", "0x4D, 0x5A" -> bytes, or null if it isn't hex */
  static parseHex(text) {
    let digits = text.replace(/0x/gi, '').replace(/[\s,;:-]/g, '');
    if (!/^([0-9a-f]{2})*$/i.test(digits)) return null;
    return Uint8Array.from(digits.match(/../g) || [], h => parseInt(h, 16));
  }
  command(cmd) {
    switch (cmd) {
      case 'undo': this.undo(); break;
      case 'redo': this.redo(); break;
      case 'save': this.save(); break;
      case 'revert': this.revert(); break;
      case 'download': this.download(); break;
      case 'findnext': this.findNext(1); break;
      case 'findprev': this.findNext(-1); break;
      case 'diffnext': this.findDifference(1); break;
      case 'diffprev': this.findDifference(-1); break;
      case 'mode':
        this.insert = !this.insert;
        this.querySelector('.hx-mode').textContent = this.insert ? 'Insert' : 'Overwrite';
        this.render();
        break;
      default: return;
    }
    if (cmd != 'save' && cmd != 'download') this.focus();
  }

  /* The byte under the mouse: { at, pane } */
  hit(target) {
    let cell = target && target.closest && target.closest('.hx-b, .hx-c');
    let row = cell && cell.closest('.hx-row');
    if (!row || row.dataset.row == null) return null;
    let j = [...cell.parentNode.children].indexOf(cell);
    return { at: +row.dataset.row * ROW + j, pane: cell.classList.contains('hx-b') ? 'hex' : 'text' };
  }
  onMouseDown(ev) {
    if (ev.button != 0) return;
    let hit = this.hit(ev.target);
    if (!this.scroller.contains(ev.target)) return;
    ev.preventDefault();
    this.focus();
    if (!hit) return;
    hit.at = Math.min(hit.at, this.maxCursor);
    this.pane = hit.pane;
    this.moveTo(hit.at, ev.shiftKey);
    let move = e => {
      let h = this.hit(document.elementFromPoint(e.clientX, e.clientY));
      if (!h) return;
      if (this.anchor == null) this.anchor = hit.at;
      this.cursor = Math.min(h.at, this.maxCursor);
      this.nibble = 0;
      this.ensureVisible(this.cursor);
      this.render();
    };
    let up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  }
  /* The byte under the mouse is lit in both columns */
  onHover(ev) {
    let hit = ev && this.hit(ev.target);
    let at = hit ? hit.at : null;
    if (at === this.hoverAt) return;
    this.hoverAt = at;
    this.render();
  }

  /* ----- Find ----- */

  /* What the find box asks for, as bytes (or null if it doesn't make sense) */
  pattern() {
    let mode = this.querySelector('.hx-find-mode').value, text = this.querySelector('.hx-find').value;
    if (!text) return null;
    if (mode == 'text' || mode == 'itext') return Uint8Array.from([...text].map(ch => this.charByte(ch) ?? 0x3f));
    if (mode == 'hex') return HexEditor.parseHex(text);
    let size = +mode, v = parseInteger(text);
    if (v == null) return null;
    let bits = BigInt(size * 8);
    if (v < -(1n << (bits - 1n)) || v > (1n << bits) - 1n) return null;
    let n = Number(BigInt.asUintN(size * 8, v)), out = new Uint8Array(size);
    for (let i = 0; i < size; i++) out[this.bigEndian ? size - 1 - i : i] = (n / 2 ** (8 * i)) & 0xff;
    return out;
  }
  /* Find every match (and draw them) */
  search(report = true) {
    let pattern = this.pattern(), count = this.querySelector('.hx-find-count');
    let ignoreCase = this.querySelector('.hx-find-mode').value == 'itext';
    this.matches = [];
    this.matchLength = 0;
    if (!this.querySelector('.hx-find').value) { count.textContent = ''; this.render(); return; }
    if (!pattern || !pattern.length) { count.textContent = 'Can’t look for that'; this.render(); return; }
    let lower = b => b >= 0x41 && b <= 0x5a ? b + 32 : b;
    let p = ignoreCase ? pattern.map(lower) : pattern, d = this.data, len = p.length;
    outer: for (let i = 0; i + len <= d.length; i++) {
      for (let j = 0; j < len; j++) {
        if ((ignoreCase ? lower(d[i + j]) : d[i + j]) != p[j]) continue outer;
      }
      this.matches.push(i);
      if (this.matches.length >= 100000) break;
    }
    this.matchLength = len;
    if (report) count.textContent = this.matches.length ? this.matches.length + ' found' : 'Not found';
    this.render();
  }
  findNext(dir) {
    if (!this.matchLength) this.search();
    let m = this.matches;
    if (!m.length) return;
    let from = this.selection ? this.selection.start : this.cursor, i;
    if (dir > 0) { i = m.findIndex(at => at > from); if (i < 0) i = 0; }
    else { i = m.findLastIndex(at => at < from); if (i < 0) i = m.length - 1; }
    let mode = this.querySelector('.hx-find-mode').value;
    this.pane = mode == 'text' || mode == 'itext' ? 'text' : 'hex';
    this.anchor = m[i];
    this.cursor = m[i] + this.matchLength - 1;
    this.nibble = 0;
    this.ensureVisible(this.cursor);
    this.ensureVisible(this.anchor);
    this.querySelector('.hx-find-count').textContent = `${i + 1} of ${m.length}${m.length >= 100000 ? '+' : ''}`;
    this.render();
    this.focus();
  }

  /* ----- Comparing ----- */

  updateCompareSelect() {
    let select = this.querySelector('.hx-compare');
    let options = [new Option('Compare with…', '')];
    for (let [key, c] of Object.entries(this.compares)) options.push(new Option(c.label, key));
    options.push(new Option('A file from your computer…', 'pick'));
    select.replaceChildren(...options);
    select.value = this.compareKey && this.compares[this.compareKey] ? this.compareKey : '';
  }
  chooseCompare(key) {
    if (key == 'pick') { this.querySelector('.hx-compare-file').click(); return; }
    this.compareKey = key;
    this.compare = key && this.compares[key] ? this.compares[key].bytes : null;
    this.updateCompareSelect();
    this.render();
  }
  differs(i) {
    let c = this.compare;
    return i < this.data.length ? i >= c.length || c[i] != this.data[i] : i < c.length;
  }
  findDifference(dir) {
    if (!this.compare) { this.flash('Choose something to compare with first', true); return; }
    let n = Math.max(this.data.length, this.compare.length), start = this.cursor;
    // Step out of the run of differences the cursor is in, then find the next one
    let i = start + dir;
    if (dir > 0) {
      while (i < n && this.differs(i) && this.differs(i - 1)) i++;
      while (i < n && !this.differs(i)) i++;
    } else {
      while (i >= 0 && !this.differs(i)) i--;
      while (i > 0 && this.differs(i - 1)) i--;
    }
    if (i < 0 || i >= n) { this.flash('No more differences that way'); return; }
    this.moveTo(Math.min(i, this.maxCursor));
    this.focus();
  }
  countDifferences() {
    if (this.diffCache && this.diffCache.data === this.data && this.diffCache.version === this.version && this.diffCache.compare === this.compare) return this.diffCache.count;
    let c = this.compare, d = this.data, count = 0, n = Math.min(c.length, d.length);
    for (let i = 0; i < n; i++) if (c[i] != d[i]) count++;
    count += Math.abs(c.length - d.length);
    this.diffCache = { data: d, version: this.version, compare: c, count };
    return count;
  }

  /* ----- Drawing ----- */

  /* Fit the rows to the space there is. Very long files would make the scrolling area
     taller than browsers allow, so its height is capped, and the scroll position maps
     to a row by proportion. */
  layout() {
    if (!this.built) return;
    // (Measured once it's on screen)
    if (!this.rowHeight) this.rowHeight = this.querySelector('.hx-header').getBoundingClientRect().height;
    let rowHeight = this.rowHeight || 19, viewHeight = this.scroller.clientHeight;
    this.visibleRows = Math.max(1, Math.floor(viewHeight / rowHeight));
    let total = Math.min(this.rowCount * rowHeight, 8e6);
    this.rowsEl.style.height = viewHeight + 'px';
    this.spacer.style.height = Math.max(0, total - viewHeight) + 'px';
    // Enough rows to fill the view
    while (this.rowsEl.children.length < this.visibleRows + 1) {
      let row = document.createElement('div');
      row.className = 'hx-row';
      row.innerHTML = `<span class="hx-off"></span><span class="hx-hex">${'<span class="hx-b"></span>'.repeat(ROW)}</span><span class="hx-asc">${'<span class="hx-c"></span>'.repeat(ROW)}</span>`;
      row.off = row.firstChild;
      row.bytes = [...row.querySelectorAll('.hx-b')];
      row.chars = [...row.querySelectorAll('.hx-c')];
      this.rowsEl.append(row);
    }
    this.top = Math.min(this.top, this.maxTop);
    this.render();
  }
  get maxTop() { return Math.max(0, this.rowCount - this.visibleRows); }
  get scrollMax() { return Math.max(0, this.scroller.scrollHeight - this.scroller.clientHeight); }
  setTop(top) {
    this.top = Math.max(0, Math.min(Math.round(top), this.maxTop));
    let scrollTop = this.maxTop ? this.top / this.maxTop * this.scrollMax : 0;
    this.expectedScroll = scrollTop;
    this.scroller.scrollTop = scrollTop;
    this.render();
  }
  onScroll() {
    let s = this.scroller.scrollTop;
    if (this.expectedScroll != null && Math.abs(s - this.expectedScroll) < 1) { this.expectedScroll = null; return; }
    this.expectedScroll = null;
    this.top = this.scrollMax ? Math.round(s / this.scrollMax * this.maxTop) : 0;
    this.render();
  }
  ensureVisible(at) {
    let row = Math.floor(at / ROW);
    if (row < this.top) this.setTop(row);
    else if (row >= this.top + this.visibleRows) this.setTop(row - this.visibleRows + 1);
  }
  render() {
    if (!this.built || this.rendering) return;
    // Drawn once per frame, however many changes ask for it
    this.rendering = true;
    requestAnimationFrame(() => { this.rendering = false; this.draw(); });
  }
  draw() {
    let d = this.data, n = d.length, sel = this.selection, rows = this.rowsEl.children;
    let digits = n > 0xffffff ? 8 : 6;
    let first = this.top * ROW, last = first + rows.length * ROW;
    // Which bytes on screen are in a match
    let matched = new Set(), m = this.matches, len = this.matchLength;
    if (m.length) {
      let lo = 0, hi = m.length;
      while (lo < hi) { let mid = (lo + hi) >> 1; if (m[mid] + len <= first) lo = mid + 1; else hi = mid; }
      for (let k = lo; k < m.length && m[k] < last; k++) for (let i = m[k]; i < m[k] + len; i++) matched.add(i);
    }
    for (let r = 0; r < rows.length; r++) {
      let row = rows[r], index = this.top + r;
      if (index >= this.rowCount) { row.classList.add('hx-gone'); row.dataset.row = ''; continue; }
      row.classList.remove('hx-gone');
      row.dataset.row = index;
      row.off.textContent = hex(index * ROW, digits);
      for (let j = 0; j < ROW; j++) {
        let i = index * ROW + j, b = row.bytes[j], c = row.chars[j];
        let cls = '';
        if (i < n) {
          let v = d[i];
          b.textContent = hex(v);
          c.textContent = this.charOf(v);
          if (v == 0) cls += ' hx-zero';
          if (this.dirty[i]) cls += ' hx-dirty';
        } else {
          b.textContent = c.textContent = '';
        }
        if (this.compare && this.differs(i)) cls += ' hx-diff';
        if (matched.has(i)) cls += ' hx-match';
        if (i === this.hoverAt) cls += ' hx-hover';
        if (sel && i >= sel.start && i < sel.end) cls += ' hx-sel';
        let cursor = i == this.cursor && (i < n || !this.readOnly);
        b.className = 'hx-b' + cls + (cursor ? ' hx-cur' + (this.pane == 'hex' ? ' hx-act' + (this.nibble ? ' hx-nib' : '') : '') : '');
        c.className = 'hx-c' + cls + (cursor ? ' hx-cur' + (this.pane == 'text' ? ' hx-act' : '') : '');
      }
    }
    this.headerCells.forEach((cell, j) => cell.classList.toggle('hx-colcur', j == this.cursor % ROW));
    this.renderToolbar();
    this.renderInspector();
    this.renderStatus();
  }
  renderToolbar() {
    let q = sel => this.querySelector(sel);
    q('[data-cmd="undo"]').disabled = !this.undoStack.length;
    q('[data-cmd="redo"]').disabled = !this.redoStack.length;
    q('[data-cmd="save"]').hidden = !this.onsave || this.readOnly;
    q('[data-cmd="save"]').disabled = !this.modified;
    q('[data-cmd="revert"]').disabled = !this.modified;
    q('.hx-mode').hidden = this.readOnly;
    let differences = this.compare && this.countDifferences();
    q('.hx-diff-count').textContent = !this.compare ? '' : differences ? differences.toLocaleString() + ' bytes differ' : 'Same';
    for (let b of this.querySelectorAll('[data-cmd^="diff"]')) b.disabled = !this.compare;
  }
  renderInspector() {
    let at = this.cursor, view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    this.querySelector('.hx-insp-at').textContent = 'At ' + hex(at, 6);
    for (let field of this.inspector) {
      if (document.activeElement == field.input) continue; // being typed into
      let ok = at + field.size <= this.data.length, text = '';
      if (ok) {
        if (field.type == 'bits') text = this.data[at].toString(2).padStart(8, '0');
        else if (field.type == 'char') text = this.cp437 ? CP437[this.data[at]] : String.fromCharCode(this.data[at]);
        else {
          let v = view['get' + field.type](at, !this.bigEndian);
          text = field.type.startsWith('Float') ? String(v) : v.toString();
        }
      }
      field.input.value = text;
      field.input.disabled = !ok || this.readOnly;
      field.input.setCustomValidity('');
    }
  }
  renderStatus() {
    let at = this.cursor, n = this.data.length, sel = this.selection;
    let parts = [`Offset <b>${hex(at, 6)}</b> (${at.toLocaleString()})`];
    if (at < n) parts.push(`Byte <b>${hex(this.data[at])}</b> = ${this.data[at]}`);
    if (sel) parts.push(`Selected <b>${(sel.end - sel.start).toLocaleString()}</b> bytes (${hex(sel.start, 6)}–${hex(sel.end - 1, 6)})`);
    let grown = n - this.saved.length;
    parts.push(`Size ${n.toLocaleString()} bytes` + (grown ? ` <span class="hx-warn">(${grown > 0 ? '+' : ''}${grown.toLocaleString()} since saved)</span>` : ''));
    if (!this.readOnly) parts.push(this.insert ? 'Insert' : 'Overwrite');
    if (this.readOnly) parts.push('Read only');
    else if (this.modified) parts.push('<span class="hx-warn">Unsaved changes</span>');
    if (this.message) parts.push(this.message.warn ? `<span class="hx-warn">${this.message.text.replace(/</g, '&lt;')}</span>` : `<b>${this.message.text.replace(/</g, '&lt;')}</b>`);
    this.status.innerHTML = parts.join(' · ');
  }
}
customElements.define('emularity-hex-editor', HexEditor);
