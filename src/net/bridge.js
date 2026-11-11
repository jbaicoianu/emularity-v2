import { LanTrunk } from './lan.js'
import { awaitAnswer, deliverAnswer } from './signaling.js'

/* A bridge between this browser's virtual LAN and another browser's, over WebRTC, so
   machines on either can reach the other's as if on one network.

   Ethernet frames cross in a data channel that drops rather than retransmits (like a
   real wire: the machines' own TCP deals with loss), and the sides tell each other
   which machines they have over a reliable one, so names resolve across. In each
   browser the bridge is a port on the LAN's switch (see LanTrunk, and lan-worker.js for
   what it keeps from crossing: each side keeps its own gateway, DHCP and internet).

   The peer connection lives in the page that made it (workers can't have one), so the
   bridge lasts as long as that tab. Bridges in this page are in LanBridge.all; each
   fires 'change' as its status moves through:
     inviting   an offer is ready (offer) to send to the other side; waiting for the answer
     answering  an answer is ready (answer) to send back; waiting for the connection
     connecting the answer's in; connecting
     connected  frames are flowing
     closed     ended (error says why, if it failed)

   Getting the offer and answer across is up to a signaling method (see signaling.js);
   these only deal in messages. Use:
     let bridge = await LanBridge.invite({ label });  // bridge.offer -> the other side
     bridge.acceptAnswer(answer);                     // what came back
   and on the other side:
     let bridge = await LanBridge.join(offer, { label });  // bridge.answer -> back */

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const ICE_GATHER_TIMEOUT = 4000; // ms: the offer/answer carry all candidates (no trickling)
const MAX_BUFFERED = 1 << 20;    // bytes queued in the frame channel before frames are dropped

export class LanBridge extends EventTarget {
  static all = new Set();
  static iceServers = ICE_SERVERS;

  status = 'new';
  error = null;
  remoteLabel = '';
  remoteHosts = [];
  rx = 0; tx = 0; // bytes of frames each way
  offer = null; answer = null;

  constructor({ label = '', uplink } = {}) {
    super();
    this.id = crypto.randomUUID();
    this.label = label;
    this.uplink = uplink;
    this.created = Date.now();
    this.pc = new RTCPeerConnection({ iceServers: LanBridge.iceServers });
    this.pc.addEventListener('connectionstatechange', () => {
      let s = this.pc.connectionState;
      if (s == 'failed') this.close("Couldn't connect: the two browsers may not be able to reach each other directly");
      else if (s == 'closed') this.close();
    });
    LanBridge.all.add(this);
    this.onPageHide = () => this.close();
    addEventListener('pagehide', this.onPageHide);
  }

  /* Start an invitation; resolves once bridge.offer is ready */
  static async invite(options) {
    let bridge = new LanBridge(options);
    try {
      bridge.setChannels(bridge.pc.createDataChannel('frames', { ordered: false, maxRetransmits: 0 }),
        bridge.pc.createDataChannel('control'));
      await bridge.pc.setLocalDescription(await bridge.pc.createOffer());
      await bridge.gathered();
      bridge.offer = { type: 'offer', id: bridge.id, sdp: bridge.pc.localDescription.sdp, label: bridge.label };
      bridge.stopWaiting = awaitAnswer(bridge.id, answer => bridge.acceptAnswer(answer).catch(() => {}));
      bridge.setStatus('inviting');
    } catch (e) {
      bridge.close(e.message);
      throw e;
    }
    return bridge;
  }

  /* Accept an invitation; resolves once bridge.answer is ready */
  static async join(offer, options) {
    if (offer.type != 'offer') throw new Error("That's a reply, not an invitation: it goes back to the browser that sent the invitation.");
    for (let b of LanBridge.all) if (b.id == offer.id) throw new Error('This tab made that invitation: it has to be opened in the other browser.');
    let bridge = new LanBridge(options);
    bridge.id = offer.id;
    bridge.remoteLabel = offer.label;
    try {
      let channels = {};
      bridge.pc.addEventListener('datachannel', ev => {
        channels[ev.channel.label] = ev.channel;
        if (channels.frames && channels.control) bridge.setChannels(channels.frames, channels.control);
      });
      await bridge.pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      await bridge.pc.setLocalDescription(await bridge.pc.createAnswer());
      await bridge.gathered();
      bridge.answer = { type: 'answer', id: bridge.id, sdp: bridge.pc.localDescription.sdp, label: bridge.label };
      bridge.setStatus('answering');
    } catch (e) {
      bridge.close(e.message);
      throw e;
    }
    return bridge;
  }

  /* An answer to an invitation: its own, or one meant for another tab here */
  static async deliver(answer) {
    if (answer.type != 'answer') throw new Error("That's an invitation, not a reply.");
    return deliverAnswer(answer);
  }

  async acceptAnswer(answer) {
    if (answer.type != 'answer') throw new Error("That's an invitation, not a reply: send it to the other browser.");
    if (answer.id != this.id) throw new Error('That reply is for a different invitation.');
    if (this.status != 'inviting') return; // already taken (e.g. pasted twice)
    this.remoteLabel = answer.label;
    this.setStatus('connecting');
    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    } catch (e) {
      this.close("That reply couldn't be used: " + e.message);
      throw e;
    }
  }

  /* Wait for ICE candidate gathering, so the description carries them all */
  gathered() {
    if (this.pc.iceGatheringState == 'complete') return Promise.resolve();
    return new Promise(resolve => {
      let done = () => { clearTimeout(timer); this.pc.removeEventListener('icegatheringstatechange', check); resolve(); };
      let check = () => { if (this.pc.iceGatheringState == 'complete') done(); };
      let timer = setTimeout(done, ICE_GATHER_TIMEOUT); // go with what we have
      this.pc.addEventListener('icegatheringstatechange', check);
    });
  }

  setChannels(frames, control) {
    frames.binaryType = 'arraybuffer';
    this.frames = frames;
    this.control = control;
    let opened = () => { if (frames.readyState == 'open' && control.readyState == 'open') this.start(); };
    frames.addEventListener('open', opened);
    control.addEventListener('open', opened);
    for (let ch of [frames, control]) ch.addEventListener('close', () => this.close(this.status == 'connected' ? null : 'The connection closed'));
    frames.addEventListener('message', ev => {
      let frame = new Uint8Array(ev.data);
      this.rx += frame.length;
      this.trunk?.send(frame);
    });
    control.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.hosts) {
        this.remoteHosts = msg.hosts;
        this.trunk?.remoteHosts(msg.hosts);
        this.emit();
      }
      if (msg.bye) this.close();
    });
    opened();
  }

  /* Both channels are open: plug into the LAN */
  start() {
    if (this.trunk) return;
    this.stopWaiting?.();
    this.trunk = new LanTrunk(frame => {
      if (this.frames.readyState != 'open' || this.frames.bufferedAmount > MAX_BUFFERED) return; // congested: drop
      this.tx += frame.length;
      this.frames.send(frame);
    }, {
      id: this.id, label: this.remoteLabel, uplink: this.uplink,
      onHosts: hosts => { if (this.control.readyState == 'open') this.control.send(JSON.stringify({ hosts })); },
    });
    if (this.remoteHosts.length) this.trunk.remoteHosts(this.remoteHosts);
    this.connected = Date.now();
    this.setStatus('connected');
  }

  close(error = null) {
    if (this.status == 'closed') return;
    this.error = error;
    try { if (this.control?.readyState == 'open') this.control.send(JSON.stringify({ bye: true })); } catch (e) {}
    this.stopWaiting?.();
    this.trunk?.close();
    this.trunk = null;
    this.pc.close();
    removeEventListener('pagehide', this.onPageHide);
    LanBridge.all.delete(this);
    this.setStatus('closed');
    if (error) LanBridge.events.dispatchEvent(new CustomEvent('error', { detail: { bridge: this, error } }));
  }

  setStatus(status) {
    this.status = status;
    this.emit();
  }
  emit() {
    this.dispatchEvent(new Event('change'));
    LanBridge.events.dispatchEvent(new Event('change'));
  }
  /* Fires 'change' when any bridge in this page changes, and 'error' ({ detail: {
     bridge, error } }) when one fails */
  static events = new EventTarget();
}
