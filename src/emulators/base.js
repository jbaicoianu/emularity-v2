import { BaseClass } from '../baseclass.js'
import { VirtualFile } from '../fs/virtualfile.js'

let canvasID = 0;
export class BaseEmulator extends BaseClass {
  arguments = ''
  wasmroot = ''
  wasmscript = ''
  wasmfile = null
  wasminit = ''
  splashlogo = 'emularity-transparent.png'
  bgcolor = '#000'
  progressbgcolor = '#222'
  progressfgcolor = '#090'
  progressbordercolor = '#777'
  progresserrorcolor = '#900'
  progresserrorbordercolor = '#f00'
  progresscompletebordercolor = '#0f0'
  fontcolor = '#fff'
  emulatorroot = '/emulator'
  resolution = '800x600'
  splashresolution = '800x600'
  sound = true
  autostart = true
  canvas = null
  files = {}
  oncreate = null
  onpreinit = null
  onprerun = null
  oncanvaschange = null
  onrun = null

  constructor(settings) {
    super();
    this.settings = settings;
    this.extraargs = [] ;
  }
  connectedCallback() {
    if (!this.settings) this.settings = {};
    this.loadSettingsFromAttributes();
    this.classList.add('emularity-emulator');
    this.status = 'Initializing...';

    if (this.oncreate) this.addEventListener('create', ev => new Function(this.oncreate).call(this, ev));
    if (this.onpreinit) this.addEventListener('preinit', ev => new Function(this.onpreinit).call(this, ev));
    if (this.onprerun) this.addEventListener('prerun', ev => new Function(this.onprerun).call(this, ev));
    if (this.onrun) this.addEventListener('run', ev => new Function(this.onrun).call(this, ev));
    if (this.oncanvaschange) this.addEventListener('canvaschange', ev => new Function(this.oncanvaschange).call(this, ev));

    this.dispatchEvent(new CustomEvent('create'));

    if (this.autostart) {
      setTimeout(() => {
        this.start();
      }, 0);
    }
  }
  loadSettingsFromAttributes() {
    let properties = Object.getOwnPropertyNames(this);
    properties.forEach(propname => {
      if (this.hasAttribute(propname)) {
        this.settings[propname] = this.getAttribute(propname);
      }
    });

    if (this.settings['sound'] == 'false' || this.settings['sound'] == '0') this.settings['sound'] = false;
    if (this.settings['autostart'] == 'false' || this.settings['autostart'] == '0') this.settings['autostart'] = false;

    this.setSettings(this.settings);
  }
  setSettings(settings={}) {
    for (let k in settings) {
      this[k] = settings[k];
      this.setAttribute(k, settings[k]);
    }
    this.scripturl = this.wasmroot + '/' + this.wasmscript;

    if (this.files) {
      for (let path in this.files) {
        this.addFile(path, this.files[path]);
      }
    }
  }
  start() {
    if (this.settings) this.setSettings(this.settings);
    this.initLoadingScreen().then(() => {
      this.load(this.scripturl, this.wasminit);
    });
  }
  async load(scripturl, wasminit=null) {
    let fullurl = new URL(scripturl, location.href).href;
    let hasScript = false;
    this.module = await this.initModule();
    if (wasminit !== null) {
      hasScript = (typeof self[wasminit] != 'undefined');
    } else {
      if (typeof importScripts == 'function') {
        hasScript = (typeof Module != 'undefined');
      } else {
        let scripts = document.querySelectorAll('script');


        scripts.forEach(script => {
          if (script.src == fullurl) {
            //hasScript = true;
          }
        });
      }
    }
    return new Promise(resolve => {
      if (!hasScript) {
        if (typeof document == 'undefined') {
          self.Module = this.module;
          self.screen = { width: 1024, height: 768 };
          if (this.module.canvas instanceof OffscreenCanvas) {
            this.module.canvas.style = {};
          }
          this.module.specialHTMLTargets = [this.module.canvas];
          this.module.specialHTMLTargets['#canvas'] = this.module.canvas;
          importScripts(scripturl);
          this.handleScriptLoad();
        } else {
          window.Module = this.module;
          let script = document.createElement('script');
          script.src = scripturl;
          document.body.appendChild(script);
          script.addEventListener('load', ev => {
            this.handleScriptLoad();
          });
        }
      } else {
        this.handleScriptLoad();
      }
    });
  }
  async handleScriptLoad() {
    let module = this.module;
    return new Promise(resolve => {
      if (this.wasminit && this.wasminit in self) {
        self[this.wasminit](module).then(module => {
          resolve(module)
        });
      } else if (!this.wasminit && typeof Module != 'undefined') {
        //window.Module = module;
        //for (let k in module) {
        //  Module[k] = module[k];
        //}
/*
        Module.preInit = module.preInit;
        Module.preRun = module.preRun;
        Module.onRuntimeInitialized = module.onRuntimeInitialized;
        Module.canvas = module.canvas;
*/
        resolve(module);
      }
    });
  }
  async initModule() {
    let success = await this.preinitFilesystem();

    if (!success) {
      return false;
    }
    let module = this.module = {
      arguments: this.getArguments(),
      noInitialRun: false,
      canvas: this.getCanvas(),
      preInit: () => {
        //module.ENV.SDL_HINT_EMSCRIPTEN_KEYBOARD_ELEMENT = "#" + this.canvas.id;
        //module.funcs.env.setenv('SDL_HINT_EMSCRIPTEN_KEYBOARD_ELEMENT', this.canvas.id);
        this.setStatus('Loading system...');
        this.dispatchEvent(new CustomEvent('preinit'));
      },
      preRun: [ () => {
        this.initEmscriptenFilesystem(module.FS || self.FS);
        module.elementPointerLock = false;
        //module.ENV.SDL_HINT_EMSCRIPTEN_KEYBOARD_ELEMENT = "#" + this.canvas.id;
/*
        module.funcs.env.setenv('SDL_HINT_EMSCRIPTEN_KEYBOARD_ELEMENT', this.canvas.id);
        module.funcs.canvas.setEmscriptenCanvasID(this.canvas.id);
*/
        this.setStatus('Starting...');
        this.dispatchEvent(new CustomEvent('prerun'));
      }],
      onRuntimeInitialized: () => {
        this.setStatus('Running');
        // Replace splash canvas with emulator canvas, and emit an event
        if (this.splashcanvas && this.splashcanvas.parentNode) {
          this.splashcanvas.parentNode.removeChild(this.splashcanvas);
        }
        if (this.canvas && this.canvas.parentNode != this) {
          this.appendChild(this.canvas);
        }
        this.dispatchEvent(new CustomEvent('canvaschange', { detail: this.canvas }));
        this.dispatchEvent(new CustomEvent('run'));
      },
      websocket: { url: 'wss://' },
    };
    if (this.wasmfileloader && this.wasmfileloader.data) {
      module.wasmBinary = this.wasmfileloader.data;
    }
    return module;
  }
  getCanvas() {
    if (!this.canvas) {
      if (typeof document != 'undefined') {
        let canvas = document.createElement('canvas');
        this.canvas = canvas;
        canvas.id = 'canvas'// + canvasID++;
        let res = this.getResolution();
        canvas.width = res.x;
        canvas.height = res.y;
        this.canvas = canvas;
      } else {
        // TODO - do something with OffscreenCanvas here, eg, pass a canvas from the main thread
      }
    }
        let canvas = this.canvas;
        canvas.id = 'canvas'// + canvasID++;
        let res = this.getResolution();
        canvas.width = res.x;
        canvas.height = res.y;
    return this.canvas;
  }
  initLoadingScreen() {
    return new Promise(resolve => {
      if (typeof document != 'undefined') {
        let canvas = document.createElement('canvas');
        let res = this.getResolution(this.splashresolution);
        canvas.width = res.x;
        canvas.height = res.y;
        this.appendChild(canvas);
        this.splashcanvas = canvas;
        this.splashctx = canvas.getContext('2d');
        canvas.addEventListener('touchstart', ev => this.handleTouchStart(ev));
        if (this.splashlogo) {
          let img = new Image();
          img.src = this.splashlogo;
          this.logo = img;
          img.addEventListener('load', ev => {
            this.drawLogo();
            resolve();
          });
        } else {
          resolve();
        }
      } else {
        // Running in a worker - what should we do hereo?
        resolve();
      }
    });
  }
  getResolution(resstr) {
    if (!resstr) resstr = this.resolution;
    let res = resstr.split('x');
    return {x: res[0], y: res[1]};
  }
  getLogoScale(img) {
    let aspect = img.width / img.height;
    // max 60% height
    let scale = 1;
    if (img.height > this.splashcanvas.height) {
      scale = (this.splashcanvas.height * .6) / img.height;
    }
    return scale;
  }
  drawLogo() {
    this.splashcanvas.width = this.splashcanvas.width;
    let img = this.logo;
    let aspect = img.width / img.height;
    let scale = this.getLogoScale(this.logo);
    let imgw = img.width * scale,
        imgh = (img.width / aspect) * scale;
    let ctx = this.splashctx;
    ctx.fillStyle = this.bgcolor;
    ctx.fillRect(0, 0, this.splashcanvas.width, this.splashcanvas.height);
    ctx.drawImage(img, (this.splashcanvas.width - imgw) / 2, 0, imgw, imgh);
    this.drawStatus();
  }
  setStatus(statustext) {
    this.status = statustext;
    this.drawStatus();
  }
  drawStatus() {
    let canvas = this.splashcanvas,
        ctx = this.splashctx;
    if (!ctx || !this.logo) return;
    let height = 20,
        logoscale = this.getLogoScale(this.logo),
        logoaspect = this.logo.width / this.logo.height,
        ypos = (this.logo.height * logoscale);
    ctx.fillStyle = this.bgcolor;
    ctx.fillRect(0, ypos, canvas.width, height);
    ctx.font = 'bold ' + (height * .8) + 'px sans-serif';
    ctx.fillStyle = this.fontcolor;
    ctx.textAlign = 'center';
    ctx.fillText(this.status, canvas.width / 2, ypos + height * .8);
  }
  drawProgressBar(num, file, total=null, progress=null, error=false) {
    let canvas = this.splashcanvas,
        ctx = this.splashctx;
    if (!ctx || !this.logo) return;

    let marginx = 5,
        marginy = 1,
        logoscale = this.getLogoScale(this.logo),
        height = 20,
        radius = height / 2,
        logoaspect = this.logo.width / this.logo.height,
        //ypos = (canvas.height - this.logo.width / logoaspect) + (num + 2) * (height + marginy * 2),
        ypos = (this.logo.height * logoscale) + (num + 1) * (height + marginy * 2),
        width = canvas.width;

    ctx.save();
    ctx.beginPath();
    ctx.arc(marginx + radius, ypos + radius, radius, Math.PI/2, -Math.PI/2);
    ctx.moveTo(marginx + radius, ypos);
    ctx.lineTo(width - marginx - radius, ypos);
    ctx.arc(width - marginx - radius, ypos + radius, radius, -Math.PI/2, Math.PI/2);
    ctx.moveTo(width - marginx - radius, ypos + height);
    ctx.lineTo(marginx + radius, ypos + height);
    ctx.arc(marginx + radius, ypos + radius, radius, Math.PI/2, -Math.PI/2);
    ctx.fillStyle = this.progressbgcolor;
    ctx.clip();

    ctx.fillRect(marginx, ypos, width - marginx, height);
    let bordercolor = this.progressbordercolor;
    if (error) {
      bordercolor = this.progresserrorbordercolor;
      ctx.fillStyle = this.progresserrorcolor;
      ctx.fillRect(marginx, ypos, width - marginx, height);
      ctx.fillStyle = this.fontcolor;
      ctx.textAlign = 'center';
      ctx.font = (height * .8) + 'px sans-serif';
      let text = file.label || file.url;
      ctx.fillText(`${text} (${error})`, canvas.width / 2, ypos + height * .8);
    } else if (progress !== null && total !== null) {
      let percent = progress / total;
      ctx.fillStyle = this.progressfgcolor;
      ctx.fillRect(marginx, ypos, (width - marginx) * percent, height);
      ctx.fillStyle = this.fontcolor;
      ctx.textAlign = 'center';
      ctx.font = (height * .8) + 'px sans-serif';
      let text = file.label || file.url;
      ctx.fillText(`${text} (${this.formatBytes(progress)} / ${this.formatBytes(total)} - ${(percent * 100).toFixed(0)}%)`, canvas.width / 2, ypos + height * .8);
      if (percent >= 1) {
        bordercolor = this.progresscompletebordercolor;
      }
    } else {
      ctx.fillStyle = this.fontcolor;
      ctx.textAlign = 'center';
      ctx.font = (height * .8) + 'px sans-serif';
      ctx.fillText(file.label || file.url, canvas.width / 2, ypos + height * .8);
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = bordercolor;
    ctx.stroke();
    ctx.restore();

  }
  formatBytes(bytes) {
    const labels = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    for (let i = 0; i < labels.length; i++) {
      if (value < 1024) {
        return (+value).toFixed(1) + labels[i];
      }
      value /= 1024;
    }
  }
  getArguments() {
    let args = this.arguments.length > 0 ? this.arguments.split(' ') : [];
    if (this.extraargs.length > 0) {
      args.push.apply(args, this.extraargs);
    }
    return args;
  }
  async preinitFilesystem() {
    // load files
    this.setStatus('Downloading...');
    let files = this.getFiles();
    let promises = [];
    let dlnum = 0;

    let success = true;
    for (let i = 0; i < files.length; i++) {
      if (files[i].url) {
        let fileno = dlnum++;
        this.drawProgressBar(fileno, files[i]);
        files[i].addEventListener('progress', ev => this.drawProgressBar(fileno, files[i], ev.detail.total, ev.detail.complete));
        files[i].addEventListener('error', ev => {
          this.drawProgressBar(fileno, files[i], 0, 0, ev.detail);
          if (!files[i].optional) {
            success = false;
          }
        });
      }
    }
    await Promise.all(files.map(f => f.fetch()));
    if (!success) {
      this.setStatus('Failed!');
      return false;
    }
    this.setStatus('Initializing filesystem...');

    // initialize BrowserFS filesystem
    let inMemoryFS = new BrowserFS.FileSystem.InMemory();
    let deltaFS = inMemoryFS;
    if (false) { // FIXME - IndexedDB is causing issues with filesystem remnants preventing zips from mounting, just use inMemoryFS for now
      await new Promise((resolve, reject) => {
        // If the browser supports IndexedDB storage, mirror writes to that storage for persistence purposes.
        if (BrowserFS.FileSystem.IndexedDB.isAvailable()) {
          // Read-only inMemoryFS with an IndexedDB-backed write layer overlay
          deltaFS = new BrowserFS.FileSystem.AsyncMirror(
                      inMemoryFS,
                      new BrowserFS.FileSystem.IndexedDB(function(e, fs) {
                        if (e) {
                          // we probably weren't given access;
                          // private window for example.
                          // don't fail completely, just don't
                          // use indexeddb
                          deltaFS = inMemoryFS;
                          resolve();
                        } else {
                          // Initialize deltaFS by copying files from async storage to sync storage.
                          deltaFS.initialize(function (e) {
                                               if (e) {
                                                 reject(e);
                                               } else {
                                                 resolve()
                                               }
                                             });
                        }
                      },
                      this.systemname)
                    );
        }
      });
    }

    // Any file system writes to MountableFileSystem will be written to the
    // deltaFS, letting us mount read-only zip files into the MountableFileSystem
    // while being able to "write" to them.
    let bfs = this.bfs = new BrowserFS.FileSystem.OverlayFS(deltaFS, new BrowserFS.FileSystem.MountableFileSystem());
    await new Promise((resolve, reject) => {
      bfs.initialize((e) => {
        if (e) {
          console.error("Failed to initialize the OverlayFS:", e);
          reject();
        } else {
          resolve();
        }
      });
    });
    return true;
  }
  initEmscriptenFilesystem(fs) {
    this.fs = fs;
    fs.mkdir(this.emulatorroot);
    // FIXME - we shouldn't need to do this when running with modules!
    self.FS = fs;
    if (!self.PATH && this.module.PATH) self.PATH = this.module.PATH;
    if (!self.ERRNO_CODES && this.module.ERRNO_CODES) self.ERRNO_CODES = this.module.ERRNO_CODES;
    this.module.PATH = self.PATH;
    this.module.ERRNO_CODES = self.ERRNO_CODES;
    //this.module.FS.PATH = this.module.PATH;
    self.Module = this.module;

    BrowserFS.initialize(this.bfs);
    let emscriptenfs = new BrowserFS.EmscriptenFS();
    emscriptenfs.FS = fs;
    fs.mount(emscriptenfs, {root: '/'}, this.emulatorroot);
    const bfs = this.bfs;

    // Mount all files associated with this machine
    let files = this.getFiles();
    const Buffer = BrowserFS.BFSRequire('buffer').Buffer;
    files.forEach(f => {
      if (f.mountpoint) {
        if (f.data) {
          if (bfs.existsSync(f.mountpoint)) {
            // If a directory already exists at the path we're trying to mount this drive, remove it
            // otherwise the running system will be unable to load files
            bfs.rmdirSync(f.mountpoint);
          }
          let zfs = new BrowserFS.FileSystem.ZipFS(new Buffer(f.data));
          bfs.getOverlayedFileSystems().readable.mount(f.mountpoint, zfs);
        } else {
          if (!bfs.existsSync(f.mountpoint)) {
            bfs.mkdirSync(f.mountpoint);
          }
        }
      } else if (f.path && f.data) {
        fs.writeFile(this.emulatorroot + f.path, f.data);
      }
    });
  }
  getFiles() {
    let files = [];
    if (this.scripturl) {
      // Prefetch WASM file so we have a nice progress bar in the UI for it
      let wasmfile = new VirtualFile({
        url: this.wasmfile ? this.wasmroot + '/' + this.wasmfile : this.scripturl.replace('.js', '.wasm'),
        label: 'Emulator System',
      });
      files.push(wasmfile);
      this.wasmfileloader = wasmfile;
    }
    this.childNodes.forEach(n => {
      if (n instanceof VirtualFile) {
        files.push(n);
      }
    });
    return files;
  }
  addFile(path, file) {
    file.setAttribute('path', path);
    file.path = path;
    this.appendChild(file);
  }
  addArgument() {
    this.extraargs.push.apply(this.extraargs, arguments);
  }
  handleTouchStart(ev) {

  }
  cloneKeyboardEvent(ev) {
    let evargs = {};
    ['type', 'key', 'code', 'charCode', 'keyCode', 'shiftKey', 'ctrlKey', 'altKey', 'metaKey', 'detail', 'eventPhase', 'bubbles', 'cancelable', 'composed', 'data'].forEach(k => {
      evargs[k] = ev[k];
    });
    if (ev.key == 'Undentified') {
    }
    this.textarea.value += '\n' + JSON.stringify(evargs);
    let newev = new KeyboardEvent(ev.type, evargs);
    return newev;
  }
}

