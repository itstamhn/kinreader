// The Cloudflare build resolves a .wasm import to a compiled WebAssembly.Module.
// Bun resolves it to a path string instead, which is why the loader in
// src/lib/og-card-png.ts casts through `unknown` and handles both shapes.
declare module '*.wasm' {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
