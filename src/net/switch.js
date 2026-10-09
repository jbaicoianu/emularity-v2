import { macToString } from './packets.js'

/* A learning Ethernet switch. Ports are objects with a deliver(frame) method; the
   switch learns which port each source MAC address lives behind, sends unicast frames
   only there, and floods broadcast, multicast and not-yet-learned frames to every
   other port. */
export class EthernetSwitch {
  ports = new Set();
  macs = new Map(); // MAC string -> port

  attach(port) {
    this.ports.add(port);
  }
  detach(port) {
    this.ports.delete(port);
    for (let [mac, p] of this.macs) if (p === port) this.macs.delete(mac);
  }

  /* A frame arriving from `from` */
  forward(from, frame) {
    if (frame.length < 14) return;
    let src = frame.subarray(6, 12);
    if (!(src[0] & 1)) this.macs.set(macToString(src), from); // never learn a multicast source
    let dest = frame.subarray(0, 6);
    let to = dest[0] & 1 ? null : this.macs.get(macToString(dest)); // group bit: broadcast/multicast
    if (to) {
      if (to !== from) to.deliver(frame);
      return;
    }
    for (let port of this.ports) if (port !== from) port.deliver(frame);
  }
}
