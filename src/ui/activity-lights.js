/* <emularity-activity-lights>: a front panel of drive and network lights for a running
   emulator, from the activity events it sends (see src/emulators/activity.js).

     let lights = document.createElement('emularity-activity-lights');
     lights.emulator = emu;

   Each device gets an icon and a light: green while reading (or receiving), amber
   while writing (or sending). A floppy's light glows dimly while its motor runs, as on
   a real drive. A network has a light for each direction. Hovering one says what's in
   it and how much it has moved. It hides itself when there's nothing to show.

   Removable drives a page lets you change disks in can be clickable:

     lights.drives = emu.mediaDrives;   // [{ id, label, kind, current: { name } }]
     lights.addEventListener('driveclick', ev => ...);  // detail: { drive, element }

   Those drives get a light even before the emulator reports on them (an empty CD
   drive, say), and clicking one sends driveclick (bubbling) with the drive's id. */

const LIT_MS = 120; // how long a light stays on after the last activity

const ICONS = {
  floppy: '<path d="M2.5 2.5h9l2 2v9h-11z"/><path d="M5 2.5v3.5h5V2.5M5 13.5V9h6v4.5"/>',
  cdrom: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.5"/>',
  hdd: '<rect x="2" y="4" width="12" height="8" rx="1.5"/><path d="M4.5 9.5h4"/><circle cx="11.5" cy="9.5" r=".6"/>',
  network: '<rect x="5.5" y="2" width="5" height="4" rx=".5"/><path d="M8 6v3M3 9h10M3 9v2M13 9v2M8 9v2"/><rect x="1.5" y="11" width="3" height="2.5" rx=".4"/><rect x="11.5" y="11" width="3" height="2.5" rx=".4"/><rect x="6.5" y="11" width="3" height="2.5" rx=".4"/>',
  save: '<path d="M8 2v7M5 6.5 8 9.5l3-3"/><path d="M2.5 9.5v4h11v-4"/>',
};

const STYLE = `
emularity-activity-lights {
  display: inline-flex; align-items: center; gap: .55em;
  --led-off: #2a2f2a; --led-read: #4cff6a; --led-write: #ffb22b; --led-motor: #2e7a3a;
  color: #9a9a9a;
}
emularity-activity-lights[hidden] { display: none; }
emularity-activity-lights .al-device { display: inline-flex; align-items: center; gap: .3em; cursor: default; }
emularity-activity-lights button.al-device {
  font: inherit; color: inherit; background: none; border: 1px solid transparent; border-radius: 4px;
  margin: 0 -.25em; padding: .15em .25em; min-width: 0; line-height: 1; cursor: pointer;
}
emularity-activity-lights button.al-device:hover, emularity-activity-lights button.al-device.al-open { border-color: #555; background: #ffffff10; color: #ddd; }
emularity-activity-lights .al-letter { font: 600 .75em/1 system-ui, sans-serif; }
emularity-activity-lights .al-device.al-empty svg { opacity: .45; }
emularity-activity-lights svg {
  width: 1.3em; height: 1.3em; flex: none;
  fill: none; stroke: currentColor; stroke-width: 1.2; stroke-linejoin: round; stroke-linecap: round;
}
emularity-activity-lights .al-led {
  width: .45em; height: .45em; border-radius: 50%; flex: none;
  background: var(--led-off); box-shadow: inset 0 0 0 1px #0006;
  transition: background-color 80ms, box-shadow 80ms;
}
emularity-activity-lights .al-led.al-motor { background: var(--led-motor); }
emularity-activity-lights .al-led.al-read { background: var(--led-read); box-shadow: 0 0 .45em var(--led-read); transition: none; }
emularity-activity-lights .al-led.al-write { background: var(--led-write); box-shadow: 0 0 .45em var(--led-write); transition: none; }
`;

const fmtBytes = n => n < 1024 ? n + ' bytes' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';

export class ActivityLights extends HTMLElement {
  connectedCallback() {
    if (!document.querySelector('style[data-emularity-activity-lights]')) {
      let style = document.createElement('style');
      style.dataset.emularityActivityLights = '';
      style.textContent = STYLE;
      document.head.append(style);
    }
    this.setAttribute('role', 'group');
    this.setAttribute('aria-label', 'Drive and network activity');
    this.listen();
  }
  disconnectedCallback() {
    this.unlisten();
  }

  get drives() { return this._drives || []; }
  set drives(list) {
    this._drives = list || [];
    if (this.isConnected) this.render(this.reported);
  }

  get emulator() { return this._emulator || null; }
  set emulator(emu) {
    this.unlisten();
    this._emulator = emu;
    this.totals = new Map();
    if (this.isConnected) this.listen();
  }

  listen() {
    let emu = this._emulator;
    if (!emu || this.handlers) { this.render(); return; }
    this.handlers = {
      activitydeviceschange: ev => this.render(ev.detail),
      activity: ev => this.show(ev.detail),
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

  render(reported = this._emulator && this._emulator.activityDevices || []) {
    this.reported = reported;
    // Removable drives the emulator doesn't report on (yet) go after their kind
    let devices = reported.slice(), drives = new Map(this.drives.map(d => [d.id, d]));
    for (let d of this.drives) {
      if (devices.some(x => x.id == d.id)) continue;
      let after = devices.findLastIndex(x => x.kind == d.kind);
      devices.splice(after < 0 ? devices.length : after + 1, 0, { id: d.id, kind: d.kind, label: d.label, medium: d.current ? d.current.name : null, features: [] });
    }
    this.devices = new Map();
    this.replaceChildren();
    for (let d of devices) {
      let drive = drives.get(d.id);
      let el = document.createElement(drive ? 'button' : 'span');
      el.className = 'al-device al-' + d.kind;
      if (drive) {
        el.type = 'button';
        el.addEventListener('click', () => {
          this.dispatchEvent(new CustomEvent('driveclick', { bubbles: true, detail: { drive: d.id, element: el } }));
        });
      }
      // Drive letters, where there are several drives of a kind
      let letter = /\b([A-Z]):/.exec(d.label);
      let leds = d.kind == 'network' ? ['transmit', 'receive'] : ['activity'];
      el.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[d.kind] || ICONS.hdd}</svg>` +
        (letter && devices.filter(x => x.kind == d.kind).length > 1 ? `<span class="al-letter">${letter[1]}:</span>` : '') +
        leds.map(l => `<span class="al-led" data-led="${l}"></span>`).join('');
      el.classList.toggle('al-empty', ['floppy', 'cdrom'].includes(d.kind) && !d.medium);
      let leds_ = Object.fromEntries([...el.querySelectorAll('.al-led')].map(x => [x.dataset.led, x]));
      if (d.motor) leds_.activity.classList.add('al-motor');
      let entry = { device: d, el, leds: leds_, timers: {}, clickable: !!drive };
      el.addEventListener('mouseenter', () => this.describe(entry));
      this.describe(entry);
      this.devices.set(d.id, entry);
      this.append(el);
    }
    this.hidden = !devices.length;
  }
  describe({ device: d, el, clickable }) {
    let text = d.label + (['floppy', 'cdrom'].includes(d.kind) ? ' — ' + (d.medium || 'empty') : d.medium ? ' — ' + d.medium : '');
    let t = this.totals.get(d.id);
    if (t) {
      let parts = [];
      if (t.read) parts.push('read ' + fmtBytes(t.read));
      if (t.write) parts.push('written ' + fmtBytes(t.write));
      if (t.receive) parts.push('received ' + fmtBytes(t.receive));
      if (t.transmit) parts.push('sent ' + fmtBytes(t.transmit));
      if (parts.length) text += '\n' + parts.join(', ') + ' this session';
    }
    if (clickable) text += '\nClick to change disks';
    el.title = text;
    el.setAttribute('aria-label', text);
  }

  show(e) {
    let entry = this.devices && this.devices.get(e.device);
    if (!entry) return;
    if (e.type == 'motor') {
      entry.device.motor = e.on;
      entry.leds.activity.classList.toggle('al-motor', e.on);
      return;
    }
    if (e.type == 'seek') return;
    let t = this.totals.get(e.device) || {};
    t[e.type] = (t[e.type] || 0) + (e.bytes || 0);
    this.totals.set(e.device, t);
    let led = entry.leds[e.type] || entry.leds.activity;
    let cls = e.type == 'write' || e.type == 'transmit' ? 'al-write' : 'al-read';
    let key = led.dataset.led + cls;
    led.classList.remove(cls == 'al-read' ? 'al-write' : 'al-read');
    led.classList.add(cls);
    clearTimeout(entry.timers[key]);
    entry.timers[key] = setTimeout(() => led.classList.remove(cls), LIT_MS);
  }
}

if (!customElements.get('emularity-activity-lights')) customElements.define('emularity-activity-lights', ActivityLights);
