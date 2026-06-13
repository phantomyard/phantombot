/**
 * Phase 1 smoke test: prove the Matrix native crypto addon loads inside a
 * `bun build --compile` binary via the patched loader + sibling .node, with the
 * build tree (node_modules) absent. Run by scripts/smoke-native-crypto.sh.
 */
import { loadNativeCrypto, nativeCryptoFilename } from "../src/channels/matrix/nativeCrypto";

async function main() {
  console.log(`[smoke] expecting addon: ${nativeCryptoFilename()}`);
  const native = loadNativeCrypto() as {
    OlmMachine: { initialize: (u: unknown, d: unknown) => Promise<{ identityKeys: { ed25519: unknown; curve25519: unknown } }> };
    UserId: new (s: string) => unknown;
    DeviceId: new (s: string) => unknown;
  };
  const machine = await native.OlmMachine.initialize(
    new native.UserId("@smoke:example.org"),
    new native.DeviceId("SMOKEDEVICE"),
  );
  const keys = machine.identityKeys;
  const ok = !!keys.ed25519 && !!keys.curve25519;
  console.log(`[smoke] OlmMachine initialized; ed25519+curve25519 present: ${ok}`);
  if (!ok) process.exit(1);
  console.log("[smoke] PASS");
  // NOTE: the prebuilt 0.4.0 addon SIGABRTs during runtime teardown (napi-rs
  // tokio_runtime shutdown bug) even on a clean `process.exit(0)`. It's purely
  // a shutdown artifact — crypto works fully before it. Callers must judge
  // success by the "[smoke] PASS" line, not the exit code. Tracked as a Phase 2
  // daemon-lifecycle item (clean shutdown / addon upgrade).
  process.exit(0);
}

main().catch((e) => {
  console.error("[smoke] FAIL:", e?.message ?? e);
  process.exit(1);
});
