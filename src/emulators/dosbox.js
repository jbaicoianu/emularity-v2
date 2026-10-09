import { BaseEmulator } from './base.js'
import { VirtualFile } from '../fs/virtualfile.js'

/* DOSBox */
export class DOSBoxEmulator extends BaseEmulator {
  wasmscript = 'dosbox.module.js'
  wasminit = 'createDOSBox'
  media = []  // disk images: [{ drive: 'fda'|'fdb'|'cdrom', id, name, blob | url }]

  /* Removable-media drives. Every image for a drive is mounted at boot (IMGMOUNT
     takes a list), and DOSBox's Ctrl+F4 swaps between them; a disk can't be added
     while running, nor a drive emptied. */
  static DRIVES = {
    fda: { label: 'Floppy A:', kind: 'floppy', letter: 'a', type: 'floppy' },
    fdb: { label: 'Floppy B:', kind: 'floppy', letter: 'b', type: 'floppy' },
    cdrom: { label: 'CD-ROM D:', kind: 'cdrom', letter: 'd', type: 'iso' },
  };

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
    // Disk images go in plain memory, outside the (possibly persisted) drive tree
    fs.mkdirTree('/media');
    for (let f of this.mediaFiles()) {
      if (!f.data) continue;
      if (f.imageDir) fs.mkdirTree(f.imageDir);
      fs.writeFile(f.imagePath, f.data);
      for (let x of f.extra || []) fs.writeFile(x.path, x.data);
    }
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
    // Each drive's disks, in the order Ctrl+F4 cycles through them
    this.mounted = {};
    for (let f of this.mediaFiles()) {
      if (!f.data) continue;
      (this.mounted[f.medium.drive] ||= []).push(f.medium);
    }
    this.position = {};
    for (let drive in this.mounted) {
      let { letter, type } = DOSBoxEmulator.DRIVES[drive];
      let paths = this.mediaFiles().filter(f => f.data && f.medium.drive == drive).map(f => f.imagePath);
      mounts.push(`imgmount ${letter} ${paths.join(' ')} -t ${type}`);
      this.position[drive] = 0;
    }
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
      cputype=auto
      core = simple
      cycles = auto
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
      doublescan=false
      showmenu=false
       
      [autoexec]
      rem @ECHO OFF
      ${mounts.join('\n')}
      ${this.exe ? this.exe : ''}
    `;
  }
  getFiles() {
    return super.getFiles().concat(this.mediaFiles());
  }
  /* The disk images, as files to download (with the rest, for the progress bar) */
  mediaFiles() {
    if (!this._mediaFiles) {
      this._mediaFiles = (this.media || []).filter(m => DOSBoxEmulator.DRIVES[m.drive]).map((m, i) => {
        let ext = DOSBoxEmulator.DRIVES[m.drive].type == 'iso' ? '.iso' : '.img';
        let f = new VirtualFile(m.url ? { url: m.url, label: m.name } : { label: m.name });
        if (m.blob) f.fetch = async () => { f.data = new Uint8Array(await m.blob.arrayBuffer()); return f; };
        f.optional = true; // a missing disk shouldn't stop the machine booting
        f.medium = m;
        f.imagePath = `/media/${i}${ext}`;
        // A bin/cue goes in as it is (DOSBox reads cue sheets, and plays audio tracks):
        // the cue, with its files beside it under plain names
        if (m.cue) {
          let dir = f.imageDir = `/media/${i}`;
          f.imagePath = `${dir}/cd.cue`;
          f.fetch = async () => {
            let names = new Map(m.cue.files.map((x, j) => [x.name, `track${j}${(x.name.match(/\.[a-z0-9]+$/i) || [''])[0]}`]));
            let text = m.cue.text.replace(/^(\s*FILE\s+)("[^"]*"|\S+)/gim, (all, cmd, name) => {
              let to = names.get(name.replace(/^"|"$/g, ''));
              return to ? `${cmd}"${to}"` : all;
            });
            f.extra = [];
            for (let x of m.cue.files) f.extra.push({ path: `${dir}/${names.get(x.name)}`, data: new Uint8Array(await x.blob.arrayBuffer()) });
            f.data = new TextEncoder().encode(text);
            return f;
          };
        }
        return f;
      });
    }
    return this._mediaFiles;
  }

  /* ----- Removable media (see v86.js for the API) ----- */

  get mediaDrives() {
    return Object.entries(DOSBoxEmulator.DRIVES).map(([id, d]) => {
      let disks = (this.mounted && this.mounted[id]) || [];
      let current = disks[this.position[id]];
      return { id, label: d.label, kind: d.kind, canEject: false, disks: disks.map(m => m.id),
        current: current ? { id: current.id, name: current.name } : null };
    });
  }
  /* Swap a drive to one of its disks. Ctrl+F4 moves every multi-disk drive on to its
     next disk, so others may change too. */
  async insertMedia(drive, m) {
    let disks = (this.mounted && this.mounted[drive]) || [];
    let index = disks.findIndex(d => d.id == m.id);
    if (index < 0) {
      let err = new Error(`${m.name} will be in ${DOSBoxEmulator.DRIVES[drive] ? DOSBoxEmulator.DRIVES[drive].label : drive} after a restart`);
      err.needsRestart = true;
      throw err;
    }
    while (this.position[drive] != index) {
      await this.pressSwapKey();
      for (let d in this.mounted) this.position[d] = (this.position[d] + 1) % this.mounted[d].length;
    }
    for (let d in this.mounted) {
      let current = this.mounted[d][this.position[d]];
      this.dispatchEvent(new CustomEvent('mediachange', { detail: { drive: d, current: { id: current.id, name: current.name } } }));
    }
  }
  async ejectMedia(drive) {
    throw new Error("DOSBox can't empty a drive; insert a different disk instead");
  }
  /* Ctrl+F4, through the page's key events as SDL sees them */
  async pressSwapKey() {
    let send = (type, key, code, keyCode, ctrlKey) => {
      let ev = new KeyboardEvent(type, { key, code, ctrlKey, bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'keyCode', { get: () => keyCode });
      Object.defineProperty(ev, 'which', { get: () => keyCode });
      (this.canvas || window).dispatchEvent(ev);
    };
    let pause = () => new Promise(r => setTimeout(r, 60));
    send('keydown', 'Control', 'ControlLeft', 17, true); await pause();
    send('keydown', 'F4', 'F4', 115, true); await pause();
    send('keyup', 'F4', 'F4', 115, true); await pause();
    send('keyup', 'Control', 'ControlLeft', 17, false); await pause();
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

