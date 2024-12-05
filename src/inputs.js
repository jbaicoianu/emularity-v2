export class VirtualKeyboard extends HTMLElement {
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

