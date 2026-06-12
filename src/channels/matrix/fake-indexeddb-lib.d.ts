/**
 * fake-indexeddb ships per-class entry points (`fake-indexeddb/lib/FDBFactory`
 * etc.) whose .d.ts files aren't reachable through the package's `exports`
 * map under `moduleResolution: bundler`. We import them for their runtime
 * value only (to register the IndexedDB globals + patch the transaction
 * prototype), so a permissive ambient declaration is all we need — the IDB
 * surface itself is exercised through the polyfilled globals, not these types.
 */
declare module "fake-indexeddb/lib/*" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const value: any;
  export default value;
}
