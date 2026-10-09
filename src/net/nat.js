import { PROTO_ICMP, PROTO_TCP, PROTO_UDP, checksum, ipToString } from './packets.js'

/* Network address and port translation between a private LAN and one public address
   (e.g. the address a PPP link was given), working on raw IPv4 packets.

   Outgoing TCP/UDP flows get a public port of their own (ICMP echoes an echo id), and
   replies are matched back to the LAN host by it. A flow can also be redirected: sent
   to a different destination than the LAN host asked for, with replies appearing to
   come from the original one (used to send DNS lookups made to the gateway on to a
   real resolver). ICMP errors about a flow (unreachable, time exceeded) are translated
   too, and TCP SYNs have their MSS clamped so segments fit the uplink's MTU. Packets
   are modified in place; checksums are recomputed. */

const ICMP_ECHO_REQUEST = 8, ICMP_ECHO_REPLY = 0;
const ICMP_ERRORS = new Set([3, 4, 5, 11, 12]); // unreachable, source quench, redirect, time exceeded, parameter problem
const TIMEOUT = { [PROTO_TCP]: 2 * 3600e3, [PROTO_UDP]: 120e3, [PROTO_ICMP]: 30e3 };
const TCP_CLOSED_TIMEOUT = 60e3; // after FIN/RST

const ihl = p => (p[0] & 0xf) * 4;
const ip32 = (p, o) => ((p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3]) >>> 0;
const put32 = (p, o, v) => { p[o] = v >>> 24; p[o + 1] = (v >> 16) & 0xff; p[o + 2] = (v >> 8) & 0xff; p[o + 3] = v & 0xff; };
const get16 = (p, o) => (p[o] << 8) | p[o + 1];
const put16 = (p, o, v) => { p[o] = v >> 8; p[o + 1] = v & 0xff; };

/* The flow's "port" fields: source/destination ports, or for ICMP echo the id */
function ports(packet) {
  let l4 = ihl(packet), proto = packet[9];
  if (proto == PROTO_TCP || proto == PROTO_UDP) return { src: get16(packet, l4), dst: get16(packet, l4 + 2) };
  if (proto == PROTO_ICMP && (packet[l4] == ICMP_ECHO_REQUEST || packet[l4] == ICMP_ECHO_REPLY)) {
    let id = get16(packet, l4 + 4);
    return { src: id, dst: id };
  }
  return null;
}
function setPorts(packet, src, dst) {
  let l4 = ihl(packet);
  if (packet[9] == PROTO_ICMP) put16(packet, l4 + 4, packet[l4] == ICMP_ECHO_REPLY ? dst : src);
  else { put16(packet, l4, src); put16(packet, l4 + 2, dst); }
}

/* Recompute the IP header checksum and the TCP/UDP/ICMP one */
export function fixChecksums(packet) {
  let h = ihl(packet), total = get16(packet, 2);
  put16(packet, 10, 0);
  put16(packet, 10, checksum(packet.subarray(0, h)));
  let l4 = packet.subarray(h, total), proto = packet[9];
  if (proto == PROTO_ICMP) {
    put16(l4, 2, 0);
    put16(l4, 2, checksum(l4));
  } else if (proto == PROTO_TCP || proto == PROTO_UDP) {
    let at = proto == PROTO_TCP ? 16 : 6;
    if (proto == PROTO_UDP && get16(l4, 6) == 0) return; // UDP checksum not in use
    put16(l4, at, 0);
    let pseudo = new Uint8Array(12);
    pseudo.set(packet.subarray(12, 20), 0);
    pseudo[9] = proto;
    put16(pseudo, 10, l4.length);
    let sum = checksum(l4, (~checksum(pseudo)) & 0xffff);
    put16(l4, at, proto == PROTO_UDP ? (sum || 0xffff) : sum);
  }
}

export class Nat {
  constructor() {
    this.publicIp = 0;
    this.mtu = 1500;
    this.out = new Map();  // proto|lanIp|lanPort|origDst|origDstPort -> flow
    this.in = new Map();   // proto|publicPort -> flow
    this.nextPort = 20000 + Math.floor(Math.random() * 20000);
  }
  /* The public side: our address (dotted string) and the uplink's MTU */
  setPublic(ip, mtu = 1500) {
    this.publicIp = ip ? ip.split('.').reduce((a, b) => (a << 8 | +b) >>> 0, 0) : 0;
    this.mtu = mtu;
    this.out.clear();
    this.in.clear();
  }

  allocPort(proto) {
    for (let i = 0; i < 64512; i++) {
      let port = this.nextPort;
      this.nextPort = this.nextPort >= 65535 ? 1024 : this.nextPort + 1;
      if (!this.in.has(proto + '|' + port)) return port;
    }
    return null;
  }
  expire(now) {
    if (now - (this.lastSweep || 0) < 10e3) return;
    this.lastSweep = now;
    for (let [key, flow] of this.in) {
      if (flow.expires < now) { this.in.delete(key); this.out.delete(flow.outKey); }
    }
  }

  /* A packet from the LAN, headed out. Translated in place and returned, or null if
     it can't be (unsupported protocol, no ports left). `redirect` sends it to another
     { ip, port } instead (replies still appear to come from where it was sent). */
  outbound(packet, redirect = null) {
    let proto = packet[9], p = ports(packet), now = Date.now();
    if (!p || !this.publicIp) return null;
    this.expire(now);
    let lanIp = ip32(packet, 12), origDst = ip32(packet, 16);
    let outKey = proto + '|' + lanIp + '|' + p.src + '|' + origDst + '|' + p.dst;
    let flow = this.out.get(outKey);
    if (!flow) {
      let publicPort = this.allocPort(proto);
      if (publicPort == null) return null;
      flow = {
        outKey, proto, lanIp, lanPort: p.src, origDst, origDstPort: p.dst, publicPort,
        remoteIp: redirect ? redirect.ip : origDst,
        remotePort: redirect ? redirect.port : p.dst,
      };
      this.out.set(outKey, flow);
      this.in.set(proto + '|' + publicPort, flow);
    }
    if (proto == PROTO_TCP) {
      let flags = packet[ihl(packet) + 13];
      if ((flags & 0x12) == 0x02) flow.closing = false; // a new connection's SYN
      if (flags & 0x05) flow.closing = true;            // FIN or RST
      if (flags & 0x02) this.clampMss(packet);          // SYN
    }
    // A closing connection's last ACKs don't bring it back to life
    flow.expires = now + (flow.closing ? TCP_CLOSED_TIMEOUT : TIMEOUT[proto]);
    put32(packet, 12, this.publicIp);
    put32(packet, 16, flow.remoteIp);
    setPorts(packet, flow.publicPort, flow.remotePort);
    fixChecksums(packet);
    return packet;
  }

  /* A packet from outside. Translated in place and returned with the LAN host to
     deliver it to ({ packet, lanIp }), or null if it belongs to no flow. */
  inbound(packet) {
    let proto = packet[9], l4 = ihl(packet);
    if (proto == PROTO_ICMP && ICMP_ERRORS.has(packet[l4])) return this.inboundError(packet);
    let p = ports(packet);
    if (!p) return null;
    let flow = this.in.get(proto + '|' + p.dst);
    if (!flow || ip32(packet, 12) != flow.remoteIp) return null;
    if (proto == PROTO_TCP && packet[l4 + 13] & 0x05) {
      flow.closing = true;
      flow.expires = Date.now() + TCP_CLOSED_TIMEOUT;
    }
    put32(packet, 12, flow.origDst);
    put32(packet, 16, flow.lanIp);
    setPorts(packet, flow.origDstPort, flow.lanPort);
    fixChecksums(packet);
    return { packet, lanIp: flow.lanIp };
  }
  /* An ICMP error quotes the start of the packet that caused it, which we sent out
     translated: map the quoted packet back too */
  inboundError(packet) {
    let l4 = ihl(packet), quoted = packet.subarray(l4 + 8);
    if (quoted.length < 28 || (quoted[0] >> 4) != 4) return null;
    let qproto = quoted[9], qp = ports(quoted);
    if (!qp) return null;
    let flow = this.in.get(qproto + '|' + qp.src);
    if (!flow) return null;
    put32(quoted, 12, flow.lanIp);
    put32(quoted, 16, flow.origDst);
    setPorts(quoted, flow.lanPort, flow.origDstPort);
    put16(quoted, 10, 0);
    put16(quoted, 10, checksum(quoted.subarray(0, ihl(quoted))));
    put32(packet, 16, flow.lanIp);
    fixChecksums(packet);
    return { packet, lanIp: flow.lanIp };
  }

  /* Lower the MSS option of a TCP SYN so segments fit the uplink without
     fragmenting (a guest on Ethernet assumes 1500) */
  clampMss(packet) {
    let t = ihl(packet), dataOffset = (packet[t + 12] >> 4) * 4, max = this.mtu - 40;
    for (let i = t + 20; i < t + dataOffset;) {
      let kind = packet[i];
      if (kind == 0) break;
      if (kind == 1) { i++; continue; }
      if (kind == 2 && packet[i + 1] == 4 && get16(packet, i + 2) > max) put16(packet, i + 2, max);
      i += packet[i + 1] || 1;
    }
  }

  /* Active flows, for display */
  get flowCount() { return this.in.size; }
  describe() {
    return [...this.in.values()].map(f => ({ proto: f.proto, from: ipToString(u8(f.lanIp)) + ':' + f.lanPort, to: ipToString(u8(f.remoteIp)) + ':' + f.remotePort }));
  }
}
const u8 = n => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
