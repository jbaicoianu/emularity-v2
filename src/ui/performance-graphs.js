/* <emularity-performance-graphs>: small running graphs of how hard an emulator is
   working (CPU, load, speed), from its metrics events (see
   src/emulators/performance-meter.js).

     let graphs = document.createElement('emularity-performance-graphs');
     graphs.emulator = emu;

   Each measure gets a label, a graph of the last HISTORY samples, and its latest value.
   Hovering one explains it, with its average and peak. Load at or over HIGH (the
   emulator can't keep up) is shown in amber. Hides itself when there's nothing to
   show. */

const HISTORY = 60; // samples kept: 30 seconds, at two a second
const HIGH = 90;

const STYLE = `
emularity-performance-graphs {
  display: inline-flex; align-items: center; gap: .4em;
  --pg-line: #49c8d7; --pg-high: #ffb22b; --pg-grid: #2b2b2b;
  --pg-label: #8a8a8a; --pg-value: #d8d8d8;
}
emularity-performance-graphs[hidden] { display: none; }
emularity-performance-graphs .pg-metric {
  display: inline-grid; grid-template-columns: auto auto; grid-template-rows: auto 1fr;
  align-items: baseline; column-gap: .5em; row-gap: .1em; cursor: default;
  width: 6.2em; height: 2.15em; padding: .22em .4em .18em; box-sizing: border-box;
  border: 1px solid var(--pg-grid); border-radius: 5px; background: #0d0d0d;
}
emularity-performance-graphs .pg-label { font: 600 .62em/1 system-ui, sans-serif; letter-spacing: .06em; text-transform: uppercase; color: var(--pg-label); }
emularity-performance-graphs .pg-value {
  font: .68em/1 system-ui, sans-serif; font-variant-numeric: tabular-nums;
  color: var(--pg-value); text-align: right; white-space: nowrap;
}
emularity-performance-graphs canvas { grid-column: 1 / -1; width: 100%; height: 100%; min-height: 0; display: block; }
emularity-performance-graphs .pg-high .pg-value { color: var(--pg-high); }
`;

const format = (m, v) => v == null ? '–' : m.unit == '%' ? Math.round(v) + '%' : (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + m.unit;

export class PerformanceGraphs extends HTMLElement {
  connectedCallback() {
    if (!document.querySelector('style[data-emularity-performance-graphs]')) {
      let style = document.createElement('style');
      style.dataset.emularityPerformanceGraphs = '';
      style.textContent = STYLE;
      document.head.append(style);
    }
    this.setAttribute('role', 'group');
    this.setAttribute('aria-label', 'Performance');
    this.listen();
  }
  disconnectedCallback() {
    this.unlisten();
  }

  get emulator() { return this._emulator || null; }
  set emulator(emu) {
    this.unlisten();
    this._emulator = emu;
    this.history = {};
    if (this.isConnected) this.listen();
  }

  listen() {
    let emu = this._emulator;
    if (!emu || this.handlers) { this.render(); return; }
    this.handlers = {
      metricschange: ev => this.render(ev.detail),
      metrics: ev => this.add(ev.detail.values),
    };
    for (let [type, fn] of Object.entries(this.handlers)) emu.addEventListener(type, fn);
    this.render();
  }
  unlisten() {
    if (this.handlers && this._emulator) {
      for (let [type, fn] of Object.entries(this.handlers)) this._emulator.removeEventListener(type, fn);
    }
    this.handlers = null;
  }

  render(metrics = this._emulator && this._emulator.performanceMetrics || []) {
    this.entries = metrics.map(m => {
      let el = document.createElement('span');
      el.className = 'pg-metric';
      el.innerHTML = `<span class="pg-label"></span><span class="pg-value">–</span><canvas aria-hidden="true"></canvas>`;
      el.querySelector('.pg-label').textContent = m.label;
      let entry = { metric: m, el, canvas: el.querySelector('canvas'), value: el.querySelector('.pg-value') };
      el.addEventListener('mouseenter', () => this.describe(entry));
      return entry;
    });
    this.replaceChildren(...this.entries.map(e => e.el));
    this.hidden = !this.entries.length;
    for (let e of this.entries) { this.describe(e); this.draw(e); }
  }
  add(values) {
    for (let [id, v] of Object.entries(values)) {
      let h = this.history[id] ||= [];
      h.push(v);
      if (h.length > HISTORY) h.shift();
    }
    for (let e of this.entries || []) {
      let h = this.history[e.metric.id] || [], v = h[h.length - 1];
      e.value.textContent = format(e.metric, v);
      e.el.classList.toggle('pg-high', e.metric.id == 'load' && v >= HIGH);
      this.draw(e);
    }
  }
  describe({ metric: m, el }) {
    let h = this.history[m.id] || [], text = m.label + ': ' + m.description;
    if (h.length) {
      let avg = h.reduce((a, b) => a + b, 0) / h.length, peak = Math.max(...h);
      text += `\nNow ${format(m, h[h.length - 1])}, average ${format(m, avg)}, peak ${format(m, peak)} over the last ${Math.round(h.length / 2)}s`;
    }
    el.title = text;
    el.setAttribute('aria-label', text);
  }
  draw({ metric: m, canvas, el }) {
    let box = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    if (!box.width) return;
    let w = Math.round(box.width * dpr), h = Math.round(box.height * dpr);
    if (canvas.width != w || canvas.height != h) { canvas.width = w; canvas.height = h; }
    let ctx = canvas.getContext('2d'), css = getComputedStyle(this);
    ctx.clearRect(0, 0, w, h);
    // Baseline and midline
    ctx.fillStyle = css.getPropertyValue('--pg-grid').trim() || '#2b2b2b';
    ctx.fillRect(0, h - dpr, w, dpr);
    ctx.fillRect(0, Math.round(h / 2), w, Math.max(1, dpr / 2));
    let values = this.history[m.id] || [];
    if (values.length < 2) return;
    let top = m.max || Math.max(1, ...values) * 1.15;
    let step = w / (HISTORY - 1), x0 = w - (values.length - 1) * step, pad = dpr;
    let y = v => h - pad - Math.min(1, v / top) * (h - pad * 2);
    let color = (el.classList.contains('pg-high') ? css.getPropertyValue('--pg-high') : css.getPropertyValue('--pg-line')).trim();
    ctx.beginPath();
    values.forEach((v, i) => i ? ctx.lineTo(x0 + i * step, y(v)) : ctx.moveTo(x0, y(v)));
    ctx.lineWidth = 1.5 * dpr;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.lineTo(w, h);
    ctx.lineTo(x0, h);
    ctx.closePath();
    ctx.globalAlpha = .18;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

if (!customElements.get('emularity-performance-graphs')) customElements.define('emularity-performance-graphs', PerformanceGraphs);
