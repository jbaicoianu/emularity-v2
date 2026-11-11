import { LanMonitor } from './lan.js'
import { LanGraph } from './lan-graph.js'
import { LanBridge } from './bridge.js'
import { ManualSignaling } from './signaling.js'
import { LanBridgeWizard } from './bridge-wizard.js'

/* <emularity-lan-panel>: a live view of the virtual LAN. A map (the internet as a cloud
   above the gateway, machines below) and a table of machines with their names and
   addresses, updated as machines join, leave and get addresses. Clicking the cloud
   shows the internet uplink's settings. It watches the LAN while it's in the
   document. Its `uplink` attribute names the page's uplink settings file (see
   LanMonitor).

   It also bridges the LAN with other browsers' (see bridge.js), set up in a modal
   that walks through passing links between friends (see bridge-wizard.js), and lists
   the bridges. useCode() takes an invitation or reply link (or code), e.g. one the
   page was opened with. */

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
      <section class="lan-bridges">
        <h4>Other networks</h4>
        <p class="field-hint">Connect this network with a friend's, in their browser, so your machines can reach each other. Each side keeps its own internet connection.</p>
        <div class="lan-bridge-list"></div>
        <p class="lan-bridge-message" hidden></p>
        <div class="lan-bridge-buttons"><button type="button" class="lan-connect-friend">Connect with a friend's network…</button></div>
      </section>
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
    this.setupBridges();
    this.graph = new LanGraph(this.querySelector('.lan-graph-container'));
    this.monitor = new LanMonitor(state => this.render(state), history => this.graph.setHistory(history),
      { uplink: this.getAttribute('uplink') });
  }
  disconnectedCallback() {
    if (this.monitor) this.monitor.close();
    this.monitor = null;
    if (this.onBridgeChange) LanBridge.events.removeEventListener('change', this.onBridgeChange);
    if (this.onBridgeError) LanBridge.events.removeEventListener('error', this.onBridgeError);
    this.wizard?.setBridge(null);
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
    let bridges = state.bridges || [];
    this.querySelector('.lan-empty').hidden = hosts.length > 0 || bridges.length > 0;
    this.renderMap(state, hosts, bridges);
    this.renderBridges();
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
    for (let b of bridges) {
      let who = (b.label || 'another browser') + "'s network";
      rows.push(row(['⇄ ' + who, b.hosts.length + ' machine' + (b.hosts.length == 1 ? '' : 's'), '', 'Bridge (WebRTC)', rate(b.rate),
        formatBytes(b.rx || 0) + ' / ' + formatBytes(b.tx || 0), new Date(b.joined).toLocaleTimeString()], 'lan-gateway'));
      for (let h of b.hosts) {
        let r = row([h.name + '.' + state.domain, (h.ip || 'no address yet') + (h.conflict ? ' ⚠' : ''), h.mac || '',
          (h.title ? h.title + ' · ' : '') + 'on ' + who, '', '', ''], 'lan-remote' + (h.conflict ? ' lan-conflict' : ''));
        if (h.conflict) r.title = 'A machine here has the same address. The one with the higher MAC address gets a new address when it renews its lease (or restart its networking).';
        rows.push(r);
      }
    }
    this.querySelector('tbody').replaceChildren(...rows);
  }

  /* ----- Bridges to other browsers' LANs ----- */

  setupBridges() {
    this.wizard = new LanBridgeWizard(this, { uplink: this.getAttribute('uplink') });
    this.querySelector('.lan-connect-friend').addEventListener('click', () => { this.bridgeMessage(''); this.wizard.open(); });
    this.onBridgeChange = () => this.renderBridges();
    LanBridge.events.addEventListener('change', this.onBridgeChange);
    // Failures show in the wizard if it's open, and here otherwise
    this.onBridgeError = ev => { if (!this.wizard.dialog.open) this.bridgeMessage(ev.detail.error, true); };
    LanBridge.events.addEventListener('error', this.onBridgeError);
    this.renderBridges();
  }

  bridgeMessage(text, error = false) {
    let p = this.querySelector('.lan-bridge-message');
    p.textContent = text;
    p.hidden = !text;
    p.classList.toggle('lan-error', error);
  }

  /* An invitation or reply (a link, or its code). An invitation opens the wizard to
     join; a reply goes to the invitation waiting for it, in whichever tab that is
     (where the wizard, if open, moves on). */
  async useCode(text) {
    let message;
    try {
      message = await ManualSignaling.decode(text);
    } catch (e) {
      return this.bridgeMessage(e.message, true);
    }
    if (message.type == 'offer') return this.wizard.openInvitation(message);
    let mine = [...LanBridge.all].find(b => b.id == message.id);
    try {
      if (mine) {
        await mine.acceptAnswer(message);
        this.wizard.resume(mine);
      } else if (await LanBridge.deliver(message)) {
        this.bridgeMessage("Reply received: your other tab, with the invitation, is connecting now. You can close this one.");
      } else {
        this.bridgeMessage('No invitation in this browser is waiting for that reply. Open it in the browser that made the invitation, while its tab is still open.', true);
      }
    } catch (e) {
      this.bridgeMessage(e.message, true);
    }
  }

  renderBridges() {
    let list = this.querySelector('.lan-bridge-list');
    if (!list) return;
    let cards = new Map([...list.children].map(c => [c.bridgeId, c]));
    let wanted = [];
    let fmt = r => r ? formatBytes(Math.round(r.in)) + '/s ↓ ' + formatBytes(Math.round(r.out)) + '/s ↑' : '';
    for (let bridge of LanBridge.all) {
      let card = cards.get(bridge.id);
      if (!card || card.status != bridge.status) card = this.bridgeCard(bridge);
      if (bridge.status == 'connected') {
        let info = (this.state?.bridges || []).find(b => b.id == bridge.id);
        let n = bridge.remoteHosts.length;
        card.querySelector('.lan-bridge-stats').textContent = n + ' machine' + (n == 1 ? '' : 's') + ' there' + (info ? ' · ' + fmt(info.rate) : '');
      }
      wanted.push(card);
    }
    for (let b of this.state?.bridges || []) {
      if ([...LanBridge.all].some(x => x.id == b.id)) continue;
      let line = cards.get(b.id);
      if (!line || line.status != 'elsewhere') {
        line = document.createElement('div');
        line.className = 'lan-bridge lan-bridge-elsewhere';
        line.bridgeId = b.id;
        line.status = 'elsewhere';
      }
      line.textContent = 'Connected to ' + (b.label || 'another browser') + "'s network (from another tab) · " + b.hosts.length + ' machines';
      wanted.push(line);
    }
    // Only touch the list when it changes: moving a card would lose a reply being typed
    if (wanted.length != list.children.length || wanted.some((c, i) => list.children[i] !== c)) list.replaceChildren(...wanted);
  }

  /* A bridge being set up: who with, and a way back into the wizard */
  bridgeCard(bridge) {
    let card = document.createElement('div');
    card.className = 'lan-bridge lan-bridge-' + bridge.status;
    card.bridgeId = bridge.id;
    card.status = bridge.status;
    let who = bridge.remoteLabel || (bridge.status == 'inviting' ? 'a friend' : 'your friend');
    let line = document.createElement('p');
    let button = (text, action) => {
      let b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.addEventListener('click', action);
      return b;
    };
    if (bridge.status == 'connected') {
      line.textContent = '⇄ Connected with ' + who + "'s network";
      let stats = document.createElement('span');
      stats.className = 'lan-bridge-stats';
      line.append(' · ', stats);
      card.append(line, button('Disconnect', () => bridge.close()));
    } else {
      line.textContent = { inviting: 'Invitation waiting for a reply', answering: 'Waiting for ' + who + ' to open your reply',
        connecting: 'Connecting to ' + who + '…' }[bridge.status] || bridge.status;
      card.append(line, button('Continue…', () => this.wizard.resume(bridge)), ' ', button('Cancel', () => bridge.close()));
    }
    return card;
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
  renderMap(state, hosts, bridges) {
    let up = state.uplink || { status: 'off' };
    let topology = JSON.stringify([state.gateway, up.status, up.session && up.session.ip, hosts.map(h => [h.name, h.ip]),
      bridges.map(b => [b.id, b.label, b.hosts.map(h => [h.name, h.ip, h.conflict])])]);
    if (topology != this.topology) {
      this.topology = topology;
      this.buildMap(state, hosts, bridges);
    }
    this.updateFlows(state, hosts, bridges);
  }

  buildMap(state, hosts, bridges) {
    let svg = this.querySelector('.lan-map');
    let ns = 'http://www.w3.org/2000/svg';
    let el = (tag, attrs, ...children) => {
      let e = document.createElementNS(ns, tag);
      for (let k in attrs) e.setAttribute(k, attrs[k]);
      for (let c of children) e.append(c);
      return e;
    };
    let maxName = bridges.length ? 20 : 24;
    let box = (x, y, name, ip, cls, tooltip, rx = 6) => {
      if (name.length > maxName) name = name.slice(0, maxName - 1) + '…'; // the full name is in the tooltip and table
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
    // Machines in rows of up to `perRow` across a column centred on `cx`, from `top`
    const ROW = 58;
    let place = (list, cx, width, top, perRow) => list.map((item, i) => {
      let row = Math.floor(i / perRow), inRow = Math.min(perRow, list.length - row * perRow);
      return { item, at: { x: cx - width / 2 + width * ((i % perRow) + 0.5) / inRow, y: top + row * ROW } };
    });
    let rowsOf = (n, perRow) => Math.ceil(n / perRow) || 1;

    // This browser's segment: the internet at the top, the gateway below it, and its
    // machines under that, so traffic fans out from the uplink to the machines using
    // it. With bridges, it takes the left half, and each bridged network is a segment
    // on the right, its machines hanging off the far end of the tunnel to it.
    let split = bridges.length > 0;
    let localCx = split ? 160 : 320, localW = split ? 320 : 640, perRow = split ? 2 : 4;
    let up = state.uplink || { status: 'off' };
    let gateway = { x: localCx, y: 150 }, cloudAt = { x: localCx, y: 66 };
    let cloud = el('g', { class: 'lan-cloud lan-uplink-' + up.status, role: 'button', tabindex: 0, transform: `translate(${localCx - 320},0)` },
      el('path', { d: 'M276,66 a20,20 0 0,1 2,-40 a28,28 0 0,1 50,-10 a24,24 0 0,1 40,14 a18,18 0 0,1 -4,36 z' }),
      el('text', { x: 320, y: 42, class: 'lan-name' }, 'Internet'),
      el('text', { x: 320, y: 56, class: 'lan-ip' }, up.session ? up.session.ip : STATUS_TEXT[up.status] || up.status),
      el('title', {}, 'Internet settings'));
    cloud.addEventListener('click', () => this.toggleUplinkForm());
    cloud.addEventListener('keydown', ev => { if (ev.key == 'Enter' || ev.key == ' ') { ev.preventDefault(); this.toggleUplinkForm(); } });

    let under = [], flows = [flow('uplink', cloudAt, gateway, 'lan-uplink-flow lan-uplink-' + up.status)], nodes = [];
    for (let { item: h, at } of place(hosts, localCx, localW, 260, perRow)) {
      flows.push(flow('host:' + h.name, gateway, at)); // `in`: toward the machine
      nodes.push(box(at.x, at.y, h.name, h.ip || '…', h.ip ? '' : 'lan-pending', (h.title ? h.title + '\n' : '') + (h.mac || '')));
    }
    let bottom = 260 + rowsOf(hosts.length, perRow) * ROW;

    let top = 110;
    for (let b of bridges) {
      let who = (b.label || 'Another browser') + "'s network";
      let remoteRows = rowsOf(b.hosts.length, 2);
      let height = 76 + remoteRows * ROW;
      let end = { x: 480, y: top + 40 }; // where the tunnel comes out: their switch
      under.push(el('g', { class: 'lan-segment' },
        el('rect', { x: 334, y: top, width: 296, height, rx: 10 }),
        el('text', { x: 620, y: top + 18, class: 'lan-segment-name' }, who),
        el('title', {}, who + ': its machines, bridged with this network. It has its own gateway and internet connection.')));
      // The tunnel: a pipe from this network's switch (at the gateway) to theirs,
      // carrying the bridge's traffic as its bands
      // labelled between the gateway's box and the segment
      let labelX = (gateway.x + 56 + 334) / 2, labelY = gateway.y + (end.y - gateway.y) * (labelX - gateway.x) / (end.x - gateway.x);
      under.push(el('g', { class: 'lan-tunnel' },
        el('line', { x1: gateway.x, y1: gateway.y, x2: end.x, y2: end.y, class: 'lan-tunnel-pipe' }),
        el('line', { x1: gateway.x, y1: gateway.y, x2: end.x, y2: end.y, class: 'lan-tunnel-bore' }),
        el('text', { x: labelX, y: labelY - 17, class: 'lan-tunnel-label' }, '⇄ tunnel'),
        el('title', {}, 'Bridge to ' + who)));
      flows.push(flow('bridge:' + b.id, gateway, end, 'lan-tunnel-flow'));
      nodes.push(el('circle', { cx: end.x, cy: end.y, r: 5, class: 'lan-tunnel-end' }));
      for (let { item: h, at } of place(b.hosts, 480, 296, top + 100, 2)) {
        under.push(el('line', { x1: end.x, y1: end.y, x2: at.x, y2: at.y, class: 'lan-link lan-remote-link' }));
        nodes.push(box(at.x, at.y, h.name, (h.ip || '…') + (h.conflict ? ' ⚠' : ''), 'lan-remote-node' + (h.conflict ? ' lan-conflict' : ''),
          (h.title ? h.title + '\n' : '') + (h.mac || '') + '\non ' + who + (h.conflict ? '\nSame address as a machine here' : '')));
      }
      if (!b.hosts.length) nodes.push(el('text', { x: 480, y: top + 104, class: 'lan-segment-empty' }, 'no machines yet'));
      top += height + 24;
      bottom = Math.max(bottom, top);
    }

    let gw = box(gateway.x, gateway.y, 'gateway', state.gateway, 'lan-gateway', 'Router: DHCP, DNS, NAT', 17);
    let height = bottom + 20;
    svg.setAttribute('viewBox', '0 0 640 ' + height);
    let legend = el('g', { class: 'lan-legend' },
      el('line', { x1: 8, y1: height - 8, x2: 24, y2: height - 8, class: 'lan-band lan-band-in', 'stroke-width': 4 }),
      el('text', { x: 28, y: height - 5 }, 'to a machine / from the internet'),
      el('line', { x1: 196, y1: height - 8, x2: 212, y2: height - 8, class: 'lan-band lan-band-out', 'stroke-width': 4 }),
      el('text', { x: 216, y: height - 5 }, 'from a machine / to the internet'));
    svg.replaceChildren(...under, ...flows, legend, cloud, ...nodes, gw); // links under the boxes
    this.flows = new Map(flows.map(f => [f.dataset.key, f]));
  }

  updateFlows(state, hosts, bridges) {
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
    // A bridge's rx is what came from the other side, i.e. toward the machines here
    for (let b of bridges) set('bridge:' + b.id, b.rate ? { in: b.rate.out, out: b.rate.in } : { in: 0, out: 0 });
  }
}

