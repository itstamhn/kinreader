import { initWasm, Resvg } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import { INSTRUMENT_SANS_400, INSTRUMENT_SANS_700, NEWSREADER_700 } from './og-fonts';
import { assertSafeRemoteUrl } from './safe-remote-url';
import { renderOgCard, type OgCardParams } from './og-card';

// Why this exists: the card was an SVG, and X, Facebook and LinkedIn do not
// render SVG for og:image / twitter:image. The card was almost certainly
// invisible on every platform it was built for.
//
// It rasterises the *same* SVG that ./og-card.ts produces, so there is one
// design with two outputs rather than two designs to keep in sync. That is also
// why the headline is wrapped <tspan>s rather than a <foreignObject>: resvg
// does not implement foreignObject, and the fallback SVG is better off without
// it too.
//
// satori was tried first and abandoned. Its text shaper is Emscripten-compiled
// harfbuzz, which on Cloudflare Workers fails three different ways in sequence
// -- self.location.href, then __dirname under nodejs_compat, then reaching for
// XMLHttpRequest to fetch a wasm it does not inline. resvg needs none of that:
// it takes font buffers directly.

const WIDTH = 1200;

// The hero image is composited by us now, so it is capped in both time and
// size: a slow or enormous image must degrade to the placeholder rather than
// hold the card hostage.
const IMAGE_FETCH_TIMEOUT_MS = 2500;
const IMAGE_MAX_BYTES = 3 * 1024 * 1024;

let wasmReady: Promise<void> | null = null;

// A `.wasm` import resolves differently per runtime: the Cloudflare build hands
// back a compiled `WebAssembly.Module`, while Bun (which runs the tests) hands
// back a path to the file on disk. Handle both rather than pretending the tests
// run where production does.
function ensureWasm(): Promise<void> {
  // initWasm throws if called twice, so the promise itself is the lock,
  // memoised for the lifetime of the isolate.
  wasmReady ??= (async () => {
    const source = resvgWasm as unknown;

    if (typeof source === 'string') {
      // Bun/Node. `globalThis.Bun` does not exist in a Worker, and this branch
      // is unreachable there anyway, so no node: import is needed.
      const bytes = await (globalThis as any).Bun.file(source).arrayBuffer();
      await initWasm(bytes);
      return;
    }

    await initWasm(source as WebAssembly.Module);
  })();

  return wasmReady;
}

async function fetchHeroImageDataUri(image: string): Promise<string | null> {
  if (!image) return null;

  try {
    const url = assertSafeRemoteUrl(image);
    const res = await fetch(url, {
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!res.ok) return null;

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) return null;

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_MAX_BYTES) return null;

    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `data:${contentType.split(';')[0]};base64,${btoa(binary)}`;
  } catch {
    // Any failure -- blocked host, timeout, wrong content type, oversized --
    // falls back to the placeholder. The card is never worth failing over.
    return null;
  }
}

export async function renderOgCardPng(params: OgCardParams): Promise<Uint8Array<ArrayBuffer>> {
  // The SVG references the hero image by URL, which resvg will not fetch. It is
  // inlined as a data URI here, which is also where the host guard runs: unlike
  // the SVG path, *this Worker* is the one making the request.
  const heroImage = await fetchHeroImageDataUri(params.image || '');
  const svg = renderOgCard({ ...params, image: heroImage ?? '' });

  await ensureWasm();
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: WIDTH },
    font: {
      fontBuffers: [INSTRUMENT_SANS_400, INSTRUMENT_SANS_700, NEWSREADER_700],
      defaultFontFamily: 'Instrument Sans',
      // There are no system fonts in a Worker, and asking for them costs a scan
      // of a directory that is not there.
      loadSystemFonts: false,
    },
  })
    .render()
    .asPng();

  // resvg types the result as a bare Uint8Array (so, ArrayBufferLike), which TS
  // will not accept as a BodyInit because that union excludes SharedArrayBuffer.
  // These bytes are always ArrayBuffer-backed.
  return png as Uint8Array<ArrayBuffer>;
}
