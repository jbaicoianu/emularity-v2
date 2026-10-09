import { BaseEmulator } from './emulators/base.js'
import { DOSBoxEmulator, DOSBoxEmulatorFloppy, DOSBoxEmulatorDrive } from './emulators/dosbox.js'
import { MAMEEmulator } from './emulators/mame.js'
import { V86Emulator } from './emulators/v86.js'
import { LibretroEmulator } from './emulators/libretro.js'
import { VirtualFile } from './fs/virtualfile.js'
import { VirtualKeyboard } from './inputs.js'
import { LanPanel } from './net/lan-panel.js'

export default {
  emulators: {
    Emulator: BaseEmulator,
    DOSBoxEmulator,
    MAMEEmulator,
    V86Emulator,
    LibretroEmulator,
  },
  input: {
    VirtualKeyboard,
  },
  fs: {
    VirtualFile,
    DOSBoxEmulatorFloppy,
    DOSBoxEmulatorDrive,
  },
  net: {
    LanPanel,
  },

}


if (typeof customElements != 'undefined') {
  customElements.define('emularity-emulator', BaseEmulator);
  customElements.define('emularity-keyboard', VirtualKeyboard);

  customElements.define('emularity-file', VirtualFile);

  customElements.define('emularity-dosbox', DOSBoxEmulator);
  customElements.define('emularity-dosbox-floppy', DOSBoxEmulatorFloppy);
  customElements.define('emularity-dosbox-drive', DOSBoxEmulatorDrive);

  customElements.define('emularity-mame', MAMEEmulator);

  customElements.define('emularity-x86', V86Emulator);

  customElements.define('emularity-libretro', LibretroEmulator);

  customElements.define('emularity-lan-panel', LanPanel);
}
