import { BaseClass } from '../baseclass.js'

export class VirtualFile extends BaseClass {
  url = false
  mountpoint = false
  path = ''
  label = false
  encoding = 'binary'
  optional = false

  constructor(settings) {
    super();
    this.data = false;
    if (settings) this.setSettings(settings);
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
  setSettings(settings) {
    for (let k in settings) {
      this[k] = settings[k];
      this.setAttribute(k, settings[k]);
    }
  }
  async fetch() {
    if (this.url) {
      try {
        let res = await fetch(this.url);
        let contentLength = res.headers.get('Content-Length');

        if (res.body && res.body.getReader) {
          // Accumulate chunks and size the final buffer from the bytes we actually
          // receive. Content-Length can't be used to pre-size the buffer: when the
          // server sends the response compressed (Content-Encoding: gzip/br, as
          // GitHub Pages and many CDNs do), the header is the compressed size while
          // the stream yields the larger decompressed body.
          let reader = res.body.getReader();
          let total = contentLength ? +contentLength : 0;
          let chunks = [];
          let loaded = 0;
          while (true) {
            let {done, value} = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.byteLength;
            // Once we pass the reported size (compression), report loaded as the total
            this.dispatchEvent(new CustomEvent('progress', { detail: { complete: loaded, total: total >= loaded ? total : loaded } }));
          }
          let data = new Uint8Array(loaded);
          let offset = 0;
          for (let chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.byteLength;
          }
          this.dispatchEvent(new CustomEvent('complete'));
          this.data = data;
        } else {
          this.data = new Uint8Array(await res.arrayBuffer());
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


