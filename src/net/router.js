import {
  ETHERTYPE_ARP, ETHERTYPE_IPV4, PROTO_ICMP, PROTO_UDP, BROADCAST_MAC,
  ARP_REQUEST, ARP_REPLY, ICMP_ECHO_REQUEST, ICMP_ECHO_REPLY,
  DHCP, DHCP_OPT, DHCP_SERVER_PORT, DHCP_CLIENT_PORT, DNS_PORT, DNS_TYPE, DNS_RCODE,
  parseEthernet, buildEthernet, parseArp, buildArp, parseIpv4, buildIpv4,
  parseUdp, buildUdp, parseIcmp, buildIcmp, parseDhcp, buildDhcpReply, parseDnsQuery, buildDnsResponse, encodeDnsName,
  macToString, ipToString, parseIp, sameBytes,
} from './packets.js'

const ICMP_UNREACHABLE = 3, ICMP_TIME_EXCEEDED = 11;
const UNREACHABLE_NET = 0, UNREACHABLE_PORT = 3;

/* The LAN's gateway, plugged into the switch like any other port. It answers ARP for
   its own address, replies to pings, runs a DHCP server handing out addresses from
   the subnet, and a DNS server for the machines' names (as given by `names`, an
   object with lookup(name) -> IP bytes, reverse(IP bytes) -> name and forMac(MAC
   string) -> name). Names resolve bare or under `domain`; "gateway" is the router.
   `onLease(mac, ip)` hears about each address it leases.
   Packets for anywhere beyond the LAN go to `wan`, an uplink (see PppUplink) with
   `online`, send(packet) and forwardDns(packet), which hands replies back through
   deliverFromWan(). Without one online, they're refused with ICMP "network
   unreachable", and lookups of outside names fail. */
export class Router {
  static LEASE_SECONDS = 3600;
  static OFFER_SECONDS = 60;   // how long an offered address is kept for its taker

  constructor(lan, { mac = '52:54:00:00:00:01', subnet = '10.86.0', poolStart = 100, poolEnd = 249, domain = 'lan', names = null, onLease = null, log = console.log } = {}) {
    this.lan = lan;
    this.log = log;
    this.onLease = onLease;
    this.domain = domain;
    this.names = names;
    this.mac = new Uint8Array(mac.split(':').map(h => parseInt(h, 16)));
    this.subnet = subnet;
    this.ip = parseIp(subnet + '.1');
    this.netmask = parseIp('255.255.255.0');
    this.broadcast = parseIp(subnet + '.255');
    this.pool = [poolStart, poolEnd];
    this.leases = new Map(); // MAC string -> { host, expires }
    this.neighbors = new Map(); // LAN IP string -> MAC, learned from what they send us
    this.wan = null;
    lan.attach(this);
  }

  send(frame) {
    this.lan.forward(this, frame);
  }
  onLan(ip) {
    return ip[0] == this.ip[0] && ip[1] == this.ip[1] && ip[2] == this.ip[2];
  }

  /* A frame from the switch: addressed to us, or broadcast */
  deliver(frame) {
    let eth = parseEthernet(frame);
    if (!eth) return;
    if (eth.ethertype == ETHERTYPE_ARP) this.handleArp(eth);
    else if (eth.ethertype == ETHERTYPE_IPV4) this.handleIpv4(eth);
  }
  learnNeighbor(ip, mac) {
    if (this.onLan(ip) && ip[3] != 0 && ip[3] != 255) this.neighbors.set(ipToString(ip), mac.slice());
  }

  handleArp(eth) {
    let arp = parseArp(eth.payload);
    if (!arp) return;
    this.learnNeighbor(arp.senderIp, arp.senderMac);
    if (arp.op != ARP_REQUEST || !sameBytes(arp.targetIp, this.ip)) return;
    this.send(buildEthernet({
      dest: arp.senderMac, src: this.mac, ethertype: ETHERTYPE_ARP,
      payload: buildArp({ op: ARP_REPLY, senderMac: this.mac, senderIp: this.ip, targetMac: arp.senderMac, targetIp: arp.senderIp }),
    }));
  }

  handleIpv4(eth) {
    let ip = parseIpv4(eth.payload);
    if (!ip) return;
    this.learnNeighbor(ip.src, eth.src);
    let toUs = sameBytes(ip.dest, this.ip), broadcast = ip.dest.every(b => b == 255) || sameBytes(ip.dest, this.broadcast);
    if (ip.proto == PROTO_UDP && (toUs || broadcast)) {
      let udp = parseUdp(ip.payload);
      if (udp && udp.destPort == DHCP_SERVER_PORT) return this.handleDhcp(eth, udp);
      if (udp && toUs && udp.destPort == DNS_PORT) return this.handleDns(eth, ip, udp);
      if (udp && toUs) return this.sendUnreachable(eth, UNREACHABLE_PORT); // nothing listening
      return;
    }
    if (toUs) {
      if (ip.proto == PROTO_ICMP) {
        let icmp = parseIcmp(ip.payload);
        if (icmp && icmp.type == ICMP_ECHO_REQUEST) {
          this.sendIp(eth.src, ip.src, PROTO_ICMP, buildIcmp({ type: ICMP_ECHO_REPLY, rest: icmp.rest }));
        }
      }
      return;
    }
    // Addressed to our MAC but another IP: we're the gateway for it
    if (broadcast || this.onLan(ip.dest) || !sameBytes(eth.dest, this.mac)) return;
    if (!this.wan?.online) return this.sendUnreachable(eth, UNREACHABLE_NET);
    if (ip.ttl <= 1) return this.sendIcmpError(eth, ICMP_TIME_EXCEEDED, 0); // traceroute gets our hop
    let packet = eth.payload.slice(0, ip.payload.byteOffset - eth.payload.byteOffset + ip.payload.length);
    packet[8]--; // TTL (the uplink recomputes checksums)
    this.wan.send(packet);
  }

  /* An IPv4 packet from the uplink for a LAN machine */
  deliverFromWan(packet, lanIp) {
    let dest = new Uint8Array([lanIp >>> 24, (lanIp >> 16) & 0xff, (lanIp >> 8) & 0xff, lanIp & 0xff]);
    let mac = this.neighbors.get(ipToString(dest));
    if (!mac) {
      // Haven't heard from it (unusual: it sent the packet this answers): ask, and drop
      this.send(buildEthernet({ dest: BROADCAST_MAC, src: this.mac, ethertype: ETHERTYPE_ARP,
        payload: buildArp({ op: ARP_REQUEST, senderMac: this.mac, senderIp: this.ip, targetMac: new Uint8Array(6), targetIp: dest }) }));
      return;
    }
    this.send(buildEthernet({ dest: mac, src: this.mac, ethertype: ETHERTYPE_IPV4, payload: packet }));
  }

  sendIp(destMac, destIp, proto, payload) {
    this.send(buildEthernet({
      dest: destMac, src: this.mac, ethertype: ETHERTYPE_IPV4,
      payload: buildIpv4({ proto, src: this.ip, dest: destIp, payload }),
    }));
  }
  sendUnreachable(eth, code) {
    this.sendIcmpError(eth, ICMP_UNREACHABLE, code);
  }
  /* An ICMP error about a packet, quoting its header + 8 bytes */
  sendIcmpError(eth, type, code) {
    let ip = parseIpv4(eth.payload);
    let ihl = (eth.payload[0] & 0xf) * 4;
    let quoted = eth.payload.subarray(0, Math.min(eth.payload.length, ihl + 8));
    let rest = new Uint8Array(4 + quoted.length);
    rest.set(quoted, 4);
    this.sendIp(eth.src, ip.src, PROTO_ICMP, buildIcmp({ type, code, rest }));
  }

  /* ----- DNS ----- */

  handleDns(eth, ip, udp) {
    let query = parseDnsQuery(udp.payload);
    if (!query || query.questions.length != 1) return;
    let { name, type } = query.questions[0];
    let answers = [], rcode = DNS_RCODE.OK;
    name = name.toLowerCase().replace(/\.$/, '');
    let reverse = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\.in-addr\.arpa$/.exec(name);
    let host = name.endsWith('.' + this.domain) ? name.slice(0, -this.domain.length - 1) : !name.includes('.') ? name : null;
    if (host != null) {
      let addr = host == 'gateway' ? this.ip : this.names?.lookup(host);
      if (!addr) rcode = DNS_RCODE.NXDOMAIN;
      else if (type == DNS_TYPE.A) answers.push({ type, data: addr });
      // other types (e.g. AAAA): the name exists but has no such record
    } else if (this.wan?.online && !(reverse && this.onLan(reverse.slice(1, 5).reverse().map(Number)))) {
      // An outside name (or address): ask the uplink's resolver; it replies directly
      let packet = eth.payload.slice(0, ip.payload.byteOffset - eth.payload.byteOffset + ip.payload.length);
      return this.wan.forwardDns(packet);
    } else if (reverse) {
      let addr = new Uint8Array(reverse.slice(1, 5).reverse().map(Number));
      let found = sameBytes(addr, this.ip) ? 'gateway' : this.onLan(addr) ? this.names?.reverse(addr) : null;
      if (!found) rcode = DNS_RCODE.NXDOMAIN;
      else if (type == DNS_TYPE.PTR) answers.push({ type, data: encodeDnsName(found + '.' + this.domain) });
    } else {
      rcode = DNS_RCODE.SERVFAIL; // an outside name, and no uplink to ask
    }
    this.sendIp(eth.src, ip.src, PROTO_UDP, buildUdp({
      srcPort: DNS_PORT, destPort: udp.srcPort, srcIp: this.ip, destIp: ip.src,
      payload: buildDnsResponse(query, answers, rcode),
    }));
  }

  /* ----- DHCP ----- */

  handleDhcp(eth, udp) {
    let msg = parseDhcp(udp.payload);
    if (!msg || msg.op != 1) return;
    let mac = macToString(msg.chaddr);
    let serverId = msg.options.get(DHCP_OPT.SERVER_ID);
    if (serverId && !sameBytes(serverId, this.ip)) return; // the client picked another server

    if (msg.type == DHCP.DISCOVER) {
      // An offer holds the address briefly; the lease starts when it's taken (REQUEST)
      let host = this.allocate(mac, msg.options.get(DHCP_OPT.REQUESTED_IP), Router.OFFER_SECONDS);
      if (host) this.sendDhcp(msg, DHCP.OFFER, host);
    } else if (msg.type == DHCP.REQUEST) {
      let wanted = msg.options.get(DHCP_OPT.REQUESTED_IP) || msg.ciaddr;
      let host = this.onLan(wanted) ? this.allocate(mac, wanted) : null;
      if (host && host == wanted[3]) {
        this.sendDhcp(msg, DHCP.ACK, host);
        if (this.onLease) this.onLease(mac, parseIp(this.subnet + '.' + host));
      }
      else this.sendDhcp(msg, DHCP.NAK, null);
    } else if (msg.type == DHCP.RELEASE) {
      this.leases.delete(mac);
    }
  }

  /* Take over a lease handed out before (e.g. by the router before a restart) */
  restoreLease(mac, ip) {
    if (!this.onLan(ip)) return;
    this.leases.set(mac, { host: ip[3], expires: Date.now() + Router.LEASE_SECONDS * 1000 });
    this.neighbors.set(ipToString(ip), new Uint8Array(mac.split(':').map(h => parseInt(h, 16))));
  }

  /* The host number to lease to `mac`: its current lease, the address it asked for if
     that's free, or the first free one. Expired leases count as free. It's held for
     `seconds` (or longer, if it was already). */
  allocate(mac, requested, seconds = Router.LEASE_SECONDS) {
    let now = Date.now();
    let taken = new Map();
    for (let [m, lease] of this.leases) if (m != mac && lease.expires > now) taken.set(lease.host, m);
    let free = host => host >= this.pool[0] && host <= this.pool[1] && !taken.has(host);
    let lease = this.leases.get(mac);
    let host = lease && free(lease.host) ? lease.host
      : requested && this.onLan(requested) && free(requested[3]) ? requested[3]
      : null;
    for (let h = this.pool[0]; !host && h <= this.pool[1]; h++) if (free(h)) host = h;
    if (!host) return null;
    let expires = now + seconds * 1000;
    if (lease && lease.host == host) expires = Math.max(expires, lease.expires);
    this.leases.set(mac, { host, expires });
    return host;
  }

  sendDhcp(msg, type, host) {
    let u32 = n => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    let options = new Map([[DHCP_OPT.MESSAGE_TYPE, [type]], [DHCP_OPT.SERVER_ID, this.ip]]);
    if (type != DHCP.NAK) {
      options.set(DHCP_OPT.LEASE_TIME, u32(Router.LEASE_SECONDS));
      options.set(DHCP_OPT.RENEWAL_TIME, u32(Router.LEASE_SECONDS / 2));
      options.set(DHCP_OPT.REBINDING_TIME, u32(Router.LEASE_SECONDS * 7 / 8));
      options.set(DHCP_OPT.SUBNET_MASK, this.netmask);
      options.set(DHCP_OPT.ROUTER, this.ip);
      options.set(DHCP_OPT.DNS, this.ip);
      options.set(DHCP_OPT.BROADCAST, this.broadcast);
      options.set(DHCP_OPT.DOMAIN, Array.from(this.domain, c => c.charCodeAt(0)));
      let hostname = this.names?.forMac(macToString(msg.chaddr));
      if (hostname) options.set(DHCP_OPT.HOSTNAME, Array.from(hostname, c => c.charCodeAt(0)));
    }
    let yiaddr = host ? parseIp(this.subnet + '.' + host) : null;
    let reply = buildDhcpReply({ xid: msg.xid, flags: msg.flags, chaddr: msg.chaddr, yiaddr, siaddr: this.ip, options });
    // Broadcast the reply: the client has no address yet, and it's always accepted
    let dest = parseIp('255.255.255.255');
    this.send(buildEthernet({
      dest: BROADCAST_MAC, src: this.mac, ethertype: ETHERTYPE_IPV4,
      payload: buildIpv4({ proto: PROTO_UDP, src: this.ip, dest,
        payload: buildUdp({ srcPort: DHCP_SERVER_PORT, destPort: DHCP_CLIENT_PORT, payload: reply, srcIp: this.ip, destIp: dest }) }),
    }));
    let what = { [DHCP.OFFER]: 'offered ' + ipToString(yiaddr) + ' to', [DHCP.ACK]: 'leased ' + ipToString(yiaddr) + ' to', [DHCP.NAK]: 'refused a request from' }[type];
    this.log('DHCP ' + what + ' ' + macToString(msg.chaddr));
  }
}
