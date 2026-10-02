/* Mouse input for a v86 machine, driven from its display canvas (replacing v86's own
   adapter, which listens on the whole window and measures movement in CSS pixels).

   v86 exposes two pointing devices, both fed through its bus:
   - a VMware absolute pointer ("mouse-absolute"), used by guests with a vmmouse driver
     (e.g. Arch's Xorg). We report where the pointer is on the guest screen, so the
     guest cursor sits exactly under ours.
   - a PS/2 mouse ("mouse-delta"), the only option for most other guests. It's
     relative, so we forward movement, scaled to guest pixels. The guest applies its
     own acceleration, so without pointer lock its cursor can drift from ours; with
     pointer lock it behaves like a real mouse. We don't know where the guest cursor
     starts, so the first time the pointer is over the canvas we pin the guest cursor
     into the nearest corner and move it from there to the pointer. Movement outside
     the canvas isn't forwarded, so when the pointer comes back in, we move the guest
     cursor by the distance between where it left and where it re-entered. Both are
     exact only if the guest's acceleration is off.

   Pointer lock is taken automatically while the canvas is fullscreen, and on click
   with `captureOnClick`. */
export class V86Mouse {
  constructor(emulator, canvas, { captureOnClick = false } = {}) {
    this.emulator = emulator;
    this.canvas = canvas;
    this.captureOnClick = captureOnClick;
    this.calibrated = false;    // the guest cursor is where we think it is
    this.absolute = false;  // guest is using the VMware absolute pointer
    this.locked = false;
    this.buttons = [false, false, false]; // left, middle, right
    this.rest = { x: 0, y: 0 }; // sub-pixel movement not yet sent
    this.exit = null;           // where the pointer left the canvas (guest pixels)

    this.listeners = {
      pointerleave: ev => this.onLeave(ev),
      pointerenter: ev => this.onEnter(ev),
      pointermove: ev => this.onMove(ev),
      pointerdown: ev => this.onButton(ev, true),
      pointerup: ev => this.onButton(ev, false),
      wheel: ev => this.onWheel(ev),
      contextmenu: ev => ev.preventDefault(),
    };
    for (let [type, fn] of Object.entries(this.listeners)) canvas.addEventListener(type, fn, { passive: false });
    this.onLockChange = () => this.setLocked(document.pointerLockElement === canvas);
    document.addEventListener('pointerlockchange', this.onLockChange);
    this.onFullscreenChange = () => {
      let fs = document.fullscreenElement;
      if (fs && fs.contains(canvas)) this.lock().catch(e => console.warn('Emularity: pointer lock failed', e));
      else if (this.locked) document.exitPointerLock();
    };
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    emulator.add_listener('vmware-absolute-mouse', on => {
      this.absolute = on;
      this.canvas.style.cursor = on ? 'none' : ''; // the guest draws its cursor right under ours
    });
  }

  destroy() {
    for (let [type, fn] of Object.entries(this.listeners)) this.canvas.removeEventListener(type, fn);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
  }

  async lock() {
    try { await this.canvas.requestPointerLock({ unadjustedMovement: true }); }
    catch (e) { await this.canvas.requestPointerLock(); } // unadjustedMovement unsupported
  }
  setLocked(locked) {
    this.locked = locked;
    // Locked movement leaves the guest cursor somewhere we can't predict
    this.exit = null;
    this.calibrated = false;
    this.emulator.bus.send('mouse-pointer-lock', locked); // switches the VMware pointer to relative
  }

  send(type, data) {
    if (this.emulator.is_running()) this.emulator.bus.send(type, data);
  }

  /* The canvas is drawn at the guest's resolution but displayed scaled, and
     letterboxed when object-fit: contain. Returns the guest pixels per CSS pixel and
     where the picture starts. */
  layout() {
    let c = this.canvas, rect = c.getBoundingClientRect();
    let sx = rect.width / c.width, sy = rect.height / c.height, ox = 0, oy = 0;
    if (getComputedStyle(c).objectFit == 'contain') {
      sx = sy = Math.min(sx, sy);
      ox = (rect.width - c.width * sx) / 2;
      oy = (rect.height - c.height * sy) / 2;
    }
    return { scaleX: 1 / sx, scaleY: 1 / sy, left: rect.left + ox, top: rect.top + oy };
  }

  /* The pointer's position in guest pixels, clamped to the screen */
  guestPoint(ev, l = this.layout()) {
    return {
      x: Math.max(0, Math.min(this.canvas.width - 1, (ev.clientX - l.left) * l.scaleX)),
      y: Math.max(0, Math.min(this.canvas.height - 1, (ev.clientY - l.top) * l.scaleY)),
    };
  }
  onLeave(ev) {
    // Clamped, since the guest cursor stopped at the screen edge
    if (!this.locked && !this.absolute) this.exit = this.guestPoint(ev);
  }
  onEnter(ev) {
    if (this.locked || this.absolute) return;
    let p = this.guestPoint(ev);
    if (!this.calibrated) this.calibrate(p);
    else if (this.exit) this.sendDelta(p.x - this.exit.x, p.y - this.exit.y);
    else return;
    this.exit = null;
    this.entered = true;
  }
  /* Pin the guest cursor into the corner nearest `p`, then move it to `p`. Large
     packets are fine for pinning: acceleration only pushes it further in. */
  calibrate(p) {
    let w = this.canvas.width, h = this.canvas.height;
    let right = p.x >= w / 2, bottom = p.y >= h / 2;
    for (let i = Math.ceil(Math.max(w, h) / 255) + 2; i > 0; i--) this.send('mouse-delta', [right ? 255 : -255, bottom ? -255 : 255]);
    this.rest = { x: 0, y: 0 };
    this.sendDelta(p.x - (right ? w - 1 : 0), p.y - (bottom ? h - 1 : 0));
    this.calibrated = true;
  }

  onMove(ev) {
    let l = this.layout();
    if (!this.locked) {
      let p = this.guestPoint(ev, l);
      this.send('mouse-absolute', [p.x, p.y, this.canvas.width, this.canvas.height]);
      // The pointer can already be over the canvas when it starts (no enter event)
      if (!this.absolute && !this.calibrated) { this.calibrate(p); return; }
    }
    // Relative movement: raw when locked (the guest's acceleration applies, like a
    // real mouse), otherwise in guest pixels so it keeps pace with our cursor. Absolute
    // guests need it too: the VMware pointer raises no interrupt of its own, its driver
    // reads the position when woken by a PS/2 packet.
    // The move that brings the pointer in is measured from outside the canvas, and
    // onEnter already moved the guest cursor there.
    if (this.entered) { this.entered = false; return; }
    let dx = ev.movementX, dy = ev.movementY;
    if (!this.locked) { dx *= l.scaleX; dy *= l.scaleY; }
    this.sendDelta(dx, dy);
  }
  /* Relative movement in guest pixels (y down), carrying sub-pixel remainders over */
  sendDelta(dx, dy) {
    dx += this.rest.x; dy += this.rest.y;
    let ix = Math.trunc(dx), iy = Math.trunc(dy);
    this.rest = { x: dx - ix, y: dy - iy };
    // PS/2 deltas are 9-bit signed, so split big moves
    while (ix || iy) {
      let px = Math.max(-255, Math.min(255, ix)), py = Math.max(-255, Math.min(255, iy));
      this.send('mouse-delta', [px, -py]);
      ix -= px; iy -= py;
    }
  }
  onButton(ev, down) {
    let i = [0, 2, 1][ev.button]; // DOM: 0 left, 1 middle, 2 right
    if (i === undefined) return;
    ev.preventDefault();
    this.canvas.focus();
    // A click that captures the mouse isn't passed on to the guest
    if (down && this.captureOnClick && !this.locked) {
      this.swallowUp = ev.button;
      this.lock().catch(e => console.warn('Emularity: pointer lock failed', e));
      return;
    }
    if (!down && this.swallowUp === ev.button) { this.swallowUp = null; return; }
    // Keep receiving moves while a button is held, even outside the canvas (drags).
    // Not while locked: the lock already keeps them, and capture throws.
    if (down && !this.locked) this.canvas.setPointerCapture(ev.pointerId);
    this.buttons[i] = down;
    this.send('mouse-click', this.buttons.slice());
  }
  onWheel(ev) {
    ev.preventDefault();
    if (ev.deltaY) this.send('mouse-wheel', [Math.sign(ev.deltaY), 0]);
  }
}
