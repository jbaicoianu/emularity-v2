/* What the machine's devices are doing: disk reads and writes, floppy motors and head
   seeks, network traffic, cartridge saves... Each emulator lists the devices it can
   report on, and reports what they do as DOM events on its element, so a page can light
   up drive lights, play drive noises, and so on, the same way for every system.

   The devices: emulator.activityDevices, a list of
     { id, kind, label, medium, features }
       id        'fda', 'c', 'hda', 'net0'... (unique to the emulator)
       kind      'floppy' | 'cdrom' | 'hdd' | 'network' | 'save'
       label     'Floppy A:', 'Drive C:'...
       medium    the name of the disk in the drive (or null, empty, or not a drive)
       features  what it reports: some of 'read', 'write', 'seek', 'motor',
                 'transmit', 'receive'. (DOSBox, for one, has no floppy motor or head
                 to report on; a page making noises would fake those from reads.)

   Events, on the emulator element:
     activitydeviceschange  the devices (or what's in them) changed; detail: the list
     activity               detail: { device, kind, type, bytes, count, ... }
       type 'read' | 'write' | 'transmit' | 'receive': `count` operations moving
            `bytes` bytes. Busy devices do thousands a second, so these are batched:
            the first of a burst is sent at once (for a sound to start on time), then
            at most one every WINDOW ms per device and type, summing what happened.
       type 'seek': the head moved, { from, to } (tracks); sent as it happens
       type 'motor': the motor started or stopped, { on }; sent as it happens
     activitystart / activityend  a device got busy, or went quiet for IDLE ms
            (reads, writes and traffic, not motors); detail: { device, kind } */
export class ActivityReporter {
  static WINDOW = 50
  static IDLE = 250

  constructor(target) {
    this.target = target;
    this.devices = [];
    this.pending = new Map(); // 'id type' -> { dev, type, bytes, count, extra, timer }
    this.busy = new Map();    // id -> { last, timer }
  }
  /* Replace the device list */
  setDevices(list) {
    this.devices = list.map(d => ({ medium: null, features: [], ...d }));
    this.changed();
  }
  /* Add a device, or update one */
  setDevice(d) {
    let i = this.devices.findIndex(x => x.id == d.id);
    if (i < 0) this.devices.push({ medium: null, features: [], ...d });
    else this.devices[i] = { ...this.devices[i], ...d };
    this.changed();
  }
  device(id) {
    return this.devices.find(d => d.id == id);
  }
  changed() {
    this.emit('activitydeviceschange', this.devices.map(d => ({ ...d })));
  }

  report(id, type, { bytes = 0, ...extra } = {}) {
    let dev = this.device(id);
    if (!dev) return;
    if (type == 'seek' || type == 'motor') {
      if (type == 'motor') dev.motor = extra.on;
      this.emit('activity', { device: id, kind: dev.kind, type, ...extra });
      return;
    }
    this.markBusy(dev);
    let key = id + ' ' + type, p = this.pending.get(key);
    if (!p) {
      this.emit('activity', { device: id, kind: dev.kind, type, bytes, count: 1, ...extra });
      p = { dev, type, bytes: 0, count: 0, extra: null };
      p.timer = setTimeout(() => this.flush(key), ActivityReporter.WINDOW);
      this.pending.set(key, p);
    } else {
      p.bytes += bytes;
      p.count++;
      p.extra = extra;
    }
  }
  flush(key) {
    let p = this.pending.get(key);
    if (!p) return;
    if (!p.count) return this.pending.delete(key);
    this.emit('activity', { device: p.dev.id, kind: p.dev.kind, type: p.type, bytes: p.bytes, count: p.count, ...p.extra });
    p.bytes = p.count = 0;
    p.timer = setTimeout(() => this.flush(key), ActivityReporter.WINDOW);
  }
  /* One timer per busy device, put off (rather than reset) as more happens */
  markBusy(dev) {
    let now = performance.now(), b = this.busy.get(dev.id);
    if (b) { b.last = now; return; }
    b = { last: now };
    let check = () => {
      let wait = b.last + ActivityReporter.IDLE - performance.now();
      if (wait > 0) { b.timer = setTimeout(check, wait); return; }
      this.busy.delete(dev.id);
      this.emit('activityend', { device: dev.id, kind: dev.kind });
    };
    b.timer = setTimeout(check, ActivityReporter.IDLE);
    this.busy.set(dev.id, b);
    this.emit('activitystart', { device: dev.id, kind: dev.kind });
  }
  emit(type, detail) {
    this.target.dispatchEvent(new CustomEvent(type, { detail }));
  }
  stop() {
    for (let p of this.pending.values()) clearTimeout(p.timer);
    for (let b of this.busy.values()) clearTimeout(b.timer);
    this.pending.clear();
    this.busy.clear();
  }

  /* Report reads and writes of an Emscripten module's files: watchFiles(FS, path =>
     device id or null). Disk images and drive folders are files to the emulator, so
     this covers most of what Emscripten-built emulators do with their disks. */
  watchFiles(fs, deviceFor) {
    if (!fs || fs.emularityActivity) return;
    fs.emularityActivity = true;
    let reporter = this, read = fs.read, write = fs.write;
    let lookup = stream => {
      if (stream.activityDevice === undefined) stream.activityDevice = stream.path ? deviceFor(stream.path) : null;
      return stream.activityDevice;
    };
    fs.read = function (stream) {
      let n = read.apply(this, arguments), id = lookup(stream);
      if (id) reporter.report(id, 'read', { bytes: n });
      return n;
    };
    fs.write = function (stream) {
      let n = write.apply(this, arguments), id = lookup(stream);
      if (id) reporter.report(id, 'write', { bytes: n });
      return n;
    };
  }
}
