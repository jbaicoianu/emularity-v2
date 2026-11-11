import { LanBridge } from './bridge.js'
import { ManualSignaling } from './signaling.js'

/* A modal that walks the user through bridging their network with a friend's (see
   bridge.js), passing the links along by whatever messaging app they use:

     name     what the friend will see them as
     choose   invite a friend, or use a link a friend sent
   Inviting:
     invite   the invitation link to send (copy, share, or QR), and a place for the
              friend's reply link
   Joining:
     paste    the friend's invitation link, if it didn't come from opening it
     confirm  who's inviting, and what joining means
     reply    the reply link to send back; waits for the friend to open it
   Then:
     connecting, connected, or failed

   The steps follow the bridge's status, so a reply link opened in another tab (which
   hands it to this one) moves it along too. Closing the modal leaves a pending
   bridge waiting; the network panel can reopen it there (resume()). */

const LABEL_KEY = 'emularity-lan-label';
const label = {
  get() { try { return localStorage.getItem(LABEL_KEY) || ''; } catch (e) { return ''; } },
  set(value) { try { localStorage.setItem(LABEL_KEY, value); } catch (e) {} },
};

export class LanBridgeWizard {
  constructor(container, { uplink } = {}) {
    this.uplink = uplink;
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'lan-wizard';
    this.dialog.innerHTML = `
      <button type="button" class="close-dialog lan-wizard-close" title="Close">✕</button>
      <h3>Connect with a friend's network</h3>
      <ol class="lan-wizard-progress"><li>Your name</li><li>Share links</li><li>Connected</li></ol>
      <div class="lan-wizard-body"></div>`;
    this.dialog.querySelector('.lan-wizard-close').addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('close', () => this.setBridge(null));
    this.body = this.dialog.querySelector('.lan-wizard-body');
    container.append(this.dialog);
    this.onBridgeChange = () => this.follow();
  }

  /* From the start */
  open() {
    this.setBridge(null);
    this.offer = null;
    this.show('name');
  }
  /* With an invitation (a decoded offer), e.g. from a link: the name, then whether to join */
  openInvitation(offer) {
    this.setBridge(null);
    this.offer = offer;
    this.show('name');
  }
  /* Back to a bridge still being set up */
  resume(bridge) {
    this.setBridge(bridge);
    this.follow();
  }
  remove() {
    this.setBridge(null);
    this.dialog.remove();
  }

  setBridge(bridge) {
    if (this.bridge) this.bridge.removeEventListener('change', this.onBridgeChange);
    this.bridge = bridge;
    if (bridge) bridge.addEventListener('change', this.onBridgeChange);
  }
  /* The step for the bridge's status */
  follow() {
    let b = this.bridge;
    if (!b) return;
    let step = { inviting: 'invite', answering: 'reply', connecting: 'connecting', connected: 'connected' }[b.status];
    if (b.status == 'closed') step = b.connected ? 'ended' : 'failed';
    if (step && step != this.step) this.show(step);
  }

  show(step) {
    this.step = step;
    let stage = { name: 0, choose: 0, invite: 1, paste: 1, confirm: 1, reply: 1, connecting: 1, connected: 2, ended: 2, failed: 2 }[step];
    this.dialog.querySelectorAll('.lan-wizard-progress li').forEach((li, i) => {
      li.classList.toggle('done', i < stage);
      li.classList.toggle('current', i == stage);
    });
    this.body.replaceChildren(...this[step]());
    if (!this.dialog.open) this.dialog.showModal();
    let focus = this.body.querySelector('[autofocus]');
    if (focus) focus.focus();
  }

  /* ----- Steps ----- */

  name() {
    let form = html(`<form>
      <p>Pick a name your friend will recognize. They'll see it when you invite them, and on their network map.</p>
      <label>Your name <input type="text" name="label" maxlength="40" required placeholder="e.g. Alex" autofocus></label>
      <div class="lan-wizard-buttons"><button type="submit" class="primary">Next</button></div>
    </form>`);
    form.elements.label.value = label.get();
    form.addEventListener('submit', ev => {
      ev.preventDefault();
      label.set(form.elements.label.value.trim());
      this.show(this.offer ? 'confirm' : 'choose');
    });
    return [form];
  }

  choose() {
    let [p, buttons] = html(`<p>Are you starting the connection, or did a friend send you a link?</p>
      <div class="lan-wizard-choices">
        <button type="button" class="lan-wizard-choice" data-choice="invite" autofocus><strong>Invite a friend</strong><span>Get a link to send them</span></button>
        <button type="button" class="lan-wizard-choice" data-choice="paste"><strong>I have a link from a friend</strong><span>Use the invitation they sent you</span></button>
      </div>`);
    buttons.querySelector('[data-choice="paste"]').addEventListener('click', () => this.show('paste'));
    let inviteButton = buttons.querySelector('[data-choice="invite"]');
    inviteButton.addEventListener('click', async () => {
      inviteButton.disabled = true;
      this.status(buttons, 'Preparing your invitation…');
      try {
        this.setBridge(await LanBridge.invite({ label: label.get(), uplink: this.uplink }));
        this.follow();
      } catch (e) {
        this.status(buttons, "Couldn't make an invitation: " + e.message, true);
        inviteButton.disabled = false;
      }
    });
    return [p, buttons];
  }

  invite() {
    let bridge = this.bridge;
    let intro = html(`<div>
      <h4>1. Send your friend this link</h4>
      <p>Paste it into a message to them, or let them scan the code if they're next to you. It works once, and only while this window stays open.</p>
    </div>`);
    let reply = html(`<form class="lan-wizard-reply">
      <h4>2. Open the link they send back</h4>
      <p>When your friend opens your link, they'll get a reply link to send you. Open it in this browser and you'll connect, or paste it here:</p>
      <textarea name="code" rows="2" spellcheck="false" placeholder="Their reply link"></textarea>
      <div class="lan-wizard-buttons"><button type="submit" class="primary">Connect</button> <button type="button" class="lan-wizard-cancel">Cancel invitation</button></div>
    </form>`);
    reply.addEventListener('submit', async ev => {
      ev.preventDefault();
      try {
        let answer = await ManualSignaling.decode(reply.elements.code.value);
        await bridge.acceptAnswer(answer);
      } catch (e) {
        this.status(reply, e.message, true);
      }
    });
    reply.querySelector('.lan-wizard-cancel').addEventListener('click', () => { bridge.close(); this.dialog.close(); });
    return [intro, shareBox(bridge.offer, (bridge.label || 'A friend') + ' invited you to connect your Emularity network with theirs:'), reply];
  }

  paste() {
    let form = html(`<form>
      <p>Paste the invitation link your friend sent you. (Opening it in this browser works too.)</p>
      <textarea name="code" rows="3" spellcheck="false" placeholder="Their invitation link" autofocus></textarea>
      <div class="lan-wizard-buttons"><button type="submit" class="primary">Next</button> <button type="button" class="lan-wizard-back">Back</button></div>
    </form>`);
    form.querySelector('.lan-wizard-back').addEventListener('click', () => this.show('choose'));
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      try {
        let message = await ManualSignaling.decode(form.elements.code.value);
        if (message.type != 'offer') throw new Error("That's a reply link: it goes back to the browser that made the invitation.");
        this.offer = message;
        this.show('confirm');
      } catch (e) {
        this.status(form, e.message, true);
      }
    });
    return [form];
  }

  confirm() {
    let who = this.offer.label || 'Someone';
    let form = html(`<form>
      <p><strong></strong> invited you to connect your network with theirs.</p>
      <p class="lan-wizard-note">Their machines will be able to reach yours, and yours theirs, as if on one local network. Each of you keeps your own internet connection. Only join if you know who sent this.</p>
      <div class="lan-wizard-buttons"><button type="submit" class="primary" autofocus>Join</button> <button type="button" class="lan-wizard-cancel">Not now</button></div>
    </form>`);
    form.querySelector('strong').textContent = who;
    form.querySelector('.lan-wizard-cancel').addEventListener('click', () => this.dialog.close());
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      form.querySelector('[type="submit"]').disabled = true;
      this.status(form, 'Preparing your reply…');
      try {
        this.setBridge(await LanBridge.join(this.offer, { label: label.get(), uplink: this.uplink }));
        this.follow();
      } catch (e) {
        this.status(form, e.message, true);
        form.querySelector('[type="submit"]').disabled = false;
      }
    });
    return [form];
  }

  reply() {
    let bridge = this.bridge, who = bridge.remoteLabel || 'your friend';
    let intro = html(`<div>
      <h4>Send this reply link back to <span></span></h4>
      <p>Paste it into your conversation. You'll be connected as soon as they open it, so keep this window open until then.</p>
    </div>`);
    intro.querySelector('span').textContent = who;
    let waiting = html(`<div>
      <p class="lan-wizard-waiting">Waiting for <span></span> to open it…</p>
      <div class="lan-wizard-buttons"><button type="button" class="lan-wizard-cancel">Cancel</button></div>
    </div>`);
    waiting.querySelector('span').textContent = who;
    waiting.querySelector('.lan-wizard-cancel').addEventListener('click', () => { bridge.close(); this.dialog.close(); });
    return [intro, shareBox(bridge.answer, 'Here is my reply, to connect our Emularity networks:'), waiting];
  }

  connecting() {
    let who = this.bridge.remoteLabel || 'your friend';
    let p = html('<p class="lan-wizard-waiting"></p>');
    p.textContent = 'Connecting to ' + who + "'s network…";
    return [p];
  }

  connected() {
    let who = this.bridge.remoteLabel || 'your friend';
    let [title, text, buttons] = html(`<h4 class="lan-wizard-success">Connected</h4>
      <p>Your machines and <span></span>'s are on one network now. Theirs appear in your network list, and can be reached by name (e.g. <code>ping name.lan</code>). This tab keeps the connection open: closing it disconnects.</p>
      <div class="lan-wizard-buttons"><button type="button" class="primary" autofocus>Done</button></div>`);
    text.querySelector('span').textContent = who;
    buttons.querySelector('button').addEventListener('click', () => this.dialog.close());
    return [title, text, buttons];
  }

  ended() {
    let [text, buttons] = html(`<p>The connection was closed.</p>
      <div class="lan-wizard-buttons"><button type="button" class="primary">Close</button></div>`);
    buttons.querySelector('button').addEventListener('click', () => this.dialog.close());
    return [text, buttons];
  }

  failed() {
    let [text, buttons] = html(`<p class="lan-wizard-error"></p>
      <div class="lan-wizard-buttons"><button type="button" class="primary">Start over</button> <button type="button" class="lan-wizard-cancel">Close</button></div>`);
    text.textContent = this.bridge.error || 'The connection was cancelled.';
    buttons.querySelector('.primary').addEventListener('click', () => this.open());
    buttons.querySelector('.lan-wizard-cancel').addEventListener('click', () => this.dialog.close());
    return [text, buttons];
  }

  /* A status line at the end of `el` */
  status(el, text, error = false) {
    let p = el.querySelector(':scope > .lan-wizard-status');
    if (!p) {
      p = document.createElement('p');
      p.className = 'lan-wizard-status';
      el.append(p);
    }
    p.textContent = text;
    p.classList.toggle('lan-wizard-error', error);
  }
}

/* Elements from markup: the one, or an array if several */
function html(markup) {
  let t = document.createElement('template');
  t.innerHTML = markup.trim();
  let nodes = [...t.content.children];
  return nodes.length == 1 ? nodes[0] : nodes;
}

/* A message's link to pass on: copy it, share it (where the browser can hand it to a
   messaging app), or scan its QR code */
function shareBox(message, shareText) {
  let box = html(`<div class="lan-share">
    <canvas class="lan-qr" hidden></canvas>
    <div class="lan-share-main">
      <input type="text" readonly aria-label="Link">
      <div class="lan-wizard-buttons">
        <button type="button" class="primary lan-copy">Copy link</button>
        <button type="button" class="lan-share-button" hidden>Share…</button>
      </div>
    </div>
  </div>`);
  let input = box.querySelector('input'), copy = box.querySelector('.lan-copy'), share = box.querySelector('.lan-share-button');
  ManualSignaling.link(message).then(link => {
    input.value = link;
    drawQr(box.querySelector('canvas'), link);
    if (navigator.canShare?.({ text: shareText, url: link })) share.hidden = false;
  });
  input.addEventListener('focus', () => input.select());
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(input.value);
      copy.textContent = 'Copied ✓';
    } catch (e) {
      input.focus();
      copy.textContent = 'Press Ctrl+C';
    }
    setTimeout(() => { copy.textContent = 'Copy link'; }, 2000);
  });
  share.addEventListener('click', () => navigator.share({ text: shareText, url: input.value }).catch(() => {}));
  return box;
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
