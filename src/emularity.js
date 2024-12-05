import { Emulator } from './emulator.js'
import { VirtualFile } from './virtualfile.js'
import { VirtualKeyboard } from './inputs.js'
import { DOSBoxEmulator, DOSBoxEmulatorFloppy, DOSBoxEmulatorDrive } from './emulators/dosbox.js'
import { MAMEEmulator } from './emulators/mame.js'

export default {
  Emulator,
  VirtualFile,
  VirtualKeyboard,
  DOSBoxEmulator,
  DOSBoxEmulatorFloppy,
  DOSBoxEmulatorDrive,
  MAMEEmulator
}


if (typeof customElements != 'undefined') {
  customElements.define('emularity-emulator', Emulator);
  customElements.define('emularity-keyboard', VirtualKeyboard);

  customElements.define('emularity-file', VirtualFile);

  customElements.define('emularity-dosbox', DOSBoxEmulator);
  customElements.define('emularity-dosbox-floppy', DOSBoxEmulatorFloppy);
  customElements.define('emularity-dosbox-drive', DOSBoxEmulatorDrive);

  customElements.define('emularity-mame', MAMEEmulator);
}
