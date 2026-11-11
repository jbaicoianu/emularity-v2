import { LanMonitor } from './lan.js'
import { LanGraph } from './lan-graph.js'
import { LanBridge } from './bridge.js'
import { ManualSignaling } from './signaling.js'

/* <emularity-lan-panel>: a live view of the virtual LAN. A map (the internet as a cloud
   above the gateway, machines below) and a table of machines with their names and
   addresses, updated as machines join, leave and get addresses. Clicking the cloud
   shows the internet uplink's settings. It watches the LAN while it's in the
   document. Its `uplink` attribute names the page's uplink settings file (see
   LanMonitor).

   It also bridges the LAN with other browsers' (see bridge.js): inviting another, or
   joining with an invitation, with the codes passed along by hand (as links or QR
   codes; see signaling.js). useCode() takes an invitation or reply, e.g. from a link
   the page was opened with. */

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
        <p class="field-hint">Bridge this network with someone else's, in another browser, so machines on either can reach each other. Each side keeps its own gateway and internet connection.</p>
        <div class="lan-bridge-list"></div>
        <p class="lan-bridge-message" hidden></p>
        <form class="lan-join-form" hidden>
          <label>Invitation (a link or code someone sent you) <textarea name="code" rows="3" spellcheck="false"></textarea></label>
          <div class="lan-bridge-buttons"><button type="submit">Join their network</button> <button type="button" class="lan-join-cancel">Cancel</button></div>
        </form>
        <div class="lan-bridge-buttons lan-bridge-start">
          <label class="lan-bridge-label">Your name, as others see it <input name="label" type="text" maxlength="40" placeholder="e.g. Alex"></label>
          <button type="button" class="lan-invite">Invite another network…</button>
          <button type="button" class="lan-join">Use an invitation…</button>
        </div>
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
    const LABEL_KEY = 'emularity-lan-label';
    let labelInput = this.querySelector('.lan-bridge-label input');
    try { labelInput.value = localStorage.getItem(LABEL_KEY) || ''; } catch (e) {}
    labelInput.addEventListener('change', () => { try { localStorage.setItem(LABEL_KEY, labelInput.value.trim()); } catch (e) {} });
    this.bridgeLabel = () => labelInput.value.trim();
    let joinForm = this.querySelector('.lan-join-form');
    this.querySelector('.lan-invite').addEventListener('click', async ev => {
      ev.target.disabled = true;
      this.bridgeMessage('Preparing an invitation…');
      try {
        await LanBridge.invite({ label: this.bridgeLabel(), uplink: this.getAttribute('uplink') });
        this.bridgeMessage('');
      } catch (e) {
        this.bridgeMessage("Couldn't make an invitation: " + e.message, true);
      }
      ev.target.disabled = false;
    });
    this.querySelector('.lan-join').addEventListener('click', () => {
      joinForm.hidden = false;
      joinForm.elements.code.focus();
    });
    this.querySelector('.lan-join-cancel').addEventListener('click', () => { joinForm.hidden = true; joinForm.reset(); });
    joinForm.addEventListener('submit', ev => {
      ev.preventDefault();
      this.useCode(joinForm.elements.code.value, true);
    });
    this.onBridgeChange = () => this.renderBridges();
    LanBridge.events.addEventListener('change', this.onBridgeChange);
    this.onBridgeError = ev => this.bridgeMessage(ev.detail.error, true);
    LanBridge.events.addEventListener('error', this.onBridgeError);
    this.renderBridges();
  }

  bridgeMessage(text, error = false) {
    let p = this.querySelector('.lan-bridge-message');
    p.textContent = text;
    p.hidden = !text;
    p.classList.toggle('lan-error', error);
  }

  /* An invitation or reply (a code, or a link with one). An invitation fills in the
     join form, to join when the user confirms (or straight away if `confirmed`); a
     reply goes to the invitation waiting for it, in whichever tab that is. */
  async useCode(text, confirmed = false) {
    let joinForm = this.querySelector('.lan-join-form');
    let message;
    try {
      message = await ManualSignaling.decode(text);
    } catch (e) {
      return this.bridgeMessage(e.message, true);
    }
    if (message.type == 'answer') {
      joinForm.hidden = true;
      joinForm.reset();
      let mine = [...LanBridge.all].find(b => b.id == message.id);
      try {
        if (mine) await mine.acceptAnswer(message);
        else if (await LanBridge.deliver(message)) this.bridgeMessage("Reply passed to the tab with the invitation: it's connecting there.");
        else this.bridgeMessage('No invitation in this browser is waiting for that reply. It has to be used in the tab that made the invitation, while that stays open.', true);
      } catch (e) {
        this.bridgeMessage(e.message, true);
      }
      return;
    }
    if (!confirmed) {
      joinForm.hidden = false;
      joinForm.elements.code.value = text;
      this.bridgeMessage((message.label || 'Someone') + ' invited you to bridge your network with theirs. Their machines will be able to reach yours, and yours theirs.');
      joinForm.querySelector('[type="submit"]').focus();
      return;
    }
    this.bridgeMessage('Preparing a reply…');
    try {
      await LanBridge.join(message, { label: this.bridgeLabel(), uplink: this.getAttribute('uplink') });
      joinForm.hidden = true;
      joinForm.reset();
      this.bridgeMessage('');
    } catch (e) {
      this.bridgeMessage(e.message, true);
    }
  }

  /* A card per bridge this page holds (rebuilt only when its status changes, so a
     reply being typed isn't lost), and a line for those other tabs hold */
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

  bridgeCard(bridge) {
    let card = document.createElement('div');
    card.className = 'lan-bridge lan-bridge-' + bridge.status;
    card.bridgeId = bridge.id;
    card.status = bridge.status;
    let who = bridge.remoteLabel || 'the other browser';
    let close = text => {
      let b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.addEventListener('click', () => bridge.close());
      return b;
    };
    let p = (text, cls) => {
      let e = document.createElement('p');
      e.textContent = text;
      if (cls) e.className = cls;
      return e;
    };
    if (bridge.status == 'inviting' || bridge.status == 'answering') {
      let inviting = bridge.status == 'inviting';
      let message = inviting ? bridge.offer : bridge.answer;
      card.append(p(inviting
        ? '1. Send this invitation to the person whose network you want to bridge with (it works once, while this tab stays open):'
        : '2. Send this reply back to ' + who + ', to open or paste into the tab with the invitation:'));
      let share = this.shareBox(message);
      card.append(share);
      if (inviting) {
        let form = document.createElement('form');
        form.className = 'lan-answer-form';
        form.innerHTML = `<label>3. Then paste their reply here (or open their reply link in this browser) <textarea name="code" rows="2" spellcheck="false"></textarea></label>
          <div class="lan-bridge-buttons"><button type="submit">Connect</button></div>`;
        form.addEventListener('submit', ev => { ev.preventDefault(); this.useCode(form.elements.code.value); });
        card.append(form);
      } else {
        card.append(p('Waiting for ' + who + ' to use it… Keep this tab open.', 'field-hint'));
      }
      card.append(close('Cancel'));
    } else if (bridge.status == 'connecting') {
      card.append(p('Connecting to ' + who + '…'), close('Cancel'));
    } else if (bridge.status == 'connected') {
      let line = p('⇄ Bridged with ' + who + "'s network");
      let stats = document.createElement('span');
      stats.className = 'lan-bridge-stats';
      line.append(' · ', stats);
      card.append(line, p('This tab carries the bridge: closing it disconnects.', 'field-hint'), close('Disconnect'));
    }
    return card;
  }

  /* A message as a link to copy, with a QR code for it */
  shareBox(message) {
    let box = document.createElement('div');
    box.className = 'lan-share';
    box.innerHTML = `<canvas class="lan-qr" hidden></canvas><div class="lan-share-text"><input type="text" readonly> <button type="button">Copy link</button></div>`;
    let input = box.querySelector('input'), button = box.querySelector('button');
    ManualSignaling.link(message).then(link => {
      input.value = link;
      drawQr(box.querySelector('canvas'), link);
    });
    input.addEventListener('focus', () => input.select());
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(input.value);
        button.textContent = 'Copied';
      } catch (e) {
        input.select();
        button.textContent = 'Press Ctrl+C';
      }
      setTimeout(() => { button.textContent = 'Copy link'; }, 2000);
    });
    return box;
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
      bridges.map(b => [b.id, b.label, b.hosts.length])]);
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
    // Bridged networks sit among the machines, as the switch ports they are
    let nodes0 = hosts.map(h => ({ key: 'host:' + h.name, name: h.name, ip: h.ip || '…', cls: h.ip ? '' : 'lan-pending',
      tooltip: (h.title ? h.title + '\n' : '') + (h.mac || '') }))
      .concat(bridges.map(b => ({ key: 'bridge:' + b.id, name: '⇄ ' + (b.label || 'other network'),
        ip: b.hosts.length + ' machine' + (b.hosts.length == 1 ? '' : 's'), cls: 'lan-bridge-node',
        tooltip: 'Bridged network: ' + (b.hosts.map(h => h.name).join(', ') || 'no machines yet') })));
    let perRow = 4, rows = Math.ceil(nodes0.length / perRow) || 1;
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
    nodes0.forEach((n, i) => {
      let row = Math.floor(i / perRow), inRow = Math.min(perRow, nodes0.length - row * perRow);
      let at = { x: 640 * ((i % perRow) + 0.5) / inRow, y: 260 + row * 58 };
      flows.push(flow(n.key, gateway, at)); // `in`: toward the machine
      nodes.push(box(at.x, at.y, n.name, n.ip, n.cls, n.tooltip));
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

/* A QR code for `text`, drawn on `canvas` (shown once drawn). The encoder is loaded
   when first needed; without it (offline, say) there's just the link. */
let qrLibrary = null;
async function drawQr(canvas, text) {
  try {
    qrLibrary ||= import('https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/+esm').then(m => m.default);
    let qrcode = await qrLibrary;
    let qr = qrcode(0, 'L');
    qr.addData(text);
    qr.make();
    let n = qr.getModuleCount(), margin = 4, scale = Math.max(2, Math.floor(240 / (n + margin * 2)));
    canvas.width = canvas.height = (n + margin * 2) * scale;
    let ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
    }
    canvas.hidden = false;
  } catch (e) {
    console.warn('Emularity LAN: no QR code', e);
  }
}
