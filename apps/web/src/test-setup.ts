import { GlobalRegistrator } from '@happy-dom/global-registrator';

// happy-dom implements the *browser* fetch spec, where `Cookie` and
// `Set-Cookie` are forbidden header names and are silently dropped. The
// Worker code under test lives on the other side of that line -- it reads and
// writes those headers as ordinary ones -- so keep Bun's native fetch
// primitives and let happy-dom supply only the DOM.
const nativeFetchGlobals = {
  Request: globalThis.Request,
  Response: globalThis.Response,
  Headers: globalThis.Headers,
  fetch: globalThis.fetch,
};

GlobalRegistrator.register();

if (typeof window !== 'undefined' && !window.speechSynthesis) {
  (window as any).speechSynthesis = {
    speak: () => {},
    cancel: () => {},
    pause: () => {},
    resume: () => {},
    getVoices: () => [],
  };
}

Object.assign(globalThis, nativeFetchGlobals);

// Nothing in the suite talks to a live Convex deployment (procedures are
// mocked at the client prototype), but constructing `ConvexReactClient`
// still dials the deployment's WebSocket. Behind a proxy that answers the
// upgrade with a non-101 status the `ws` layer emits an 'error' with no
// listener attached, and Bun attributes that unhandled error to whichever
// test happens to be running -- a flake that scales with suite length.
// An inert socket that never opens keeps the client in CONNECTING forever,
// which is exactly the state every test here already assumes.
class InertWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  url: string;
  binaryType = 'blob';
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(url: string | URL) {
    this.url = url.toString();
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() {
    return false;
  }
}
(globalThis as any).WebSocket = InertWebSocket;
if (typeof window !== 'undefined') (window as any).WebSocket = InertWebSocket;
