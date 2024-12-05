export class VirtualFile extends HTMLElement {
  constructor(url, mountpoint, label) {
    super();
    this.data = false;

  }
  connectedCallback() {
    this.url = this.getAttribute('url') ?? false;
    this.mountpoint = this.getAttribute('mountpoint') ?? false;
    this.path = this.getAttribute('path') ?? '';
    this.label = this.getAttribute('label') ?? false;
    this.encoding = this.getAttribute('encoding') ?? 'unix';
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
    } else if (this.innerHTML.length > 0) {
      let content = this.innerHTML;
      if (this.encoding == 'msdos') {
        content = content.replaceAll('\n', '\r\n');
      }
      this.data = new TextEncoder().encode(content);
    }
    return this;
  }
}


