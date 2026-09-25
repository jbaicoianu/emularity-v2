# Emularity v2

![Emularity](logos/emularity-transparent.png)

Easy emulation in the browser.

Emularity v2 is a declarative, web-component-based loader for Emscripten/WebAssembly
emulators. Drop a custom HTML tag into your page, point it at the files your system
needs, and Emularity handles the rest: downloading files with progress bars, assembling
them into a virtual filesystem, configuring the emulator, and booting it into a canvas
on your page.

It is a ground-up rewrite of the original [Emularity](https://github.com/db48x/emularity)
loader, which powers in-browser emulation on the [Internet Archive](https://archive.org).
Where v1 required a page of JavaScript configuration, v2 lets you describe a machine
entirely in HTML.

## Quick example

Here is a complete page that boots Doom in DOSBox:

```html
<html>
  <head>
    <script src="vendor/browserfs.js"></script>
    <script type="module" src="src/emularity.js"></script>
    <link rel="stylesheet" href="css/emularity.css">
  </head>
  <body>
    <emularity-dosbox exe="c:\doom.bat" wasmroot="emulators/dosbox"
                      splashlogo="logos/emularity-transparent.png">
      <emularity-dosbox-drive letter="c"
          url="https://ia801602.us.archive.org/cors_get.php?path=/34/items/doom_20231012/doom.zip"
          label="doom.zip"></emularity-dosbox-drive>
      <emularity-file path="/c/doom.bat" encoding="msdos">
        @echo off
        c:
        cd doom
        doom.exe
      </emularity-file>
      <emularity-keyboard layout="pc101"></emularity-keyboard>
    </emularity-dosbox>
  </body>
</html>
```

The loader shows a splash screen with per-file download progress, mounts `doom.zip` as
the C: drive, writes the inline batch file into the virtual filesystem (with DOS line
endings), generates a `dosbox.conf`, and starts the emulator.

## Features

- **Declarative HTML API**: machines are described with custom elements and
  attributes, no JavaScript required for common cases
- **Multiple emulators**: DOSBox and MAME have dedicated elements; any
  Emscripten-compiled emulator (e.g. Chocolate Doom) can be driven through the generic
  `<emularity-emulator>` element
- **Virtual filesystem**: powered by [BrowserFS](https://github.com/jvilk/BrowserFS)
  (vendored in [`vendor/`](vendor/)), so remote zips can be mounted as directories or
  drives, and files can be fetched from URLs or defined inline in the page
- **Loading screen**: configurable splash logo, colors, and per-file progress bars
- **Virtual keyboards**: on-screen touch controls, from a full PC 101-key layout to
  custom per-machine layouts (arcade buttons, calculator keypads) defined in JSON + CSS
- **Scriptable**: lifecycle events and a small JavaScript API for dynamically adding
  files and arguments before boot

## Getting started

```sh
git clone https://github.com/jbaicoianu/emularity-v2
cd emularity-v2
```

There are no dependencies to install and no build step; BrowserFS, the only runtime
dependency, is vendored in [`vendor/`](vendor/). Just serve the directory with any
static web server and open one of the examples:

```sh
npx http-server .
# then browse to http://localhost:8080/examples/dosbox-doom.html
```

A web server is required, since the loader uses ES modules and `fetch()`, which don't work
from `file://` URLs. Files you load (zips, disk images, ROMs) must be same-origin or
served with CORS headers; the examples use archive.org's `cors_get.php` endpoint for
this reason.

## Examples

The [`examples/`](examples/) directory contains working demos, also hosted at
[jbaicoianu.github.io/emularity-v2](https://jbaicoianu.github.io/emularity-v2/):

| Example | Emulator | Demonstrates |
|---|---|---|
| [`dosbox-doom.html`](examples/dosbox-doom.html) | DOSBox | Mounting a zip as a drive, inline batch file, virtual keyboard |
| [`mame-pacman.html`](examples/mame-pacman.html) | MAME | Arcade emulation, custom arcade control panel, themed loading screen |
| [`mame-apple2e.html`](examples/mame-apple2e.html) | MAME | Apple IIe booting a floppy image (Oregon Trail), remote emulator builds |
| [`mame-ti82.html`](examples/mame-ti82.html) | MAME | TI-82 calculator with a custom on-screen keypad, persistent NVRAM directory |
| [`mame-irix.html`](examples/mame-irix.html) | MAME | SGI Indy booting IRIX from a CHD hard disk image |
| [`chocolate-doom.html`](examples/chocolate-doom.html) | Chocolate Doom | Generic emulator element, game selector UI, drag-and-drop WADs, pointer lock / fullscreen, URL parameters |

Precompiled WebAssembly builds of DOSBox, several MAME drivers, and Chocolate Doom are
included in [`emulators/`](emulators/).

## Elements

### `<emularity-emulator>`

The generic base element, usable directly with any Emscripten-built emulator that
follows standard module conventions. `<emularity-dosbox>` and `<emularity-mame>` extend
it with emulator-specific configuration.

| Attribute | Default | Description |
|---|---|---|
| `wasmroot` | | Base URL for the emulator's `.js`/`.wasm` build |
| `wasmscript` | | Filename of the Emscripten JavaScript loader |
| `wasmfile` | derived from `wasmscript` | Filename of the `.wasm` binary, if it doesn't match the script name |
| `wasminit` | | Name of the module factory function exported by the build (e.g. `MAMEPACMAN`) |
| `arguments` | | Space-separated command-line arguments passed to the emulator |
| `resolution` | `800x600` | Emulator canvas resolution |
| `splashresolution` | `800x600` | Loading screen canvas resolution |
| `splashlogo` | | URL of the logo shown on the loading screen |
| `sound` | `true` | Set to `false` to disable audio |
| `autostart` | `true` | Set to `false` to defer booting until you call `.start()` |
| `emulatorroot` | `/emulator` | Mount point of the virtual filesystem inside the emulator |
| `bgcolor`, `fontcolor` | | Loading screen background and text colors |
| `progressbgcolor`, `progressfgcolor`, `progressbordercolor`, `progresscompletebordercolor`, `progresserrorcolor`, `progresserrorbordercolor` | | Progress bar colors |

### `<emularity-dosbox>`

DOSBox with a generated `dosbox.conf`. Adds:

| Attribute | Description |
|---|---|
| `exe` | Command(s) to run from the autoexec section once drives are mounted, e.g. `c:\doom.bat` |

Drives are declared as children:

- `<emularity-dosbox-drive letter="c" url="...">` mounts a zip as a hard drive
- `<emularity-dosbox-floppy letter="a" url="...">` mounts a zip as a floppy drive

### `<emularity-mame>`

MAME with a generated `mame.ini`. Adds:

| Attribute | Description |
|---|---|
| `system` | MAME system/driver name to boot, e.g. `pacman`, `apple2e`, `indy_4610` |

ROM zips placed at the root of the virtual filesystem (e.g. `path="/pacman.zip"`) are
found automatically via the generated `-rompath`. Additional MAME options (slot
devices, disk images, config directories, etc.) go in `arguments`.

### `<emularity-file>`

A file in the emulator's virtual filesystem. Placed as a child of an emulator element.

| Attribute | Description |
|---|---|
| `url` | URL to download the file from (shown with a progress bar during load) |
| `path` | Destination path in the virtual filesystem |
| `mountpoint` | Mount the file (a zip) as a directory at this path instead of copying it |
| `label` | Human-readable name shown on the progress bar |
| `encoding` | For inline content: `msdos` converts line endings to CRLF |
| `optional` | If set, a failed download won't abort the boot |

If no `url` is given, the element's text content becomes the file's contents, which is
handy for batch files and config files written directly in your HTML.

### `<emularity-keyboard>`

An on-screen keyboard/control panel, useful for touch devices and machines with
special controls.

| Attribute | Description |
|---|---|
| `layout` | Name of the layout to display; `pc101` and `numpad` are built in |
| `src` | URL of a JSON file defining a custom layout |

Custom layouts define rows of keys (label, key code, CSS class) and can reference a
stylesheet for styling; see [`inputs/mame/pacman.json`](inputs/mame/pacman.json) for an
arcade panel and [`inputs/mame/ticalc.json`](inputs/mame/ticalc.json) for a calculator
keypad.

## Scripting

Emulator elements are ordinary DOM elements. Useful properties and methods:

- `.start()`: boot the emulator (when `autostart="false"`)
- `.addFile(path, fileElement)`: add an `<emularity-file>` programmatically before boot
- `.addArgument(...args)`: append command-line arguments before boot
- `.started` / `.running`: boot state flags
- `.canvas`: the emulator's canvas, e.g. for requesting fullscreen or pointer lock

Lifecycle events are dispatched on the element and can also be hooked with attributes:

| Event | Attribute | Fires |
|---|---|---|
| `create` | `oncreate` | When the element is added to the page |
| `preinit` | `onpreinit` | After downloads complete, before the module initializes |
| `prerun` | `onprerun` | After the filesystem is mounted, before the emulator runs |
| `run` | `onrun` | When the emulator is running |
| `canvaschange` | `oncanvaschange` | When the splash canvas is replaced by the emulator canvas |

The [Chocolate Doom example](examples/chocolate-doom.html) shows most of this in
action: it defers `autostart`, builds a game-selector UI, accepts drag-and-dropped WAD
files, and injects files and arguments from URL parameters in an `oncreate` handler.

## Status

Emularity v2 is a work in progress. The API is still settling, and some rough edges
remain (IndexedDB persistence is currently disabled, gamepad/arcade controls are in
development). Bug reports and pull requests are welcome.

## Credits

- The original [Emularity](https://github.com/db48x/emularity) by db48x, Jason Scott,
  and the Internet Archive team, which pioneered mass in-browser emulation
- [MAME](https://www.mamedev.org/), [DOSBox](https://www.dosbox.com/), and
  [Chocolate Doom](https://www.chocolate-doom.org/), the emulators doing the real work
- [Emscripten](https://emscripten.org/) for making it possible to run them in a browser
- [BrowserFS](https://github.com/jvilk/BrowserFS) for the virtual filesystem

## License

[GPL-3.0-or-later](LICENSE)
