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
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { Box, Text, useApp, useInput, useStdout } from "ink";

import {
  hostSnapshot,
  probeServiceActive,
  type HostSnapshot,
  type PersonaSnapshot,
} from "./snapshot.ts";
import {
  applyDefaultPersona,
  applyEmbedding,
  applyUpdateChannel,
  applyVoice,
  describeDefaultPersonaChange,
  describeEmbeddingChange,
  describePersonaRemoval,
  applyRemovePersona,
  describeUpdateChannelChange,
  describeVoiceChange,
  setSecret,
  unsetSecret,
  type Consequence,
} from "./actions.ts";
import { Frame } from "./components/Frame.tsx";
import { ConfirmScreen, type ConfirmRequest } from "./screens/Confirm.tsx";
import {
  FileEditorScreen,
  type FileEditorResult,
} from "./screens/FileEditor.tsx";
import { AskScreen, type AskRequest } from "./screens/Ask.tsx";
import { ChooseScreen, type ChooseRequest } from "./screens/Choose.tsx";
import {
  SearchListScreen,
  type SearchListRequest,
} from "./screens/SearchList.tsx";
import { ReembedScreen, type ReembedState } from "./screens/Reembed.tsx";
import { openChat, type ChatSession } from "./chatSession.ts";
import { ChatScreen } from "./screens/Chat.tsx";
import { DashboardScreen } from "./screens/Dashboard.tsx";
import { NewPersonaScreen } from "./screens/NewPersona.tsx";
import {
  CreatePersonaScreen,
  type CreatePersonaAnswers,
} from "./screens/CreatePersona.tsx";
import { PersonaDetailScreen } from "./screens/PersonaDetail.tsx";
import { KeysScreen } from "./screens/Keys.tsx";
import { DoctorScreen } from "./screens/Doctor.tsx";
import { gatherStatus, type StatusRows } from "./status.ts";
import { McpScreen } from "./screens/Mcp.tsx";
import { LogsScreen } from "./screens/Logs.tsx";
import { WizardScreen, type WizardAnswers } from "./screens/Wizard.tsx";
import { theme } from "./theme.ts";
import { logBuffer } from "./logBuffer.ts";
import { TerminalSizeContext, renderRows, terminalSize } from "./terminal.ts";
import { loadConfig, loadConfigForPersona, type Config } from "../config.ts";
import { runDoctor, type DoctorReport } from "../cli/doctor.ts";
import type { WizardStep } from "../lib/personaComplete.ts";

type Screen =
  | "chat"
  | "dashboard"
  | "persona"
  | "keys"
  | "doctor"
  | "mcp"
  | "logs"
  | "newPersona"
  | "createPersona"
  | "wizard"
  | "editor";

export interface AppProps {
  host: HostSnapshot;
  /** Persona to open chat with. Undefined means "run the wizard first". */
  startPersona?: string;
  /**
   * Where `startPersona` lands: "chat" (default) or "configure" — the boot
   * doctrine sends a default persona with no brain of its own straight to its
   * Configure screen, where the red `required` Brain row is the nudge.
   */
  startScreen?: "chat" | "configure";
  /** Where the wizard resumes, when it is the opening screen. */
  wizardStartAt?: WizardStep;
  onCreatePersona: (
    answers: WizardAnswers,
  ) => Promise<void | { created: boolean }>;
  /**
   * The wizard's Brain steps (brainOnboarding.ts), run after the persona is
   * created. Injectable for tests — the real implementation asks on screens
   * and writes through the same config helpers the CLI uses. The result
   * decides where the wizard lands: "chat" only when the brain was verified
   * by a real turn; anything else lands in Configure.
   */
  onWizardBrain?: (
    persona: string,
  ) => Promise<{ landing: "chat" | "configure"; notice: string }>;
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
  /**
   * Seam for tests, same reason as `openSession`: the settings screen runs
   * the doctor when it opens, and the real checks need a real persona on
   * disk. Injectable so a screen-level test can pin the DOCTOR telemetry
   * block with a well-formed report instead of a failure notice.
   */
  runDoctorImpl?: typeof runDoctor;
}

export function App(props: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [host, setHost] = useState(props.host);
  // An INCOMPLETE persona arrives with both a name and a resume point, so the
  // wizard must win over chat here — otherwise `resolveOpeningScreen`'s resume
  // path is unreachable and a user whose harness is uninstalled lands in a chat
  // box wired to a brain that does not exist. A persona booting to Configure
  // arrives as startPersona + startScreen="configure" (brain-only gap).
  const [screen, setScreen] = useState<Screen>(
    props.wizardStartAt
      ? "wizard"
      : props.startPersona
        ? props.startScreen === "configure"
          ? "persona"
          : "chat"
        : "wizard",
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
  // The settings screen's live /status reading for the persona it is open on.
  // Undefined = still gathering; the descriptions read `…` until this lands.
  const [detailStatus, setDetailStatus] = useState<StatusRows | undefined>();
  // Bumped whenever settings-affecting writes happen, so the reading refreshes
  // instead of describing the config as it was before the edit.
  const [detailNonce, setDetailNonce] = useState(0);
  const [notice, setNotice] = useState<string | undefined>();
  const [editorPath, setEditorPath] = useState<string | null>(null);
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
  const [searchAsk, setSearchAsk] = useState<
    (SearchListRequest & { resolve: (value: string | undefined) => void }) | undefined
  >();
  const [reembed, setReembed] = useState<
    { space: string; state: ReembedState } | undefined
  >();
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
      confirmName?: string;
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
      confirmName?: string;
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

  /** Ask with the searchable list screen (long catalogues). Same contract. */
  const askSearch = useCallback(async (input: SearchListRequest) => {
    const value = await new Promise<string | undefined>((resolve) => {
      setSearchAsk({ ...input, resolve });
    });
    setSearchAsk(undefined);
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
    // Any refresh follows a write; the settings screen's /status reading
    // must not keep describing the pre-write config. The gather effect
    // no-ops when the settings screen is not open, so the bump is free.
    setDetailNonce((n) => n + 1);
  }, []);

  // The settings screen's live probes. Gathered off the render path (they
  // reach the network, 5s deadline) and shown as `…` until they land, so the
  // screen paints instantly and fills in.
  useEffect(() => {
    if (screen !== "persona") return;
    let cancelled = false;
    setDetailStatus(undefined);
    gatherStatus({ persona: personaName })
      .then((rows) => {
        if (!cancelled) setDetailStatus(rows);
      })
      .catch(() => {
        /* leave the cells at `…`; a failed probe must not blank the screen */
      });
    return () => {
      cancelled = true;
    };
  }, [screen, personaName, detailNonce]);

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

  useInput((char, key) => {
    // While a clack prompt owns the terminal the app is not on screen. Acting
    // on a keystroke here would change something the user cannot see.
    if (prompting) return;
    // ^q quits from anywhere — including while a question screen (ask,
    // choose, confirm) owns the rest of the keyboard. A question never owns
    // the decision to leave the app, and a footer that advertises no Quit
    // must not mean there is no way out.
    if (key.ctrl && char === "q") {
      exit();
      return;
    }
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
    // unquittable except by killing the terminal.
    if (screen === "chat" && !session) {
      if ((key.ctrl && char === "c") || key.escape) exit();
    }
  });

  const runTheDoctor = useCallback(async (who?: string) => {
    const target = who ?? personaName;
    setDoctorRunning(true);
    try {
      let buffer = "";
      await (props.runDoctorImpl ?? runDoctor)({
        persona: target,
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
          await gatherStatus({
            persona: target,
            chain: host.personas.find((p) => p.name === target)?.chain,
          }),
        );
      } catch {
        setDoctorStatus(undefined);
      }
    } catch (e) {
      setNotice(`doctor failed: ${(e as Error).message}`);
    } finally {
      setDoctorRunning(false);
    }
  }, [personaName, host]);

  // The settings screen no longer runs the doctor — its telemetry block shows
  // the persona's /status reading only. The full Doctor screen (from the
  // phantoms list) still gathers its report via runTheDoctor on open.
  /**
   * The wizard's Brain steps (`brainOnboarding.ts`), run right after the
   * wizard creates the persona. Same dep discipline as `changeBrain`: the
   * flow owns the ASKING, this owns the DEPS — every write goes through the
   * same functions the CLI harness command uses, so the wizard, this flow
   * and the CLI cannot write different shapes of the same files.
   */
  const onboardBrain = useCallback(
    async (
      persona: string,
    ): Promise<{ landing: "chat" | "configure"; notice: string }> => {
      setPrompting(true);
      try {
        // On-demand imports, same reason as `changeBrain`: the harness graph
        // must not delay the app's first render.
        const { runBrainOnboarding } = await import("./brainOnboarding.ts");
        const { loadConfig } = await import("../config.ts");
        const { ENV_PI_API_KEY } = await import("../lib/piRouting.ts");
        const {
          applyHarnessChain,
          applyRouting,
          clearPiRouting,
          defaultInstallRunner,
          detectAvailability,
          installPi,
          piInstallCommand,
        } = await import("../cli/harness.ts");
        const { resolveHarnessWriteTarget } = await import(
          "../lib/harnessWriteTarget.ts"
        );
        const { harnessChainIds } = await import("../harnesses/buildChain.ts");
        const { listPiModels } = await import("../lib/piModels.ts");
        const {
          getPersonaSecret,
          setPersonaSecret,
          unsetPersonaSecret,
        } = await import("../lib/vaultSecrets.ts");
        const { writePiApiKey } = await import("../lib/piAuthStore.ts");

        const config = await loadConfig(persona);
        const availability = await detectAvailability(config);
        const writeTarget = await resolveHarnessWriteTarget(config, persona);
        const routing = config.harnesses.pi.routing ?? {};

        return await runBrainOnboarding(
          {
            choose: askChoice,
            search: askSearch,
            value: askValue,
            note: (title, body) => setNotice(`${title}: ${body.split("\n")[0]}`),
          },
          {
            persona,
            availability: () => detectAvailability(config),
            installCommand: piInstallCommand().join(" "),
            installPi: async () => {
              // stdout/stdin inherit: the operator goes through Pi's own
              // onboarding live. The q shim only needs `note` (failure).
              const ok = await installPi(
                defaultInstallRunner,
                {
                  note: (body: string, title?: string) =>
                    setNotice(
                      title ? `${title}: ${body.split("\n")[0]}` : body,
                    ),
                } as never,
              );
              return ok && Boolean((await detectAvailability(config)).pi);
            },
            chain: harnessChainIds(config, persona),
            routing: {
              provider: routing.provider,
              primaryModel: routing.primaryModel,
              imageModel: routing.imageModel,
              codingModel: routing.codingModel,
            },
            storedKey: await getPersonaSecret(config, ENV_PI_API_KEY, persona),
            targetPath: writeTarget.path,
            personaScope: writeTarget.scope === "persona",
            piBin: availability.pi,
            listModels: (extraEnv) =>
              listPiModels(availability.pi!, undefined, extraEnv),
            setSecret: (value) =>
              setPersonaSecret(config, ENV_PI_API_KEY, value, persona),
            unsetSecret: () =>
              unsetPersonaSecret(config, ENV_PI_API_KEY, persona),
            writeAuth: (provider, value) => writePiApiKey(provider, value),
            applyChain: (chain) =>
              applyHarnessChain(
                writeTarget.path,
                chain as never,
                persona,
                writeTarget.scope,
              ),
            applyRouting: (choices) => applyRouting(writeTarget.path, choices),
            clearRouting: async (opts) => {
              await clearPiRouting(writeTarget.path, opts);
            },
            probe: async (id) => {
              const { probeHarness } = await import("../lib/harnessProbe.ts");
              return probeHarness({ config, id });
            },
          },
        );
      } catch (e) {
        return {
          landing: "configure" as const,
          notice: `brain setup failed: ${(e as Error).message}`,
        };
      } finally {
        setPrompting(false);
        await refresh();
      }
    },
    [refresh, askChoice, askSearch, askValue],
  );

  const wizardBrain = props.onWizardBrain ?? onboardBrain;

  /**
   * The Brain row. Runs the SAME flow the wizard's Brain steps use
   * (`runBrainOnboarding`) — primary (with the Pi install offer) → Pi's model
   * slots → fallback → Test now / Skip — so fixing a red `required` Brain in
   * Configure is the identical experience to setting one up at first run.
   * Delegating also means the writes cannot diverge between the two paths.
   */
  const changeBrain = useCallback(
    async (target: PersonaSnapshot) => {
      const result = await onboardBrain(target.name);
      setNotice(result.notice);

      // Writes are exactly the two applyChain endings — a verified chain and
      // a saved-untested one. A cancel ("brain unchanged"), a Skip with no
      // brain chosen, and a failed test (nothing saved) must NOT offer a
      // restart: nothing changed to restart into.
      const wroteChain =
        result.notice.startsWith("brain verified") ||
        result.notice.startsWith("brain saved");
      if (wroteChain) {
        const { maybePromptRestart } = await import("../cli/harness.ts");
        const { defaultServiceControl } = await import("../lib/platform.ts");
        await maybePromptRestart(
          defaultServiceControl(),
          async (message) =>
            await askConfirmValue({
              title: message,
              consequence: {
                summary: "",
                detail: "",
                longRunning: false,
                restarts: true,
              },
            }),
          {
            note: (body: string, title?: string) =>
              setNotice(title ? `${title}: ${body.split("\n")[0]}` : body),
          } as never,
        );
      }

      // A verified brain earns chat, same as the wizard's landing.
      if (result.landing === "chat") setScreen("chat");
    },
    [onboardBrain, askConfirmValue],
  );

  /**
   * The Autostart row — a selector, not a toggle. Default phantom:
   * Off | Login | Boot. Siblings: On | Off (On is login-level). Boot needs
   * platform privileges, so its flow validates a credential (sudo password
   * on Linux, Windows account password) against the REAL mechanism before
   * anything is written — a failed Boot writes nothing and the old state
   * stands. On Linux the password is used once in memory and never stored
   * (vault rows are exported into every agent turn's environment); Windows
   * stores its password in the default phantom's vault — Boot is a
   * default-phantom option, and the default owns them. If Default moves,
   * the new default has no credential and the TUI re-prompts.
   *
   * macOS is deliberately absent from Boot: a boot start there needs a
   * root-owned LaunchDaemon set — real installer territory — so the menu
   * never offers what cannot be delivered.
   */
  const changeAutostart = useCallback(
    async (target: PersonaSnapshot) => {
      const current = target.autostart ? target.autostartMode : "off";
      const isDefault = target.isDefault;
      const pick = await askChoice({
        title: `Autostart for ${target.name}?`,
        description:
          "Login starts the daemon when you sign in. Boot starts it without " +
          "a login (needs your password once).",
        options: isDefault
          ? [
              { value: "off", label: "Off", hint: "not started with the daemon" },
              { value: "login", label: "Login", hint: "starts at login — no password needed" },
              { value: "boot", label: "Boot", hint: "starts at boot without a login — asks for your password once" },
            ]
          : [
              { value: "login", label: "On", hint: "starts at login with the daemon" },
              { value: "off", label: "Off", hint: "not started with the daemon" },
            ],
        initial: isDefault ? current : target.autostart ? "login" : "off",
      });
      if (pick === undefined) return;
      const choice: "off" | "login" | "boot" =
        pick === "on" ? "login" : (pick as "off" | "login" | "boot");
      if (choice === current) return; // ↵ on the current value is a no-op

      // Boot: platform privilege setup first — nothing written until it
      // succeeds. A failed Boot leaves the previous state untouched.
      if (choice === "boot") {
        const { currentPlatform } = await import("../lib/platform.ts");
        const platform = currentPlatform();
        if (platform === "darwin") {
          setNotice(
            "Boot start isn’t available on macOS yet (needs the LaunchDaemon " +
              "installer) — choose Login for now.",
          );
          return;
        }
        setPrompting(true);
        try {
          const { loadConfigForPersona } = await import("../config.ts");
          const { personaDir } = await import("../config.ts");
          const boot = await import("../lib/autostartBoot.ts");
          const { config } = await loadConfigForPersona(target.name);
          const dir = personaDir(config, target.name);
          const askPassword = () =>
            askValue({
              title: platform === "windows"
                ? "Windows account password"
                : "sudo password",
              description: platform === "windows"
                ? "Stored in this phantom’s vault (encrypted at rest) so task " +
                  "re-registration can reuse it."
                : "Used once to enable boot — never stored.",
              masked: true,
            });
          let outcome: { status: string; error?: string };
          const spawnRunner = boot.bunSpawnRunner();
          if (platform === "linux") {
            // ENABLE-ONLY LINGER DOCTRINE: linger is a one-way prerequisite —
            // enabled here if missing (passwordless sudo first, validated
            // re-prompt loop if a password is required), and NEVER disabled
            // by phantombot anywhere. The boot start itself is the daemon
            // unit enable, which needs no sudo at all.
            const user = (await import("node:os")).userInfo().username;
            if (!(await boot.probeLingerLinux(user))) {
              if (await boot.probeSudoPasswordless(spawnRunner)) {
                outcome = await boot.enableBootLinuxPasswordless(user, spawnRunner);
              } else {
                let credential: string | undefined;
                for (;;) {
                  credential = await askPassword();
                  if (!credential) {
                    setNotice("boot setup cancelled — nothing changed");
                    return;
                  }
                  outcome = await boot.enableBootLinux(credential, user, spawnRunner);
                  if (outcome.status === "ok") break;
                  if (outcome.status === "invalid-credential") {
                    setNotice(
                      `${outcome.error ?? "the password was rejected"} — try again, or esc to cancel`,
                    );
                    continue;
                  }
                  break;
                }
              }
              if (!outcome || outcome.status !== "ok") {
                setNotice(
                  `boot setup failed: ${outcome?.error ?? "cancelled"} — nothing changed`,
                );
                return;
              }
            }
            const u = await boot.enableDaemonUnit(spawnRunner);
            if (u.status !== "ok") {
              setNotice(`boot setup failed: ${u.error} — nothing changed`);
              return;
            }
            const r = await (await import("./actions.ts")).applyAutostartChoice({
              config,
              persona: target.name,
              choice: "boot",
            });
            setNotice(
              r.ok
                ? "autostart: boot — starts without a login"
                : `boot set up, but the daemon update failed: ${r.error}`,
            );
            await refresh();
            return;
          }
          // Windows: only Windows persists its boot credential (task
          // re-registration re-reads it). The sudo password on Linux is
          // use-once in memory — a vault row would be exported into every
          // agent turn's environment.
          const key = boot.WINDOWS_PASSWORD_VAULT_KEY;
          let credential: string | null | undefined =
            await boot.readBootCredential(dir, key);
          const who = await new Promise<string>((resolve, reject) => {
            const child = Bun.spawn(["whoami"], { stdout: "pipe", stderr: "pipe" });
            void new Response(child.stdout).text().then(resolve, reject);
            void child.exited.then((code) => {
              if (code !== 0) reject(new Error("whoami failed"));
            });
          });
          for (;;) {
            if (!credential) {
              credential = await askPassword();
              if (!credential) {
                setNotice("boot setup cancelled — nothing changed");
                return;
              }
            }
            let valid: boolean;
            try {
              const { defaultValidateWindowsCredential } = await import(
                "../cli/install.ts"
              );
              valid = await defaultValidateWindowsCredential(who.trim(), credential);
            } catch (e) {
              // Unverifiable (no reachable account store) proceeds as
              // requested — same doctrine as install.ts, only an explicit
              // "invalid" downgrades.
              valid = true;
              setNotice(`could not verify the password (${(e as Error).message}); proceeding`);
            }
            outcome = valid
              ? await boot.enableBootWindows(
                  process.execPath,
                  target.name,
                  who.trim(),
                  credential,
                  { out: { write: () => {} }, err: { write: () => {} } },
                )
              : { status: "invalid-credential", error: "the password did not validate" };
            if (outcome.status === "ok") break;
            if (outcome.status === "invalid-credential") {
              setNotice(
                `${outcome.error ?? "the password was rejected"} — try again, or esc to cancel`,
              );
              credential = undefined; // force the re-prompt
              continue;
            }
            setNotice(`boot setup failed: ${outcome.error} — nothing changed`);
            return;
          }
          if (typeof credential !== "string") return; // keeps the type honest
          await boot.saveBootCredential(dir, key, credential);
          const r = await (await import("./actions.ts")).applyAutostartChoice({
            config,
            persona: target.name,
            choice: "boot",
          });
          setNotice(
            r.ok
              ? "autostart: boot — starts without a login"
              : `boot set up, but the daemon update failed: ${r.error}`,
          );
          await refresh();
          return;
        } finally {
          setPrompting(false);
        }
      }

      // Off / Login: no credentials for the persona change itself — but a
      // BOOT-level persona leaving needs platform teardown (Caveat 2).
      // Linux/macOS hooks (linger / LaunchDaemon) are host-level, so they're
      // torn down only when the LAST boot-level persona leaves; Windows
      // tasks are per-persona and torn down / downgraded individually.
      const { loadConfigForPersona } = await import("../config.ts");
      const { config } = await loadConfigForPersona(target.name);
      const boot = await import("../lib/autostartBoot.ts");
      const { applyAutostartChoice } = await import("./actions.ts");

      const wasBoot = target.autostart && target.autostartMode === "boot";
      let teardownNote = "";
      if (wasBoot) {
        const platform = (await import("../lib/platform.ts")).currentPlatform();
        const runner = boot.bunSpawnRunner();
        const promptSudo = async (): Promise<string | undefined> =>
          askValue({
            title: "sudo password",
            description: "Needed once to remove the boot start — never stored.",
            masked: true,
          });
        if (platform === "windows") {
          // Tasks are per-persona: Off deletes this persona's task set
          // (ownership-checked), Login downgrades it to interactive so the
          // heartbeat self-heal stops healing password-mode tasks back.
          const t = choice === "off"
            ? await boot.teardownBootWindows(target.name, {
                out: { write: () => {} },
                err: { write: () => {} },
              })
            : await boot.registerLoginTasksWindows(process.execPath, target.name, {
                out: { write: () => {} },
                err: { write: () => {} },
              });
          if (t.status !== "ok") {
            setNotice(`boot teardown failed: ${t.error} — nothing changed`);
            return;
          }
          teardownNote = choice === "off" ? " — boot tasks removed" : " — boot tasks moved to login";
        } else {
          // ENABLE-ONLY LINGER DOCTRINE (Andrew/Robbie, 2026-08-31): the
          // boot start on Linux is the enabled daemon UNIT — phantombot
          // stops booting by disabling its own unit (no sudo) and NEVER
          // touches linger, which is one-way host state that may carry
          // other systemd --user services. No ownership marker exists.
          // The unit is disabled ONLY when a recorded boot persona leaves:
          // the record is the proof phantombot (not the installer) chose
          // boot, so the disable undoes OUR choice and never installer
          // default state. Records-only: the outgoing persona's own record
          // is stripped, and reading live unit state here would be
          // circular (the unit is still enabled because of the choice we
          // are undoing).
          const postList = (config.autostartPersonas ?? []).filter(
            (p) => p !== target.name,
          );
          const postModes = { ...(config.autostartModes ?? {}) };
          delete postModes[target.name];
          const unitNeeded = boot.bootHookStillNeeded(postList, postModes);
          if (!unitNeeded) {
            if (platform === "linux") {
              const d = await boot.disableDaemonUnit(runner);
              if (d.status !== "ok") {
                setNotice(`boot teardown failed: ${d.error} — nothing changed`);
                return;
              }
              // Login-level start: keep/land the marked hook line when any
              // remaining on-list persona still needs a login start.
              const hook = boot.loginHookNeeded(postList, postModes);
              const h = await boot.writeLoginHook(hook);
              if (h.status !== "ok") {
                setNotice(`boot start disabled, but the login hook failed: ${h.error}`);
              }
              teardownNote = hook
                ? " — boot start moved to login (~/.profile; GUI-only sessions may not fire it)"
                : " — boot start removed";
            } else {
              // macOS: inherited LaunchDaemon teardown (ours-only labels).
              // Boot is not selectable on macOS, so this is reachable only
              // for a daemon an earlier install path created.
              const passwordless = await boot.probeSudoPasswordless(runner);
              let outcome: { status: string; error?: string };
              for (;;) {
                outcome = passwordless
                  ? await boot.teardownBootMacPasswordless(runner)
                  : await (async () => {
                      const pw = await promptSudo();
                      if (!pw) return { status: "cancelled" };
                      return boot.teardownBootMac(pw, runner);
                    })();
                if (outcome.status === "ok") break;
                if (outcome.status === "invalid-credential") {
                  setNotice(
                    `${outcome.error ?? "the password was rejected"} — try again, or esc to cancel`,
                  );
                  continue;
                }
                const msg = outcome.status === "cancelled"
                  ? "autostart change cancelled — boot start stays in place"
                  : `boot teardown failed: ${outcome.error} — nothing changed`;
                setNotice(msg);
                return;
              }
              teardownNote = " — boot start removed";
            }
          }
        }
      }

      const r = await applyAutostartChoice({
        config,
        persona: target.name,
        choice,
      });
      setNotice(
        r.ok
          ? choice === "off"
            ? `autostart: off — ${target.name} no longer starts with the daemon${teardownNote}`
            : `autostart: login${teardownNote}`
          : `failed: ${r.error}`,
      );
      await refresh();
    },
    [askChoice, askValue, askConfirmValue],
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
        const { maybePromptRestart } = await import("../cli/harness.ts");
        const { defaultServiceControl } = await import("../lib/platform.ts");
        const { loadConfig, personaDir } = await import("../config.ts");
        const { resolvePersonaWriteTarget } = await import(
          "../lib/personaConfig.ts"
        );
        const { configurePhantomchat, configureTelegram } = await import(
          "./channelsFlow.ts"
        );
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
        const chat = loadPhantomchatPersonaConfig(agentDir);
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

        // Which channel to walk? The Choose screen — the same picker the
        // Brain and Identity flows use. The current state sits in each row's
        // hint so the pick is an informed one.
        const which = await askChoice({
          title: `Chat channel for ${target.name}`,
          description: "which chat surface this phantom answers on",
          options: [
            {
              value: "phantomchat",
              label: "PhantomChat",
              hint: chat
                ? chat.allowedNpubs.length > 0
                  ? `${chat.allowedNpubs.length} allowed npub(s)`
                  : "trust-on-first-use armed"
                : "not set up",
            },
            {
              value: "telegram",
              label: "Telegram",
              hint: existing?.token
                ? `${existing.allowedUserIds?.length ?? 0} allowed user(s)`
                : "not set up",
            },
          ],
        });
        // esc on the picker is "did nothing" — no gate, no walkthrough.
        if (!which) {
          setNotice("channels unchanged");
          return;
        }

        // The user PICKED the channel, so there is no offer/skip gate here —
        // this is the same walkthrough `phantombot phantomchat --persona` or
        // `phantombot telegram --persona` runs, asked on screens instead of
        // @clack. The WRITE paths are those commands' own, so the TUI and the
        // CLI cannot write different shapes of the same block.
        if (which === "phantomchat") {
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
        } else {
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

        // Same post-apply hook the Brain flow runs: a channel change (token,
        // allowlist, identity) only bites on the next service spawn, so offer
        // the restart here — but only when something was actually SAVED.
        if (notices.some((n) => n.includes("saved"))) {
          await maybePromptRestart(
            defaultServiceControl(),
            async (message) =>
              await askConfirmValue({
                title: message,
                consequence: {
                  summary: "",
                  detail: "",
                  longRunning: false,
                  restarts: true,
                },
              }),
            {
              note: (body: string, title?: string) =>
                setNotice(title ? `${title}: ${body.split("\n")[0]}` : body),
            } as never,
          );
        }
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
   * The Memory row, as the embeddings flow (`memoryFlow.ts`).
   *
   * The clack wizard's walkthrough — provider, key/endpoint validation,
   * defaults prefilled from the live config — asked on screens; the WRITE
   * path stays `applyEmbedding` (the same `applyEmbeddingConfig` the CLI
   * calls, plus the in-app re-embed when the space changes). No test screen:
   * recall is judged by using the phantom. Setup is IDEMPOTENT — re-running
   * the flow and keeping every answer writes nothing.
   */
  const changeMemory = useCallback(
    async (target: PersonaSnapshot) => {
      setPrompting(true);
      try {
        const { configureMemory, embeddingUpdateEquals } = await import(
          "./memoryFlow.ts"
        );
        const { geminiEmbed } = await import("../lib/geminiEmbed.ts");
        const { openaiCompatibleEmbed } = await import(
          "../lib/openaiCompatibleEmbed.ts"
        );
        const { config } = await loadConfigForPersona(target.name);
        const chosen = await configureMemory(
          target.name,
          { choose: askChoice, value: askValue },
          {
            existing: config.embeddings,
            validateGemini: (key) =>
              geminiEmbed(key, "phantombot key validation test", {
                model: "gemini-embedding-001",
                dims: 1536,
              }),
            validateOpenAI: (settings) =>
              openaiCompatibleEmbed(
                "phantombot embedding validation test",
                settings,
              ),
          },
        );
        if (!chosen) return setNotice("memory unchanged");
        if ("rejected" in chosen)
          return setNotice(`memory unchanged — rejected: ${chosen.rejected}`);
        if (embeddingUpdateEquals(config.embeddings, chosen.update))
          return setNotice("memory unchanged — already set");

        const change = {
          next: chosen.update,
          indexedChunks: target.memory.indexedTotal,
        };
        await askConfirm({
          title: `Change ${target.name}'s embeddings to ${chosen.summary}?`,
          consequence: describeEmbeddingChange(config, change),
          run: async () => {
            const space =
              target.memory.embedding?.fingerprint ?? "new space";
            setReembed({
              space,
              state: {
                done: 0,
                total: target.memory.indexedTotal ?? 0,
                path: "",
                startedAt: Date.now(),
                errors: 0,
              },
            });
            const r = await applyEmbedding({
              config,
              persona: target.name,
              change,
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
      } catch (e) {
        setNotice(`memory failed: ${(e as Error).message}`);
      } finally {
        setPrompting(false);
        await refresh();
      }
    },
    [refresh, askChoice, askValue, askConfirmValue],
  );

  /**
   * The Voice row, as a flow — the `phantombot voice` clack walkthrough
   * (provider picker, key keep/replace, voice selection) asked on screens.
   * The WRITE path stays `applyVoice` (`applyVoiceConfig`). No preview:
   * the phantom's first spoken turn is the audition. Setup is idempotent —
   * esc or keeping the offered defaults leaves the config untouched.
   */
  const changeVoice = useCallback(
    async (target: PersonaSnapshot) => {
      setPrompting(true);
      try {
        const { configureVoice } = await import("./voiceFlow.ts");
        const {
          ENV_KEY_FOR_PROVIDER,
          validateElevenLabsKey,
          validateOpenAIKey,
        } = await import("../lib/voice.ts");
        const { maybePromptRestart } = await import("../cli/harness.ts");
        const { defaultServiceControl } = await import("../lib/platform.ts");
        const { config } = await loadConfigForPersona(target.name);

        const provider = await askChoice({
          title: `Voice for ${target.name}`,
          description: "how this phantom speaks and hears voice notes",
          options: [
            {
              value: "elevenlabs",
              label: "ElevenLabs",
              hint:
                config.voice.provider === "elevenlabs"
                  ? "current · premium · paid (API key required)"
                  : "premium · paid (API key required)",
            },
            {
              value: "openai",
              label: "OpenAI",
              hint:
                config.voice.provider === "openai"
                  ? "current · 6 built-in voices · paid (API key required)"
                  : "6 built-in voices · paid (API key required)",
            },
            {
              value: "azure_edge",
              label: "Azure Edge TTS",
              hint:
                config.voice.provider === "azure_edge"
                  ? "current · free · no key · speaks only"
                  : "free · no key · speaks only",
            },
            {
              value: "none",
              label: "None — disable TTS/STT",
              hint:
                config.voice.provider === "none"
                  ? "current · text only"
                  : "text only",
            },
          ],
          initial: config.voice.provider,
        });
        // esc on the picker is "did nothing".
        if (!provider) return setNotice("voice unchanged");

        const chosen = await configureVoice(
          target.name,
          provider as "openai" | "elevenlabs" | "azure_edge" | "none",
          { choose: askChoice, value: askValue, confirm: askConfirmValue },
          {
            existing: config.voice,
            hasKey: (p) => {
              const envVar = ENV_KEY_FOR_PROVIDER[p as "openai" | "elevenlabs"];
              return Boolean(envVar && process.env[envVar]);
            },
            validateKey: (p, key) =>
              p === "openai"
                ? validateOpenAIKey(key)
                : validateElevenLabsKey(key),
          },
        );
        if (!chosen) return setNotice("voice unchanged");
        if ("rejected" in chosen)
          return setNotice(`voice unchanged — key rejected: ${chosen.rejected}`);

        // The restart offer below belongs to a SAVE, not to a visit — a
        // cancelled confirm must not fire it.
        let saved = false;
        await askConfirm({
          title: `Set ${target.name}'s voice to ${chosen.summary}?`,
          consequence: describeVoiceChange(chosen.voice),
          run: async () => {
            const r = await applyVoice({
              config,
              persona: target.name,
              voice: chosen.voice,
              apiKey: chosen.apiKey,
            });
            saved = r.ok;
            setNotice(
              r.ok ? `voice saved: ${chosen.summary}` : `failed: ${r.error}`,
            );
            await refresh();
          },
        });

        // Same post-apply hook the CLI runs: the voice block is read on the
        // next service spawn, so offer the restart when something was saved.
        if (saved)
          await maybePromptRestart(
          defaultServiceControl(),
          async (message) =>
            await askConfirmValue({
              title: message,
              consequence: {
                summary: "",
                detail: "",
                longRunning: false,
                restarts: true,
              },
            }),
          {
            note: (body: string, title?: string) =>
              setNotice(title ? `${title}: ${body.split("\n")[0]}` : body),
          } as never,
        );
      } catch (e) {
        setNotice(`voice failed: ${(e as Error).message}`);
      } finally {
        setPrompting(false);
        await refresh();
      }
    },
    [refresh, askChoice, askValue, askConfirmValue],
  );

  /**
   * Offer the service restart a persona-adding route needs. Shared by import
   * and restore — the same post-apply hook the Brain/Voice/Channels flows run
   * inline, factored out here because those flows predate the pattern's third
   * copy.
   */
  const offerRestart = useCallback(async () => {
    const { maybePromptRestart } = await import("../cli/harness.ts");
    const { defaultServiceControl } = await import("../lib/platform.ts");
    await maybePromptRestart(
      defaultServiceControl(),
      async (message) =>
        await askConfirmValue({
          title: message,
          consequence: {
            summary: "",
            detail: "",
            longRunning: false,
            restarts: true,
          },
        }),
      {
        note: (body: string, title?: string) =>
          setNotice(title ? `${title}: ${body.split("\n")[0]}` : body),
      } as never,
    );
  }, [askConfirmValue]);

  /**
   * Import an OpenClaw- or phantombot-shaped directory, all on screens.
   *
   * The WRITE path is `runImportPersona` with an explicit source — the same
   * machinery `phantombot persona --import` uses, including the OpenClaw
   * telegram/voice sniff, default adoption and scaffold — so the TUI and the
   * CLI cannot import differently shaped personas. Only the ASKING is ours:
   * path, name, overwrite confirm, all on Ask/Confirm screens instead of clack.
   */
  const importPersonaFromDirectory = useCallback(async () => {
    const source = await askValue({
      title: "Import a persona from a directory",
      hint: "path to an OpenClaw- or phantombot-shaped persona directory",
    });
    if (!source) return setNotice("import cancelled");
    if (!existsSync(source))
      return setNotice(`import failed: no such directory: ${source}`);

    const { validPersonaName } = await import("../cli/persona-new.ts");
    const suggested = basename(source);
    const name = await askValue({
      title: "Persona name",
      hint: validPersonaName(suggested)
        ? `blank keeps '${suggested}'`
        : "lowercase letters, digits, '-' or '_'",
      initial: validPersonaName(suggested) ? suggested : undefined,
      allowEmpty: true,
    });
    if (name === undefined) return setNotice("import cancelled");
    const target = name || (validPersonaName(suggested) ? suggested : "");
    if (!target)
      return setNotice("import failed: a valid persona name is required");

    if (host.personas.some((p) => p.name === target)) {
      const yes = await askConfirmValue({
        title: `Persona '${target}' already exists — overwrite it?`,
        danger: true,
        consequence: {
          summary: "the current directory is archived to personas-archive/ first",
          detail: "",
          longRunning: false,
          restarts: false,
        },
      });
      if (!yes) return setNotice("import cancelled");
    }

    setPrompting(true);
    try {
      const { runImportPersona } = await import("../cli/import-persona.ts");
      const config = await loadConfig();
      let output = "";
      const code = await runImportPersona({
        source,
        as: target,
        overwrite: true,
        config,
        out: { write: (chunk: string) => void (output += chunk) },
        err: { write: (chunk: string) => void (output += chunk) },
      });
      if (code !== 0)
        return setNotice(
          output.trim().split("\n")[0] || `import of ${target} failed`,
        );

      await refresh();
      setPersonaName(target);
      navRef.current = [];
      setScreen("persona");
      setNotice(`imported ${target} — finish its settings below`);
      await offerRestart();
    } catch (e) {
      setNotice(`import failed: ${(e as Error).message}`);
    } finally {
      setPrompting(false);
    }
  }, [host, askValue, askConfirmValue, refresh, offerRestart]);

  /**
   * Restore an archived persona from `personas-archive/`, all on screens.
   * The WRITE path is `applyRestore` (the clack flow's own helper), so the
   * archive-then-restore semantics — the existing dir archived first — are
   * the ones the CLI already tests.
   */
  const restoreArchivedPersona = useCallback(async () => {
    const { listArchives } = await import("../lib/personaArchive.ts");
    let archives;
    try {
      archives = await listArchives(host.personasDir);
    } catch (e) {
      return setNotice(`restore failed: ${(e as Error).message}`);
    }
    if (archives.length === 0)
      return setNotice("no archived personas to restore");

    const picked = await askChoice({
      title: "Restore an archived persona",
      description:
        "the archive is copied back under personas/ — nothing is removed from personas-archive/",
      options: archives.map((a) => ({
        value: a.archiveName,
        label: a.name,
        hint: a.dir,
      })),
    });
    if (!picked) return setNotice("restore cancelled");
    const chosen = archives.find((a) => a.archiveName === picked);
    if (!chosen) return;

    const { validPersonaName } = await import("../cli/persona-new.ts");
    const name = await askValue({
      title: "Persona name",
      hint: `blank keeps '${chosen.name}'`,
      initial: chosen.name,
      allowEmpty: true,
    });
    if (name === undefined) return setNotice("restore cancelled");
    const target = name || chosen.name;
    if (!validPersonaName(target))
      return setNotice(
        "restore failed: use lowercase letters, digits, '-' or '_'",
      );

    if (host.personas.some((p) => p.name === target)) {
      const yes = await askConfirmValue({
        title: `Persona '${target}' already exists — overwrite it?`,
        danger: true,
        consequence: {
          summary: "the current directory is archived to personas-archive/ first",
          detail: "",
          longRunning: false,
          restarts: false,
        },
      });
      if (!yes) return setNotice("restore cancelled");
    }

    setPrompting(true);
    try {
      const { applyRestore } = await import("../cli/import-persona.ts");
      const { ensurePersonaScaffold } = await import(
        "../lib/personaScaffold.ts"
      );
      const config = await loadConfig();
      const r = await applyRestore(config, chosen, target);
      await ensurePersonaScaffold(r.dir);

      await refresh();
      setPersonaName(target);
      navRef.current = [];
      setScreen("persona");
      setNotice(
        `restored ${target} from ${chosen.archiveName}${r.alsoArchived ? ` — previous ${target} archived` : ""}`,
      );
      await offerRestart();
    } catch (e) {
      setNotice(`restore failed: ${(e as Error).message}`);
    } finally {
      setPrompting(false);
    }
  }, [host, askChoice, askValue, askConfirmValue, refresh, offerRestart]);

  /**
   * Pick one of the prompt files and edit it in the app's own editor.
   *
   * A missing file is offered too, and creating it by opening it is the
   * correct behaviour: a persona with no IDENTITY.md is a persona that has
   * never been told who it is, and the way to fix that is to write one.
   */
  const editIdentity = useCallback(
    (target: PersonaSnapshot) => {
      void (async () => {
        const choice = await askChoice({
          title: `Which file for ${target.name}?`,
          options: target.identity.files.map((f) => ({
            value: f.path,
            label: f.name,
            hint: f.present ? undefined : "does not exist yet",
          })),
        });
        if (!choice) return;
        setEditorPath(choice);
        go("editor");
      })();
    },
    [askChoice, go],
  );

  const body = (() => {
    if (screen === "wizard") {
      return (
        <WizardScreen
          startAt={props.wizardStartAt}
          initial={{ name: props.startPersona ?? "" }}
          existingNames={host.personas.map((p) => p.name)}
          // Only when the wizard was reached from another screen; on first
          // run the stack is empty and `back` would fall through to chat,
          // which does not exist yet.
          onBack={navRef.current.length > 0 ? back : undefined}
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
              // A freshly created persona continues straight into the Brain
              // steps (brainOnboarding.ts): primary → Pi install/configure →
              // fallback → test. Chat is earned by a VERIFIED brain — a real
              // one-shot turn through the primary; every other exit (skip,
              // failed test, cancel) lands in CONFIGURE, where the red
              // `required` Brain row is the nudge. A resumed wizard (identity
              // fix on an existing persona) skips the brain steps — its brain
              // state is whatever it already was.
              const brainResult =
                result?.created !== false
                  ? await wizardBrain(answers.name)
                  : undefined;
              // The brain steps' notice (what happened to the config)
              // supersedes the creation line — but only when the flow has
              // something to say.
              if (brainResult?.notice) setNotice(brainResult.notice);
              setScreen(brainResult?.landing === "chat" ? "chat" : "persona");
            } catch (e) {
              setNotice(`could not create ${answers.name}: ${(e as Error).message}`);
            }
          }}
        />
      );
    }

    if (screen === "newPersona") {
      return (
        <NewPersonaScreen
          personasDir={host.personasDir}
          onCreate={() => go("createPersona")}
          onImport={() => void importPersonaFromDirectory()}
          onRestore={() => void restoreArchivedPersona()}
          onBack={back}
        />
      );
    }

    if (screen === "createPersona") {
      return (
        <CreatePersonaScreen
          existingNames={host.personas.map((p) => p.name)}
          onCreate={(answers: CreatePersonaAnswers) => {
            void (async () => {
              try {
                await props.onCreatePersona({
                  name: answers.name,
                  identity: answers.identity,
                  tone: answers.tone,
                  owner: answers.owner,
                  expertise: answers.expertise,
                  makeDefault: false,
                });
                await refresh();
                setPersonaName(answers.name);
                setNotice(
                  `created ${host.personasDir}/${answers.name} — finish setup in Configure`,
                );
                // Same rule as the wizard: a just-created persona is not a
                // place to go back to. Land in Configure, where the rest of
                // its setup (brain, channels, memory, voice) actually lives.
                navRef.current = [];
                setScreen("persona");
              } catch (e) {
                setNotice(
                  `could not create ${answers.name}: ${(e as Error).message}`,
                );
              }
            })();
          }}
          onBack={back}
        />
      );
    }

    if (screen === "editor" && editorPath !== null) {
      const editing = host.personas.find((p) => editorPath.includes(p.name));
      return (
        <FileEditorScreen
          path={editorPath}
          personaName={editing?.name ?? ""}
          onBack={(r: FileEditorResult) => {
            const file = editorPath.split("/").pop();
            setNotice(
              r.error
                ? `save failed: ${r.error}`
                : r.saved
                  ? `${file} saved — restart to load it`
                  : r.changed
                    ? `${file} discarded`
                    : `${file} unchanged`,
            );
            setEditorPath(null);
            back();
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
          status={(() => {
            // Andrew, 2026-08-31: the autostart state lives on the chat top
            // banner — it is the one fact that decides whether this phantom
            // will be here when you reboot. An Off is LOUD (red): a default
            // phantom with nothing starting it is exactly the surprise you
            // only discover after a restart.
            const chatPersona = host.personas.find(
              (hp) => hp.name === session?.persona,
            );
            if (!chatPersona) return `channel: ${host.updateChannel}`;
            const label = chatPersona.isDefault
              ? chatPersona.autostart
                ? (chatPersona.autostartMode ?? "login")
                : "off"
              : chatPersona.autostart
                ? "on"
                : "off";
            return `channel: ${host.updateChannel} · autostart: ${label}`;
          })()}
          statusColor={
            (() => {
              const chatPersona = host.personas.find(
                (hp) => hp.name === session?.persona,
              );
              if (!chatPersona?.isDefault) return undefined;
              return chatPersona.autostart ? undefined : theme.bad;
            })()
          }
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
          onNew={() => go("newPersona")}
          onLogs={() => go("logs")}
          onDoctor={(name) => {
            setPersonaName(name);
            // A stale report from a previous run must not flash as THIS
            // persona's — clear, then gather.
            setDoctorReport(undefined);
            setDoctorStatus(undefined);
            go("doctor");
            void runTheDoctor(name);
          }}
          onRemove={(name) => {
            // The default cannot be removed out from under the host: it owns
            // /update and /restart, so removing it would strand the box.
            // Saying WHY here beats a generic "failed" after the confirm.
            if (host.defaultPersona === name) {
              setNotice(
                host.personas.length > 1
                  ? `${name} is the default — make another phantom the default before removing it`
                  : `${name} is the only phantom on this host and the default — nothing to hand the host to`,
              );
              return;
            }
            const row = host.personas.find((p) => p.name === name);
            void askConfirm({
              title: `Remove ${name} from this host?`,
              danger: true,
              // The loudest confirm there is: the exact name typed by hand.
              confirmName: name,
              consequence: describePersonaRemoval(name, row?.autostart ?? false),
              run: async () => {
                // HOST config — the autostart entry lives there, and the
                // persona's own layer is about to stop existing.
                const { host: hostConfig } = await loadConfigForPersona(name);
                const r = await applyRemovePersona({
                  config: hostConfig,
                  persona: name,
                });
                setNotice(
                  r.ok
                    ? `removed ${name} — archived as ${r.archive}`
                    : `failed: ${r.error}`,
                );
                // A phantom that no longer exists must not stay selected:
                // esc → chat would otherwise open a ghost thread.
                setPersonaName((current) =>
                  current === name ? hostConfig.defaultPersona : current,
                );
                await refresh();
              },
            });
          }}
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
          status={detailStatus}
          onBack={back}
          onEditIdentity={() => void editIdentity(persona)}
          onChangeBrain={() => void changeBrain(persona)}
          onChangeChannels={() => void changeChannels(persona)}
          onChangeAutostart={() => void changeAutostart(persona)}
          releaseChannel={host.updateChannel}
          canSetDefault={host.personas.length > 1}
          canSetRelease={!process.env.PHANTOMBOT_PERSONA?.trim()}
          onToggleRelease={() => {
            const next =
              host.updateChannel === "preview" ? "stable" : "preview";
            void askConfirm({
              title: `Follow the ${next} release channel?`,
              consequence: describeUpdateChannelChange(next),
              run: async () => {
                const { config } = await loadConfigForPersona(persona.name);
                const r = await applyUpdateChannel({
                  config,
                  channel: next,
                });
                setNotice(
                  r.ok
                    ? `release channel: ${host.updateChannel} → ${next}`
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
            // Memory and Voice are FLOWS now, not screens — the same clack
            // walkthroughs the Brain and Channels rows run.
            if (target === "memory") void changeMemory(persona);
            else void changeVoice(persona);
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

    if (screen === "logs") {
      return (
        <LogsScreen
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

  if (searchAsk) {
    return (
      <TerminalSizeContext.Provider value={size}>
        <Box flexDirection="column" height={renderRows(size)}>
          <SearchListScreen
            request={searchAsk}
            onAnswer={(v) => searchAsk.resolve(v)}
          />
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
