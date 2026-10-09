/* A PPP client (RFC 1661) in plain JavaScript: link setup (LCP), authentication
   (CHAP-MD5 or PAP) and IPv4 setup (IPCP), then IPv4 packets in both directions. No
   dependencies; it runs in pages, workers and Node.

   PPPClient knows nothing about the transport: hand it whatever arrives with
   receive(bytes), and it calls `send(bytes)` with what to transmit. Frames use async
   HDLC-like framing (RFC 1662: 0x7e flags, 0x7d escapes, 16-bit FCS) by default, as
   pppd speaks over a serial line or a byte stream; framing: 'raw' sends and expects
   bare PPP frames (protocol + payload), one per message. PPPOverWebSocket wires it to
   a WebSocket.

   Events (it's an EventTarget):
     state   detail: { state }  'connecting' | 'authenticating' | 'configuring' | 'up' | 'down'
     up      detail: { localIp, peerIp, dns: [...], mtu }  (addresses as dotted strings)
     packet  detail: Uint8Array IPv4 packet from the peer
     down    detail: { reason }
     log     detail: string

     let ppp = new PPPOverWebSocket('wss://example.com/', { username, password });
     ppp.addEventListener('up', ev => console.log('online as', ev.detail.localIp));
     ppp.addEventListener('packet', ev => handle(ev.detail));
     ppp.connect();
     ppp.sendIp(packet); */

const PROTO = { IPV4: 0x0021, IPCP: 0x8021, LCP: 0xc021, PAP: 0xc023, CHAP: 0xc223 };
const CODE = {
  CONFIGURE_REQUEST: 1, CONFIGURE_ACK: 2, CONFIGURE_NAK: 3, CONFIGURE_REJECT: 4,
  TERMINATE_REQUEST: 5, TERMINATE_ACK: 6, CODE_REJECT: 7, PROTOCOL_REJECT: 8,
  ECHO_REQUEST: 9, ECHO_REPLY: 10, DISCARD_REQUEST: 11,
};
const LCP_OPT = { MRU: 1, ACCM: 2, AUTH: 3, MAGIC: 5, PFC: 7, ACFC: 8 };
const IPCP_OPT = { COMPRESSION: 2, ADDRESS: 3, DNS1: 129, DNS2: 131 };
const CHAP_MD5 = 5;

const RESTART_MS = 3000;  // RFC 1661's Restart timer
const MAX_CONFIGURE = 10; // ...and Max-Configure

/* ----- Async HDLC-like framing (RFC 1662) ----- */

const FCS_TABLE = (() => {
  let t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i;
    for (let b = 0; b < 8; b++) v = v & 1 ? (v >>> 1) ^ 0x8408 : v >>> 1;
    t[i] = v;
  }
  return t;
})();
function fcs16(bytes) {
  let fcs = 0xffff;
  for (let b of bytes) fcs = (fcs >>> 8) ^ FCS_TABLE[(fcs ^ b) & 0xff];
  return fcs;
}

// The most bytes between flags in a frame we accept: our MRU (the default 1500; we
// don't ask for another) plus address, control, protocol and FCS, every byte escaped
const MAX_FRAME = 2 * (1500 + 6);

export class HdlcFraming {
  buffer = [];
  /* Encode a PPP frame (address/control + protocol + payload). `accm` is the
     peer's async control character map: control characters (< 0x20) whose bit is set
     get escaped, as do the flag and escape bytes themselves. */
  static encode(frame, accm = 0xffffffff) {
    let fcs = fcs16(frame) ^ 0xffff;
    let body = new Uint8Array(frame.length + 2);
    body.set(frame);
    body[frame.length] = fcs & 0xff;
    body[frame.length + 1] = fcs >>> 8;
    let out = [0x7e];
    for (let b of body) {
      if (b == 0x7e || b == 0x7d || (b < 0x20 && (accm >>> b) & 1)) out.push(0x7d, b ^ 0x20);
      else out.push(b);
    }
    out.push(0x7e);
    return new Uint8Array(out);
  }
  /* Feed received bytes; returns the complete, checksummed frames found (without
     their FCS). Frames may span calls. */
  decode(bytes) {
    let frames = [];
    for (let b of bytes) {
      if (b == 0x7e) {
        if (this.buffer.length >= 4) {
          let frame = this.unescape(this.buffer);
          if (frame && fcs16(frame) == 0xf0b8) frames.push(frame.subarray(0, frame.length - 2)); // good FCS residue
        }
        this.buffer = [];
      } else if (this.buffer.length < MAX_FRAME) {
        this.buffer.push(b);
      } else {
        this.buffer = []; // no frame is this long: junk (what follows fails its FCS)
      }
    }
    return frames;
  }
  unescape(bytes) {
    let out = new Uint8Array(bytes.length), n = 0;
    for (let i = 0; i < bytes.length; i++) out[n++] = bytes[i] == 0x7d ? bytes[++i] ^ 0x20 : bytes[i];
    return out.subarray(0, n);
  }
}

/* ----- MD5 (RFC 1321), for CHAP: neither WebCrypto nor Node's subtle crypto has it ----- */

const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
export function md5(bytes) {
  let len = bytes.length, padded = new Uint8Array(((len + 8) >>> 6) * 64 + 64);
  padded.set(bytes);
  padded[len] = 0x80;
  let v = new DataView(padded.buffer);
  v.setUint32(padded.length - 8, (len * 8) >>> 0, true);
  v.setUint32(padded.length - 4, Math.floor(len / 0x20000000), true);
  let h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let off = 0; off < padded.length; off += 64) {
    let [a, b, c, d] = h;
    for (let i = 0; i < 64; i++) {
      let f, g, r = i >> 4;
      if (r == 0) { f = (b & c) | (~b & d); g = i; }
      else if (r == 1) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (r == 2) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      let s = MD5_S[(r << 2) | (i & 3)];
      let t = (a + f + MD5_K[i] + v.getUint32(off + g * 4, true)) >>> 0;
      [a, d, c] = [d, c, b];
      b = (b + ((t << s) | (t >>> (32 - s)))) >>> 0;
    }
    h = [(h[0] + a) >>> 0, (h[1] + b) >>> 0, (h[2] + c) >>> 0, (h[3] + d) >>> 0];
  }
  let out = new Uint8Array(16), ov = new DataView(out.buffer);
  h.forEach((x, i) => ov.setUint32(i * 4, x, true));
  return out;
}

/* ----- Configuration option lists (LCP / IPCP) ----- */

function parseOptions(data) {
  let opts = [];
  for (let i = 0; i + 2 <= data.length;) {
    let type = data[i], len = data[i + 1];
    if (len < 2 || i + len > data.length) return null;
    opts.push({ type, value: data.subarray(i + 2, i + len) });
    i += len;
  }
  return opts;
}
function encodeOptions(opts) {
  let out = [];
  for (let { type, value } of opts) out.push(type, value.length + 2, ...value);
  return out;
}
const u32 = n => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const readU32 = (v, i = 0) => ((v[i] << 24) | (v[i + 1] << 16) | (v[i + 2] << 8) | v[i + 3]) >>> 0;
const ipString = v => Array.from(v).join('.');
const utf8 = s => new TextEncoder().encode(s);

/* ----- The client ----- */

export class PPPClient extends EventTarget {
  constructor({ username = '', password = '', framing = 'hdlc', send = () => {} } = {}) {
    super();
    this.username = username;
    this.password = password;
    this.framing = framing;
    this.transmit = send;
    this.hdlc = new HdlcFraming();
    this.state = 'down';
    this.reset();
  }

  /* ----- Public API ----- */

  start() {
    this.reset();
    this.setState('connecting');
    this.lcp.sendRequest();
  }
  stop(reason = 'closed') {
    if (this.state == 'down') return;
    if (this.lcp.opened) this.sendControl(PROTO.LCP, CODE.TERMINATE_REQUEST, this.nextId(), []);
    this.down(reason);
  }
  /* Raw bytes from the transport */
  receive(bytes) {
    if (this.framing == 'raw') return this.handleFrame(bytes);
    for (let frame of this.hdlc.decode(bytes)) this.handleFrame(frame);
  }
  /* An IPv4 packet for the peer (only once 'up') */
  sendIp(packet) {
    if (this.state == 'up') this.sendFrame(PROTO.IPV4, packet);
  }

  /* ----- Internals ----- */

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  log(message) { this.emit('log', message); }
  setState(state) {
    if (state == this.state) return;
    this.state = state;
    this.emit('state', { state });
  }
  down(reason) {
    this.clearTimers();
    if (this.state == 'down') return;
    this.setState('down');
    this.emit('down', { reason });
  }
  clearTimers() {
    for (let layer of [this.lcp, this.ipcp]) if (layer) clearTimeout(layer.timer);
    clearTimeout(this.papTimer);
  }
  reset() {
    this.clearTimers();
    this.id = Math.floor(Math.random() * 256);
    this.magic = (Math.random() * 0xffffffff) >>> 0;
    this.txAccm = 0xffffffff; // escape every control character until the peer says otherwise
    this.peerMru = 1500;
    this.auth = null;         // the authentication protocol the peer asked for
    this.lcp = new Negotiation(this, PROTO.LCP, {
      request: () => [{ type: LCP_OPT.MAGIC, value: u32(this.magic) }, { type: LCP_OPT.ACCM, value: u32(0) }],
      check: opt => this.checkLcpOption(opt),
      opened: () => this.lcpOpened(),
    });
    this.ipcp = new Negotiation(this, PROTO.IPCP, {
      request: () => [
        { type: IPCP_OPT.ADDRESS, value: this.localIp || [0, 0, 0, 0] },
        { type: IPCP_OPT.DNS1, value: this.dns[0] || [0, 0, 0, 0] },
        { type: IPCP_OPT.DNS2, value: this.dns[1] || [0, 0, 0, 0] },
      ],
      check: opt => opt.type == IPCP_OPT.ADDRESS && opt.value.length == 4 ? (this.peerIp = opt.value.slice(), null) : 'reject',
      nak: opt => {
        if (opt.type == IPCP_OPT.ADDRESS) this.localIp = opt.value.slice();
        else if (opt.type == IPCP_OPT.DNS1) this.dns[0] = opt.value.slice();
        else if (opt.type == IPCP_OPT.DNS2) this.dns[1] = opt.value.slice();
      },
      opened: () => this.ipcpOpened(),
    });
    this.localIp = null;
    this.peerIp = null;
    this.dns = [];
  }
  nextId() { return this.id = (this.id + 1) & 0xff; }

  sendFrame(protocol, payload) {
    let frame = new Uint8Array(4 + payload.length);
    frame[0] = 0xff; frame[1] = 0x03; // address + control: always sent in full
    frame[2] = protocol >> 8; frame[3] = protocol & 0xff;
    frame.set(payload, 4);
    this.transmit(this.framing == 'raw' ? frame.subarray(2) : HdlcFraming.encode(frame, this.txAccm));
  }
  sendControl(protocol, code, id, data) {
    let len = 4 + data.length;
    this.sendFrame(protocol, new Uint8Array([code, id, len >> 8, len & 0xff, ...data]));
  }

  handleFrame(frame) {
    let i = 0;
    if (frame[0] == 0xff && frame[1] == 0x03) i = 2; // address/control may be compressed away
    let protocol = frame[i] & 1 ? frame[i++] : (frame[i++] << 8) | frame[i++]; // protocol may be 1 byte
    let payload = frame.subarray(i);
    if (protocol == PROTO.IPV4) { if (this.state == 'up') this.emit('packet', payload); return; }
    if (protocol == PROTO.LCP) return this.handleLcp(payload);
    if (protocol == PROTO.CHAP) return this.handleChap(payload);
    if (protocol == PROTO.PAP) return this.handlePap(payload);
    if (protocol == PROTO.IPCP) return this.ipcp.handle(payload);
    // Anything else (IPv6CP, CCP, ...): tell the peer we don't speak it
    if (this.lcp.opened) this.sendControl(PROTO.LCP, CODE.PROTOCOL_REJECT, this.nextId(), [protocol >> 8, protocol & 0xff, ...payload]);
  }

  /* ----- LCP ----- */

  handleLcp(packet) {
    let [code, id] = packet;
    if (code <= CODE.CONFIGURE_REJECT) return this.lcp.handle(packet);
    if (code == CODE.ECHO_REQUEST && this.lcp.opened) {
      this.sendControl(PROTO.LCP, CODE.ECHO_REPLY, id, [...u32(this.magic), ...packet.subarray(8)]);
    } else if (code == CODE.TERMINATE_REQUEST) {
      this.sendControl(PROTO.LCP, CODE.TERMINATE_ACK, id, []);
      this.down('the server ended the session');
    } else if (code == CODE.PROTOCOL_REJECT || code == CODE.CODE_REJECT) {
      this.log('peer rejected protocol/code ' + Array.from(packet.subarray(4, 6), b => b.toString(16)).join(''));
    }
  }
  /* The peer's LCP option: null to accept, 'reject', or a value to suggest (nak) */
  checkLcpOption({ type, value }) {
    switch (type) {
      case LCP_OPT.MRU: this.peerMru = (value[0] << 8) | value[1]; return null;
      case LCP_OPT.ACCM: this.pendingAccm = readU32(value); return null;
      case LCP_OPT.MAGIC: return null;
      case LCP_OPT.PFC: case LCP_OPT.ACFC: return null; // fine: we accept compressed frames
      case LCP_OPT.AUTH: {
        let proto = (value[0] << 8) | value[1];
        if (proto == PROTO.CHAP && value[2] == CHAP_MD5) { this.auth = PROTO.CHAP; return null; }
        if (proto == PROTO.PAP) { this.auth = PROTO.PAP; return null; }
        return [PROTO.CHAP >> 8, PROTO.CHAP & 0xff, CHAP_MD5]; // e.g. EAP: suggest CHAP-MD5 instead
      }
      default: return 'reject';
    }
  }
  lcpOpened() {
    if (this.pendingAccm != null) this.txAccm = this.pendingAccm;
    if (this.auth == PROTO.CHAP) { this.setState('authenticating'); return; } // wait for the challenge
    if (this.auth == PROTO.PAP) { this.setState('authenticating'); return this.sendPap(0); }
    this.startNetwork();
  }

  /* ----- Authentication ----- */

  handleChap(packet) {
    let [code, id] = packet;
    if (code == 1) { // Challenge: MD5(id + secret + challenge)
      let size = packet[4], challenge = packet.subarray(5, 5 + size);
      let secret = utf8(this.password), name = utf8(this.username);
      let hash = md5(new Uint8Array([id, ...secret, ...challenge]));
      this.sendControl(PROTO.CHAP, 2, id, [16, ...hash, ...name]);
    } else if (code == 3) { // Success
      this.startNetwork();
    } else if (code == 4) { // Failure
      this.stop('authentication failed');
    }
  }
  sendPap(attempt) {
    if (attempt >= MAX_CONFIGURE) return this.stop('no response to authentication');
    let name = utf8(this.username), pass = utf8(this.password);
    this.sendControl(PROTO.PAP, 1, this.nextId(), [name.length, ...name, pass.length, ...pass]);
    this.papTimer = setTimeout(() => this.sendPap(attempt + 1), RESTART_MS);
  }
  handlePap(packet) {
    clearTimeout(this.papTimer);
    if (packet[0] == 2) this.startNetwork();
    else if (packet[0] == 3) this.stop('authentication failed');
  }

  /* ----- IPCP ----- */

  startNetwork() {
    if (this.state == 'configuring' || this.state == 'up') return;
    this.setState('configuring');
    this.ipcp.sendRequest();
  }
  ipcpOpened() {
    this.setState('up');
    this.emit('up', {
      localIp: ipString(this.localIp || [0, 0, 0, 0]),
      peerIp: this.peerIp ? ipString(this.peerIp) : null,
      dns: this.dns.filter(d => d && readU32(d)).map(ipString),
      mtu: this.peerMru,
    });
  }
}

/* One Configure-Request/Ack/Nak/Reject exchange (LCP or IPCP): our request is resent
   until acked, adjusted by the peer's naks and rejects; the peer's requests are
   checked option by option. Opened once both sides have acked. */
class Negotiation {
  constructor(ppp, protocol, { request, check, nak = () => {}, opened }) {
    Object.assign(this, { ppp, protocol, buildRequest: request, check, applyNak: nak, onOpened: opened });
    this.rejected = new Set(); // option types the peer rejected
    this.ackedByPeer = false;
    this.ackedPeer = false;
    this.opened = false;
    this.tries = 0;
  }
  sendRequest() {
    clearTimeout(this.timer);
    if (this.tries++ >= MAX_CONFIGURE) return this.ppp.stop('no response from the server');
    this.requestId = this.ppp.nextId();
    let opts = this.buildRequest().filter(o => !this.rejected.has(o.type));
    this.ppp.sendControl(this.protocol, CODE.CONFIGURE_REQUEST, this.requestId, encodeOptions(opts));
    this.timer = setTimeout(() => this.sendRequest(), RESTART_MS);
  }
  handle(packet) {
    let [code, id] = packet, len = (packet[2] << 8) | packet[3];
    let opts = parseOptions(packet.subarray(4, len));
    if (!opts) return;
    if (code == CODE.CONFIGURE_REQUEST) {
      let rejects = [], naks = [];
      for (let opt of opts) {
        let verdict = this.check(opt);
        if (verdict == 'reject') rejects.push(opt);
        else if (verdict) naks.push({ type: opt.type, value: verdict });
      }
      if (rejects.length) this.ppp.sendControl(this.protocol, CODE.CONFIGURE_REJECT, id, encodeOptions(rejects));
      else if (naks.length) this.ppp.sendControl(this.protocol, CODE.CONFIGURE_NAK, id, encodeOptions(naks));
      else {
        this.ppp.sendControl(this.protocol, CODE.CONFIGURE_ACK, id, encodeOptions(opts));
        this.ackedPeer = true;
      }
    } else if (id == this.requestId) {
      if (code == CODE.CONFIGURE_ACK) { clearTimeout(this.timer); this.ackedByPeer = true; }
      else if (code == CODE.CONFIGURE_NAK) { opts.forEach(o => this.applyNak(o)); this.sendRequest(); }
      else if (code == CODE.CONFIGURE_REJECT) { opts.forEach(o => this.rejected.add(o.type)); this.sendRequest(); }
    }
    if (this.ackedPeer && this.ackedByPeer && !this.opened) {
      this.opened = true;
      this.onOpened();
    }
  }
}

/* A PPPClient over a WebSocket: one HDLC-framed (or raw) PPP frame per message, which
   is how PPP-over-WebSocket servers (e.g. pppd behind a websocket bridge) talk. */
export class PPPOverWebSocket extends PPPClient {
  constructor(url, { protocols, ...options } = {}) {
    super(options);
    this.url = url;
    this.protocols = protocols;
  }
  connect() {
    this.close();
    this.setState('connecting');
    let ws = this.ws = new WebSocket(this.url, this.protocols);
    ws.binaryType = 'arraybuffer';
    this.transmit = bytes => { if (ws.readyState == 1) ws.send(bytes); };
    ws.onopen = () => this.start();
    ws.onmessage = ev => { if (ev.data instanceof ArrayBuffer) this.receive(new Uint8Array(ev.data)); };
    ws.onerror = () => this.log('websocket error');
    ws.onclose = ev => { if (this.ws === ws) { this.ws = null; this.down('connection closed' + (ev.code != 1000 ? ' (' + ev.code + ')' : '')); } };
  }
  close(reason = 'closed') {
    let ws = this.ws;
    this.ws = null;
    this.stop(reason);
    if (ws) ws.close();
  }
  /* However the session ends (including by giving up on the server), the socket goes
     with it */
  down(reason) {
    super.down(reason);
    let ws = this.ws;
    this.ws = null;
    if (ws) ws.close();
  }
}
