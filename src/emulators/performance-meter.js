/* How hard the machine is working, sampled a couple of times a second while it runs, so
   a page can draw CPU graphs and the like the same way for every emulator (see
   src/ui/performance-graphs.js).

   The measures: emulator.performanceMetrics, a list of
     { id, label, unit, max, description }
       'load'  every emulator: the share of this computer's time spent emulating (on
               the page's main thread). Near 100%, the emulator can't keep up, and the
               machine runs slow.
       'cpu'   where the emulator can tell: how busy the emulated CPU is, as the share
               of time it isn't halted waiting for something to do. (Guests that never
               halt, such as DOS and Windows 9x, which wait by spinning, show 100%.)
       'mips'  where the emulator can tell: millions of instructions run a second.
     `max` is the top of the scale (100 for percentages), or null to fit the values.

   Events, on the emulator element:
     metricschange  the measures changed; detail: the list
     metrics        a sample, every INTERVAL ms while running;
                    detail: { time, values: { load: 42.1, cpu: 12.5, ... } }

   An emulator feeds it time spent emulating (busy), time its CPU sat halted (halted),
   and any other values when asked (sampler). */
export class PerformanceMeter {
  static INTERVAL = 500

  static LOAD = { id: 'load', label: 'Load', unit: '%', max: 100,
    description: "How much of your computer's time goes to emulating. Near 100%, it can't keep up, and the machine runs slow." }
  static CPU = { id: 'cpu', label: 'CPU', unit: '%', max: 100,
    description: "How busy the emulated CPU is: the share of time it isn't halted, waiting for something to do. Systems that wait by spinning (DOS, Windows 95/98) always show 100%." }
  static MIPS = { id: 'mips', label: 'Speed', unit: 'MIPS', max: null,
    description: 'Millions of instructions the emulated CPU runs a second.' }

  constructor(target) {
    this.target = target;
    this.metrics = [PerformanceMeter.LOAD];
    this.sampler = null; // () => ({ mips: ... }), for values measured at sample time
    this.busyMs = 0;
    this.haltedMs = 0;
  }
  setMetrics(list) {
    this.metrics = list;
    this.target.dispatchEvent(new CustomEvent('metricschange', { detail: list.map(m => ({ ...m })) }));
  }
  busy(ms) { this.busyMs += ms; }
  halted(ms) { this.haltedMs += ms; }

  start() {
    if (this.timer) return;
    this.last = performance.now();
    this.busyMs = this.haltedMs = 0;
    if (this.onStart) this.onStart();
    this.timer = setInterval(() => this.sample(), PerformanceMeter.INTERVAL);
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
  sample() {
    let now = performance.now(), wall = now - this.last;
    if (wall <= 0) return;
    let extra = this.sampler ? this.sampler(now, wall) : {};
    let values = { load: Math.min(100, this.busyMs / wall * 100), ...extra };
    if (this.metrics.some(m => m.id == 'cpu')) values.cpu = Math.max(0, 100 - this.haltedMs / wall * 100);
    this.last = now;
    this.busyMs = this.haltedMs = 0;
    this.target.dispatchEvent(new CustomEvent('metrics', { detail: { time: Date.now(), values } }));
  }

  /* Count the time spent in a WebAssembly instance's exported functions (and whatever
     they call) as busy: for Emscripten emulators, that's all of the emulating. Calls
     from inside a call aren't counted twice. Returns an instance-like { exports }. */
  timeExports(instance) {
    let meter = this, depth = 0, exports = {};
    for (let [name, value] of Object.entries(instance.exports)) {
      exports[name] = typeof value != 'function' ? value : function () {
        if (depth) return value.apply(this, arguments);
        depth = 1;
        let t = performance.now();
        try { return value.apply(this, arguments); }
        finally { depth = 0; meter.busyMs += performance.now() - t; }
      };
    }
    return { exports };
  }
}
