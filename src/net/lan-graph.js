/* The LAN's bandwidth over time, for <emularity-lan-panel>: a mirrored stacked area
   chart (traffic to each machine stacked above the baseline, from each machine
   below, on one shared scale), with the internet uplink's in/out drawn over it as a
   line. Time ranges from a minute to a day, live; a crosshair readout of every
   machine at the hovered moment; a legend that hides and shows machines; and stat
   tiles for the range.

   Fed by LanMonitor: setHistory() with the worker's history, then addSample() each
   second. Samples are { t, up: [in, out], hosts: { name: [in, out] } } in bytes/s. */

// Categorical slots, in fixed order, stepped for the dark panel (validated against
// #111: lightness band, chroma, CVD and normal-vision separation, 3:1 contrast)
const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const OTHER_COLOR = '#898781';
const INTERNET_COLOR = '#c3c2b7';
const RANGES = [
  { label: '1 min', seconds: 60, tick: 15 },
  { label: '10 min', seconds: 600, tick: 120 },
  { label: '1 hour', seconds: 3600, tick: 600 },
  { label: '24 hours', seconds: 86400, tick: 4 * 3600 },
];
const MAX_POINTS = 240;
const W = 640, H = 236, LEFT = 66, RIGHT = 10, TOP = 10, BOTTOM = 24;
const NS = 'http://www.w3.org/2000/svg';

function formatRate(bytes) {
  return formatBytes(bytes) + '/s';
}
function formatBytes(n) {
  if (n < 1024) return Math.round(n) + ' B';
  let units = ['KB', 'MB', 'GB', 'TB'], i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + units[i];
}
function formatAgo(seconds) {
  if (seconds <= 0) return 'now';
  if (seconds < 60) return '−' + seconds + 's';
  if (seconds < 3600) return '−' + Math.round(seconds / 60) + 'm';
  return '−' + Math.round(seconds / 3600) + 'h';
}
/* A round scale step (1, 2 or 5 of a binary unit) that fits `max` in about 3 ticks */
function niceStep(max) {
  for (let unit of [1, 1024, 1024 ** 2, 1024 ** 3]) {
    for (let m of [1, 2, 5, 10, 20, 50, 100, 200, 500]) {
      if (m * unit * 3 >= max) return m * unit;
    }
  }
  return 1024 ** 4;
}
function el(tag, attrs = {}, text) {
  let e = document.createElementNS(NS, tag);
  for (let k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  return e;
}

export class LanGraph {
  constructor(container) {
    this.root = container;
    this.range = RANGES[1];
    this.seconds = [];
    this.minutes = [];
    this.colors = new Map(); // machine name -> slot index, in order of first appearance
    this.hidden = new Set();
    container.classList.add('lan-graph');
    container.innerHTML = `
      <div class="lan-graph-head">
        <h4>Bandwidth</h4>
        <div class="lan-graph-ranges" role="group" aria-label="Time range"></div>
      </div>
      <div class="lan-graph-tiles"></div>
      <div class="lan-graph-plot">
        <svg class="lan-graph-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bandwidth over time"></svg>
        <div class="lan-graph-tip" hidden></div>
      </div>
      <div class="lan-graph-legend"></div>`;
    let ranges = container.querySelector('.lan-graph-ranges');
    for (let range of RANGES) {
      let b = document.createElement('button');
      b.type = 'button';
      b.textContent = range.label;
      b.addEventListener('click', () => { this.range = range; this.render(); });
      range.button = b;
      ranges.appendChild(b);
    }
    this.svg = container.querySelector('svg');
    this.tip = container.querySelector('.lan-graph-tip');
    this.svg.addEventListener('pointermove', ev => { this.hoverX = this.toViewX(ev); this.renderHover(); });
    this.svg.addEventListener('pointerleave', () => { this.hoverX = null; this.renderHover(); });
  }

  setHistory(history) {
    this.seconds = history.seconds.slice();
    this.minutes = history.minutes.slice();
    this.schedule();
  }
  addSample(sample) {
    let last = this.seconds[this.seconds.length - 1];
    if (!sample || (last && sample.t <= last.t)) return;
    this.seconds.push(sample);
    if (this.seconds.length > 3600) this.seconds.shift();
    this.schedule();
  }
  schedule() {
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => { this.pending = 0; this.render(); });
  }
  toViewX(ev) {
    let r = this.svg.getBoundingClientRect();
    return (ev.clientX - r.left) / r.width * W;
  }

  /* ----- Data ----- */

  /* The range's samples averaged into equal time buckets: [{ t, width, up, hosts }],
     each `null` where there's no data yet. Older than the per-second hour comes from
     the per-minute averages. */
  buckets() {
    let now = this.seconds.length ? this.seconds[this.seconds.length - 1].t : Date.now();
    let span = this.range.seconds * 1000, from = now - span;
    let width = Math.max(1000, span / MAX_POINTS), count = Math.ceil(span / width);
    let firstSecond = this.seconds.length ? this.seconds[0].t : Infinity;
    let samples = [
      ...this.minutes.filter(m => m.t + 60000 > from && m.t < firstSecond).map(m => ({ ...m, dt: 60 })),
      ...this.seconds.filter(s => s.t > from).map(s => ({ ...s, dt: 1 })),
    ];
    let buckets = Array.from({ length: count }, (_, i) => ({ t: from + i * width, width, weight: 0, up: [0, 0], hosts: {} }));
    for (let s of samples) {
      let i = Math.min(count - 1, Math.max(0, Math.floor((s.t - from) / width)));
      let b = buckets[i];
      b.weight += s.dt;
      b.up[0] += s.up[0] * s.dt; b.up[1] += s.up[1] * s.dt;
      for (let name in s.hosts) {
        let acc = b.hosts[name] ||= [0, 0];
        acc[0] += s.hosts[name][0] * s.dt; acc[1] += s.hosts[name][1] * s.dt;
      }
    }
    // Averages; before the first data, nothing
    let started = false;
    return buckets.map(b => {
      if (!b.weight) return started ? { ...b, up: [0, 0], hosts: {} } : null;
      started = true;
      let avg = ([a, c]) => [a / b.weight, c / b.weight];
      let hosts = {};
      for (let name in b.hosts) hosts[name] = avg(b.hosts[name]);
      return { t: b.t, width, up: avg(b.up), hosts };
    });
  }

  /* The machines to draw, bottom of the stack first. Colors follow the machine: each
     keeps the slot it was first seen with. Past eight, the rest fold into "Other". */
  series(buckets) {
    let names = [];
    for (let b of buckets) if (b) for (let name in b.hosts) if (!names.includes(name)) names.push(name);
    for (let name of names) if (!this.colors.has(name)) this.colors.set(name, this.colors.size);
    let list = names.map(name => ({ name, slot: this.colors.get(name) })).sort((a, b) => a.slot - b.slot);
    let own = list.filter(s => s.slot < PALETTE.length - 1 || list.length <= PALETTE.length);
    let rest = list.filter(s => !own.includes(s));
    let series = own.map(s => ({ key: s.name, label: s.name, color: PALETTE[s.slot % PALETTE.length], names: [s.name] }));
    if (rest.length) series.push({ key: '(other)', label: 'Other (' + rest.length + ')', color: OTHER_COLOR, names: rest.map(s => s.name) });
    return series;
  }
  value(bucket, series, dir) {
    let v = 0;
    for (let name of series.names) v += bucket.hosts[name] ? bucket.hosts[name][dir] : 0;
    return v;
  }

  /* ----- Drawing ----- */

  render() {
    for (let range of RANGES) range.button.setAttribute('aria-pressed', range == this.range);
    let buckets = this.buckets(), series = this.series(buckets);
    let visible = series.filter(s => !this.hidden.has(s.key));
    this.view = { buckets, series, visible };
    this.renderTiles();
    this.renderLegend(series);

    // One scale for both directions, so in and out compare directly
    let max = 1024;
    for (let b of buckets) {
      if (!b) continue;
      let down = 0, up = 0;
      for (let s of visible) { down += this.value(b, s, 0); up += this.value(b, s, 1); }
      max = Math.max(max, down, up, b.up[0], b.up[1]);
    }
    let step = niceStep(max), ymax = step * Math.ceil(max / step);
    let plotW = W - LEFT - RIGHT, half = (H - TOP - BOTTOM) / 2, zero = TOP + half;
    let first = buckets.findIndex(b => b);
    let x = i => LEFT + (i + 0.5) / buckets.length * plotW;
    let y = (v, dir) => dir == 0 ? zero - v / ymax * half : zero + v / ymax * half;
    this.geometry = { x, plotW, count: buckets.length };

    let nodes = [];
    // Gridlines and scale, both directions
    for (let v = step; v <= ymax + 1; v += step) {
      for (let dir of [0, 1]) {
        nodes.push(el('line', { x1: LEFT, x2: W - RIGHT, y1: y(v, dir), y2: y(v, dir), class: 'lan-graph-grid' }));
        nodes.push(el('text', { x: LEFT - 6, y: y(v, dir) + 3, class: 'lan-graph-axis', 'text-anchor': 'end' }, formatRate(v)));
      }
    }
    nodes.push(el('text', { x: LEFT + 4, y: TOP + 9, class: 'lan-graph-region' }, '↓ to machines'));
    nodes.push(el('text', { x: LEFT + 4, y: H - BOTTOM - 4, class: 'lan-graph-region' }, '↑ from machines'));
    // Time axis: ticks back from now
    for (let ago = 0; ago <= this.range.seconds; ago += this.range.tick) {
      let tx = LEFT + plotW * (1 - ago / this.range.seconds);
      nodes.push(el('text', { x: tx, y: H - 6, class: 'lan-graph-axis', 'text-anchor': ago == 0 ? 'end' : ago == this.range.seconds ? 'start' : 'middle' }, formatAgo(ago)));
    }

    if (first >= 0) {
      // Stacked areas: each machine on top of those below it, both directions
      let below = [buckets.map(() => 0), buckets.map(() => 0)];
      for (let s of visible) {
        for (let dir of [0, 1]) {
          let top = [], bottom = [];
          for (let i = first; i < buckets.length; i++) {
            let v = buckets[i] ? this.value(buckets[i], s, dir) : 0;
            bottom.push([x(i), y(below[dir][i], dir)]);
            below[dir][i] += v;
            top.push([x(i), y(below[dir][i], dir)]);
          }
          let d = 'M' + top.map(p => p.join(',')).join('L') + 'L' + bottom.reverse().map(p => p.join(',')).join('L') + 'Z';
          nodes.push(el('path', { d, fill: s.color, class: 'lan-graph-area' }));
        }
      }
      // The internet link, over the stack
      if (!this.hidden.has('(internet)')) {
        for (let dir of [0, 1]) {
          let pts = [];
          for (let i = first; i < buckets.length; i++) pts.push(x(i) + ',' + y(buckets[i] ? buckets[i].up[dir] : 0, dir));
          nodes.push(el('path', { d: 'M' + pts.join('L'), class: 'lan-graph-internet', stroke: INTERNET_COLOR }));
        }
      }
    }
    nodes.push(el('line', { x1: LEFT, x2: W - RIGHT, y1: zero, y2: zero, class: 'lan-graph-baseline' }));
    this.crosshair = el('line', { y1: TOP, y2: H - BOTTOM, class: 'lan-graph-crosshair', visibility: 'hidden' });
    nodes.push(this.crosshair);
    this.svg.replaceChildren(...nodes);
    this.renderHover();
  }

  renderHover() {
    if (!this.view || !this.geometry) return;
    let { buckets, visible } = this.view, { plotW, count } = this.geometry;
    let i = this.hoverX == null ? -1 : Math.floor((this.hoverX - LEFT) / plotW * count);
    let b = i >= 0 && i < count ? buckets[i] : null;
    if (!b) {
      this.tip.hidden = true;
      this.crosshair.setAttribute('visibility', 'hidden');
      return;
    }
    let cx = this.geometry.x(i);
    this.crosshair.setAttribute('x1', cx);
    this.crosshair.setAttribute('x2', cx);
    this.crosshair.setAttribute('visibility', 'visible');

    let time = new Date(b.t + b.width / 2).toLocaleTimeString();
    let head = document.createElement('div');
    head.className = 'lan-graph-tip-head';
    head.textContent = time + (b.width > 1000 ? ' · average over ' + formatAgo(Math.round(b.width / 1000)).slice(1) : '');
    let rows = [head];
    let row = (color, label, down, up, cls = '') => {
      let r = document.createElement('div');
      r.className = 'lan-graph-tip-row ' + cls;
      let key = document.createElement('span');
      key.className = 'lan-graph-key';
      if (color) key.style.background = color;
      let name = document.createElement('span');
      name.className = 'lan-graph-tip-name';
      name.textContent = label;
      let values = document.createElement('span');
      values.className = 'lan-graph-tip-values';
      values.textContent = '↓ ' + formatRate(down) + '  ↑ ' + formatRate(up);
      r.append(key, name, values);
      return r;
    };
    let totalDown = 0, totalUp = 0;
    for (let s of visible.slice().reverse()) { // top of the stack first
      let down = this.value(b, s, 0), up = this.value(b, s, 1);
      totalDown += down; totalUp += up;
      rows.push(row(s.color, s.label, down, up));
    }
    rows.push(row(null, 'All machines', totalDown, totalUp, 'lan-graph-tip-total'));
    if (!this.hidden.has('(internet)')) rows.push(row(INTERNET_COLOR, 'Internet', b.up[0], b.up[1], 'lan-graph-tip-internet'));
    this.tip.replaceChildren(...rows);
    this.tip.hidden = false;
    // Beside the crosshair, on whichever side has room
    let frac = cx / W;
    this.tip.style.left = frac < 0.55 ? 'calc(' + (frac * 100) + '% + 12px)' : '';
    this.tip.style.right = frac < 0.55 ? '' : 'calc(' + ((1 - frac) * 100) + '% + 12px)';
  }

  renderTiles() {
    // From the raw samples in range, not the buckets, so peaks aren't averaged away
    let now = this.seconds.length ? this.seconds[this.seconds.length - 1].t : Date.now();
    let from = now - this.range.seconds * 1000;
    let firstSecond = this.seconds.length ? this.seconds[0].t : Infinity;
    let samples = [
      ...this.minutes.filter(m => m.t + 60000 > from && m.t < firstSecond).map(m => ({ ...m, dt: 60 })),
      ...this.seconds.filter(s => s.t > from).map(s => ({ ...s, dt: 1 })),
    ];
    let sum = s => Object.values(s.hosts).reduce((a, [i, o]) => [a[0] + i, a[1] + o], [0, 0]);
    let latest = this.seconds.length ? sum(this.seconds[this.seconds.length - 1]) : [0, 0];
    let peak = [0, 0], total = [0, 0], internet = [0, 0];
    for (let s of samples) {
      let [i, o] = sum(s);
      peak = [Math.max(peak[0], i), Math.max(peak[1], o)];
      total = [total[0] + i * s.dt, total[1] + o * s.dt];
      internet = [internet[0] + s.up[0] * s.dt, internet[1] + s.up[1] * s.dt];
    }
    let tile = (label, value, detail) => {
      let t = document.createElement('div');
      t.className = 'lan-graph-tile';
      let l = document.createElement('div'); l.className = 'lan-graph-tile-label'; l.textContent = label;
      let v = document.createElement('div'); v.className = 'lan-graph-tile-value'; v.textContent = value;
      let d = document.createElement('div'); d.className = 'lan-graph-tile-detail'; d.textContent = detail;
      t.append(l, v, d);
      return t;
    };
    let range = 'in the last ' + this.range.label;
    this.root.querySelector('.lan-graph-tiles').replaceChildren(
      tile('Now', '↓ ' + formatRate(latest[0]), '↑ ' + formatRate(latest[1])),
      tile('Peak', '↓ ' + formatRate(peak[0]), '↑ ' + formatRate(peak[1]) + ' · ' + range),
      tile('Transferred', '↓ ' + formatBytes(total[0]), '↑ ' + formatBytes(total[1]) + ' · ' + range),
      tile('Internet', '↓ ' + formatBytes(internet[0]), '↑ ' + formatBytes(internet[1]) + ' · ' + range),
    );
  }

  renderLegend(series) {
    let items = series.map(s => ({ key: s.key, label: s.label, color: s.color, kind: 'area' }));
    items.push({ key: '(internet)', label: 'Internet', color: INTERNET_COLOR, kind: 'line' });
    let legend = this.root.querySelector('.lan-graph-legend');
    legend.replaceChildren(...items.map(item => {
      let b = document.createElement('button');
      b.type = 'button';
      b.className = 'lan-graph-legend-item';
      b.setAttribute('aria-pressed', !this.hidden.has(item.key));
      b.title = (this.hidden.has(item.key) ? 'Show ' : 'Hide ') + item.label;
      let key = document.createElement('span');
      key.className = 'lan-graph-key lan-graph-key-' + item.kind;
      key.style.background = item.color;
      let label = document.createElement('span');
      label.textContent = item.label;
      b.append(key, label);
      b.addEventListener('click', () => {
        if (this.hidden.has(item.key)) this.hidden.delete(item.key); else this.hidden.add(item.key);
        this.render();
      });
      return b;
    }));
    if (!series.length) {
      let note = document.createElement('span');
      note.className = 'lan-graph-empty';
      note.textContent = 'No traffic recorded yet.';
      legend.prepend(note);
    }
  }
}
