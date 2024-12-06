let BaseClass;
if (typeof HTMLElement != 'undefined') {
  BaseClass = class extends HTMLElement {
  }
} else {
  BaseClass = class extends EventTarget {
    childNodes = []
    setAttribute(k, v) {
    }
    appendChild(node) {
      if (this.childNodes.indexOf(node) == -1) {
        this.childNodes.push(node);
      }
    }
  }
}

export {
  BaseClass
}
