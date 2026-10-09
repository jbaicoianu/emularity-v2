import { LanMonitor } from './lan.js'
import { LanGraph } from './lan-graph.js'

/* <emularity-lan-panel>: a live view of the virtual LAN. A map (the internet as a cloud
   above the gateway, machines below) and a table of machines with their names and
   addresses, updated as machines join, leave and get addresses. Clicking the cloud
   shows the internet uplink's settings. It watches the LAN while it's in the
   document. Its `uplink` attribute names the page's uplink settings file (see
   LanMonitor). */

const STATUS_TEXT = {
  off: 'offline', connecting: 'connecting…', authenticating: 'logging in…',
  configuring: 'getting an address…', online: 'online', waiting: 'retrying…',
};
function formatBytes(n) {
  if (n < 1024) return n + ' B';
  let units = ['KB', 'MB', 'GB'], i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + units[i];
}

export class LanPanel extends HTMLElement {
  connectedCallback() {
    this.classList.add('emularity-lan-panel');
    this.innerHTML = `
      <svg class="lan-map" viewBox="0 0 640 330" role="img" aria-label="Network map"></svg>
      <form class="lan-uplink-form" hidden>
        <h4>Internet uplink <small>(PPP over WebSocket)</small></h4>
        <label>Server <input name="url" type="url" required></label>
        <label>Username <input name="username" type="text" autocomplete="off"></label>
        <label>Password <input name="password" type="password" autocomplete="new-password"></label>
        <label>DNS server, if the PPP server doesn't provide one <input name="dns" type="text"></label>
        <p class="lan-uplink-status"></p>
        <div class="lan-uplink-buttons">
          <button type="submit">Connect</button>
          <button type="button" class="lan-disconnect">Disconnect</button>
          <button type="button" class="lan-reset" title="Forget the settings entered here, and use the site's own">Use default settings</button>
        </div>
      </form>
      <div class="lan-graph-container"></div>
      <table class="lan-hosts">
        <thead><tr><th>Name</th><th>IP address</th><th>MAC address</th><th>System</th><th>Now ↓ / ↑</th><th>Total ↓ / ↑</th><th>Joined</th></tr></thead>
        <tbody></tbody>
      </table>
      <p class="lan-empty">No machines are on the network. Machines join it when they start with networking enabled.</p>
      <div class="lan-actions">
        <button type="button" class="lan-restart" title="Restart the switch, router and uplink (and load any updated networking code). Running machines stay connected.">Restart network</button>
      </div>`;
    if (typeof SharedWorker == 'undefined') {
      this.querySelector('.lan-empty').textContent = "This browser can't run the virtual network (no SharedWorker).";
      return;
    }
    let form = this.querySelector('form');
    form.addEventListener('submit', ev => {
      ev.preventDefault();
      let f = name => form.elements[name].value.trim();
      let settings = { url: f('url'), username: f('username'), dns: f('dns'), enabled: true };
      if (f('password')) settings.password = form.elements.password.value; // blank: keep the saved one
      this.monitor.configureUplink(settings);
      form.elements.password.value = '';
    });
    this.querySelector('.lan-disconnect').addEventListener('click', () => this.monitor.configureUplink({ enabled: false }));
    this.querySelector('.lan-reset').addEventListener('click', () => { this.monitor.resetUplink(); this.fillAfterReset = true; });
    this.querySelector('.lan-restart').addEventListener('click', () => this.monitor.restart());
    this.graph = new LanGraph(this.querySelector('.lan-graph-container'));
    this.monitor = new LanMonitor(state => this.render(state), history => this.graph.setHistory(history),
      { uplink: this.getAttribute('uplink') });
  }
  disconnectedCallback() {
    if (this.monitor) this.monitor.close();
    this.monitor = null;
  }
  toggleUplinkForm() {
    let form = this.querySelector('form');
    form.hidden = !form.hidden;
    if (!form.hidden) this.fillForm(true);
  }

  render(state) {
    this.state = state;
    if (state.sample) this.graph.addSample(state.sample);
    let hosts = state.hosts.slice().sort((a, b) => a.joined - b.joined);
    this.querySelector('.lan-empty').hidden = hosts.length > 0;
    this.renderMap(state, hosts);
    this.fillForm(false);
    let row = (cells, cls) => {
      let tr = document.createElement('tr');
      if (cls) tr.className = cls;
      for (let text of cells) {
        let td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      }
      return tr;
    };
    let rate = r => r ? formatBytes(Math.round(r.in)) + '/s / ' + formatBytes(Math.round(r.out)) + '/s' : '';
    let rows = [row(['gateway.' + state.domain, state.gateway, '', 'Router: DHCP, DNS, NAT', '', '', ''], 'lan-gateway')];
    let up = state.uplink;
    if (up && up.session) {
      rows.push(row(['(internet)', up.session.ip, '', 'PPP: ' + up.url, rate(up.rate), formatBytes(up.rx) + ' / ' + formatBytes(up.tx),
        new Date(up.session.since).toLocaleTimeString()], 'lan-gateway'));
    }
    for (let h of hosts) {
      rows.push(row([h.name + '.' + state.domain, h.ip || 'no address yet', h.mac || '', h.title || '', rate(h.rate),
        formatBytes(h.rx || 0) + ' / ' + formatBytes(h.tx || 0), new Date(h.joined).toLocaleTimeString()], h.ip ? '' : 'lan-pending'));
    }
    this.querySelector('tbody').replaceChildren(...rows);
  }

  /* The uplink settings form: fields filled from the saved settings (unless the user is
     editing them), and the connection status */
  fillForm(force) {
    let up = this.state && this.state.uplink, form = this.querySelector('form');
    if (!up) return;
    if (this.fillAfterReset && !up.customized) { force = true; this.fillAfterReset = false; }
    if (force || !form.contains(document.activeElement)) {
      form.elements.url.value = up.url;
      form.elements.username.value = up.username;
      form.elements.dns.value = up.dns;
      form.elements.password.placeholder = up.hasPassword ? '(saved; type to change)' : '';
    }
    let status = STATUS_TEXT[up.status] || up.status;
    if (up.session) {
      status = `Online as ${up.session.ip} · DNS ${up.session.dns.join(', ')} · ↓ ${formatBytes(up.rx)} ↑ ${formatBytes(up.tx)} · ${up.flows} connection${up.flows == 1 ? '' : 's'}`;
    } else if (up.error && up.status != 'off') {
      status = 'Not connected (' + up.error + '): ' + status;
    } else if (up.status == 'off') {
      status = 'Not connected.' + (up.error ? ' Last error: ' + up.error + '.' : '');
    }
    this.querySelector('.lan-uplink-status').textContent = status;
    this.querySelector('.lan-disconnect').disabled = !up.enabled;
    this.querySelector('.lan-reset').hidden = !up.customized;
    form.querySelector('[type="submit"]').textContent = up.enabled ? 'Apply & reconnect' : 'Connect';
  }

  /* The map: links from the gateway to each machine and up to the internet, drawn as
     two bands (one per direction) whose width shows the current throughput. The
     layout is rebuilt only when machines or the uplink change, so the bands' flowing
     dashes animate smoothly between updates. */
  renderMap(state, hosts) {
    let up = state.uplink || { status: 'off' };
    let topology = JSON.stringify([state.gateway, up.status, up.session && up.session.ip, hosts.map(h => [h.name, h.ip])]);
    if (topology != this.topology) {
      this.topology = topology;
      this.buildMap(state, hosts);
    }
    this.updateFlows(state, hosts);
  }

  buildMap(state, hosts) {
    let svg = this.querySelector('.lan-map');
    let ns = 'http://www.w3.org/2000/svg';
    let el = (tag, attrs, ...children) => {
      let e = document.createElementNS(ns, tag);
      for (let k in attrs) e.setAttribute(k, attrs[k]);
      for (let c of children) e.append(c);
      return e;
    };
    let box = (x, y, name, ip, cls, tooltip, rx = 6) => {
      if (name.length > 24) name = name.slice(0, 23) + '…'; // the full name is in the tooltip and table
      let w = Math.max(104, name.length * 6.6 + 16); // fits 11px text
      return el('g', { class: 'lan-node ' + cls },
        el('rect', { x: x - w / 2, y: y - 17, width: w, height: 34, rx }),
        el('text', { x, y: y - 3, class: 'lan-name' }, name),
        el('text', { x, y: y + 11, class: 'lan-ip' }, ip),
        el('title', {}, tooltip));
    };
    // A link: a hairline, and a band for each direction (`in` flows from `a` to `b`)
    let flow = (key, a, b, cls = '') => {
      let g = el('g', { class: 'lan-flow ' + cls, 'data-key': key },
        el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'lan-link' }),
        el('line', { class: 'lan-band lan-band-in' }),
        el('line', { class: 'lan-band lan-band-out' }),
        el('text', { class: 'lan-rate' }));
      g.ends = { a, b };
      return g;
    };

    // The internet at the top, the gateway below it, and machines in rows of up to four
    // under that, so traffic fans out from the uplink to the machines using it
    let up = state.uplink || { status: 'off' };
    let perRow = 4, rows = Math.ceil(hosts.length / perRow) || 1;
    let height = 250 + rows * 58 + 20;
    svg.setAttribute('viewBox', '0 0 640 ' + height);
    let gateway = { x: 320, y: 150 }, cloudAt = { x: 320, y: 66 };
    let cloud = el('g', { class: 'lan-cloud lan-uplink-' + up.status, role: 'button', tabindex: 0 },
      el('path', { d: 'M276,66 a20,20 0 0,1 2,-40 a28,28 0 0,1 50,-10 a24,24 0 0,1 40,14 a18,18 0 0,1 -4,36 z' }),
      el('text', { x: 320, y: 42, class: 'lan-name' }, 'Internet'),
      el('text', { x: 320, y: 56, class: 'lan-ip' }, up.session ? up.session.ip : STATUS_TEXT[up.status] || up.status),
      el('title', {}, 'Internet settings'));
    cloud.addEventListener('click', () => this.toggleUplinkForm());
    cloud.addEventListener('keydown', ev => { if (ev.key == 'Enter' || ev.key == ' ') { ev.preventDefault(); this.toggleUplinkForm(); } });

    let flows = [flow('uplink', cloudAt, gateway, 'lan-uplink-flow lan-uplink-' + up.status)], nodes = [];
    hosts.forEach((h, i) => {
      let row = Math.floor(i / perRow), inRow = Math.min(perRow, hosts.length - row * perRow);
      let at = { x: 640 * ((i % perRow) + 0.5) / inRow, y: 260 + row * 58 };
      flows.push(flow('host:' + h.name, gateway, at)); // `in`: toward the machine
      nodes.push(box(at.x, at.y, h.name, h.ip || '…', h.ip ? '' : 'lan-pending', (h.title ? h.title + '\n' : '') + (h.mac || '')));
    });
    let gw = box(gateway.x, gateway.y, 'gateway', state.gateway, 'lan-gateway', 'Router: DHCP, DNS, NAT', 17);
    let legend = el('g', { class: 'lan-legend' },
      el('line', { x1: 8, y1: height - 8, x2: 24, y2: height - 8, class: 'lan-band lan-band-in', 'stroke-width': 4 }),
      el('text', { x: 28, y: height - 5 }, 'to a machine / from the internet'),
      el('line', { x1: 196, y1: height - 8, x2: 212, y2: height - 8, class: 'lan-band lan-band-out', 'stroke-width': 4 }),
      el('text', { x: 216, y: height - 5 }, 'from a machine / to the internet'));
    svg.replaceChildren(...flows, legend, cloud, ...nodes, gw); // links under the boxes
    this.flows = new Map(flows.map(f => [f.dataset.key, f]));
  }

  updateFlows(state, hosts) {
    // Band width grows with the log of the rate: ~2px at 1 KB/s, ~9 at 1 MB/s, ~11 at 10 MB/s
    let width = rate => rate < 64 ? 0 : Math.min(16, 1.5 + 2.4 * Math.log10(1 + rate / 1024));
    let fmt = rate => formatBytes(Math.round(rate)) + '/s';
    let set = (key, rate) => {
      let g = this.flows && this.flows.get(key);
      if (!g) return;
      let { a, b } = g.ends;
      let dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len, ny = dx / len; // normal: bands sit either side of the hairline
      let [, bandIn, bandOut, label] = g.children;
      let wIn = width(rate.in), wOut = width(rate.out);
      // `in` runs a -> b, `out` b -> a, so the dashes move the way the data does
      let place = (line, w, side, from, to) => {
        let off = side * (w / 2 + 1);
        line.setAttribute('x1', from.x + nx * off); line.setAttribute('y1', from.y + ny * off);
        line.setAttribute('x2', to.x + nx * off); line.setAttribute('y2', to.y + ny * off);
        line.setAttribute('stroke-width', w);
        line.style.display = w ? '' : 'none';
      };
      place(bandIn, wIn, 1, a, b);
      place(bandOut, wOut, -1, b, a);
      let busy = rate.in >= 1024 || rate.out >= 1024;
      label.style.display = busy ? '' : 'none';
      if (busy) {
        // Beside the middle of the link, clear of the bands
        let off = Math.max(wIn, wOut) + 12;
        label.setAttribute('x', a.x + dx * 0.5 + nx * off);
        label.setAttribute('y', a.y + dy * 0.5 + ny * off + 4);
        // Grow away from the link, whichever side of it the label is on
        label.setAttribute('text-anchor', Math.abs(nx) < 0.3 ? 'middle' : nx < 0 ? 'end' : 'start');
        label.textContent = '↓' + fmt(rate.in) + '  ↑' + fmt(rate.out);
      }
    };
    let up = state.uplink;
    set('uplink', up && up.rate ? up.rate : { in: 0, out: 0 });
    for (let h of hosts) set('host:' + h.name, h.rate || { in: 0, out: 0 });
  }
}
