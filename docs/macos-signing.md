# macOS: stopping the permission-prompt nagging

## The symptom

On macOS, phantombot keeps re-asking for access to your home folder, Documents,
Desktop, Downloads, or Full Disk Access — again and again, especially right after
it updates itself.

## Why it happens

macOS TCC (Privacy & Security) pins each permission grant to the **exact
code-signing identity** of the binary that was granted. phantombot ships
**ad-hoc signed** (`Identifier=a.out`, no stable designated requirement) and it
**auto-updates its own binary**. Every update rewrites the file → new code
identity → the grant you gave last time no longer matches → macOS prompts again.
It is structural, not a misconfiguration.

## The fix: a stable signing identity, applied automatically

phantombot gives itself a **stable self-signed code-signing identity** and signs
its binary with it. Because the identity no longer changes on every update, a
single Full Disk Access grant sticks across all future updates.

**This happens automatically — there is nothing to opt into.** Every
`phantombot update` on macOS applies the stable identity to the freshly-swapped
binary. The first update creates the identity; every update after that re-signs
with the same one.

Grant **Full Disk Access** to phantombot once, in **System Settings → Privacy &
Security → Full Disk Access** (Full Disk Access is granted by path, so it
survives the binary being rewritten). That's the last prompt you'll see — every
subsequent update re-applies the same identity silently.

## Applying it now, or repairing it (`fix-signing`)

```
phantombot fix-signing
```

You usually don't need this — the update path already does it. Use it to apply
the identity to the **current** binary immediately (without waiting for the next
update), or to **repair** signing if an update's automatic re-sign failed and
left an ad-hoc signature behind. It runs the same idempotent, transactional
logic the update path uses.

### What it does under the hood

- Creates a **dedicated throwaway keychain** (`phantombot-signing.keychain`)
  with a password phantombot generates and stores in its own encrypted vault.
  **The login keychain — the one with the password nobody remembers — is never
  touched**, so codesign runs fully headless and macOS never pops the
  keychain-password dialog.
- Generates a self-signed code-signing certificate (`CN=phantombot-codesign`),
  sets the key's partition list so codesign is non-interactive, and signs the
  binary with `--identifier dev.phantombot`.
- Verifies the signature **and** that the signed binary still runs.

### Safety: updates can't break

Applying the identity is **transactional**. It backs up the binary before
signing and, on any failure, restores it. If the failure happened while creating
the identity this run, it also tears the keychain down and clears the stored
password — so a half-made identity is never left behind. Worst case, you're back
to exactly the prior state: working binary, ad-hoc signature, still nagging.
Nothing to un-break.

This is the load-bearing promise: **making the fix automatic for everyone must
never risk an update.** It doesn't, because the guarantee comes from the
fail-safe, not from gating the feature behind an opt-in. The signing step is
best-effort: if it fails for any reason, the update keeps the freshly-swapped
binary and continues — you get a working new binary and, at most, one extra
macOS prompt (exactly today's behaviour). Every external command runs under a
timeout, so codesign can never hang a headless update waiting on a prompt.

## New installs

There is no way to ship a self-signed app that touches Documents/Desktop/
Downloads with **zero** first-run prompts (that needs a Developer ID cert +
notarization or an MDM PPPC profile, which we don't have). But the first
`phantombot update` gives the binary its stable identity, so after the single
Full Disk Access grant, macOS never nags again.

## Non-macOS

`fix-signing` is a friendly no-op on Linux and Windows — there is no TCC and
nothing to fix.
