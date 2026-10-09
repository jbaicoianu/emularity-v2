import { PPPOverWebSocket } from './ppp.js'
import { Nat } from './nat.js'

/* The LAN's internet uplink: a PPP-over-WebSocket session, with the router's
   outside-bound packets translated (NAT) onto the address it was given. Plugs into a
   Router as its `wan`. Reconnects (with backoff) while enabled.

   Its settings come in two layers: those the page provides (see provide(), usually
   from a settings file named in the page's markup), and those the user changed (see
   configure()), which win field by field. With neither, there's no server, and it's
   off. */

export const DEFAULT_UPLINK = {
  url: '',          // a PPP-over-WebSocket server, wss://...
  username: '',
  password: '',
  dns: '1.1.1.1',   // used when the PPP server doesn't provide DNS servers
  enabled: false,
};

// The known settings in `settings`, without any left undefined
const pick = settings => Object.fromEntries(Object.keys(DEFAULT_UPLINK)
  .filter(k => settings && settings[k] !== undefined).map(k => [k, settings[k]]));

const ip32 = s => s.split('.').reduce((a, b) => (a << 8 | +b) >>> 0, 0);

export class PppUplink {
  constructor(router, { onChange = () => {} } = {}) {
    this.router = router;
    router.wan = this;
    this.onChange = onChange;
    this.nat = new Nat();
    this.provided = {}; // from the page
    this.changed = {};  // by the user (saved)
    this.config = { ...DEFAULT_UPLINK };
    this.status = 'off';  // off | connecting | authenticating | configuring | online | waiting
    this.session = null;  // { ip, peerIp, dns, mtu, since } while online
    this.error = null;
    this.rx = this.tx = 0;
    this.retryDelay = 0;
  }

  get online() { return this.status == 'online'; }

  /* The user's changes to the settings (any of DEFAULT_UPLINK's keys) */
  configure(changes) {
    this.changed = { ...this.changed, ...pick(changes) };
    this.apply();
  }
  /* The page's settings (replacing any it gave before) */
  provide(settings) {
    this.provided = pick(settings);
    this.apply();
  }
  /* Settings back to what the page provides */
  reset() {
    this.changed = {};
    this.apply();
  }
  /* Take up the current settings, reconnecting as needed */
  apply() {
    let config = { ...DEFAULT_UPLINK, ...this.provided, ...this.changed };
    let same = JSON.stringify(config) == JSON.stringify(this.config);
    this.config = config;
    if (same && (this.ppp || this.status == 'waiting' || !config.enabled)) return;
    this.disconnect();
    this.error = config.enabled && !config.url ? 'no server set' : null;
    this.retryDelay = 0;
    if (config.enabled && config.url) this.connect();
    this.onChange();
  }

  connect() {
    clearTimeout(this.retryTimer);
    let { url, username, password } = this.config;
    let ppp = this.ppp = new PPPOverWebSocket(url, { username, password });
    ppp.addEventListener('state', ev => {
      if (this.ppp !== ppp || ev.detail.state == 'down' || ev.detail.state == 'up') return;
      this.status = ev.detail.state;
      this.onChange();
    });
    ppp.addEventListener('up', ev => {
      let { localIp, peerIp, dns, mtu } = ev.detail;
      this.session = { ip: localIp, peerIp, dns: dns.length ? dns : [this.config.dns], mtu, since: Date.now() };
      this.nat.setPublic(localIp, mtu);
      this.status = 'online';
      this.error = null;
      this.retryDelay = 0;
      this.router.log('internet uplink online as ' + localIp);
      this.onChange();
    });
    ppp.addEventListener('packet', ev => this.fromWan(ev.detail));
    ppp.addEventListener('down', ev => {
      if (this.ppp !== ppp) return;
      this.ppp = null;
      this.session = null;
      this.nat.setPublic(null);
      this.error = ev.detail.reason;
      this.router.log('internet uplink down: ' + ev.detail.reason);
      if (this.config.enabled) {
        // Try again, backing off: 2s, 4s, 8s ... up to a minute
        this.retryDelay = Math.min(60e3, (this.retryDelay || 1000) * 2);
        this.status = 'waiting';
        this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
      } else {
        this.status = 'off';
      }
      this.onChange();
    });
    ppp.connect();
  }
  disconnect() {
    clearTimeout(this.retryTimer);
    let ppp = this.ppp;
    this.ppp = null;
    this.session = null;
    this.status = 'off';
    if (ppp) ppp.close('disconnected');
  }

  /* From the router: a LAN packet headed outside */
  send(packet) {
    let out = this.online && this.nat.outbound(packet);
    if (!out) return;
    this.tx += out.length;
    this.ppp.sendIp(out);
  }
  /* From the router: a DNS query to the gateway for an outside name. It goes to the
     uplink's resolver, and the answer appears to come from the gateway. */
  forwardDns(packet) {
    let out = this.online && this.nat.outbound(packet, { ip: ip32(this.session.dns[0]), port: 53 });
    if (!out) return;
    this.tx += out.length;
    this.ppp.sendIp(out);
  }
  fromWan(packet) {
    this.rx += packet.length;
    let result = this.nat.inbound(packet);
    if (result) this.router.deliverFromWan(result.packet, result.lanIp);
  }

  /* For display (the password itself is never sent back) */
  state() {
    let { url, username, password, dns, enabled } = this.config;
    return {
      status: this.status, url, username, hasPassword: !!password, dns, enabled,
      customized: Object.keys(this.changed).length > 0,
      session: this.session, error: this.error, rx: this.rx, tx: this.tx, flows: this.nat.flowCount,
    };
  }
}
