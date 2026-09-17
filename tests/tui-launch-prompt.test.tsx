/**
 * `phantombot --prompt` — the seeded first turn (issue #575).
 *
 * The flag exists so a desktop launcher (Omarchy's default-agent picker) can
 * hand phantombot a prompt the way it hands one to `pi`, `claude` and `codex`.
 * Its security premise is that the prompt runs IN FRONT OF THE USER, in the
 * TUI they just launched — which is also why these tests drive the real `App`
 * and the real `ChatScreen` rather than asserting on a plan: "the prompt was
 * parsed" and "the prompt was actually sent as a turn, exactly once, to the
 * phantom the user named" are different claims, and only the second one is the
 * feature.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";

import { App } from "../src/tui/App.tsx";
import { seedForOpening } from "../src/tui/index.tsx";
import type { ChatSession } from "../src/tui/chatSession.ts";
import type { HostSnapshot, PersonaSnapshot } from "../src/tui/snapshot.ts";

function fakeStdin() {
  const s = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: () => void;
    ref: () => void;
    unref: () => void;
  };
  s.isTTY = true;
  s.setRawMode = () => {};
  s.ref = () => {};
  s.unref = () => {};
  return s;
}

function fakeStdout() {
  const frames: string[] = [];
  const s = new EventEmitter() as EventEmitter & {
    columns: number;
    rows: number;
    write: (c: string) => void;
    frames: string[];
  };
  s.columns = 100;
  s.rows = 40;
  s.frames = frames;
  s.write = (c: string) => void frames.push(c);
  return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const last = (frames: string[]) => frames.at(-1) ?? "";

function persona(name: string, isDefault: boolean): PersonaSnapshot {
  return {
    name,
    dir: `/tmp/does-not-exist/${name}`,
    isDefault,
    autostart: false,
    chain: ["claude"],
    brainConfigured: true,
    channels: ["cli only"],
    identity: { files: [] },
    channelDetails: [],
    memory: { dbPath: `/tmp/does-not-exist/${name}/memory.sqlite` },
    completeness: {
      persona: name,
      complete: true,
      resumeAt: "done",
      requirements: [],
    },
  };
}

const HOST: HostSnapshot = {
  version: "0.0.0-test",
  updateChannel: "stable",
  defaultPersona: "alice",
  personasDir: "/tmp/does-not-exist",
  personas: [persona("alice", true), persona("bob", false)],
} as HostSnapshot;

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

interface Recorded {
  sent: string[];
  commands: string[];
  workingDirs: Array<string | undefined>;
}

/**
 * Mount the real app with a recording session.
 *
 * `sessionPersona` exists for one case only: the guard that a seed is offered
 * to the persona the launch NAMED. Everywhere else it is the start persona,
 * exactly as production resolves it.
 */
function mountApp(props: {
  seedPrompt?: string;
  startPersona?: string;
  sessionPersona?: (requested: string) => string;
  startNotice?: string;
  workingDir?: string;
}) {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const rec: Recorded = { sent: [], commands: [], workingDirs: [] };
  const instance = render(
    <App
      host={HOST}
      startPersona={props.startPersona ?? "alice"}
      seedPrompt={props.seedPrompt}
      startNotice={props.startNotice}
      workingDir={props.workingDir}
      onCreatePersona={async () => {}}
      openSession={async ({ persona, workingDir }) => {
        rec.workingDirs.push(workingDir);
        const name = props.sessionPersona?.(persona) ?? persona;
        return {
          persona: name,
          conversation: `cli:tui:${name}`,
          history: [],
          async *send(text: string) {
            rec.sent.push(`${name}:${text}`);
            yield { type: "done", text: "ok" } as never;
          },
          async command(text: string) {
            rec.commands.push(`${name}:${text}`);
            return { reply: "ok" };
          },
          reloadHarnesses: async () => [],
          close: async () => {},
        } as unknown as ChatSession;
      }}
    />,
    {
      stdin: stdin as never,
      stdout: stdout as never,
      exitOnCtrlC: false,
      patchConsole: false,
      debug: true,
    },
  );
  mounted.push(() => instance.unmount());
  return {
    rec,
    frame: () => last(stdout.frames),
    press: async (bytes: string) => {
      stdin.write(bytes);
      await sleep(80);
    },
    settle: () => sleep(120),
  };
}

describe("the launch prompt reaches the conversation", () => {
  test("it is sent as a real turn, and shown in the transcript", async () => {
    const app = mountApp({ seedPrompt: "review this project" });
    await app.settle();
    expect(app.rec.sent).toEqual(["alice:review this project"]);
    // Visible, not just dispatched: the user must see what was asked on their
    // behalf — that is the whole difference from the headless `ask` detour.
    expect(app.frame()).toContain("review this project");
  });

  test("a seeded slash command runs as a command, exactly like a typed one", async () => {
    const app = mountApp({ seedPrompt: "/status" });
    await app.settle();
    expect(app.rec.commands).toEqual(["alice:/status"]);
    expect(app.rec.sent).toEqual([]);
  });

  test("it is sent ONCE — a trip to settings and back never replays it", async () => {
    // The chat screen unmounts on ^s and remounts on esc. A mount-scoped guard
    // alone would resend the launch prompt every time the user came back.
    const app = mountApp({ seedPrompt: "ship it" });
    await app.settle();
    await app.press("\x13"); // ^s → the phantom table
    expect(app.frame()).toContain("PHANTOMS");
    await app.press("\x1b"); // esc → back to the conversation
    expect(app.frame()).toContain("Send");
    await app.press("\x13");
    await app.press("\x1b");
    expect(app.rec.sent).toEqual(["alice:ship it"]);
  });

  test("no launch prompt means no turn at all", async () => {
    const app = mountApp({});
    await app.settle();
    expect(app.rec.sent).toEqual([]);
    expect(app.rec.commands).toEqual([]);
  });

  test("only the persona the launch named is seeded", async () => {
    // A session that opened on someone else (the user reached the table and
    // switched before it opened) must not inherit the prompt: `--persona kai`
    // means kai, and a prompt delivered to the wrong phantom is a prompt the
    // user never approved for it.
    const app = mountApp({
      seedPrompt: "ship it",
      startPersona: "alice",
      sessionPersona: () => "bob",
    });
    await app.settle();
    expect(app.rec.sent).toEqual([]);
  });

  test("the launch cwd is handed to the session it opens", async () => {
    const app = mountApp({ workingDir: "/tmp/work" });
    await app.settle();
    expect(app.rec.workingDirs).toEqual(["/tmp/work"]);
  });

  test("a dropped prompt is explained on screen, not silently discarded", async () => {
    const app = mountApp({
      startNotice: "--prompt was not sent: finish setting up this phantom.",
    });
    await app.settle();
    expect(app.frame()).toContain("--prompt was not sent");
  });
});

describe("seedForOpening", () => {
  test("only a ready chat takes the prompt", () => {
    expect(seedForOpening("hi", "chat")).toEqual({ prompt: "hi" });
  });

  test("a setup screen drops it and says so", () => {
    // Holding it across onboarding would fire the turn minutes later, after
    // the user stopped expecting it — and on a phantom with no brain there is
    // nothing that could answer it at all.
    for (const screen of ["wizard", "configure"] as const) {
      const seed = seedForOpening("hi", screen);
      expect(seed.prompt).toBeUndefined();
      expect(seed.notice).toContain("--prompt");
    }
  });

  test("no prompt produces no notice", () => {
    expect(seedForOpening(undefined, "wizard")).toEqual({});
  });
});
