/* Signaling for LAN bridges (see bridge.js): getting each side's WebRTC session
   description to the other before they can connect.

   A signaling method moves two messages: the inviting side's offer to the joining side,
   and the joining side's answer back. Each is { type: 'offer' | 'answer', id, sdp,
   label }, where `id` names the invitation (an answer carries its offer's id) and
   `label` is what the sender calls its network.

   ManualSignaling packs a message into a code (and a link carrying it) for the users to
   pass along themselves: chat, email, a QR code. A signaling server would move the same
   messages automatically, keyed by the invitation's id; bridge.js only deals in
   messages, so either can carry them. */

const VERSION = 1;

const toBase64Url = bytes => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromBase64Url = text => {
  let s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
};
async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

/* The hash parameters a link's message travels in: #lan-invite=<code>, #lan-reply=<code> */
const LINK_PARAMS = { offer: 'lan-invite', answer: 'lan-reply' };

export const ManualSignaling = {
  /* A message as a compact code: deflated JSON, in URL-safe base64. SDP is very
     repetitive, so this roughly halves it. */
  async encode(message) {
    let { type, id, sdp, label } = message;
    let json = JSON.stringify({ v: VERSION, t: type == 'offer' ? 'o' : 'a', id, sdp, label });
    return toBase64Url(await pipe(new TextEncoder().encode(json), new CompressionStream('deflate-raw')));
  },
  /* A message from a code, or from a link (or any text) containing one. Throws if it
     isn't one. */
  async decode(text) {
    text = String(text || '').trim();
    let m = /[#&?](?:lan-invite|lan-reply)=([A-Za-z0-9_-]+)/.exec(text);
    let code = m ? m[1] : text.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9_-]+$/.test(code)) throw new Error("That isn't an invitation or reply code.");
    let data;
    try {
      data = JSON.parse(new TextDecoder().decode(await pipe(fromBase64Url(code), new DecompressionStream('deflate-raw'))));
    } catch (e) {
      throw new Error("That code is incomplete or damaged: check it was copied whole.");
    }
    if (data.v != VERSION || !data.sdp || !data.id) throw new Error('That code is from an incompatible version.');
    return { type: data.t == 'o' ? 'offer' : 'answer', id: data.id, sdp: data.sdp, label: data.label || '' };
  },
  /* A link to `page` (by default this one) carrying the message's code */
  async link(message, page = location.href) {
    let url = new URL(page);
    url.hash = LINK_PARAMS[message.type] + '=' + await this.encode(message);
    return url.href;
  },
  /* The code in a location's hash, if it has one: { type, code } */
  fromHash(hash = location.hash) {
    let m = /^#(lan-invite|lan-reply)=([A-Za-z0-9_-]+)$/.exec(hash);
    return m ? { type: m[1] == 'lan-invite' ? 'offer' : 'answer', code: m[2] } : null;
  },
};

/* Answers can arrive in any tab: a reply link opened in this browser loads a new
   page, but the invitation waiting for it lives in the tab that made it. Tabs pass
   answers along on a BroadcastChannel; deliverAnswer() resolves true if a waiting tab
   took it. */
const CHANNEL = 'emularity-lan-signaling';
const waiting = new Map(); // invitation id -> function(message)
let channel = null;
function openChannel() {
  if (channel || typeof BroadcastChannel == 'undefined') return channel;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = ev => {
    let { answer, ack } = ev.data || {};
    if (answer && waiting.has(answer.id)) {
      waiting.get(answer.id)(answer);
      channel.postMessage({ ack: answer.id });
    } else if (ack && pendingAcks.has(ack)) {
      pendingAcks.get(ack)(true);
    }
  };
  return channel;
}
const pendingAcks = new Map(); // invitation id -> resolve

export function awaitAnswer(id, onAnswer) {
  openChannel();
  waiting.set(id, onAnswer);
  return () => waiting.delete(id);
}
export function deliverAnswer(message) {
  if (waiting.has(message.id)) { // this tab is the one waiting
    waiting.get(message.id)(message);
    return Promise.resolve(true);
  }
  let ch = openChannel();
  if (!ch) return Promise.resolve(false);
  return new Promise(resolve => {
    let done = taken => { pendingAcks.delete(message.id); clearTimeout(timer); resolve(taken); };
    let timer = setTimeout(() => done(false), 1500);
    pendingAcks.set(message.id, done);
    ch.postMessage({ answer: message });
  });
}
