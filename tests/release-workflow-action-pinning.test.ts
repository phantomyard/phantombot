import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// release.yml is the only workflow that handles code-signing credentials: it
// passes ES_USERNAME / ES_PASSWORD / ES_CREDENTIAL_ID / ES_TOTP_SECRET to the
// eSigner action. Every step in that job runs on the same runner BEFORE those
// secrets are exposed, so any action referenced by a mutable ref (a branch or
// a major tag like @v4, both of which can be deleted and re-pushed at the same
// name) is part of the credential path: a compromised retag can alter the
// workspace or toolchain, append to GITHUB_PATH/GITHUB_ENV, or leave a process
// behind to observe the signing credentials later in the job.
//
// This guard fails the moment someone adds an unpinned `uses:` back.
const WORKFLOW = join(import.meta.dir, '..', '.github', 'workflows', 'release.yml');

const SHA_REF = /^[0-9a-f]{40}$/;

type UseRef = { line: number; raw: string; action: string; ref: string; comment: string };

function collectUses(text: string): UseRef[] {
  const out: UseRef[] = [];
  text.split('\n').forEach((raw, i) => {
    const m = raw.match(/^\s*(?:-\s+)?uses:\s*(\S+)\s*(#.*)?$/);
    if (!m) return;
    const value = m[1];
    // Local (./path) and docker:// references are not fetched from a mutable
    // upstream git ref, so they are out of scope for this rule.
    if (value.startsWith('./') || value.startsWith('docker://')) return;
    const at = value.lastIndexOf('@');
    out.push({
      line: i + 1,
      raw: raw.trim(),
      action: at === -1 ? value : value.slice(0, at),
      ref: at === -1 ? '' : value.slice(at + 1),
      comment: (m[2] ?? '').trim(),
    });
  });
  return out;
}

describe('release workflow action pinning', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  const uses = collectUses(text);

  it('references at least one external action (guard is actually looking at something)', () => {
    expect(uses.length).toBeGreaterThan(0);
  });

  it('pins every action to a full 40-character commit sha', () => {
    const unpinned = uses.filter((u) => !SHA_REF.test(u.ref));
    expect({ unpinned: unpinned.map((u) => `line ${u.line}: ${u.raw}`) }).toEqual({ unpinned: [] });
  });

  it('records the human-readable version each sha corresponds to', () => {
    // Without the trailing `# vX.Y.Z` a reviewer cannot tell what a bare sha
    // is, and nobody can tell when the pin has gone stale.
    const undocumented = uses.filter((u) => !/^#\s*v?\d+\.\d+/.test(u.comment));
    expect({ undocumented: undocumented.map((u) => `line ${u.line}: ${u.raw}`) }).toEqual({
      undocumented: [],
    });
  });

  it('still signs with the reviewed eSigner action', () => {
    const signer = uses.filter((u) => u.action === 'SSLcom/esigner-codesign');
    expect(signer.length).toBeGreaterThan(0);
    for (const s of signer) expect(SHA_REF.test(s.ref)).toBe(true);
  });
});
