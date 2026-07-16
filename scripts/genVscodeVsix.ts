/**
 * Codegen: build + package the first-party VS Code extension (editors/vscode/)
 * into a `.vsix`, then embed that artifact — base64-encoded — into a TypeScript
 * constants module so phantombot's compiled single-ELF binary can stamp it onto
 * disk at runtime and run `code --install-extension <vsix>` (see
 * src/connectors/acp/installVscode.ts).
 *
 * Why an embedded base64 constants module (same shape as
 * scripts/genPiExtensionAssets.ts)?
 *   - `bun build --compile` produces a SINGLE ELF with no repo alongside it, so
 *     the shipped binary cannot fs-read `editors/vscode/*.vsix` at runtime.
 *   - `import ... with { type: "..." }` is NOT tsc-safe in this toolchain
 *     (`tsc --noEmit` rejects it). A plain generated `.ts` with the bytes as a
 *     JSON-encoded base64 string literal sidesteps that and stays
 *     `bun build --compile`-self-contained.
 *   - The `.vsix` is a binary zip; zip bytes are NOT reproducible across builds
 *     (timestamps/metadata vary), so we deliberately do NOT assert byte-exact
 *     drift. Instead the checked-in module records the extension VERSION, and
 *     tests/lib-vscodeExtensionAsset.test.ts asserts (a) the embedded version
 *     matches editors/vscode/package.json and (b) the bytes decode to a valid
 *     zip carrying the extension manifest + bundled extension.js.
 *
 *     Note what that does NOT catch, because it shipped a broken release: it
 *     only detects a version bump WITHOUT a regen. The failure that actually
 *     bit us is the mirror image — editing editors/vscode/ and regenerating
 *     NEITHER the version NOR this asset, which leaves both sides mutually
 *     consistent and stale, so every assertion here passes. See
 *     PHANTOMBOT_EXT_VERSION below for how the release closes that hole.
 *
 * Run: `bun run gen:vscode-vsix`. Requires network the first time (npx fetches
 * @vscode/vsce). Regenerate whenever editors/vscode/ changes.
 *
 * ## PHANTOMBOT_EXT_VERSION — why the release overrides the version
 *
 * The extension version is what `installVscode` compares against to decide
 * whether to install (`installed >= bundled` ⇒ skip as "current"). Left to a
 * hand-maintained `editors/vscode/package.json` bump, that produced a silent,
 * user-visible failure: PR #296 changed the extension's source, nobody bumped
 * the version and nobody re-ran this script, so the release shipped a STALE
 * embedded .vsix that every client then skipped as "current". The fix never
 * reached a single user, and `phantombot update` reported success.
 *
 * So the release pipeline sets `PHANTOMBOT_EXT_VERSION` to the phantombot
 * release version (`1.1.<run_number>`) and runs this script on every build.
 * That makes both failure modes structurally impossible:
 *
 *   - The .vsix is always packaged from the CURRENT source tree, so it can
 *     never lag the code that was merged.
 *   - The version always increases (run_number is monotonic), so clients
 *     always see "bundled newer than installed" and actually install.
 *
 * Locally the env var is unset and we fall back to the checked-in
 * package.json version — dev behaviour is unchanged.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const EXT_DIR = join(REPO_ROOT, "editors", "vscode");
const EXT_PKG_PATH = join(EXT_DIR, "package.json");
const OUT_FILE = join(
  REPO_ROOT,
  "src",
  "lib",
  "vscodeExtensionAsset.generated.ts",
);

const pkgRaw = readFileSync(EXT_PKG_PATH, "utf8");
const pkg = JSON.parse(pkgRaw) as {
  name: string;
  version: string;
  publisher: string;
};

/**
 * Release builds pin the extension version to phantombot's own release
 * version; local runs keep whatever package.json says. `vsce` reads the
 * version out of package.json, so an override has to be written to disk
 * before packaging — we restore the original afterwards so a local run with
 * the override set never leaves the working tree dirty.
 */
const versionOverride = process.env.PHANTOMBOT_EXT_VERSION?.trim();
if (versionOverride && !/^\d+\.\d+\.\d+$/.test(versionOverride)) {
  throw new Error(
    `PHANTOMBOT_EXT_VERSION must be a bare x.y.z semver (vsce rejects ` +
      `anything else); got ${JSON.stringify(versionOverride)}`,
  );
}
const version = versionOverride ?? pkg.version;

const extensionId = `${pkg.publisher}.${pkg.name}`;
const vsixFileName = `${pkg.name}-${version}.vsix`;

// ── Make sure the extension's own devDeps are present. ──
// editors/vscode/ is NOT a workspace of the root package.json — it has its own
// bun.lock and its own (gitignored) node_modules. So the repo-root
// `bun install` does NOT install esbuild/typescript for it, and a clean
// checkout has no node_modules there at all.
//
// This bit us for real: the release job failed with `esbuild: command not
// found` (vsce runs the extension's `vscode:prepublish` → `bun run build` →
// esbuild), while the same script passed locally purely because a dev box
// happens to have those deps lying around from previous work in that dir.
// Classic works-on-my-machine, and exactly the kind of silent
// environment-dependence this script exists to eliminate — so install them
// here rather than relying on the caller's state.
//
// Deliberately BEFORE the version stamp below: --frozen-lockfile compares
// package.json against bun.lock, and a stamped-in override version would make
// it fail on a mismatch we created ourselves.
execFileSync("bun", ["install", "--frozen-lockfile"], {
  cwd: EXT_DIR,
  stdio: "inherit",
});

// ── Build + package into a throwaway temp dir, then read the bytes back. ──
const tmp = mkdtempSync(join(tmpdir(), "phantombot-vsix-"));
const vsixPath = join(tmp, vsixFileName);
try {
  // Stamp the override into package.json so `vsce package` picks it up. Only
  // touch the file when we're actually overriding, so the common local run is
  // a pure read and can't dirty the tree.
  if (versionOverride) {
    writeFileSync(
      EXT_PKG_PATH,
      pkgRaw.replace(
        `"version": ${JSON.stringify(pkg.version)}`,
        `"version": ${JSON.stringify(version)}`,
      ),
      "utf8",
    );
  }
  // `vsce package` runs the extension's own `vscode:prepublish` (esbuild
  // bundle), so this is the full build + package pipeline in one call.
  // --no-dependencies: we bundle with esbuild, there are no runtime deps to
  // pack. --skip-license: the extension has no LICENSE file; don't fail on it.
  execFileSync(
    "npx",
    [
      "--yes",
      "@vscode/vsce@latest",
      "package",
      "--no-dependencies",
      "--skip-license",
      "--out",
      vsixPath,
    ],
    { cwd: EXT_DIR, stdio: "inherit" },
  );

  const bytes = readFileSync(vsixPath);
  const base64 = bytes.toString("base64");

  const body = [
    "// GENERATED by scripts/genVscodeVsix.ts — DO NOT EDIT. Run: bun run gen:vscode-vsix",
    "//",
    "// Embeds the built editors/vscode/ extension as a base64 .vsix so",
    "// phantombot's compiled binary can stamp it to disk and run",
    "// `code --install-extension <vsix>` (see connectors/acp/installVscode.ts).",
    "",
    `export const VSCODE_EXTENSION_ID = ${JSON.stringify(extensionId)};`,
    "",
    `export const VSCODE_EXTENSION_VERSION = ${JSON.stringify(version)};`,
    "",
    `export const VSCODE_VSIX_FILENAME = ${JSON.stringify(vsixFileName)};`,
    "",
    "/** The built .vsix, base64-encoded. Decode to bytes before writing. */",
    `export const VSCODE_VSIX_BASE64 = ${JSON.stringify(base64)};`,
    "",
  ].join("\n");

  writeFileSync(OUT_FILE, body, "utf8");
  // eslint-disable-next-line no-console
  console.log(
    `wrote ${OUT_FILE} (${extensionId}@${version}, ${bytes.length} bytes vsix, ${base64.length} base64 chars)`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
  // Put package.json back exactly as we found it. The release runs this on a
  // throwaway checkout so it wouldn't matter there, but a local run with the
  // override set must not leave a spurious version bump staged.
  if (versionOverride) writeFileSync(EXT_PKG_PATH, pkgRaw, "utf8");
}
