import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// #797: a PR labelled `behaviour-change` must put a warning banner at the TOP
// of its release notes. The #785 sandbox broke existing scheduled tasks and
// the notes said nothing beyond the PR title. These tests run the workflow's
// real shell and jq, so deleting either half of the wiring turns them red.
const WORKFLOW = join(import.meta.dir, '..', '.github', 'workflows', 'release.yml');

type Step = { name?: string; run?: string };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

function step(name: string): string {
  const wf = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8')) as Workflow;
  for (const job of Object.values(wf.jobs)) {
    for (const s of job.steps ?? []) if (s.name === name && s.run) return s.run;
  }
  throw new Error(`step not found: ${name}`);
}

function resolveFlag(prJson: string): string {
  const script = step('Resolve originating PR (audit trail only)');
  const filter = script.match(/BEHAVIOUR_CHANGE=\$\(echo "\$PR_JSON" \| jq -r '([^']+)'\)/)?.[1];
  expect(filter).toBeDefined();
  const r = spawnSync('jq', ['-r', filter as string], { input: prJson, encoding: 'utf8' });
  expect(r.status).toBe(0);
  return r.stdout.trim();
}

function renderNotes(behaviourChange: string, prNumber = '785'): string {
  const dir = mkdtempSync(join(tmpdir(), 'pb-relnotes-'));
  try {
    const r = spawnSync('bash', ['-e', '-c', step('Write release notes to file')], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        TAG: 'v1.1.999',
        PR_NUMBER: prNumber,
        PR_TITLE: 'Sandbox scheduled wakes',
        BEHAVIOUR_CHANGE: behaviourChange,
        RUN_NUMBER: '999',
        RUN_ID: '1',
        REPO: 'phantomyard/phantombot',
        SERVER_URL: 'https://github.com',
        SHA: 'abc123',
      },
    });
    expect(r.status).toBe(0);
    return readFileSync(join(dir, 'release-notes.md'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('release notes behaviour-change banner (#797)', () => {
  it('flags a PR carrying the behaviour-change label', () => {
    expect(resolveFlag('[{"number":785,"labels":[{"name":"security"},{"name":"behaviour-change"}]}]')).toBe('true');
  });

  it('does not flag an unlabelled PR or a direct push', () => {
    expect(resolveFlag('[{"number":1,"labels":[{"name":"bug"}]}]')).toBe('false');
    expect(resolveFlag('[]')).toBe('false');
  });

  it('puts the banner first, linking the PR, when flagged', () => {
    const notes = renderNotes('true');
    expect(notes.startsWith('## ⚠️ Behaviour change')).toBe(true);
    expect(notes).toContain('Read https://github.com/phantomyard/phantombot/pull/785 before you update');
    expect(notes).toContain('Automated release from workflow run #999');
  });

  it('links the commit when there is no PR', () => {
    expect(renderNotes('true', '')).toContain('Read https://github.com/phantomyard/phantombot/commit/abc123 before you update');
  });

  it('leaves notes unchanged when not flagged', () => {
    const notes = renderNotes('false');
    expect(notes).not.toContain('Behaviour change');
    expect(notes.startsWith('Automated release from workflow run #999')).toBe(true);
  });
});
