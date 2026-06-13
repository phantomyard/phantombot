/**
 * Native Matrix crypto (matrix-bot-sdk) — single-binary load seam.
 *
 * matrix-bot-sdk's E2EE is backed by `@matrix-org/matrix-sdk-crypto-nodejs`, a
 * Rust NAPI addon (the same OlmMachine / vodozemac engine matrix-js-sdk uses).
 * Unlike the old matrix-js-sdk path we do NOT fight WASM packaging.
 *
 * Single-binary packaging — IT JUST WORKS:
 *   The addon's generated NAPI loader resolves the prebuilt `.node` via STATIC
 *   `require('./matrix-sdk-crypto.<variant>.node')` strings. `bun build
 *   --compile` statically detects those requires and EMBEDS the `.node` into the
 *   compiled binary's virtual fs at its original relative path, so the loader's
 *   in-package probe finds it at runtime. The result is a genuine single-file
 *   binary — no sibling `.node`, no patch, no `--external`. (The earlier Phase 0
 *   spike wrongly concluded a 2-file unit was needed; that was an artifact of a
 *   hand-rolled DYNAMIC require bun couldn't analyze. The real loader is static.)
 *   Regression-guarded by scripts/smoke-native-crypto.sh.
 *
 * Known caveat (tracked for the daemon lifecycle, not load-time): the prebuilt
 * 0.4.0 addon SIGABRTs during napi/tokio runtime teardown on process exit. It is
 * purely a shutdown artifact — crypto is fully functional before it — but means
 * the long-lived channel must own a clean-shutdown path rather than rely on the
 * binary's exit code.
 */

/**
 * NAPI target triple for the current host, e.g. `linux-arm64-gnu`. Mirrors the
 * switch in the crypto package's generated loader. Used for diagnostics and to
 * name the addon in error messages — NOT for resolution (the loader does that).
 */
export function nativeCryptoVariant(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  switch (platform) {
    case "linux":
      return `linux-${arch}-${isMusl() ? "musl" : "gnu"}`;
    case "darwin":
      return `darwin-${arch}`;
    case "win32":
      return `win32-${arch}-msvc`;
    default:
      throw new Error(`unsupported platform for matrix native crypto: ${platform}/${arch}`);
  }
}

/** Filename of the addon for the current host, e.g. `matrix-sdk-crypto.linux-arm64-gnu.node`. */
export function nativeCryptoFilename(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `matrix-sdk-crypto.${nativeCryptoVariant(platform, arch)}.node`;
}

/**
 * Load the native crypto module through its own NAPI loader (which resolves the
 * embedded/installed addon). Throws a clear, actionable error on failure — the
 * single most useful diagnostic if a future bun/addon change ever breaks the
 * static-embed path.
 */
export function loadNativeCrypto(): unknown {
  try {
    // Bare specifier so the in-package loader runs (embedded addon in a compiled
    // binary; node_modules in dev). Do not hard-code a path here.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("@matrix-org/matrix-sdk-crypto-nodejs");
  } catch (err) {
    const file = nativeCryptoFilename();
    throw new Error(
      `Failed to load Matrix native crypto addon (${file}). It should be embedded ` +
        `in the compiled phantombot binary; if this fails, the bun static-embed ` +
        `path may have regressed (see scripts/smoke-native-crypto.sh). Original ` +
        `error: ${(err as Error).message}`,
    );
  }
}

function isMusl(): boolean {
  try {
    const report = (process as unknown as { report?: { getReport?: () => { header?: { glibcVersionRuntime?: string } } } }).report;
    if (report?.getReport) {
      return !report.getReport().header?.glibcVersionRuntime;
    }
  } catch {
    /* fall through */
  }
  return false;
}
