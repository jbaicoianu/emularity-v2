
let canvasID = 0;
export class Emulator extends HTMLElement {
  constructor() {
    super();
    this.FLAGS = {
      w: { isReadable: function() { return false; },
           isWriteable: function() { return true; },
           isTruncating: function() { return false; },
           isAppendable: function() { return false; },
           isSynchronous: function() { return false; },
           isExclusive: function() { return false; },
           pathExistsAction: function() { return 0; },
           pathNotExistsAction: function() { return 3; }
         },
      r: { isReadable: function() { return true; },
           isWriteable: function() { return false; },
           isTruncating: function() { return false; },
           isAppendable: function() { return false; },
           isSynchronous: function() { return false; },
           isExclusive: function() { return false; },
           pathExistsAction: function() { return 0; },
           pathNotExistsAction: function() { return 1; }
      }    
    };
    this.callbacks = {};
  }
  connectedCallback() {
    this.arguments = this.getAttribute('arguments') ?? '';
    this.wasmroot = this.getAttribute('wasmroot') ?? '';
    this.wasmscript = this.getAttribute('wasmscript') ?? '';
    this.initfunc = this.getAttribute('wasminit') ?? false;
    this.splashlogo = this.getAttribute('splashlogo') ?? 'emularity-transparent.png';
    this.bgcolor = this.getAttribute('bgcolor') ?? '#000';
    this.progressbgcolor = this.getAttribute('progressbgcolor') ?? '#222';
    this.progressfgcolor = this.getAttribute('progressfgcolor') ?? '#090';
    this.progressbordercolor = this.getAttribute('progressbordercolor') ?? '#777';
    this.progresserrorcolor = this.getAttribute('progresserrorcolor') ?? '#900';
    this.progresserrorbordercolor = this.getAttribute('progresserrorbordercolor') ?? '#f00';
    this.progresscompletebordercolor = this.getAttribute('progresscompletebordercolor') ?? '#0f0';
    this.fontcolor = this.getAttribute('fontcolor') ?? '#fff';
    this.scripturl = this.wasmroot + '/' + this.wasmscript;
    this.emulatorroot = this.getAttribute('emulatorroot') ?? '/emulator';
    this.resolution = this.getAttribute('resolution') ?? '800x600';
    this.splashresolution = this.getAttribute('splashresolution') ?? this.resolution;
    this.sound = this.getAttribute('sound') ?? true;

    if (this.sound == 'false' || this.sound == '0') this.sound = false;

    this.status = 'Initializing...';
    this.systemname = this.getAttribute('systemname') ?? "emulatatron2";
    this.classList.add('emularity-emulator');
    if (this.scripturl) {
      setTimeout(() => {
        this.load(this.scripturl, this.initfunc).then(module => {
          console.log('my module', module);
        });
      }, 0);
    }
  }
  async load(scripturl, initfunc=null) {
    let fullurl = new URL(scripturl, location.href).href;
    let scripts = document.querySelectorAll('script');
    let hasScript = false;

    await this.initLoadingScreen();

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
        this.executeCallbacks('preInit');
        this.dispatchEvent(new CustomEvent('preinit'));
      },
      preRun: () => {
        this.initEmscriptenFilesystem(module.FS || window.FS);
        module.elementPointerLock = false;
        //module.ENV.SDL_HINT_EMSCRIPTEN_KEYBOARD_ELEMENT = "#" + this.canvas.id;
/*
        module.funcs.env.setenv('SDL_HINT_EMSCRIPTEN_KEYBOARD_ELEMENT', this.canvas.id);
        module.funcs.canvas.setEmscriptenCanvasID(this.canvas.id);
*/
        this.setStatus('Starting...');
        this.executeCallbacks('preRun');
        this.dispatchEvent(new CustomEvent('prerun'));
      },
      onRuntimeInitialized: () => {
        this.setStatus('Running');
        // Replace splash canvas with emulator canvas, and emit an event
        if (this.splashcanvas.parentNode) {
          this.splashcanvas.parentNode.removeChild(this.splashcanvas);
        }
        if (this.canvas.parentNode != this) {
          this.appendChild(this.canvas);
        }
        this.dispatchEvent(new CustomEvent('canvaschange', { detail: this.canvas }));
        this.dispatchEvent(new CustomEvent('run'));
        this.executeCallbacks('onRuntimeInitialized');
      },
      websocket: { url: 'wss://' },
    };
    window.Module = module;
    scripts.forEach(script => {
      if (script.src == fullurl) {
        //hasScript = true;
      }
    });
    return new Promise(resolve => {
      if (!hasScript) {
        let script = document.createElement('script');
        script.src = scripturl;
        document.body.appendChild(script);
        script.addEventListener('load', ev => {
          if (initfunc && initfunc in window) {
            window[initfunc](module).then(module => resolve(module));
          } else if (!initfunc && typeof Module != 'undefined') {
            window.Module = module;
            //for (let k in module) {
            //  Module[k] = module[k];
            //}
            Module.preInit = module.preInit;
            Module.preRun = module.preRun;
            Module.onRuntimeInitialized = module.onRuntimeInitialized;
            Module.canvas = module.canvas;
            resolve(Module);
          }
        });
        
      } else {
        if (initfunc && initfunc in window) {
          window[initfunc](module).then(module => resolve(module));
        } else if (!initfunc && typeof Module != 'undefined') {
          Module.canvas = this.getCanvas();
          //window.Module = module;
          resolve(Module);
        }
      }
    });
  }
  getCanvas() {
    if (!this.canvas) {
      let canvas = document.createElement('canvas');
      this.canvas = canvas;
      canvas.id = 'canvas'// + canvasID++;
      let res = this.getResolution();
      canvas.width = res.x;
      canvas.height = res.y;
      this.canvas = canvas;
    }
    return this.canvas;
  }
  initLoadingScreen() {
    return new Promise(resolve => {
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
        return +value.toFixed(1) + labels[i];
      }
      value /= 1024;
    }
  }
  getArguments() {
    let args = this.arguments.length > 0 ? this.arguments.split(' ') : [];
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
    window.FS = fs;
    if (!window.PATH && this.module.PATH) window.PATH = this.module.PATH;
    if (!window.ERRNO_CODES && this.module.ERRNO_CODES) window.ERRNO_CODES = this.module.ERRNO_CODES;
    this.module.PATH = window.PATH;
    this.module.ERRNO_CODES = window.ERRNO_CODES;
    //this.module.FS.PATH = this.module.PATH;
    window.Module = this.module;

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
      let wasmfile = document.createElement('emularity-file');
      wasmfile.url = this.scripturl.replace('.js', '.wasm');
      wasmfile.label = 'Emulator System';
      files.push(wasmfile);
    }
    this.childNodes.forEach(n => {
      if (n instanceof EmulatorFile) {
        files.push(n);
      }
    });
    return files;
  }
  addFile(url, path) {
    let file = document.createElement('emularity-file');
    file.setAttribute('url', url);
    file.setAttribute('path', path);
    this.appendChild(file);
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
  setCallbacks(callbacks) {
    for (let k in callbacks) {
      if (!(k in this.callbacks)) {
        this.callbacks[k] = [];
      }
      this.callbacks[k].push(callbacks[k]);
    }
  }
  executeCallbacks(type) {
    if (type in this.callbacks) {
      this.callbacks[type].forEach(cb => cb());
    }
  }
}
export class EmulatorVirtualKeyboard extends HTMLElement {
  layout = 'pc101'
  layouts = {
    "pc101": [
      [
        {code: 'Escape', label: 'Esc', keyCode: 27, functionKey: true},
        {code: 'Digit1', label: '1', label2: '!', keyCode: 49},
        {code: 'Digit2', label: '2', label2: '@', keyCode: 50},
        {code: 'Digit3', label: '3', label2: '#', keyCode: 51},
        {code: 'Digit4', label: '4', label2: '$', keyCode: 52},
        {code: 'Digit5', label: '5', label2: '%', keyCode: 53},
        {code: 'Digit6', label: '6', label2: '^', keyCode: 54},
        {code: 'Digit7', label: '7', label2: '&', keyCode: 55},
        {code: 'Digit8', label: '8', label2: '*', keyCode: 56},
        {code: 'Digit9', label: '9', label2: '(', keyCode: 57},
        {code: 'Digit0', label: '0', label2: ')', keyCode: 48},
        {code: 'Minus', label: '-', label2: '_', keyCode: 189},
        {code: 'Equal', label: '=', label2: '+', keyCode: 187},
        {code: 'Backspace', label: '⌫', keyCode: 8, functionKey: true},
      ],
      [
        {code: 'Tab', label: 'Tab', keyCode: 9, functionKey: true},
        {code: 'KeyQ', label: 'Q', keyCode: 81},
        {code: 'KeyW', label: 'W', keyCode: 87},
        {code: 'KeyE', label: 'E', keyCode: 69},
        {code: 'KeyR', label: 'R', keyCode: 82},
        {code: 'KeyT', label: 'T', keyCode: 84},
        {code: 'KeyY', label: 'Y', keyCode: 89},
        {code: 'KeyU', label: 'U', keyCode: 85},
        {code: 'KeyI', label: 'I', keyCode: 73},
        {code: 'KeyO', label: 'O', keyCode: 79},
        {code: 'KeyP', label: 'P', keyCode: 80},

        {code: 'BracketLeft', label: '[', label2: '{', keyCode: 219},
        {code: 'BracketRight', label: ']', label2: '}', keyCode: 220},
        {code: 'Backslash', label: '\\', label2: '|', keyCode: 219},
        {code: 'Delete', label: 'Del', keyCode: 46, functionKey: true},
      ],
      [
        {code: 'CapsLock', label: 'Caps', keyCode: 20, functionKey: true},
        {code: 'KeyA', label: 'A', keyCode: 65},
        {code: 'KeyS', label: 'S', keyCode: 83},
        {code: 'KeyD', label: 'D', keyCode: 68},
        {code: 'KeyF', label: 'F', keyCode: 70},
        {code: 'KeyG', label: 'G', keyCode: 71},
        {code: 'KeyH', label: 'H', keyCode: 72},
        {code: 'KeyJ', label: 'J', keyCode: 74},
        {code: 'KeyK', label: 'K', keyCode: 75},
        {code: 'KeyL', label: 'L', keyCode: 76},

        {code: 'Semicolon', label: ';', label2: ':', keyCode: 186},
        {code: 'Quote', label: '\'', label2: '"', keyCode: 222},
        {code: 'Enter', label: '⏎ Enter', keyCode: 13, functionKey: true},
      ],
      [
        {code: 'ShiftLeft', label: '⇧ Shift', keyCode: 16, functionKey: true},
        {code: 'KeyZ', label: 'Z', keyCode: 90},
        {code: 'KeyX', label: 'X', keyCode: 88},
        {code: 'KeyC', label: 'C', keyCode: 67},
        {code: 'KeyV', label: 'V', keyCode: 86},
        {code: 'KeyB', label: 'B', keyCode: 66},
        {code: 'KeyN', label: 'N', keyCode: 78},
        {code: 'KeyM', label: 'M', keyCode: 77},

        {code: 'Comma', label: ',', label2: '<', keyCode: 188},
        {code: 'Period', label: '.', label2: '>', keyCode: 190},
        {code: 'Slash', label: '/', label2: '?', keyCode: 191},
        {code: 'ShiftRight', label: '⇧ Shift', keyCode: 16, functionKey: true},
        {code: 'ArrowUp', label: '↑', keyCode: 38},
        {code: 'PrintScreen', label: 'Print', keyCode: 44, functionKey: true},
      ],
      [
        {code: 'ControlLeft', label: 'Ctrl', keyCode: 17, functionKey: true},
        {code: 'AltLeft', label: 'Alt', keyCode: 18, functionKey: true},
        {code: 'Space', label: '&nbsp;', keyCode: 32, functionKey: true},
        {code: 'AltRight', label: 'Alt', keyCode: 18, functionKey: true},
        {code: 'ArrowLeft', label: '←', keyCode: 37},
        {code: 'ArrowDown', label: '↓', keyCode: 40},
        {code: 'ArrowRight', label: '→', keyCode: 39},
      ],
    ],
    "numpad": [
      [
        {code: 'NumLock', label: 'NumLock', keyCode: 144, functionKey: true},
        {code: 'NumpadDivide', label: '/', keyCode: 111, functionKey: true},
        {code: 'NumpadMultiply', label: '*', keyCode: 106, functionKey: true},
        {code: 'NumpadSubtract', label: '-', keyCode: 109, functionKey: true},
      ],
      [
        {code: 'Numpad7', label: '7', label2: '', keyCode: 103},
        {code: 'Numpad8', label: '8', label2: '', keyCode: 104},
        {code: 'Numpad9', label: '9', label2: '', keyCode: 105},
        {code: 'NumpadAdd', label: '+', keyCode: 107, functionKey: true},
      ],
      [
        {code: 'Numpad4', label: '4', label2: '', keyCode: 100},
        {code: 'Numpad5', label: '5', label2: '', keyCode: 101},
        {code: 'Numpad6', label: '6', label2: '', keyCode: 102},
      ],
      [
        {code: 'Numpad1', label: '1', label2: '', keyCode: 97},
        {code: 'Numpad2', label: '2', label2: '', keyCode: 98},
        {code: 'Numpad3', label: '3', label2: '', keyCode: 99},
        {code: 'NumpadEnter', label: '⏎', keyCode: 13, functionKey: true},
      ],
      [
        {code: 'Numpad0', label: '0', keyCode: 96},
        {code: 'NumpadDecimal', label: '.', label2: 'Del', keyCode: 110 },
      ],
    ],
    'ti-82': [
      [
        {code: 'F1', label: 'Y=', label2: 'STAT PLOT', keyCode: 97, className: 'function'},
        {code: 'F2', label: 'WINDOW', label2: 'TblSet', keyCode: 97, className: 'function'},
        {code: 'F3', label: 'ZOOM', keyCode: 97, className: 'function'},
        {code: 'F4', label: 'TRACE', label2: 'CALC', keyCode: 97, className: 'function'},
        {code: 'F5', label: 'GRAPH', label2: 'TABLE', keyCode: 97, className: 'function'},
      ],
      [
        {code: 'AltLeft', label: '2nd', keyCode: 97, className: 'second beginrow'},
        {code: 'Escape', label: 'MODE', label2: 'QUIT', keyCode: 97},
        {code: 'Delete', label: 'DEL', label2: 'INS', keyCode: 97, className: 'endrow'},

        {code: 'ShiftLeft', label: 'ALPHA', label2: "A-LOCK", keyCode: 97, className: 'numeric beginrow'},
        {code: 'KeyX', label: 'X,T,θ', label2: 'LINK', keyCode: 97},
        {code: 'Backquote', label: 'STAT', label2: 'LIST', keyCode: 97, className: 'endrow'},

        {code: 'F6', label: 'MATH', label2: 'TEST', label3: 'A', keyCode: 97, className: 'beginrow'},
        {code: 'F7', label: 'MATRX', label2: 'ANGLE', label3: 'B', keyCode: 97},
        {code: 'F8', label: 'PRGM', label2: 'DRAW', label3: 'C', keyCode: 97},
        {code: 'F9', label: 'VARS', label2: 'Y-VARS', keyCode: 97},
        {code: 'PageDown', label: 'CLEAR', keyCode: 97},

        {code: 'Comma', label: '𝓍⁻¹', label2: 'ABS', label3: 'D', keyCode: 97},
        {code: 'Insert', label: 'SIN', label2: 'SIN⁻¹', label3: 'E', keyCode: 97},
        {code: 'Home', label: 'COS', label2: 'COS⁻¹', label3: 'F', keyCode: 97},
        {code: 'PageUp', label: 'TAN', label2: 'TAN⁻¹', label3: 'G', keyCode: 97},
        {code: 'KeyP', label: '^', label2: 'π', label3: 'H', keyCode: 97},

        {code: 'Semicolon', label: '𝓍²', label2: '√', label3: 'I', keyCode: 97},
        {code: 'End', label: ',', label2: 'EE', label3: 'J', keyCode: 97},
        {code: 'BracketLeft', label: '(', label2: '{', label3: 'K', keyCode: 97},
        {code: 'BracketRight', label: ')', label2: '}', label3: 'L', keyCode: 97},
        {code: 'Slash', label: '÷', label3: 'M', keyCode: 97, className: 'operation'},

        {code: 'Quote', label: 'LOG', label2: '10ˣ', label3: 'N', keyCode: 97},
        {code: 'Digit7', label: '7', label2: 'Uₙ₋₁', label3: 'O', keyCode: 97, className: 'numeric'},
        {code: 'Digit8', label: '8', label2: 'Vₙ₋₁', label3: 'P', keyCode: 97, className: 'numeric'},
        {code: 'Digit9', label: '9', label2: '𝓃', label3: 'Q', keyCode: 97, className: 'numeric'},
        {code: 'KeyL', label: '✕', label2: '[', label3: 'R', keyCode: 97, className: 'operation'},

        {code: 'Backslash', label: 'LN', label2: 'eˣ', label3: 'S', keyCode: 97},
        {code: 'Digit4', label: '4', label2: 'L4', label3: 'T', keyCode: 97, className: 'numeric'},
        {code: 'Digit5', label: '5', label2: 'L5', label3: 'U', keyCode: 97, className: 'numeric'},
        {code: 'Digit6', label: '6', label2: 'L6', label3: 'V', keyCode: 97, className: 'numeric'},
        {code: 'Minus', label: '−', label2: ']', label3: 'W', keyCode: 97, className: 'operation'},

        {code: 'KeyS', label: 'STO▶', label2: 'RCL', label3: 'X', keyCode: 97},
        {code: 'Digit1', label: '1', label2: 'L1', label3: 'Y', keyCode: 97, className: 'numeric'},
        {code: 'Digit2', label: '2', label2: 'L2', label3: 'Z', keyCode: 97, className: 'numeric'},
        {code: 'Digit3', label: '3', label2: 'L3', label3: 'θ', keyCode: 97, className: 'numeric'},
        {code: 'Equal', label: '+', label2: 'MEM', label3: '"', keyCode: 97, className: 'operation'},

        {code: 'KeyQ', label: 'ON', label2: 'OFF', label3: 'A', keyCode: 97, className: 'onoff'},
        {code: 'Digit0', label: '0', label3: '␣', keyCode: 97, className: 'numeric'},
        {code: 'Period', label: '.', label2: ':', keyCode: 97, className: 'numeric'},
        {code: 'KeyM', label: '(-)', label2: 'ANS', label3: '?', keyCode: 97, className: 'numeric'},
        {code: 'Enter', label: 'ENTER', label2: 'ENTRY', keyCode: 97, className: 'enter'},

        {code: 'ArrowLeft', label: '◀', keyCode: 97, className: 'operation arrow_left'},
        {code: 'ArrowRight', label: '▶', keyCode: 97, className: 'operation arrow_right'},
        {code: 'ArrowUp', label: '▲', keyCode: 97, className: 'operation arrow_up'},
        {code: 'ArrowDown', label: '▼', keyCode: 97, className: 'operation arrow_down'},
      ]
    ],
  }
  constructor() {
    super();
    // TODO - should be (optionally) attached to specific DOM elements, eg, focused emulator canvas
    this.layout = this.getAttribute('layout') ?? 'pc101';
    window.addEventListener('keydown', ev => this.highlightKey(ev.code, true));
    window.addEventListener('keyup', ev => this.highlightKey(ev.code, false));
    window.addEventListener('blur', ev => { this.highlightKey('AltLeft', false); this.highlightKey('AltRight', false); });
  }
  connectedCallback() {
    if (!this.keyboard) {
      this.keyboard = this.createLayout(this.layout);
    }
  }
  createLayout(layoutname) {
    let keyboard = document.createElement('div');
    if (layoutname in this.layouts) {
      let layout = this.layouts[layoutname];
      layout.forEach(row => {
        let rowel = this.createKeyRow(row);
        keyboard.appendChild(rowel);
      });
    }
    this.appendChild(keyboard);
    return keyboard;
  }
  createKeyRow(rowdef) {
    let row = document.createElement('div');
    row.className = 'keyboard-row';
    rowdef.forEach(keydef => {
      let key = document.createElement('button');
      key.className = 'keyboard-key ' + keydef.code;
      if (keydef.functionKey) key.classList.add('function-key');
      if (keydef.className) keydef.className.split(' ').forEach(className => key.classList.add(className));

      let label = document.createElement('span');
      label.className = 'key-label';
      label.innerHTML = keydef.label;
      key.appendChild(label);
      if (keydef.label2) {
        let label2 = document.createElement('span');
        label2.className = 'key-label-2';
        label2.innerHTML = keydef.label2;
        key.appendChild(label2);
      }
      if (keydef.label3) {
        let label3 = document.createElement('span');
        label3.className = 'key-label-3';
        label3.innerHTML = keydef.label3;
        key.appendChild(label3);
      }
      key.addEventListener('mousedown', ev => this.handleVirtualKey('keydown', keydef, key));
      key.addEventListener('mouseup', ev => this.handleVirtualKey('keyup', keydef, key));
      key.addEventListener('touchstart', ev => { navigator.vibrate([1]); ev.preventDefault(); this.handleVirtualKey('keydown', keydef, key); });
      key.addEventListener('touchend', ev => this.handleVirtualKey('keyup', keydef, key));
      row.appendChild(key);
    });
    return row;
  }
  handleVirtualKey(type, keydef, key) {
    let evargs = {
      keyCode: keydef.keyCode,
      //key: keydef.key,
      code: keydef.code,
    };
    if (type == 'mousedown' || type == 'touchstart') {
      key.classList.add('active');
    } else if (type == 'mouseup' || type == 'touchend') {
      key.classList.remove('active');
    }
    let ev = new KeyboardEvent(type, evargs);
    window.dispatchEvent(ev);
  }
  clearLayout() {
    if (this.keyboard && this.keyboard.parentNode == this) {
      this.removeChild(this.keyboard);
      this.keyboard = false;
    }
  }
  highlightKey(code, active) {
console.log('highlight', code, active, this.keyboard);
    if (this.keyboard) {
      let key = this.keyboard.querySelector('.keyboard-key.' + code);
      if (key) {
        if (active) {
          key.classList.add('active');
        } else {
          key.classList.remove('active');
        }
      }
    }
  }
}
class EmulatorFile extends HTMLElement {
  constructor(url, mountpoint, label) {
    super();
    this.data = false;

  }
  connectedCallback() {
    this.url = this.getAttribute('url') ?? false;
    this.mountpoint = this.getAttribute('mountpoint') ?? false;
    this.path = this.getAttribute('path') ?? '';
    this.label = this.getAttribute('label') ?? false;
    let optional = this.getAttribute('optional') ?? false;
    this.optional = (!!optional && optional != 'false' && optional != '0' && optional != 'no');
  }
  async fetch() {
    if (this.url) {
      try {
        let res = await fetch(this.url);
        let contentLength = res.headers.get('Content-Length');

        if (contentLength) {
          //this.data = await res.arrayBuffer();
          let reader = res.body.getReader();
          let databuffer = new ArrayBuffer(contentLength),
              data = new Uint8Array(databuffer);
          let loaded = 0;
          while (true) {
            let {done, value} = await reader.read();
            //console.log('kachunk', value, done, loaded / contentLength);
            this.dispatchEvent(new CustomEvent('progress', { detail: { complete: loaded, total: contentLength } }));
            if (done) break;
            data.set(value, loaded);
            loaded += value.byteLength;
          }
          this.dispatchEvent(new CustomEvent('complete'));
          this.data = data;
        } else {
          this.data = await res.arrayBuffer();
        }
      } catch (e) {
console.error(e);
        this.dispatchEvent(new CustomEvent('error', { detail: e.message }));
      }
    }
    return this;
  }
}

/* DOSBox */
export class DOSBoxEmulator extends Emulator {
  constructor() {
    super();
    this.wasmroot = this.getAttribute('wasmroot') ?? '';
    this.wasmscript = this.getAttribute('wasmscript') ?? 'dosbox.module.js';
    this.scripturl = this.wasmroot + '/' + this.wasmscript;
    this.initfunc = this.getAttribute('wasminit') ?? 'createDOSBox';
    this.exe = this.getAttribute('exe') ?? ''
    this.classList.add('dosbox');
  }
  initEmscriptenFilesystem(fs) {
    super.initEmscriptenFilesystem(fs);
    let cfg = this.getConfig();
    this.fs.writeFile(this.emulatorroot + '/dosbox.conf', new TextEncoder().encode(cfg));
  }
  getArguments() {
    let args = this.arguments.length > 0 ? this.arguments.split(' ') : [];
    args.push('-conf', this.emulatorroot + '/dosbox.conf');
    return args;
  }
  getConfig() {
    let mounts = [];
    this.getFiles().forEach(f => {
      if (f.letter && f.mountpoint && f.mounttype) {
        mounts.push(`mount ${f.letter} ${this.emulatorroot}${f.mountpoint} -t ${f.mounttype}`);
      }
    });
    return `
      [serial]
      serial1=modem listenport:0

      [ipx]
      ipx=true

      [dosbox]
      ;fastbioslogo = true
      ;startbanner = false
      ;machine = svga_et4000
      ems = true
      memsize = 32
      dpi aware = false

      [cpu]
      cputype=486
      core = simple
      cycles = fixed 30000
      use dynamic core with paging on = false

      [dos]
      hard drive data rate limit = 0
      floppy drive data rate limit = 0

      [pci]
      voodoo=false

      [ide, primary]
      int13fakeio=true
      int13fakev86io=false

      [render]
      scaler=none


      [sdl]
      output=ttf
      doublescan=false
      showmenu=false
       
      [autoexec]
      rem @ECHO OFF
      ${mounts.join('\n')}
      ${this.exe ? this.exe : ''}
    `;
  }
/*
  getFiles() {
    let files = [];
    if (this.scripturl) {
      // Prefetch WASM file so we have a nice progress bar in the UI for it
      let wasmfile = document.createElement('emularity-file');
      wasmfile.url = this.scripturl.replace('.js', '.wasm');
      wasmfile.label = 'Emulator System';
      files.push(wasmfile);
    }
    this.childNodes.forEach(n => {
      if (n instanceof EmulatorFile) {
        files.push(n);
      }
    });
    return files;
  }
*/
}
export class DOSBoxEmulatorDrive extends EmulatorFile {
  constructor() {
    super(); 
    this.letter = this.getAttribute('letter');
    this.mounttype = 'dir';
    if (this.letter) {
      this.mountpoint = `/${this.letter}`;
    }
  }
}
export class DOSBoxEmulatorFloppy extends DOSBoxEmulatorDrive {
  constructor() {
    super(); 
    this.mounttype = 'floppy';
  }
}

/* MAME */
export class MAMEEmulator extends Emulator {
  constructor() {
    super();
  }
  connectedCallback() {
    this.system = this.getAttribute('system') ?? false;
    super.connectedCallback();
    this.classList.add('mame');
  }
  initEmscriptenFilesystem(fs) {
    super.initEmscriptenFilesystem(fs);
    let cfg = this.getConfig();
    this.fs.writeFile('/mame.ini', new TextEncoder().encode(cfg));
  }
  getArguments() {
    //return ['indy_4610', '-gio64_gfx', 'xl24', '-hard1', 'irix65.chd', '-rompath', '.', '-nodrc', '-rompath', this.emulatorroot, '-rompath', '/emulator/indy_4610'];
    let args = this.arguments.length > 0 ? this.arguments.split(' ') : [];
    if (this.system) args.unshift(this.system);
    args.push('-video', 'bgfx');
    args.push('-window');
    args.push('-rompath', this.emulatorroot);
    args.push('-resolution', this.resolution);
    args.push('-nomaximize');
    if (!this.sound) args.push('-sound', 'none');
    //args.push('-keepaspect');
    return args;
  }
  getConfig() {
    return `
bgfx_path /bgfx
bgfx_backend gles
bgfx_debug 0
artpath /artwork
    `
  }
}


customElements.define('emularity-emulator', Emulator);
customElements.define('emularity-keyboard', EmulatorVirtualKeyboard);
customElements.define('emularity-file', EmulatorFile);

customElements.define('emularity-dosbox', DOSBoxEmulator);
customElements.define('emularity-dosbox-floppy', DOSBoxEmulatorFloppy);
customElements.define('emularity-dosbox-drive', DOSBoxEmulatorDrive);

customElements.define('emularity-mame', MAMEEmulator);
