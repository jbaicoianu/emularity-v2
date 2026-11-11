import { LanBridge } from './bridge.js'

/* Groups of more than two networks. A bridge only carries frames between the two LANs
   at its ends (frames never go from one bridge out another, which keeps bridges from
   forming loops; see switch.js), so for every machine in a group to reach every other,
   every pair of networks needs a bridge of its own: a full mesh. Setting those up by
   hand would mean swapping links pairwise, so the bridges set them up themselves:

   - Each side of a bridge tells the other which networks it's bridged with
     ({ peers: [{ id, label }] }), whenever that changes.
   - Hearing of a network it isn't bridged with, a network bridges with it, passing
     the offer and answer through the neighbour they share ({ relay: { to, from,
     signal } }, forwarded one hop). Only the one with the lower id starts, so a pair
     never makes two at once.
   - If two bridges join the same pair of networks anyway (say, a link used between
     networks already in one group), the one with the higher id is closed.
   - A bridge that doesn't come up is retried a few times, while some neighbour still
     says the other network is there.

   So inviting one network into a group connects it with everyone in it, and a group
   that invites another group's member merges with it. leave() closes all of this
   page's bridges and stops it making new ones until the user sets one up again
   (rejoin()).

   It runs in the page holding the bridges. A LAN's bridges should all be held by one
   tab: networks are known by their browser's id (LanBridge.peerId), shared by its tabs,
   so another tab's bridges would look like duplicates. */

const AUTO_TIMEOUT = 20000;              // ms an automatic bridge gets to connect
const RETRY_DELAYS = [3000, 10000, 30000]; // then gives up until it hears of the network again
const SETTLE = 8000; // ms after losing a network before bridging with it again: neighbours
                     // may still be saying it's there (it may have left)

export const Mesh = {
  uplink: null,         // the page's uplink settings file, for the bridges it makes
  // This network's name, as the user gave it (see bridge-wizard.js)
  get label() { try { return localStorage.getItem('emularity-lan-label') || ''; } catch (e) { return ''; } },
  left: false,
  attempts: new Map(),  // network id -> failed automatic attempts
  retryTimers: new Map(),
  starting: new Set(),  // network ids an automatic bridge is being made for
  lost: new Map(),      // network id -> when its bridge closed

  me() { return LanBridge.peerId; },

  /* Bridges that are up, by the network at their other end */
  connected() {
    let map = new Map();
    for (let b of LanBridge.all) if (b.status == 'connected' && b.remotePeer) map.set(b.remotePeer, b);
    return map;
  },
  /* Whether there's a bridge (up or on its way) to a network */
  bridgedWith(peer) {
    if (this.starting.has(peer)) return true;
    for (let b of LanBridge.all) if (b.remotePeer == peer || b.expectPeer == peer) return true;
    return false;
  },
  /* Networks some neighbour says it's bridged with, and through which bridges */
  heardOf() {
    let map = new Map();
    for (let b of this.connected().values()) {
      for (let p of b.remotePeers || []) {
        if (p.id == this.me()) continue;
        let entry = map.get(p.id) || { label: p.label, via: [] };
        entry.via.push(b);
        map.set(p.id, entry);
      }
    }
    return map;
  },

  /* Stop making bridges, and close this page's */
  leave() {
    this.left = true;
    for (let t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
    this.attempts.clear();
    for (let b of [...LanBridge.all]) b.close();
  },
  /* The user's setting one up again */
  rejoin() {
    this.left = false;
  },

  /* ----- Telling neighbours who we're bridged with ----- */

  shareScheduled: false,
  share() {
    if (this.shareScheduled) return;
    this.shareScheduled = true;
    queueMicrotask(() => {
      this.shareScheduled = false;
      let peers = this.connected();
      for (let [id, b] of peers) {
        let list = [...peers].filter(([other]) => other != id).map(([other, x]) => ({ id: other, label: x.remoteLabel }));
        let json = JSON.stringify(list);
        if (b.sharedPeers == json) continue;
        b.sharedPeers = json;
        b.sendControl({ peers: list });
      }
    });
  },

  /* ----- Bridging with networks we hear of ----- */

  consider() {
    if (this.left) return;
    let heard = this.heardOf();
    for (let [peer, { via }] of heard) {
      if (this.bridgedWith(peer) || this.retryTimers.has(peer)) continue;
      let since = Date.now() - (this.lost.get(peer) || 0);
      if (since < SETTLE) {
        this.retryTimers.set(peer, setTimeout(() => { this.retryTimers.delete(peer); this.consider(); }, SETTLE - since));
        continue;
      }
      if (this.me() < peer) this.initiate(peer, via[0]);
    }
    // Automatic bridges still waiting for networks no one mentions any more (they left)
    for (let b of [...LanBridge.all]) {
      if (b.initiated && b.status == 'inviting' && !heard.has(b.expectPeer)) b.close();
    }
  },

  async initiate(peer, via) {
    let bridge;
    this.starting.add(peer);
    try {
      bridge = await LanBridge.invite({ label: this.label, uplink: this.uplink, auto: true });
    } catch (e) {
      return this.failed(peer);
    } finally {
      this.starting.delete(peer);
    }
    bridge.expectPeer = peer;
    bridge.initiated = true;
    let timer = setTimeout(() => { if (bridge.status != 'connected') bridge.close('Timed out connecting'); }, AUTO_TIMEOUT);
    bridge.addEventListener('change', () => {
      if (bridge.status == 'connected') { clearTimeout(timer); this.attempts.delete(peer); }
      if (bridge.status == 'closed') { clearTimeout(timer); if (!bridge.connected) this.failed(peer); }
    });
    via.sendControl({ relay: { to: peer, from: this.me(), signal: bridge.offer } });
  },

  failed(peer) {
    let n = this.attempts.get(peer) || 0;
    this.attempts.set(peer, n + 1);
    if (n >= RETRY_DELAYS.length || this.left) return; // until it's heard of afresh (see onPeers)
    this.retryTimers.set(peer, setTimeout(() => {
      this.retryTimers.delete(peer);
      this.consider();
    }, RETRY_DELAYS[n]));
  },

  /* An offer or answer for us, from `from`, passed along by the bridge `via` */
  async signal(via, from, signal) {
    if (signal.type == 'offer') {
      if (this.left || this.bridgedWith(from)) return;
      let bridge;
      try {
        bridge = await LanBridge.join(signal, { label: this.label, uplink: this.uplink, auto: true });
      } catch (e) {
        return;
      }
      bridge.expectPeer = from;
      setTimeout(() => { if (bridge.status != 'connected') bridge.close('Timed out connecting'); }, AUTO_TIMEOUT);
      via.sendControl({ relay: { to: from, from: this.me(), signal: bridge.answer } });
    } else if (signal.type == 'answer') {
      let bridge = [...LanBridge.all].find(b => b.id == signal.id && b.auto && b.expectPeer == from);
      if (bridge) bridge.acceptAnswer(signal).catch(() => {});
    }
  },

  /* ----- Control messages ----- */

  onHello(bridge) {
    // Two bridges to one network: keep the one with the lower id (both ends agree)
    for (let other of LanBridge.all) {
      if (other === bridge || other.remotePeer != bridge.remotePeer || other.status == 'closed') continue;
      let drop = other.id < bridge.id ? bridge : other;
      drop.duplicate = true;
      drop.close();
      if (drop === bridge) return;
    }
    if (bridge.remotePeer == this.me()) bridge.close('That invitation came from this browser');
    this.share();
  },

  onControl(bridge, msg) {
    if (msg.peers && Array.isArray(msg.peers)) {
      bridge.remotePeers = msg.peers.slice(0, 64)
        .filter(p => p && typeof p.id == 'string')
        .map(p => ({ id: p.id.slice(0, 64), label: String(p.label || '').slice(0, 40) }));
      for (let p of bridge.remotePeers) this.attempts.delete(p.id); // heard of afresh: worth trying again
      this.consider();
      LanBridge.events.dispatchEvent(new Event('change'));
    } else if (msg.relay && typeof msg.relay.to == 'string' && typeof msg.relay.from == 'string' && msg.relay.signal) {
      let { to, from, signal, hops } = msg.relay;
      // One hop at most: straight from a neighbour (for us, or to pass on), or passed on
      // by one (for us)
      if (hops ? to != this.me() : from != bridge.remotePeer) return;
      if (to == this.me()) return this.signal(bridge, from, signal);
      let next = this.connected().get(to);
      if (next) next.sendControl({ relay: { to, from, signal, hops: 1 } });
    }
  },
};

LanBridge.events.addEventListener('hello', ev => Mesh.onHello(ev.detail.bridge));
LanBridge.events.addEventListener('control', ev => Mesh.onControl(ev.detail.bridge, ev.detail.msg));
// A bridge coming up or going away changes who we're bridged with
let lastConnected = '';
LanBridge.events.addEventListener('change', () => {
  let now = [...Mesh.connected().keys()].sort().join();
  if (now == lastConnected) return;
  for (let peer of lastConnected.split(',')) if (peer && !now.split(',').includes(peer)) Mesh.lost.set(peer, Date.now());
  lastConnected = now;
  Mesh.share();
  Mesh.consider();
});
