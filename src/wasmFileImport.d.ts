/**
 * `import p from "x.wasm" with { type: "file" }` — bun embeds the file in a
 * compiled binary and the default export is a path it can be read from.
 * Used by src/lib/embeddedPhoton.ts.
 */
declare module "*.wasm" {
  const path: string;
  export default path;
}
