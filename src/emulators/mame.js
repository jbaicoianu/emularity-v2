import { BaseEmulator } from './base.js'

/* MAME */
export class MAMEEmulator extends BaseEmulator {
  system = false

  connectedCallback() {
    this.system = this.getAttribute('system') ?? false;
    super.connectedCallback();
    this.classList.add('mame');
  }
  setSettings(settings) {
    super.setSettings(settings);
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


