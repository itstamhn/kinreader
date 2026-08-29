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
