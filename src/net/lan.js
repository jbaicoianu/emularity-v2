/* Connections to the virtual LAN (see lan-worker.js), shared by every page on this
   origin. The worker URL and name must be the same everywhere for pages to share it.

   Restarting: a SharedWorker lives until every page using it closes, so the LAN is
   restarted by moving everyone to a new worker instance instead. The worker's name
   carries a "generation"; on restart the old worker tells every connection the new
   one and shuts itself down, and each reconnects. The current generation is kept in
   localStorage so pages opened later join it too. A new instance also loads the
   worker's code afresh. */
const GENERATION_KEY = 'emularity-lan-generation';

function connect() {
  let generation = '';
  try { generation = localStorage.getItem(GENERATION_KEY) || ''; } catch (e) {}
  let name = 'emularity-lan' + (generation ? '-' + generation : '');
  return new SharedWorker(new URL('./lan-worker.js', import.meta.url), { type: 'module', name }).port;
}
function adoptGeneration(generation) {
  try { localStorage.setItem(GENERATION_KEY, generation); } catch (e) {}
}

/* The page's settings for the LAN's internet uplink, from a JSON file of any of
   { url, username, password, dns, enabled } (see uplink.js). Fetched once per file. */
const uplinkFiles = new Map();
function loadUplinkSettings(url) {
  url = new URL(url, document.baseURI).href;
  if (!uplinkFiles.has(url)) {
    uplinkFiles.set(url, fetch(url, { credentials: 'same-origin' })
      .then(r => { if (!r.ok) throw new Error(r.status + ' ' + r.statusText); return r.json(); })
      .catch(e => { console.warn('Emularity LAN: could not load the uplink settings in ' + url, e); return null; }));
  }
  return uplinkFiles.get(url);
}

/* A connection to the worker that follows it across restarts. Subclasses handle
   messages (receive) and say what to send on (re)connecting (hello). `uplink`, the URL
   of an uplink settings file (see loadUplinkSettings), is passed on to the worker. */
class WorkerConnection {
  constructor({ uplink } = {}) {
    this.uplinkSettings = uplink ? loadUplinkSettings(uplink) : null;
  }
  open() {
    this.port = connect();
    this.port.onmessage = ev => {
      if (ev.data && ev.data.restart) {
        adoptGeneration(ev.data.restart);
        this.previous = ev.data.host; // carried into the next hello
        this.port.close();
        this.open();
      } else {
        this.receive(ev.data);
      }
    };
    this.port.start();
    this.hello();
    if (this.uplinkSettings) {
      let port = this.port;
      this.uplinkSettings.then(settings => { if (settings && this.port === port) port.postMessage({ provideUplink: settings }); });
    }
    if (!this.onPageHide) {
      this.onPageHide = () => this.close();
      addEventListener('pagehide', this.onPageHide);
    }
  }
  close() {
    if (!this.port) return;
    removeEventListener('pagehide', this.onPageHide);
    this.port.postMessage('close');
    this.port.close();
    this.port = null;
  }
}

/* A network card plugged into the LAN. `onFrame` receives incoming Ethernet frames
   as Uint8Arrays. `name` is the host name the machine asks for (made unique on the
   LAN; the result is passed to `onName`), `title` a description for network
   viewers. `uplink` is an uplink settings file (see WorkerConnection). */
export class LanConnection extends WorkerConnection {
  name = null; // the host name the LAN assigned

  constructor(onFrame, { name, title, onName, uplink } = {}) {
    super({ uplink });
    Object.assign(this, { onFrame, wantedName: name, title, onName });
    this.open();
  }
  hello() {
    this.port.postMessage({ hello: { name: this.wantedName, title: this.title, previous: this.previous } });
  }
  receive(data) {
    if (data instanceof ArrayBuffer) this.onFrame(new Uint8Array(data));
    else if (data.log) console.info('Emularity LAN:', data.log);
    else if (data.welcome) {
      this.name = data.welcome.name;
      console.info('Emularity: network card connected to the virtual LAN as "' + this.name + '"');
      if (this.onName) this.onName(this.name);
    }
  }
  send(frame) {
    if (!this.port) return;
    // Copy: the emulator may hand us a view of its own memory, which must not be
    // transferred away
    let copy = frame.slice();
    this.port.postMessage(copy.buffer, [copy.buffer]);
  }
}

/* Watches the LAN without joining it. `onState` receives the LAN's state now and
   whenever it changes: { gateway, domain, hosts: [{ name, title, mac, ip, joined,
   rx, tx, rate }], uplink: { status, url, username, hasPassword, dns, enabled,
   customized, session, error, rx, tx, flows, rate }, sample }. `onHistory` first receives the
   throughput history, { seconds: [sample...], minutes: [sample...] }, where a sample
   is { t, up: [in, out], hosts: { name: [in, out] } } in bytes per second. `uplink`
   is an uplink settings file (see WorkerConnection). */
export class LanMonitor extends WorkerConnection {
  constructor(onState, onHistory = () => {}, { uplink } = {}) {
    super({ uplink });
    this.onState = onState;
    this.onHistory = onHistory;
    this.open();
  }
  hello() {
    this.port.postMessage('monitor');
  }
  receive(data) {
    if (data.history) this.onHistory(data.history);
    if (data.state) this.onState(data.state);
  }
  /* Change the internet uplink's settings: any of { url, username, password, dns,
     enabled } */
  configureUplink(settings) {
    if (this.port) this.port.postMessage({ uplink: settings });
  }
  /* Drop the user's uplink settings, going back to those the page provides */
  resetUplink() {
    if (this.port) this.port.postMessage('resetUplink');
  }
  /* Restart the whole LAN (see above): machines stay plugged in, with a fresh switch,
     router and uplink */
  restart() {
    if (this.port) this.port.postMessage('restart');
  }
}
