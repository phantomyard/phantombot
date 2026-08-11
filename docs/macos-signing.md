# macOS: stopping the permission-prompt nagging (`fix-signing`)

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

## The fix: a stable signing identity

```
phantombot fix-signing
```

This installs a **stable self-signed code-signing identity** and signs the
current binary with it. Because the identity no longer changes on every update,
a single grant sticks across all future updates.

After running it once, grant **Full Disk Access** to phantombot in
**System Settings → Privacy & Security → Full Disk Access** (Full Disk Access is
granted by path, so it survives the binary being rewritten). That's the last
prompt you'll see — every subsequent `phantombot update` re-applies the same
identity silently.

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

### Safety: it can't break anything

`fix-signing` is **transactional**. It backs up the binary before signing and,
on any failure, restores it. If the failure happened while creating the identity
this run, it also tears the keychain down and clears the stored password — so a
half-made identity is never left behind. Worst case, you're back to exactly the
prior state: working binary, ad-hoc signature, still nagging. Nothing to
un-break.

Every external command runs under a timeout, so codesign can never hang waiting
on a prompt.

## What happens on future updates

`phantombot update` re-applies the stable signature **only if you've opted in**
(the `fix-signing` keychain exists). That step is best-effort and fail-safe: if
re-signing fails for any reason, the update restores the freshly-swapped binary
and continues — you get a working new binary and, at most, one extra macOS
prompt. If you **never** ran `fix-signing`, the update path runs zero new code
and behaves byte-for-byte as it always has.

## New installs

There is no way to ship a self-signed app that touches Documents/Desktop/
Downloads with **zero** first-run prompts (that needs a Developer ID cert +
notarization or an MDM PPPC profile, which we don't have). But after the single
Full Disk Access grant, the stable identity means macOS never nags again.

## Non-macOS

`fix-signing` is a friendly no-op on Linux and Windows — there is no TCC and
nothing to fix.
