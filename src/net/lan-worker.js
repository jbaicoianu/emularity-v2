import { EthernetSwitch } from './switch.js'
import { Router } from './router.js'
import { PppUplink } from './uplink.js'
import { ETHERTYPE_ARP, ETHERTYPE_IPV4, parseEthernet, parseArp, parseIpv4, macToString, ipToString, sameBytes } from './packets.js'

/* The virtual LAN, as a SharedWorker: every page on this origin that connects gets the
   same switch, so machines in different tabs share one network.

   Each connection's first message says what it is:
   - { hello: { name, title } }: a network card, plugged into the switch. It's sent
     { welcome: { name } } with its unique host name, then exchanges Ethernet frames
     (ArrayBuffers) until it sends 'close'. It also receives { log } messages
     describing what the LAN is doing (worker consoles are hard to find, so pages
     print these).
   - 'monitor': a viewer, sent its { history } of throughput samples (see
     recordSample) and { state } (see state()) now, then state whenever it changes
     (each second, with the latest sample).
     It can send { uplink: settings } to change the internet uplink's settings
     (PppUplink.configure; the changes are kept in IndexedDB), 'resetUplink' to drop
     those changes, or 'restart' to restart the LAN: every
     connection is sent { restart: generation } (cards also get their { host } record,
     which they pass back in their next hello as `previous`, so names, addresses and
     leases carry over) and the worker shuts down, and connections reconnect to a new
     instance named for that generation (see lan.js).
   Either kind can send { provideUplink: settings }, the page's own uplink settings
   (PppUplink.provide), which hold until the LAN restarts; connections send them again
   when they reconnect.

   The router's DNS and DHCP use the machines' host names; their MAC and IP addresses
   are learned from the traffic they send (so statically configured guests show up
   too). */

const lan = new EthernetSwitch();
const hosts = new Map();  // switch port -> { name, title, mac, ip, joined, rx, tx, rate }
const monitors = new Set();
const connections = new Set(); // every MessagePort, cards and viewers

const router = new Router(lan, {
  log: message => { for (let port of lan.ports) port.report?.(message); },
  names: {
    lookup: name => [...hosts.values()].find(h => h.name == name && h.ip)?.ip,
    reverse: ip => [...hosts.values()].find(h => h.ip && sameBytes(h.ip, ip))?.name,
    forMac: mac => [...hosts.values()].find(h => h.mac == mac)?.name,
  },
  // A machine can be looked up as soon as it has an address, before it uses it
  onLease: (mac, ip) => {
    let host = [...hosts.values()].find(h => h.mac == mac);
    if (host && !(host.ip && sameBytes(host.ip, ip))) { host.ip = ip; publish(); }
  },
});

const uplink = new PppUplink(router, { onChange: () => { saveSettings(); publish(); } });

/* The user's uplink settings persist in IndexedDB (workers have no localStorage) */
function settingsStore(mode, fn) {
  return new Promise((resolve, reject) => {
    let req = indexedDB.open('emularity-lan', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('settings');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      let tx = req.result.transaction('settings', mode), r = fn(tx.objectStore('settings'));
      tx.oncomplete = () => { req.result.close(); resolve(r && r.result); };
      tx.onerror = () => reject(tx.error);
    };
  });
}
let settingsLoaded = settingsStore('readonly', store => store.get('uplink'))
  .then(saved => { if (saved) uplink.configure(saved); })
  .catch(e => console.warn('Emularity LAN: could not load uplink settings', e));
function saveSettings() {
  settingsLoaded.then(() => settingsStore('readwrite', store => store.put(uplink.changed, 'uplink')))
    .catch(e => console.warn('Emularity LAN: could not save uplink settings', e));
}

/* A DNS-safe name, unique among the machines on the LAN */
function uniqueName(wanted) {
  let base = String(wanted || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'host';
  let taken = new Set([...hosts.values()].map(h => h.name).concat('gateway'));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = base + '-' + n;
  return name;
}

function state() {
  return {
    gateway: ipToString(router.ip),
    domain: router.domain,
    hosts: [...hosts.values()].map(h => ({ name: h.name, title: h.title, mac: h.mac, ip: h.ip && ipToString(h.ip), joined: h.joined, rx: h.rx, tx: h.tx, rate: h.rate })),
    uplink: { ...uplink.state(), rate: uplinkRate },
    sample: history.seconds[history.seconds.length - 1],
  };
}

/* Throughput: bytes per second each way (`in` = to the machine, or from the internet;
   `out` = from it, or to the internet), sampled every second. The current rates
   (`rate`) are smoothed a little so the map doesn't flicker; the history keeps the
   exact per-second figures. Viewers are refreshed with each sample. */
const RATE_INTERVAL = 1000, SMOOTHING = 0.5;
let uplinkRate = { in: 0, out: 0 }, lastSample = { time: Date.now(), uplink: { rx: 0, tx: 0 } };
function smooth(rate, bytesIn, bytesOut, seconds) {
  return {
    in: rate.in * (1 - SMOOTHING) + (bytesIn / seconds) * SMOOTHING,
    out: rate.out * (1 - SMOOTHING) + (bytesOut / seconds) * SMOOTHING,
  };
}
setInterval(() => {
  let now = Date.now(), seconds = (now - lastSample.time) / 1000;
  lastSample.time = now;
  let busy = false;
  let sample = { t: now, up: [0, 0], hosts: {} };
  for (let h of hosts.values()) {
    let bytesIn = h.rx - h.sampled.rx, bytesOut = h.tx - h.sampled.tx;
    h.rate = smooth(h.rate, bytesIn, bytesOut, seconds);
    h.sampled = { rx: h.rx, tx: h.tx };
    sample.hosts[h.name] = [Math.round(bytesIn / seconds), Math.round(bytesOut / seconds)];
  }
  let upIn = uplink.rx - lastSample.uplink.rx, upOut = uplink.tx - lastSample.uplink.tx;
  uplinkRate = smooth(uplinkRate, upIn, upOut, seconds);
  lastSample.uplink = { rx: uplink.rx, tx: uplink.tx };
  sample.up = [Math.round(upIn / seconds), Math.round(upOut / seconds)];
  recordSample(sample);
  if (monitors.size) publish();
}, RATE_INTERVAL);

/* Throughput history for graphs: a sample per second for the last hour, and
   per-minute averages for the last day. A sample is { t (ms), up: [in, out],
   hosts: { name: [in, out] } } in bytes per second. */
const history = { seconds: [], minutes: [] };
let minute = null; // the minute being accumulated: { t, n, up, hosts }
function recordSample(sample) {
  history.seconds.push(sample);
  if (history.seconds.length > 3600) history.seconds.shift();
  let start = sample.t - sample.t % 60000;
  if (minute && minute.t != start) {
    let avg = ([a, b]) => [Math.round(a / minute.n), Math.round(b / minute.n)];
    let hostsAvg = {};
    for (let name in minute.hosts) hostsAvg[name] = avg(minute.hosts[name]);
    history.minutes.push({ t: minute.t, up: avg(minute.up), hosts: hostsAvg });
    if (history.minutes.length > 1440) history.minutes.shift();
    minute = null;
  }
  minute ||= { t: start, n: 0, up: [0, 0], hosts: {} };
  minute.n++;
  minute.up[0] += sample.up[0]; minute.up[1] += sample.up[1];
  for (let name in sample.hosts) {
    let acc = minute.hosts[name] ||= [0, 0];
    acc[0] += sample.hosts[name][0]; acc[1] += sample.hosts[name][1];
  }
}
let publishPending = false;
function publish() {
  if (publishPending) return;
  publishPending = true;
  queueMicrotask(() => {
    publishPending = false;
    let s = state();
    for (let m of monitors) m.postMessage({ state: s });
  });
}

/* Learn a machine's MAC and IP addresses from a frame it sent */
function learn(host, frame) {
  let eth = parseEthernet(frame);
  if (!eth) return;
  let changed = false;
  let mac = macToString(eth.src);
  if (host.mac != mac) { host.mac = mac; changed = true; }
  let ip = null;
  if (eth.ethertype == ETHERTYPE_ARP) ip = parseArp(eth.payload)?.senderIp;
  else if (eth.ethertype == ETHERTYPE_IPV4) ip = parseIpv4(eth.payload)?.src;
  // Ignore 0.0.0.0 (DHCP before a lease) and anything off the subnet
  if (ip && router.onLan(ip) && ip[3] != 0 && ip[3] != 255 && !(host.ip && sameBytes(host.ip, ip))) {
    host.ip = ip.slice();
    changed = true;
  }
  if (changed) publish();
}

/* Hand everyone over to a fresh worker, then go away */
function restart() {
  let generation = Date.now().toString(36);
  let records = new Map([...hosts].map(([port, h]) => [port.messagePort, { name: h.name, mac: h.mac, ip: h.ip && ipToString(h.ip) }]));
  for (let p of connections) p.postMessage({ restart: generation, host: records.get(p) });
  uplink.disconnect(); // the new worker reconnects it if it's enabled
  setTimeout(() => close(), 100);
}

onconnect = ev => {
  let messagePort = ev.ports[0];
  connections.add(messagePort);
  let port = null; // set once the connection says it's a network card
  let unplug = () => {
    if (port) { lan.detach(port); hosts.delete(port); port = null; publish(); }
    monitors.delete(messagePort);
    connections.delete(messagePort);
  };
  messagePort.onmessage = msg => {
    let data = msg.data;
    if (data instanceof ArrayBuffer) {
      if (!port) return;
      let frame = new Uint8Array(data);
      let host = hosts.get(port);
      host.tx += frame.length;
      learn(host, frame);
      lan.forward(port, frame);
    } else if (data === 'close') {
      unplug();
      messagePort.close();
    } else if (data === 'monitor') {
      monitors.add(messagePort);
      messagePort.postMessage({ history });
      messagePort.postMessage({ state: state() });
    } else if (data === 'restart' && monitors.has(messagePort)) {
      restart();
    } else if (data && data.uplink && monitors.has(messagePort)) {
      settingsLoaded.then(() => uplink.configure(data.uplink));
    } else if (data === 'resetUplink' && monitors.has(messagePort)) {
      settingsLoaded.then(() => uplink.reset());
    } else if (data && data.provideUplink) {
      settingsLoaded.then(() => uplink.provide(data.provideUplink));
    } else if (data && data.hello && !port) {
      port = {
        messagePort,
        deliver(frame) {
          let host = hosts.get(port);
          if (host) host.rx += frame.length;
          let copy = frame.slice(); // other ports may be handed the same frame
          messagePort.postMessage(copy.buffer, [copy.buffer]);
        },
        report(message) {
          messagePort.postMessage({ log: message });
        },
      };
      // A card coming over from before a restart keeps its name, addresses and lease
      let previous = data.hello.previous || {};
      let name = uniqueName(previous.name || data.hello.name);
      let ip = previous.ip ? new Uint8Array(previous.ip.split('.').map(Number)) : null;
      hosts.set(port, { name, title: data.hello.title || '', mac: previous.mac || null, ip, joined: Date.now(),
        rx: 0, tx: 0, sampled: { rx: 0, tx: 0 }, rate: { in: 0, out: 0 } });
      if (previous.mac && ip) router.restoreLease(previous.mac, ip);
      lan.attach(port);
      messagePort.postMessage({ welcome: { name } });
      publish();
    }
  };
  // Browsers that support it tell us when the page holding the other end goes away
  messagePort.addEventListener('close', unplug);
  messagePort.start();
};
