import { BaseEmulator } from './base.js'
import { VirtualFile } from '../fs/virtualfile.js'

/* DOSBox */
export class DOSBoxEmulator extends BaseEmulator {
  wasmscript = 'dosbox.module.js'
  initfunc = 'createDOSBox'

  constructor(settings) {
    super(settings);
  }
  connectedCallback() {
    super.connectedCallback();
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
      if (n instanceof VirtualFile) {
        files.push(n);
      }
    });
    return files;
  }
*/
}
export class DOSBoxEmulatorDrive extends VirtualFile {
  constructor() {
    super(); 
    this.mounttype = 'dir';
  }
  connectedCallback() {
    super.connectedCallback();
    this.letter = this.getAttribute('letter');
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

