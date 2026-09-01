/**
 * The first-run flow must never dead-end (issue #471).
 *
 * REGRESSION test for two bugs that shipped in the first cut of the TUI, both
 * caused by deriving navigation state from a CONSTANT prop:
 *
 *   1. The chat session effect was gated on `props.startPersona`. `<App>` is
 *      rendered exactly once, so on a fresh box that prop is `undefined`
 *      forever — finishing the wizard landed on `screen: "chat"` with no
 *      session, which rendered a bare `opening alice…` with no Frame, no
 *      footer, and no `useInput` mounted. With `exitOnCtrlC: false`, `^q`,
 *      `^c` and `esc` were all inert: the only way out was killing the
 *      terminal.
 *
 *   2. The opening screen was chosen on `startPersona` alone, so an INCOMPLETE
 *      persona — which arrives with a name AND a resume point — opened chat
 *      instead of the wizard, and `wizardStartAt` was unreachable on every
 *      path.
 *
 * These are asserted by mounting the real `<App>` and driving real keystrokes,
 * because both bugs typecheck, render, and pass every unit test around them.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { render } from "ink";
import React from "react";

import { App } from "../src/tui/App.tsx";
import type { ChatSession } from "../src/tui/chatSession.ts";
import type { HostSnapshot } from "../src/tui/snapshot.ts";

/**
 * A stdin Ink accepts. It must be a REAL readable stream: Ink 6 pulls input
 * with `stdin.on("readable")` + `stdin.read()`, so an EventEmitter emitting
 * "data" renders fine and silently receives no keystrokes at all.
 */
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

/**
 * A `ChatSession` that opens instantly and needs nothing on disk. The real
 * opener is injected in production; here it is stubbed so the session-gate
 * bug is OBSERVABLE. With `openChat`, a temp persona that does not exist
 * rejects on both the fixed and the broken gate, so the frame reads
 * `opening alice…` either way and the regression passes a green suite.
 */
function fakeSession(persona: string): ChatSession {
  return {
    persona,
    conversation: `cli:tui:${persona}`,
    history: [],
    // eslint-disable-next-line require-yield
    async *send() {
      return;
    },
    close: async () => {},
  } as unknown as ChatSession;
}

const HOST: HostSnapshot = {
  version: "0.0.0-test",
  updateChannel: "stable",
  defaultPersona: "alice",
  personasDir: "/tmp/does-not-exist",
  personas: [],
};

const tick = () => new Promise((r) => setTimeout(r, 30));

/**
 * Point every path at a temp root. Without this the test opens a chat session
 * against the DEVELOPER'S OWN personas and can write their state.json.
 */
const saved: Record<string, string | undefined> = {};
const ENV = [
  "PHANTOMBOT_CONFIG",
  "PHANTOMBOT_STATE",
  "PHANTOMBOT_PERSONAS_DIR",
  "PHANTOMBOT_PERSONA",
] as const;

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "phantombot-tui-firstrun-"));
  tmpRoot = root;
  for (const k of ENV) saved[k] = process.env[k];
  process.env.PHANTOMBOT_CONFIG = join(root, "config.toml");
  process.env.PHANTOMBOT_STATE = join(root, "state.json");
  process.env.PHANTOMBOT_PERSONAS_DIR = join(root, "personas");
  delete process.env.PHANTOMBOT_PERSONA;
});

afterAll(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup) c();
  cleanup = [];
});

/** The temp personas root, set by beforeAll — real-creation helpers need it. */
let tmpRoot: string;

/**
 * An `onCreatePersona` that RECORDS the name like the plain mock, but also
 * writes the minimal persona to the temp root — identity.json plus a config
 *.toml naming the chosen brain — so the post-create `refresh()` sees a real
 * phantom and the app can actually land in Configure for it. Without the
 * write, the settings screen renders its no-phantom placeholder and the
 * redirect is unobservable.
 */
function recordingCreate(created: string[]) {
  return async (a: { name: string; brain?: string }) => {
    // The bounded Enter loop can reach the done step twice while the first
    // finish is still settling; a repeat create of the same name is a no-op.
    if (created.includes(a.name)) return { created: false };
    created.push(a.name);
    const dir = join(tmpRoot, "personas", a.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "identity.json"), "{}", "utf8");
    writeFileSync(
      join(dir, "config.toml"),
      `[harnesses]\nchain = ["${a.brain ?? "claude"}"]\n`,
      "utf8",
    );
    return { created: true };
  };
}

function mount(props: Partial<React.ComponentProps<typeof App>> = {}) {
  const stdin = fakeStdin();
  const stdout = fakeStdout();
  const created: string[] = [];
  const instance = render(
    <App
      host={HOST}
      onCreatePersona={async (a) => void created.push(a.name)}
      onWizardBrain={async () => ({ landing: "configure", notice: "" })}
      {...props}
    />,
    {
      stdin: stdin as never,
      stdout: stdout as never,
      exitOnCtrlC: false,
      patchConsole: false,
      // Ink writes NOTHING to stdout until unmount when `is-in-ci` says it is
      // in CI (ink/build/ink.js buffers into `lastOutput`), so a frame
      // assertion passes locally and fails on every runner. `debug` makes each
      // render write its full output on both paths.
      debug: true,
    },
  );
  cleanup.push(() => instance.unmount());
  return {
    instance,
    created,
    frame: () => stdout.frames.join(""),
    // `debug: true` rewrites the WHOLE screen on every render, so the last
    // write is the current frame. Needed wherever a test asserts what a screen
    // is NOT showing — `frame()` still holds every earlier screen.
    lastFrame: () => stdout.frames[stdout.frames.length - 1] ?? "",
    press: async (bytes: string) => {
      stdin.write(bytes);
      await tick();
    },
    /**
     * Wait for the app to actually be on screen before driving it.
     *
     * Ink mounts asynchronously and `<App>` does real work on the way up
     * (config, snapshot). A fixed `await tick()` before the first keystroke is
     * a race the suite lost as soon as startup grew: the chunk was written to
     * a stdin nobody was reading yet, the name box stayed empty, and the
     * failure surfaced three assertions later as "the wizard never finished".
     */
    waitFor: async (predicate: (frame: string) => boolean, ms = 3000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (predicate(stdout.frames[stdout.frames.length - 1] ?? "")) return;
        await tick();
      }
      throw new Error(
        `waitFor timed out; last frame:\n${stdout.frames[stdout.frames.length - 1] ?? "(nothing rendered)"}`,
      );
    },
    /**
     * Enter-until-advance: a keystroke written while the screen is
     * transitioning can land in the commit→effect window where no input
     * handler is subscribed yet (Ink registers `useInput` in a passive
     * effect, after the frame paints). A real user taps again when nothing
     * seems to happen; the test mirrors that. Bounded so a genuine deadlock
     * fails loudly instead of looping forever.
     */
    enterUntil: async (marker: string, ms = 500) => {
      for (let i = 0; i < 10; i++) {
        stdin.write("\r");
        await tick();
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if ((stdout.frames[stdout.frames.length - 1] ?? "").includes(marker))
            return;
          await tick();
        }
      }
      throw new Error(
        `enterUntil('${marker}') exhausted; last frame:\n${stdout.frames[stdout.frames.length - 1] ?? "(nothing rendered)"}`,
      );
    },
  };
}

describe("first run", () => {
  test("invalid names stay on the field with an inline error", async () => {
    const app = mount({ startPersona: undefined });
    await app.waitFor((f) => f.includes("Persona name"));
    await app.press("Bad Name\r");
    await app.waitFor((f) => f.includes("invalid name"));
    expect(app.lastFrame()).toContain("Persona name");
    expect(app.created).toEqual([]);
  });

  test("three questions plus the optional pair, then the creation callback runs with no technical steps", async () => {
    const app = mount({ startPersona: undefined });
    await app.waitFor((f) => f.includes("Persona name"));
    // name → identity (accept the editable default) → tone → skills (skip)
    // → your name (skip).
    await app.press("alice\r");
    await app.waitFor((f) => f.includes("One-line identity"));
    expect(app.lastFrame()).toContain("a helpful, no-nonsense assistant");
    await app.enterUntil("Default tone");
    await app.enterUntil("Skills & disciplines");
    await app.enterUntil("Your name");
    await app.enterUntil("alice");
    expect(app.created).toEqual(["alice"]);
  });

  test("completing the wizard leaves an app that can still be quit", async () => {
    const created: string[] = [];
    const app = mount({
      startPersona: undefined,
      onCreatePersona: recordingCreate(created),
    });
    await app.waitFor((f) => f.includes("Persona name"));

    // name → identity → tone, accepting each step's default. Bounded rather
    // than exact so the test asserts "the wizard completes", not "the wizard
    // has exactly three steps".
    await app.press("alice\r");
    await app.waitFor((f) => f.includes("alice"));
    for (let i = 0; i < 12 && app.created.length === 0; i++) {
      await app.press("\r");
    }

    expect(created).toEqual(["alice"]);

    // Straight into CONFIGURE for the name the user typed — a just-created
    // persona is an unfinished one, and the settings screen is where the rest
    // of its setup lives. It must still be a real, quittable screen.
    const frame = app.frame();
    expect(frame).toContain("alice");
    expect(frame).toContain("Identity");

    let exited = false;
    void app.instance.waitUntilExit().then(() => void (exited = true));
    await app.press("\x11"); // ^q
    await tick();
    expect(exited).toBe(true);
  });

  test("completing the wizard lands in Configure and opens no chat session", async () => {
    // The pinning test for bug 1, updated for the Configure redirect: `<App>`
    // renders ONCE, so the broken gate (`if (!props.startPersona) return`)
    // could never fire on the wizard path. The session must still be gated on
    // a REAL decision — and the decision now is NO session: a persona that
    // just came out of the wizard is unfinished, so it lands in Configure and
    // chat stays one esc away.
    const opened: string[] = [];
    const created: string[] = [];
    const app = mount({
      startPersona: undefined,
      onCreatePersona: recordingCreate(created),
      openSession: async ({ persona }) => {
        opened.push(persona);
        return fakeSession(persona);
      },
    });
    await tick();

    await app.press("alice");
    for (let i = 0; i < 12 && created.length === 0; i++) {
      await app.press("\r");
    }
    expect(created).toEqual(["alice"]);
    await tick();

    // No session was opened for the fresh persona — Configure first.
    expect(opened).toEqual([]);

    // And the settings screen is actually mounted, not the placeholder.
    const frame = app.lastFrame();
    expect(frame).not.toContain("opening alice");
    expect(frame).toContain("Identity");
    expect(frame).toContain("Brain");
  });

  test("an incomplete persona opens the wizard, not chat", async () => {
    const app = mount({ startPersona: "alice", wizardStartAt: "identity" });
    await tick();
    // The wizard's identity question, resumed — with the editable default
    // pre-filled, not the old brain interrogation.
    expect(app.frame()).toContain("One-line identity");
    expect(app.frame()).toContain("a helpful, no-nonsense assistant");
  });

  test("a resumed persona's identity question accepts the default", async () => {
    const app = mount({
      host: {
        ...HOST,
        personas: [
          {
            name: "alice",
            dir: "/tmp/does-not-exist/alice",
          } as HostSnapshot["personas"][number],
        ],
      },
      startPersona: "alice",
      wizardStartAt: "identity",
    });
    await tick();
    // A resume has no name question behind it — the persona already exists.
    await app.press("\u001b");
    expect(app.frame()).toContain("One-line identity");
    // Enter accepts the pre-filled default identity → the tone picker.
    await app.press("\r");
    expect(app.frame()).toContain("Default tone");
  });

  test("a resumed persona reports an update, not newly created identity files", async () => {
    const app = mount({
      startPersona: "alice",
      wizardStartAt: "identity",
      onCreatePersona: async () => ({ created: false }),
    });
    await app.waitFor((f) => f.includes("One-line identity"));
    // Accept the default identity, then the first tone, then skip the
    // optional skills and owner questions. The final Enter-until fires on the
    // owner screen itself — the notice is the marker it waits for.
    await app.enterUntil("Skills & disciplines");
    await app.enterUntil("updated alice · config.toml");
    expect(app.lastFrame()).not.toContain("created /tmp/does-not-exist/alice");
  });

  test("a complete persona opens chat", async () => {
    const app = mount({ startPersona: "alice" });
    await tick();
    expect(app.frame()).not.toContain("Claude Code CLI");
  });
});
