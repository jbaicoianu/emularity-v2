/* Parsing and building the few packet types the virtual LAN deals with: Ethernet,
   ARP, IPv4, UDP, ICMP and DHCP. Packets are Uint8Arrays; parse functions return
   plain objects holding subarrays (views, not copies) of the original. */

export const ETHERTYPE_IPV4 = 0x0800;
export const ETHERTYPE_ARP = 0x0806;
export const PROTO_ICMP = 1;
export const PROTO_TCP = 6;
export const PROTO_UDP = 17;

export const BROADCAST_MAC = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

export function macToString(mac) {
  return Array.from(mac, b => b.toString(16).padStart(2, '0')).join(':');
}
export function ipToString(ip) {
  return Array.from(ip).join('.');
}
export function parseIp(str) {
  return new Uint8Array(str.split('.').map(Number));
}
export function sameBytes(a, b) {
  if (a.length != b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false;
  return true;
}

/* The Internet checksum (RFC 1071) over `data`, plus an optional starting sum */
export function checksum(data, sum = 0) {
  for (let i = 0; i + 1 < data.length; i += 2) sum += (data[i] << 8) | data[i + 1];
  if (data.length & 1) sum += data[data.length - 1] << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
}

/* ----- Ethernet ----- */

export function parseEthernet(frame) {
  if (frame.length < 14) return null;
  return {
    dest: frame.subarray(0, 6),
    src: frame.subarray(6, 12),
    ethertype: (frame[12] << 8) | frame[13],
    payload: frame.subarray(14),
  };
}
export function buildEthernet({ dest, src, ethertype, payload }) {
  let frame = new Uint8Array(14 + payload.length);
  frame.set(dest, 0);
  frame.set(src, 6);
  frame[12] = ethertype >> 8;
  frame[13] = ethertype & 0xff;
  frame.set(payload, 14);
  return frame;
}

/* ----- ARP (Ethernet/IPv4 only) ----- */

export const ARP_REQUEST = 1;
export const ARP_REPLY = 2;

export function parseArp(data) {
  if (data.length < 28) return null;
  let v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (v.getUint16(0) != 1 || v.getUint16(2) != ETHERTYPE_IPV4 || data[4] != 6 || data[5] != 4) return null;
  return {
    op: v.getUint16(6),
    senderMac: data.subarray(8, 14),
    senderIp: data.subarray(14, 18),
    targetMac: data.subarray(18, 24),
    targetIp: data.subarray(24, 28),
  };
}
export function buildArp({ op, senderMac, senderIp, targetMac, targetIp }) {
  let data = new Uint8Array(28), v = new DataView(data.buffer);
  v.setUint16(0, 1);              // hardware: Ethernet
  v.setUint16(2, ETHERTYPE_IPV4); // protocol: IPv4
  data[4] = 6; data[5] = 4;
  v.setUint16(6, op);
  data.set(senderMac, 8); data.set(senderIp, 14);
  data.set(targetMac, 18); data.set(targetIp, 24);
  return data;
}

/* ----- IPv4 ----- */

export function parseIpv4(data) {
  if (data.length < 20 || (data[0] >> 4) != 4) return null;
  let ihl = (data[0] & 0xf) * 4;
  let total = (data[2] << 8) | data[3];
  if (ihl < 20 || total < ihl || total > data.length) return null;
  return {
    ttl: data[8],
    proto: data[9],
    src: data.subarray(12, 16),
    dest: data.subarray(16, 20),
    fragmented: ((data[6] & 0x3f) | data[7]) != 0, // MF flag or a fragment offset
    payload: data.subarray(ihl, total),
  };
}
let ipv4Id = 0;
export function buildIpv4({ proto, src, dest, payload, ttl = 64 }) {
  let data = new Uint8Array(20 + payload.length), v = new DataView(data.buffer);
  data[0] = 0x45; // version 4, 20-byte header
  v.setUint16(2, data.length);
  v.setUint16(4, ipv4Id = (ipv4Id + 1) & 0xffff);
  data[6] = 0x40; // don't fragment
  data[8] = ttl;
  data[9] = proto;
  data.set(src, 12);
  data.set(dest, 16);
  v.setUint16(10, checksum(data.subarray(0, 20)));
  data.set(payload, 20);
  return data;
}

/* ----- UDP ----- */

export function parseUdp(data) {
  if (data.length < 8) return null;
  let len = (data[4] << 8) | data[5];
  if (len < 8 || len > data.length) return null;
  return { srcPort: (data[0] << 8) | data[1], destPort: (data[2] << 8) | data[3], payload: data.subarray(8, len) };
}
export function buildUdp({ srcPort, destPort, payload, srcIp, destIp }) {
  let data = new Uint8Array(8 + payload.length), v = new DataView(data.buffer);
  v.setUint16(0, srcPort);
  v.setUint16(2, destPort);
  v.setUint16(4, data.length);
  data.set(payload, 8);
  // Checksum over the IPv4 pseudo-header + datagram; 0 means "none", so send 0xffff
  let pseudo = new Uint8Array(12);
  pseudo.set(srcIp, 0); pseudo.set(destIp, 4);
  pseudo[9] = PROTO_UDP; pseudo[10] = data.length >> 8; pseudo[11] = data.length & 0xff;
  let sum = (~checksum(pseudo)) & 0xffff;
  v.setUint16(6, checksum(data, sum) || 0xffff);
  return data;
}

/* ----- ICMP ----- */

export const ICMP_ECHO_REPLY = 0;
export const ICMP_ECHO_REQUEST = 8;

export function parseIcmp(data) {
  if (data.length < 8) return null;
  return { type: data[0], code: data[1], rest: data.subarray(4) };
}
export function buildIcmp({ type, code = 0, rest }) {
  let data = new Uint8Array(4 + rest.length);
  data[0] = type; data[1] = code;
  data.set(rest, 4);
  let sum = checksum(data);
  data[2] = sum >> 8; data[3] = sum & 0xff;
  return data;
}

/* ----- DHCP ----- */

export const DHCP_SERVER_PORT = 67;
export const DHCP_CLIENT_PORT = 68;
export const DHCP = { DISCOVER: 1, OFFER: 2, REQUEST: 3, DECLINE: 4, ACK: 5, NAK: 6, RELEASE: 7, INFORM: 8 };
export const DHCP_OPT = {
  SUBNET_MASK: 1, ROUTER: 3, DNS: 6, HOSTNAME: 12, DOMAIN: 15, BROADCAST: 28,
  REQUESTED_IP: 50, LEASE_TIME: 51, MESSAGE_TYPE: 53, SERVER_ID: 54, RENEWAL_TIME: 58, REBINDING_TIME: 59,
};
const DHCP_MAGIC = 0x63825363;

export function parseDhcp(data) {
  if (data.length < 240) return null;
  let v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (v.getUint32(236) != DHCP_MAGIC) return null;
  let options = new Map();
  for (let i = 240; i < data.length;) {
    let code = data[i++];
    if (code == 0) continue;   // pad
    if (code == 255) break;    // end
    let len = data[i++];
    options.set(code, data.subarray(i, i + len));
    i += len;
  }
  return {
    op: data[0],
    xid: v.getUint32(4),
    flags: v.getUint16(10),
    ciaddr: data.subarray(12, 16),
    chaddr: data.subarray(28, 34),
    type: options.get(DHCP_OPT.MESSAGE_TYPE)?.[0],
    options,
  };
}
/* A DHCP reply. `options` maps option codes to byte arrays. */
export function buildDhcpReply({ xid, flags, chaddr, yiaddr, siaddr, options }) {
  let opts = [];
  for (let [code, value] of options) opts.push(code, value.length, ...value);
  opts.push(255);
  let data = new Uint8Array(240 + opts.length), v = new DataView(data.buffer);
  data[0] = 2; // BOOTREPLY
  data[1] = 1; data[2] = 6; // Ethernet, 6-byte addresses
  v.setUint32(4, xid);
  v.setUint16(10, flags);
  if (yiaddr) data.set(yiaddr, 16);
  if (siaddr) data.set(siaddr, 20);
  data.set(chaddr, 28);
  v.setUint32(236, DHCP_MAGIC);
  data.set(opts, 240);
  return data;
}

/* ----- DNS ----- */

export const DNS_PORT = 53;
export const DNS_TYPE = { A: 1, PTR: 12, AAAA: 28 };
export const DNS_RCODE = { OK: 0, SERVFAIL: 2, NXDOMAIN: 3 };

/* A DNS query: { id, flags, questions: [{ name, type }], questionBytes } */
export function parseDnsQuery(data) {
  if (data.length < 12) return null;
  let v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let flags = v.getUint16(2);
  if (flags & 0x8000) return null; // a response, not a query
  let questions = [], p = 12;
  for (let n = v.getUint16(4); n > 0; n--) {
    let labels = [];
    while (p < data.length && data[p] != 0) {
      if (data[p] & 0xc0) return null; // compression pointers don't occur in questions
      let len = data[p++];
      labels.push(String.fromCharCode(...data.subarray(p, p + len)));
      p += len;
    }
    p++; // the root label
    if (p + 4 > data.length) return null;
    questions.push({ name: labels.join('.'), type: v.getUint16(p) });
    p += 4; // type + class
  }
  return { id: v.getUint16(0), flags, questions, questionBytes: data.subarray(12, p) };
}
export function encodeDnsName(name) {
  let bytes = [];
  for (let label of name.split('.').filter(Boolean)) bytes.push(label.length, ...Array.from(label, c => c.charCodeAt(0)));
  bytes.push(0);
  return bytes;
}
/* The answer to `query` (one question): `answers` are [{ type, data }] records for the
   name asked, `rcode` a DNS_RCODE. We're authoritative for everything we answer. */
export function buildDnsResponse(query, answers, rcode = DNS_RCODE.OK, ttl = 60) {
  let body = [];
  for (let { type, data } of answers) {
    body.push(0xc0, 12); // the name: a pointer to the question's
    body.push(type >> 8, type & 0xff, 0, 1); // class IN
    body.push(ttl >>> 24, (ttl >> 16) & 0xff, (ttl >> 8) & 0xff, ttl & 0xff);
    body.push(data.length >> 8, data.length & 0xff, ...data);
  }
  let out = new Uint8Array(12 + query.questionBytes.length + body.length), v = new DataView(out.buffer);
  v.setUint16(0, query.id);
  v.setUint16(2, 0x8000 | 0x0400 | (query.flags & 0x0100) | rcode); // response, authoritative, echo RD
  v.setUint16(4, query.questions.length);
  v.setUint16(6, answers.length);
  out.set(query.questionBytes, 12);
  out.set(body, 12 + query.questionBytes.length);
  return out;
}
