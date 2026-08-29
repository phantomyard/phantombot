/**
 * The router: one persistent app, many screens, no nested processes.
 *
 * Chat is HOME (`screen: "chat"`). `^s` opens the dashboard and `esc` comes
 * straight back to the same conversation at the same point — the chat session
 * is held here, above the screen switch, so leaving settings never loses a
 * thread or re-reads history.
 *
 * The one exception to "state is loaded once" is the snapshot: every action
 * that writes something refreshes it, because the entire premise of the
 * dashboard is that what you are looking at is what is on disk.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";

import {
  hostSnapshot,
  probeServiceActive,
  type HostSnapshot,
  type PersonaSnapshot,
} from "./snapshot.ts";
import {
  applyAutostart,
  applyDefaultPersona,
  applyEmbedding,
  applyVoice,
  describeAutostartChange,
  describeDefaultPersonaChange,
  describeEmbeddingChange,
  describeVoiceChange,
  openInEditor,
  setSecret,
  unsetSecret,
  type Consequence,
} from "./actions.ts";
import { Frame } from "./components/Frame.tsx";
import {
  withPromptTerminal,
} from "./prompts.ts";
import { ConfirmScreen, type ConfirmRequest } from "./screens/Confirm.tsx";
import { AskScreen, type AskRequest } from "./screens/Ask.tsx";
import { ChooseScreen, type ChooseRequest } from "./screens/Choose.tsx";
import { ReembedScreen, type ReembedState } from "./screens/Reembed.tsx";
import type { EmbeddingConfigUpdate } from "../cli/embedding.ts";
import { openChat, type ChatSession } from "./chatSession.ts";
import { ChatScreen } from "./screens/Chat.tsx";
import { DashboardScreen } from "./screens/Dashboard.tsx";
import { PersonaDetailScreen } from "./screens/PersonaDetail.tsx";
import { KeysScreen } from "./screens/Keys.tsx";
import { MemoryScreen, type SearchHit } from "./screens/Memory.tsx";
import { VoiceScreen } from "./screens/Voice.tsx";
import { DoctorScreen } from "./screens/Doctor.tsx";
import { gatherStatus, type StatusRows } from "./status.ts";
import { McpScreen } from "./screens/Mcp.tsx";
import { LogsScreen } from "./screens/Logs.tsx";
import { WizardScreen, type WizardAnswers } from "./screens/Wizard.tsx";
import { theme } from "./theme.ts";
import { mouse } from "./mouse.ts";
import { logBuffer } from "./logBuffer.ts";
import { TerminalSizeContext, renderRows, terminalSize } from "./terminal.ts";
import { loadConfigForPersona, type Config } from "../config.ts";
import { runMemorySearch } from "../cli/memory.ts";

import { runDoctor, type DoctorReport } from "../cli/doctor.ts";
import type { WizardStep } from "../lib/personaComplete.ts";
import type { VoiceProvider } from "../lib/voice.ts";

type Screen =
  | "chat"
  | "dashboard"
  | "persona"
  | "keys"
  | "memory"
  | "voice"
  | "doctor"
  | "mcp"
  | "logs"
  | "wizard";

export interface AppProps {
  host: HostSnapshot;
  /** Persona to open chat with. Undefined means "run the wizard first". */
  startPersona?: string;
  /** Where the wizard resumes, when it is the opening screen. */
  wizardStartAt?: WizardStep;
  onCreatePersona: (
    answers: WizardAnswers,
  ) => Promise<void | { created: boolean }>;
  /**
   * Seam for tests only; production always uses `openChat`. Injectable so the
   * session gate can be pinned by a test that FAILS when the gate regresses —
   * with the real opener, a nonexistent temp persona rejects either way and the
   * frame reads "opening …" in both worlds, so the bug survives a green suite.
   */
  openSession?: (input: {
    config: Config;
    persona: string;
  }) => Promise<ChatSession>;
}

export function App(props: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [host, setHost] = useState(props.host);
  // An INCOMPLETE persona arrives with both a name and a resume point, so the
  // wizard must win over chat here — otherwise `resolveOpeningScreen`'s resume
  // path is unreachable and a user whose harness is uninstalled lands in a chat
  // box wired to a brain that does not exist.
  const [screen, setScreen] = useState<Screen>(
    props.wizardStartAt ? "wizard" : props.startPersona ? "chat" : "wizard",
  );
  // Navigation history. `esc` means "the screen you came from" on every
  // screen, and a screen is reachable by more than one route — logs from chat
  // and from a phantom, doctor from the table and from a phantom — so a
  // hardcoded parent per screen would send you somewhere you never were. `go`
  // records the route as it is walked, `back` replays it in reverse, and chat
  // is the floor: the stack can never strand you outside the app.
  const screenRef = useRef<Screen>(screen);
  screenRef.current = screen;
  const navRef = useRef<Screen[]>([]);
  const go = useCallback((next: Screen) => {
    if (screenRef.current !== next) {
      navRef.current.push(screenRef.current);
      // Bounded: a long wander must not grow the stack without limit.
      if (navRef.current.length > 32) navRef.current.shift();
    }
    setScreen(next);
  }, []);
  const back = useCallback(() => {
    setScreen(navRef.current.pop() ?? "chat");
  }, []);

  const [personaName, setPersonaName] = useState(
    props.startPersona ?? host.defaultPersona,
  );
  const [session, setSession] = useState<ChatSession | undefined>();
  /**
   * Latched the first time chat is reached — including from the wizard's
   * `onFinish`, which is the path that had no way to set it before.
   */
  const [chatArmed, setChatArmed] = useState(
    Boolean(props.startPersona) && !props.wizardStartAt,
  );
  const [doctorReport, setDoctorReport] = useState<DoctorReport | undefined>();
  const [doctorStatus, setDoctorStatus] = useState<StatusRows | undefined>();
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  /**
   * True while a `@clack` prompt owns the terminal.
   *
   * Ink is suspended for the duration (see `prompts.ts`), so this is not about
   * drawing: it stops a keypress that arrived alongside the prompt from acting
   * on a screen the user cannot currently see.
   */
  const [prompting, setPrompting] = useState(false);
  /**
   * The pending confirmation, held with the resolver that answers it.
   *
   * A question drawn as a SCREEN cannot be awaited inline the way a clack
   * panel was, so `askConfirm` parks the promise here and the screen resolves
   * it. Holding the resolver in state (rather than a ref) is what makes the
   * question render at all: the answer arrives on a keystroke, in a different
   * turn of the event loop from the call that asked it.
   */
  const [confirm, setConfirm] = useState<
    (ConfirmRequest & { resolve: (yes: boolean) => void }) | undefined
  >();
  /**
   * The pending typed value and the pending list choice, each held with the
   * resolver that answers it — the same parking trick as `confirm`, and for
   * the same reason: a question drawn as a SCREEN resolves on a keystroke in a
   * later turn of the event loop, so the resolver cannot live on the stack.
   */
  const [ask, setAsk] = useState<
    (AskRequest & { resolve: (value: string | undefined) => void }) | undefined
  >();
  const [choose, setChoose] = useState<
    (ChooseRequest & { resolve: (value: string | undefined) => void }) | undefined
  >();
  const [reembed, setReembed] = useState<
    { space: string; state: ReembedState } | undefined
  >();
  const [voiceProvider, setVoiceProvider] = useState<VoiceProvider>("none");
  /**
   * The window, measured HERE and nowhere else.
   *
   * The app is full-screen now, so the root has to know the height: a flex
   * column with no height lays out to its content and leaves the frame floating
   * in the top of an empty screen. The size goes into a context, the root box
   * gets `height`, and the scrolling regions ask how many rows they may use —
   * no component reads `process.stdout`, and no component does column
   * arithmetic to draw anything. See `terminal.ts`.
   */
  const [size, setSize] = useState(() => terminalSize(stdout ?? process.stdout));

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize(terminalSize(stdout));
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  /**
   * Ask a question with clack, with the renderer suspended around it.
   *
   * Every state-changing setting goes through here or `askConfirm`, so a
   * cancelled prompt is a cancelled ACTION: `run` is only reached on an
   * explicit yes.
   */
  /** Ask the yes/no question and hand back the answer. */
  const askConfirmValue = useCallback(
    async (input: {
      title: string;
      consequence: Consequence;
      danger?: boolean;
    }) => {
      const yes = await new Promise<boolean>((resolve) => {
        setConfirm({ ...input, resolve });
      });
      setConfirm(undefined);
      return yes;
    },
    [],
  );

  const askConfirm = useCallback(
    async (input: {
      title: string;
      consequence: Consequence;
      danger?: boolean;
      run: () => Promise<void>;
    }) => {
      const { run, ...question } = input;
      if (await askConfirmValue(question)) await run();
    },
    [askConfirmValue],
  );

  /** Ask for a typed value on a screen. `undefined` means cancelled. */
  const askValue = useCallback(async (input: AskRequest) => {
    const value = await new Promise<string | undefined>((resolve) => {
      setAsk({ ...input, resolve });
    });
    setAsk(undefined);
    return value;
  }, []);

  /** Ask for one of a list on a screen. `undefined` means cancelled. */
  const askChoice = useCallback(async (input: ChooseRequest) => {
    const value = await new Promise<string | undefined>((resolve) => {
      setChoose({ ...input, resolve });
    });
    setChoose(undefined);
    return value;
  }, []);

  // One chat session per persona, opened lazily and kept across screen
  // switches so `^s` then `esc` returns to the same thread.
  useEffect(() => {
    if (screen === "chat") setChatArmed(true);
  }, [screen]);

  useEffect(() => {
    // Keyed on `chatArmed`, never on the initial prop: `<App>` is rendered
    // once, so gating on `props.startPersona` leaves the session undefined
    // forever after the wizard finishes — a frozen, keyless screen. And armed
    // ONCE rather than tracking `screen`, because a session that closed on `^s`
    // and reopened on `esc` would re-read history and lose the thread, which is
    // the whole reason the session is held above the screen switch.
    if (!chatArmed || !personaName) return;
    let cancelled = false;
    let opened: ChatSession | undefined;
    void (async () => {
      const { config } = await loadConfigForPersona(personaName);
      const chat = await (props.openSession ?? openChat)({
        config,
        persona: personaName,
        // Harness stderr into the log pane, not onto the frame. This is the
        // other half of the log-sink fix: the logger is redirected globally,
        // but a harness subprocess writes to whatever stream it was handed.
        stderr: { write: (chunk: string) => logBuffer.push(chunk) },
      });
      if (cancelled) {
        await chat.close();
        return;
      }
      opened = chat;
      setSession(chat);
    })().catch((e: unknown) => {
      // A session that cannot open must SAY so and stay quittable. Without
      // this the app sits on "opening …" forever with nothing but an unhandled
      // rejection in a log the user is not reading.
      if (!cancelled) setNotice(`could not open ${personaName}: ${(e as Error).message}`);
    });
    return () => {
      cancelled = true;
      void opened?.close();
    };
  }, [personaName, chatArmed]);

  const refresh = useCallback(async () => {
    setHost(await hostSnapshot());
  }, []);

  /**
   * The service state, probed off the render path. See `probeServiceActive`:
   * it costs a subprocess, so it is never awaited by a screen transition —
   * it lands in the dashboard's badge whenever it lands.
   */
  const [serviceActive, setServiceActive] = useState<boolean | undefined>();
  const probeService = useCallback(async () => {
    setServiceActive(await probeServiceActive());
  }, []);
  // Probed only once the screen that SHOWS it is open. At mount it cost a
  // subprocess on the startup path for a badge nobody was looking at, and the
  // first-run regression test caught the consequence: the event loop was busy
  // enough that keystrokes batched and the wizard read "alice\n" as a name.
  useEffect(() => {
    if (screen === "dashboard" && serviceActive === undefined) {
      void probeService();
    }
  }, [screen, serviceActive, probeService]);

  const persona =
    host.personas.find((p) => p.name === personaName) ?? host.personas[0];

  // Mouse clicks are routed centrally to the topmost registered rect. A click
  // that hits nothing is simply ignored — it must never fall through to a
  // keyboard handler.
  useEffect(() => {
    if (!mouse.enabled) return;
    return mouse.onMouse((event) => {
      if (event.kind !== "down") return;
      mouse.click(event.column, event.row);
    });
  }, []);

  useInput((char, key) => {
    // While a clack prompt owns the terminal the app is not on screen. Acting
    // on a keystroke here would change something the user cannot see.
    if (prompting) return;
    // The confirmation is a screen with its own keys. Without this the app's
    // global esc would answer the question AND pop a level of history behind
    // it, landing the user a screen further back than they asked for.
    if (confirm) return;
    // Same for the two other question screens: they own their keys, and the
    // global esc would answer the question AND pop a level behind it.
    if (ask || choose) return;
    // The log pane, from anywhere: log lines are captured while the TUI runs
    // (they used to be painted over the frame), so there has to be one key
    // that shows them. Toggles, so ^l gets you back out of it too.
    if (key.ctrl && char === "l") {
      if (screenRef.current === "logs") back();
      else go("logs");
      return;
    }
    // A global safety net for the ONE state that renders no screen component,
    // and so owns no keyboard: a per-phantom screen with no phantom to show.
    // Every real screen handles its own esc through `back`, and this net must
    // not also fire for those — two handlers popping the same history entry
    // would skip a level.
    if (
      key.escape &&
      !persona &&
      screen !== "chat" &&
      screen !== "wizard" &&
      screen !== "dashboard"
    ) {
      back();
      return;
    }
    // The one state no screen owns the keyboard for: chat before its session
    // has opened. `exitOnCtrlC: false` means Ink will not rescue us either, so
    // without this the window between "wizard finished" and "session ready" —
    // or a session that never opens because the harness is gone — is
    // unquittable except by killing the terminal, with mouse reporting still on.
    if (screen === "chat" && !session) {
      if ((key.ctrl && (char === "q" || char === "c")) || key.escape) exit();
    }
  });

  const search = useCallback(
    async (query: string): Promise<SearchHit[]> => {
      // Reuse the SUBCOMMAND's search rather than reimplementing scoring, so
      // the two surfaces can never disagree about what recall returns.
      let buffer = "";
      await runMemorySearch({
        query,
        persona: personaName,
        limit: 5,
        out: { write: (chunk: string) => void (buffer += chunk) },
      });
      try {
        const parsed = JSON.parse(buffer) as {
          results?: Array<{
            path: string;
            ftsScore?: number;
            vecScore?: number;
          }>;
        };
        return parsed.results ?? [];
      } catch {
        return [];
      }
    },
    [personaName],
  );

  const runTheDoctor = useCallback(async () => {
    setDoctorRunning(true);
    try {
      let buffer = "";
      await runDoctor({
        persona: personaName,
        json: true,
        // Read-only: opening a health screen must not repair anything behind
        // the user's back.
        repair: false,
        out: { write: (chunk: string) => void (buffer += chunk) },
      });
      setDoctorReport(JSON.parse(buffer) as DoctorReport);
      // The live `/status` probes, alongside the checks. Gathered second and
      // guarded separately: they reach the network, so a slow or failing probe
      // must not cost the user the report that already succeeded.
      try {
        setDoctorStatus(
          await gatherStatus({ persona: personaName, chain: persona?.chain }),
        );
      } catch {
        setDoctorStatus(undefined);
      }
    } catch (e) {
      setNotice(`doctor failed: ${(e as Error).message}`);
    } finally {
      setDoctorRunning(false);
    }
  }, [personaName]);

  /**
   * The harness chain, on screens.
   *
   * `runHarness` is the SAME function `phantombot harness` runs — it writes the
   * chain, Pi's routing, the provider key and the "use Pi's own config"
   * tombstone, and none of that is worth a second implementation. Only the
   * ASKING is swapped: every question becomes one of this app's own screens, so
   * the flow keeps the frame and never hands the terminal over.
   */
  const changeBrain = useCallback(
    async (target: PersonaSnapshot) => {
      setPrompting(true);
      try {
        // Imported ON DEMAND: pulling the whole `harness` subcommand graph in at
        // module scope delayed the app's first render enough that the opening
        // keystrokes were dropped — the first-run test caught it as a wizard
        // whose name box stayed empty.
        const { runHarness } = await import("../cli/harness.ts");
        const firstLine = (text: string) =>
          text.split("\n").find((l) => l.trim().length > 0) ?? "";
        await runHarness({
          persona: target.name,
          prompts: {
            // The Pi installer inherits stdin and paints its own onboarding:
            // a hand-over mid-render, which is the wedge this port removes.
            canRunInteractiveInstaller: false,
            select: async (input) =>
              (await askChoice({
                title: input.message,
                options: input.options.map((o) => ({
                  value: o.value,
                  label: o.label,
                  hint: o.hint,
                })),
                initial: input.initialValue,
              })) as never,
            text: async (input) =>
              await askValue({
                title: input.message,
                hint: input.placeholder,
                initial: input.initialValue ?? input.defaultValue,
                // "blank = keep current / none" is a real answer in this flow.
                allowEmpty: true,
              }),
            password: async (input) =>
              await askValue({
                title: input.message,
                hint: "stored in this phantom's vault, never displayed again",
                masked: true,
                allowEmpty: true,
              }),
            // The flow's own wording is the whole question — repeating it as a
            // "consequence" said the same sentence twice, and a fixed detail
            // line would be wrong for at least one of the questions asked here.
            confirm: async (input) =>
              await askConfirmValue({
                title: input.message,
                consequence: {
                  summary: "",
                  detail: "",
                  longRunning: false,
                  restarts: false,
                },
              }),
            // Clack panels have nowhere to live on a framed screen, so a note
            // becomes the notice line. The body's first line carries the fact;
            // the rest is the CLI's prose.
            note: (body, title) =>
              setNotice(title ? `${title}: ${firstLine(body)}` : firstLine(body)),
            intro: () => {},
            outro: () => {},
            cancel: () => setNotice("brain unchanged"),
          },
        });
      } catch (e) {
        setNotice(`brain failed: ${(e as Error).message}`);
      } finally {
        setPrompting(false);
        await refresh();
      }
    },
    [refresh, askChoice, askValue, askConfirmValue],
  );

  /**
   * Configure the persona's Telegram bot, on screens rather than in the
   * `phantombot telegram` clack flow. The WRITE path is still that command's
   * (`applyTelegramConfig` + `resolvePersonaWriteTarget`), so the TUI and the
   * CLI cannot write different shapes of the same block.
   */
  const changeChannels = useCallback(
    async (target: PersonaSnapshot) => {
      setPrompting(true);
      const notices: string[] = [];
      try {
        // Imported ON DEMAND for the same reason as the harness graph: pulling
        // the Telegram client in at module scope delays first render enough to
        // drop opening keystrokes.
        const { applyTelegramConfig } = await import("../cli/telegram.ts");
        const { telegramGetMe } = await import("../lib/telegramApi.ts");
        const { loadConfig, personaDir } = await import("../config.ts");
        const { resolvePersonaWriteTarget } = await import(
          "../lib/personaConfig.ts"
        );
        const {
          configurePhantomchat,
          configureTelegram,
          offerChannel,
        } = await import("./channelsFlow.ts");
        const {
          ensurePhantomchatIdentity,
          savePhantomchatAllowlist,
        } = await import("../cli/phantomchat.ts");
        const { loadPhantomchatPersonaConfig } = await import(
          "../channels/phantomchat/personaStore.ts"
        );

        const questions = {
          choose: askChoice,
          value: askValue,
          confirm: askConfirmValue,
        };
        const global = await loadConfig();
        const agentDir = personaDir(global, target.name);

        // Same order as `phantombot init`: phantomchat, then telegram. BOTH are
        // optional and each one is gated on its own choice, so a phantom that
        // already has a channel is never walked back through its setup to reach
        // the other one.
        const chat = loadPhantomchatPersonaConfig(agentDir);
        if (
          await offerChannel(questions, {
            title: `PhantomChat for ${target.name}`,
            configured: chat
              ? chat.allowedNpubs.length > 0
                ? `${chat.allowedNpubs.length} allowed npub(s)`
                : "trust-on-first-use armed"
              : undefined,
          })
        ) {
          notices.push(
            await configurePhantomchat(target.name, questions, {
              identity: async () => {
                const id = await ensurePhantomchatIdentity(agentDir);
                return {
                  npub: id.npub,
                  allowedNpubs:
                    loadPhantomchatPersonaConfig(agentDir)?.allowedNpubs ?? [],
                };
              },
              save: async ({ allowedNpubs }) => {
                const id = await ensurePhantomchatIdentity(agentDir);
                const saved = await savePhantomchatAllowlist({
                  agentDir,
                  nsec: id.nsec,
                  allowedNpubs,
                });
                return saved.path;
              },
            }),
          );
        }

        const personaConfig = await loadConfig(target.name);
        const writeTarget = await resolvePersonaWriteTarget({
          configPath: global.configPath,
          personasDir: global.personasDir,
          persona: target.name,
        });
        // Read the way the daemon reads: the persona's own layered block
        // first, and only then the legacy per-persona routing table.
        const existing =
          personaConfig.channels.telegram ??
          global.channels.telegramPersonas?.[target.name];

        if (
          await offerChannel(questions, {
            title: `Telegram for ${target.name}`,
            configured: existing?.token
              ? `${existing.allowedUserIds?.length ?? 0} allowed user(s)`
              : undefined,
          })
        ) {
          notices.push(
            await configureTelegram(target.name, questions, {
              existing: existing?.token
                ? {
                    token: existing.token,
                    allowedUserIds: existing.allowedUserIds,
                  }
                : undefined,
              validateToken: telegramGetMe,
              save: (inputs) =>
                applyTelegramConfig(
                  writeTarget.path,
                  { ...inputs, pollTimeoutS: 30 },
                  target.name,
                  writeTarget.scope,
                ),
              targetPath: writeTarget.path,
            }),
          );
        }

        setNotice(notices.join(" · ") || "channels unchanged");
      } catch (e) {
        setNotice(`channels failed: ${(e as Error).message}`);
      } finally {
        setPrompting(false);
        await refresh();
      }
    },
    [refresh, askChoice, askValue, askConfirmValue],
  );

  /**
   * Pick one of the prompt files and open it in `$EDITOR`.
   *
   * A missing file is offered too, and creating it by opening it is the
   * correct behaviour: a persona with no USER.md is a persona that has never
   * been told who it works for, and the way to fix that is to write one.
   */
  const editIdentity = useCallback(
    async (target: PersonaSnapshot) => {
      setPrompting(true);
      try {
        const choice = await askChoice({
          title: `Which file for ${target.name}?`,
          options: target.identity.files.map((f) => ({
            value: f.path,
            label: f.name,
            hint: f.present ? undefined : "does not exist yet",
          })),
        });
        if (!choice) return;
        const r = await withPromptTerminal(() => openInEditor(choice));
        const file = choice.split("/").pop();
        setNotice(
          !r.ok
            ? `editor failed: ${r.error}`
            : r.changed
              ? `${file} saved — restart to load it`
              : `${file} unchanged`,
        );
      } finally {
        setPrompting(false);
        await refresh();
      }
    },
    [refresh, askChoice],
  );

  const body = (() => {
    if (screen === "wizard") {
      return (
        <WizardScreen
          startAt={props.wizardStartAt}
          initial={{ name: props.startPersona ?? "" }}
          defaultExists={host.personas.length > 0}
          existingNames={host.personas.map((p) => p.name)}
          personasDir={host.personasDir}
          // Only when the wizard was reached from another screen; on first
          // run the stack is empty and `back` would fall through to chat,
          // which does not exist yet.
          onBack={navRef.current.length > 0 ? back : undefined}
          onQuit={exit}
          onFinish={async (answers) => {
            try {
              const result = await props.onCreatePersona(answers);
              await refresh();
              setPersonaName(answers.name);
              setNotice(
                result?.created === false
                  ? `updated ${answers.name} · config.toml`
                  : `created ${host.personasDir}/${answers.name} · identity.json · config.toml`,
              );
              // A finished wizard is not a place to go back to.
              navRef.current = [];
              setScreen("chat");
            } catch (e) {
              setNotice(`could not create ${answers.name}: ${(e as Error).message}`);
            }
          }}
        />
      );
    }

    if (screen === "chat") {
      if (!session) {
        // NEVER a bare Text: a reachable state without a Frame is a state
        // without a footer and without a key that leaves it. `^q` is handled by
        // the global handler below precisely for this window, because
        // `ChatScreen` — which owns quit everywhere else — is not mounted yet.
        return (
          <Frame
            title={["phantombot", personaName]}
            status="starting"
            footer={[{ key: "^q", label: "Quit" }]}
          >
            <Text color={theme.dim}>opening {personaName}…</Text>
          </Frame>
        );
      }
      return (
        <ChatScreen
          session={session}
          // The header answers "which phantombot am I talking to, and which
          // release ring is it on" — the two facts that change what you should
          // expect from the app. The brain and the channel list are settings,
          // not status: they live on `^s`, and printing them here made the top
          // line read `claude · cli only` on a screen that is self-evidently a
          // chat with a phantom.
          status={`channel: ${host.updateChannel}`}
          // `^s` is chat's ONLY way out to configuration, and it lands on the
          // PHANTOM TABLE: "which phantom am I configuring" is the question
          // you have to answer before any of the per-phantom settings mean
          // anything, so the table IS the settings screen and a phantom's own
          // sections are one level in from it.
          onSettings={() => go("dashboard")}
          onQuit={exit}
        />
      );
    }

    if (screen === "dashboard") {
      return (
        <DashboardScreen
          host={{ ...host, ...(serviceActive === undefined ? {} : { serviceActive }) }}
          onChat={(name) => {
            // Chat is the FLOOR, not somewhere you push onto: arriving here
            // ends the walk, so the stack is cleared rather than left holding
            // a table you already used esc-equivalent to leave. This is also
            // the only persona SWITCHER in the app — the chat screen has no
            // key for it, so the row you pick is the thread you get.
            setPersonaName(name);
            navRef.current = [];
            setScreen("chat");
          }}
          onConfigure={(name) => {
            setPersonaName(name);
            go("persona");
          }}
          onNew={() => go("wizard")}
          onBack={back}
        />
      );
    }

    if (!persona) {
      return (
        <Box>
          <Text color={theme.warn}>no phantom selected</Text>
        </Box>
      );
    }

    if (screen === "persona") {
      return (
        <PersonaDetailScreen
          persona={persona}
          onBack={back}
          onLogs={() => go("logs")}
          onEditIdentity={() => void editIdentity(persona)}
          onChangeBrain={() => void changeBrain(persona)}
          onChangeChannels={() => void changeChannels(persona)}
          onToggleAutostart={() => {
            const on = !(persona.autostart || persona.isDefault);
            void askConfirm({
              title: `${on ? "Start" : "Stop starting"} ${persona.name} with the daemon?`,
              consequence: describeAutostartChange(persona.name, on),
              run: async () => {
                const { config } = await loadConfigForPersona(persona.name);
                const r = await applyAutostart({
                  config,
                  persona: persona.name,
                  on,
                });
                setNotice(
                  r.ok
                    ? `autostart: ${r.list.join(", ") || "none"}`
                    : `failed: ${r.error}`,
                );
                await refresh();
              },
            });
          }}
          onMakeDefault={() => {
            // The default is EXCLUSIVE — exactly one phantom owns /update and
            // /restart — so there is no "off" to toggle to. Pressing the row on
            // the phantom that already holds it used to be inert, which reads
            // as a broken row; say what the key would do instead.
            if (persona.isDefault) {
              setNotice(
                host.personas.length > 1
                  ? `${persona.name} is already the default — open another phantom and press ↵ on Default to hand it over`
                  : `${persona.name} is the only phantom on this host, so it is the default`,
              );
              return;
            }
            void askConfirm({
              title: `Make ${persona.name} the default persona?`,
              danger: true,
              consequence: describeDefaultPersonaChange(
                host.defaultPersona,
                persona.name,
              ),
              run: async () => {
                const { config } = await loadConfigForPersona(persona.name);
                const r = await applyDefaultPersona({
                  config,
                  persona: persona.name,
                });
                setNotice(
                  r.ok
                    ? `default_persona: ${host.defaultPersona} → ${persona.name}`
                    : `failed: ${r.error}`,
                );
                await refresh();
              },
            });
          }}
          onOpen={(target) => {
            if (target === "doctor") {
              go("doctor");
              void runTheDoctor();
            } else {
              go(target);
            }
          }}
        />
      );
    }

    if (screen === "keys") {
      return (
        <KeysScreen
          persona={persona}
          onSet={(name) => {
            void (async () => {
              setPrompting(true);
              try {
                const value = await askValue({
                  title: `Set ${name} for ${persona.name}`,
                  hint: "written straight to the persona vault, never displayed again",
                  masked: true,
                });
                if (!value) return;
                const { config } = await loadConfigForPersona(persona.name);
                const r = await setSecret({
                  config,
                  persona: persona.name,
                  name,
                  value,
                });
                // Name only, never the value: a confirmation that echoes a
                // secret puts it in the scrollback the user just protected it
                // from.
                setNotice(r.ok ? `saved ${name}` : `failed: ${r.error}`);
                await refresh();
              } finally {
                setPrompting(false);
              }
            })();
          }}
          onUnset={(name) =>
            void askConfirm({
              title: `Remove ${name} from ${persona.name}'s vault?`,
              danger: true,
              consequence: {
                summary: "the feature using this credential stops working",
                detail:
                  "Nothing else is deleted, and the secret can be set again — " +
                  "but the vault is the only copy, so the value itself is gone.",
                longRunning: false,
                restarts: false,
              },
              run: async () => {
                const { config } = await loadConfigForPersona(persona.name);
                const r = await unsetSecret({
                  config,
                  persona: persona.name,
                  name,
                });
                setNotice(r.ok ? `removed ${name}` : `failed: ${r.error}`);
                await refresh();
              },
            })
          }
          onBack={back}
        />
      );
    }

    if (screen === "memory") {
      return (
        <MemoryScreen
          persona={persona}
          onSearch={search}
          onChangeEmbedding={async () => {
            // Demonstrates the whole rule: the change states its consequence,
            // then PERFORMS it. There is no "now go and run" anywhere here.
            const { config } = await loadConfigForPersona(persona.name);
            const next: EmbeddingConfigUpdate = {
              provider: "openai-compatible",
              openaiCompatible: {
                // Default to OpenAI proper. The base URL is an ADVANCED field
                // (blank unless the user fills it) — today's CLI pre-fills a
                // local llama-server, which assumes an endpoint most users do
                // not run.
                baseUrl: "https://api.openai.com/v1",
                model: "text-embedding-3-small",
                dims: 1536,
              },
            };
            const consequence = describeEmbeddingChange(config, {
              next,
              indexedChunks: persona.memory.indexedTotal,
            });
            void askConfirm({
              title: "Change the embedding provider?",
              consequence,
              run: async () => {
                const space = persona.memory.embedding?.fingerprint ?? "new space";
                setReembed({
                  space,
                  state: {
                    done: 0,
                    total: persona.memory.indexedTotal ?? 0,
                    path: "",
                    startedAt: Date.now(),
                    errors: 0,
                  },
                });
                const r = await applyEmbedding({
                  config,
                  persona: persona.name,
                  change: { next, indexedChunks: persona.memory.indexedTotal },
                  onProgress: (progress) =>
                    setReembed((prev) =>
                      prev
                        ? {
                            ...prev,
                            state: {
                              ...prev.state,
                              done: progress.done,
                              total: progress.total,
                              path: progress.path,
                            },
                          }
                        : prev,
                    ),
                });
                setReembed(undefined);
                setNotice(
                  r.ok
                    ? r.reembedded
                      ? "embeddings changed and the index is back in sync"
                      : "embedding settings saved; no re-embed was needed"
                    : `failed: ${r.error}`,
                );
                await refresh();
              },
            });
          }}
          onReindex={() => setNotice("reindex queued")}
          onBack={back}
        />
      );
    }

    if (screen === "voice") {
      return (
        <VoiceScreen
          personaName={persona.name}
          provider={voiceProvider}
          onChangeProvider={setVoiceProvider}
          onPreview={() =>
            setNotice(
              voiceProvider === "none"
                ? "nothing to play — pick a provider first"
                : `previewing ${voiceProvider}`,
            )
          }
          onSave={() => {
            void (async () => {
              setPrompting(true);
              try {
                // Saving a provider ALONE used to write `[voice] provider =
                // "openai"` with no key and no voice: a phantom that reads as
                // configured and is mute on its first turn. The rest of the
                // questions `phantombot voice` asks are asked here first.
                const { configureVoice } = await import("./voiceFlow.ts");
                const { ENV_KEY_FOR_PROVIDER, validateElevenLabsKey, validateOpenAIKey } =
                  await import("../lib/voice.ts");
                const { config } = await loadConfigForPersona(persona.name);
                const chosen = await configureVoice(
                  persona.name,
                  voiceProvider,
                  { choose: askChoice, value: askValue, confirm: askConfirmValue },
                  {
                    existing: config.voice,
                    hasKey: (provider) => {
                      const envVar =
                        ENV_KEY_FOR_PROVIDER[
                          provider as "openai" | "elevenlabs"
                        ];
                      return Boolean(envVar && process.env[envVar]);
                    },
                    validateKey: (provider, key) =>
                      provider === "openai"
                        ? validateOpenAIKey(key)
                        : validateElevenLabsKey(key),
                  },
                );
                if (!chosen) return setNotice("voice unchanged");
                if ("rejected" in chosen)
                  return setNotice(`voice unchanged — key rejected: ${chosen.rejected}`);

                await askConfirm({
                  title: `Set ${persona.name}'s voice to ${chosen.summary}?`,
                  consequence: describeVoiceChange(chosen.voice),
                  run: async () => {
                    const r = await applyVoice({
                      config,
                      persona: persona.name,
                      voice: chosen.voice,
                      apiKey: chosen.apiKey,
                    });
                    setNotice(
                      r.ok
                        ? `voice saved: ${chosen.summary}`
                        : `failed: ${r.error}`,
                    );
                    await refresh();
                    back();
                  },
                });
              } finally {
                setPrompting(false);
              }
            })();
          }}
          onBack={back}
        />
      );
    }

    if (screen === "logs") {
      return (
        <LogsScreen
          personaName={personaName}
          onBack={back}
        />
      );
    }

    if (screen === "doctor") {
      return (
        <DoctorScreen
          report={doctorReport}
          status={doctorStatus}
          running={doctorRunning}
          onRerun={() => void runTheDoctor()}
          onBack={back}
        />
      );
    }

    return (
      <McpScreen
        personaName={persona.name}
        servers={[]}
        onTest={() => setNotice("mcp test not wired yet")}
        onBack={back}
      />
    );
  })();

  // A running job takes over the screen; the screen underneath keeps its state,
  // so returning from it lands exactly where the user was.
  if (confirm) {
    return (
      <TerminalSizeContext.Provider value={size}>
        <Box flexDirection="column" height={renderRows(size)}>
          <ConfirmScreen
            request={confirm}
            onAnswer={(yes) => confirm.resolve(yes)}
          />
        </Box>
      </TerminalSizeContext.Provider>
    );
  }

  if (ask) {
    return (
      <TerminalSizeContext.Provider value={size}>
        <Box flexDirection="column" height={renderRows(size)}>
          <AskScreen request={ask} onAnswer={(v) => ask.resolve(v)} />
        </Box>
      </TerminalSizeContext.Provider>
    );
  }

  if (choose) {
    return (
      <TerminalSizeContext.Provider value={size}>
        <Box flexDirection="column" height={renderRows(size)}>
          <ChooseScreen request={choose} onAnswer={(v) => choose.resolve(v)} />
        </Box>
      </TerminalSizeContext.Provider>
    );
  }

  if (reembed) {
    return <ReembedScreen space={reembed.space} state={reembed.state} />;
  }
  return (
    <TerminalSizeContext.Provider value={size}>
      {/* `height` is what makes this a full-screen app rather than a block of
          output in the shell's scrollback: without it the column lays out to
          its content, and the frame neither fills the window nor stays put.
          It is the window MINUS one row (`renderRows`): a frame exactly as
          tall as the terminal puts Ink on its clear-and-redraw path, which is
          what made typing and the spinner flicker. */}
      <Box flexDirection="column" height={renderRows(size)}>
        {body}
        {notice ? (
          <Box paddingX={2}>
            <Text color={theme.warn}>{notice}</Text>
          </Box>
        ) : null}
      </Box>
    </TerminalSizeContext.Provider>
  );
}
