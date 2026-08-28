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

import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";

import { hostSnapshot, type HostSnapshot } from "./snapshot.ts";
import {
  applyEmbedding,
  applyVoice,
  describeEmbeddingChange,
  describeVoiceChange,
  restartService,
  setSecret,
  unsetSecret,
  type Consequence,
} from "./actions.ts";
import { Prompt } from "./components/Prompt.tsx";
import { Confirm } from "./components/Confirm.tsx";
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
import { McpScreen } from "./screens/Mcp.tsx";
import { WizardScreen, type WizardAnswers } from "./screens/Wizard.tsx";
import { theme } from "./theme.ts";
import { mouse } from "./mouse.ts";
import { loadConfigForPersona } from "../config.ts";
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
  | "wizard";

export interface AppProps {
  host: HostSnapshot;
  /** Persona to open chat with. Undefined means "run the wizard first". */
  startPersona?: string;
  /** Where the wizard resumes, when it is the opening screen. */
  wizardStartAt?: WizardStep;
  onCreatePersona: (answers: WizardAnswers) => Promise<void>;
}

export function App(props: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [host, setHost] = useState(props.host);
  const [screen, setScreen] = useState<Screen>(
    props.startPersona ? "chat" : "wizard",
  );
  const [personaName, setPersonaName] = useState(
    props.startPersona ?? host.defaultPersona,
  );
  const [session, setSession] = useState<ChatSession | undefined>();
  const [doctorReport, setDoctorReport] = useState<DoctorReport | undefined>();
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  /**
   * A modal owns the keyboard while it is open. Screens below keep their state,
   * so cancelling a prompt returns exactly where the user was.
   */
  const [modal, setModal] = useState<
    | undefined
    | { kind: "secret"; name: string }
    | {
        kind: "confirm";
        title: string;
        consequence: Consequence;
        danger?: boolean;
        run: () => Promise<void>;
      }
  >();
  const [reembed, setReembed] = useState<
    { space: string; state: ReembedState } | undefined
  >();
  const [voiceProvider, setVoiceProvider] = useState<VoiceProvider>("none");
  // The ONLY read of stdout.columns in the app: a resize is a reason to
  // re-render, never a number any component is allowed to see.
  const [, setResizeTick] = useState(0);

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setResizeTick((n) => n + 1);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  // One chat session per persona, opened lazily and kept across screen
  // switches so `^s` then `esc` returns to the same thread.
  useEffect(() => {
    if (!props.startPersona) return;
    let cancelled = false;
    let opened: ChatSession | undefined;
    void (async () => {
      const { config } = await loadConfigForPersona(personaName);
      const chat = await openChat({ config, persona: personaName });
      if (cancelled) {
        await chat.close();
        return;
      }
      opened = chat;
      setSession(chat);
    })();
    return () => {
      cancelled = true;
      void opened?.close();
    };
  }, [personaName, props.startPersona]);

  const refresh = useCallback(async () => {
    setHost(await hostSnapshot());
  }, []);

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

  useInput((_char, key) => {
    // A global safety net: esc from any leaf screen goes back to chat rather
    // than to a shell, so there is never a dead end.
    if (key.escape && screen !== "chat" && screen !== "dashboard") {
      setScreen("dashboard");
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
    } catch (e) {
      setNotice(`doctor failed: ${(e as Error).message}`);
    } finally {
      setDoctorRunning(false);
    }
  }, [personaName]);

  const body = (() => {
    if (screen === "wizard") {
      return (
        <WizardScreen
          version={host.version}
          startAt={props.wizardStartAt}
          initial={{ name: props.startPersona ?? "" }}
          defaultExists={host.personas.length > 0}
          onQuit={exit}
          onFinish={async (answers) => {
            await props.onCreatePersona(answers);
            await refresh();
            setPersonaName(answers.name);
            setScreen("chat");
          }}
        />
      );
    }

    if (screen === "chat") {
      if (!session) {
        return (
          <Box>
            <Text color={theme.dim}>opening {personaName}…</Text>
          </Box>
        );
      }
      return (
        <ChatScreen
          session={session}
          status={[
            persona?.resolvedHarness?.id ?? persona?.chain[0] ?? "no brain",
            persona?.channels.join(", ") ?? "",
          ]
            .filter(Boolean)
            .join(" · ")}
          onSettings={() => setScreen("dashboard")}
          onSwitchPersona={() => setScreen("dashboard")}
          onQuit={exit}
        />
      );
    }

    if (screen === "dashboard") {
      return (
        <DashboardScreen
          host={host}
          onOpen={(name) => {
            setPersonaName(name);
            setScreen("persona");
          }}
          onChat={(name) => {
            setPersonaName(name);
            setScreen("chat");
          }}
          onNew={() => setScreen("wizard")}
          onDoctor={() => {
            setScreen("doctor");
            void runTheDoctor();
          }}
          onKeys={(name) => {
            setPersonaName(name);
            setScreen("keys");
          }}
          onMcp={(name) => {
            setPersonaName(name);
            setScreen("mcp");
          }}
          onRestart={async () => {
            const r = await restartService();
            setNotice(r.ok ? "service restarted" : `restart failed: ${r.error}`);
            await refresh();
          }}
          onBack={() => setScreen("chat")}
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
          onBack={() => setScreen("dashboard")}
          onRestart={async () => {
            const r = await restartService();
            setNotice(r.ok ? "service restarted" : `restart failed: ${r.error}`);
          }}
          onOpen={(target) => {
            if (target === "doctor") {
              setScreen("doctor");
              void runTheDoctor();
            } else {
              setScreen(target);
            }
          }}
        />
      );
    }

    if (screen === "keys") {
      return (
        <KeysScreen
          persona={persona}
          onSet={(name) => setModal({ kind: "secret", name })}
          onUnset={(name) =>
            setModal({
              kind: "confirm",
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
          onBack={() => setScreen("persona")}
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
            setModal({
              kind: "confirm",
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
          onBack={() => setScreen("persona")}
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
            const consequence = describeVoiceChange({ provider: voiceProvider });
            setModal({
              kind: "confirm",
              title: `Set ${persona.name}'s voice to ${voiceProvider}?`,
              consequence,
              run: async () => {
                const { config } = await loadConfigForPersona(persona.name);
                const r = await applyVoice({
                  config,
                  persona: persona.name,
                  voice: { provider: voiceProvider },
                });
                setNotice(r.ok ? "voice saved and restarted" : `failed: ${r.error}`);
                await refresh();
                setScreen("persona");
              },
            });
          }}
          onBack={() => setScreen("persona")}
        />
      );
    }

    if (screen === "doctor") {
      return (
        <DoctorScreen
          report={doctorReport}
          running={doctorRunning}
          onRerun={() => void runTheDoctor()}
          onBack={() => setScreen("dashboard")}
        />
      );
    }

    return (
      <McpScreen
        personaName={persona.name}
        servers={[]}
        onTest={() => setNotice("mcp test not wired yet")}
        onBack={() => setScreen("persona")}
      />
    );
  })();

  // A running job and an open modal both take over the screen. The screen
  // underneath keeps its state, so cancelling returns exactly where you were.
  if (reembed) {
    return <ReembedScreen space={reembed.space} state={reembed.state} />;
  }
  if (modal?.kind === "secret") {
    return (
      <Prompt
        label={`Set ${modal.name} for ${personaName}`}
        hint="written straight to the persona vault; never displayed again"
        masked
        onCancel={() => setModal(undefined)}
        onSubmit={async (value) => {
          setModal(undefined);
          if (!value) return;
          const { config } = await loadConfigForPersona(personaName);
          const r = await setSecret({
            config,
            persona: personaName,
            name: modal.name,
            value,
          });
          // Name only, never the value — a confirmation that echoes a secret
          // puts it in the scrollback the user just protected it from.
          setNotice(r.ok ? `saved ${modal.name}` : `failed: ${r.error}`);
          await refresh();
        }}
      />
    );
  }
  if (modal?.kind === "confirm") {
    return (
      <Confirm
        title={modal.title}
        consequence={modal.consequence}
        danger={modal.danger}
        onCancel={() => setModal(undefined)}
        onConfirm={async () => {
          const run = modal.run;
          setModal(undefined);
          await run();
        }}
      />
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      {body}
      {notice ? (
        <Box paddingX={2}>
          <Text color={theme.warn}>{notice}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
