/**
 * The first-run wizard's Brain steps, as one async flow.
 *
 * Runs AFTER the wizard has created the persona (the writes need a persona to
 * target) but is presented as the wizard's continuation — the last questions
 * before the app lands somewhere real. Order is Andrew's spec:
 *
 *   1. Primary brain — Pi (default) / Claude / Codex / Skip.
 *   2. Skip → land in CONFIGURE, Brain row red `required`.
 *   3. Pi is the default; if it isn't installed, offer the official installer
 *      (or go back and pick another brain — "can't continue" is too harsh for
 *      a default the user never explicitly chose).
 *   4. Pi installed → "configure here" (provider → key → model slots) or
 *      "use host configuration".
 *   5. Fallback brain — `(none)` allowed (a single-harness chain is valid).
 *   6. Test now / Skip: a REAL one-shot turn through the primary. Pass →
 *      chain saved, land in CHAT. Fail → nothing saved, land in Configure
 *      with Brain still red `required` and the actual error on screen.
 *      Skip test → chain saved (the choices were real), land in Configure —
 *      unverified, so no chat yet.
 *
 * Claude and Codex are chain-only picks: they inherit the host's harness
 * configuration for them, exactly as the Configure Brain flow says — so for
 * those the flow is primary → fallback → test.
 *
 * The asking is injected (`BrainQuestions`, the same contract configureBrain
 * uses) and every WRITE goes through the same functions the CLI harness
 * command uses, so the wizard, the TUI Configure screen and the CLI cannot
 * write different shapes of the same files.
 */

import type { PiModel } from "../lib/piModels.ts";
import type { RoutingChoices } from "../lib/piRouting.ts";
import type { PiAuthWriteResult } from "../lib/piAuthStore.ts";
import type { KeyProbeResult } from "../lib/providerKeyProbe.ts";
import { configurePi, type BrainQuestions } from "./brainFlow.ts";
import type { Consequence } from "./actions.ts";

export interface CreateBrainOnboardingDepsOptions {
  setNotice?: (msg: string) => void;
  askConfirmValue?: (req: {
    title: string;
    consequence: Consequence;
    danger?: boolean;
    confirmName?: string;
  }) => Promise<boolean>;
}

export async function createBrainOnboardingDeps(
  persona: string,
  options?: CreateBrainOnboardingDepsOptions,
): Promise<BrainOnboardingDeps> {
  const { loadConfig } = await import("../config.ts");
  const { ENV_PI_API_KEY } = await import("../lib/piRouting.ts");
  const {
    applyHarnessChain,
    applyRouting,
    clearPiRouting,
    restorePiRouting,
    snapshotPiRouting,
    defaultInstallRunner,
    detectAvailability,
    installPi,
    piInstallCommand,
  } = await import("../cli/harness.ts");
  const { resolveHarnessWriteTarget } = await import(
    "../lib/harnessWriteTarget.ts"
  );
  const { harnessChainIds, piInstanceSecretName } = await import(
    "../harnesses/buildChain.ts"
  );
  const { listPiModels } = await import("../lib/piModels.ts");
  const { getPersonaSecret, setPersonaSecret, unsetPersonaSecret } =
    await import("../lib/vaultSecrets.ts");
  const { restorePiAuth, snapshotPiAuth, writePiApiKey } = await import(
    "../lib/piAuthStore.ts"
  );
  const { probeProviderKey } = await import("../lib/providerKeyProbe.ts");

  const config = await loadConfig(persona);
  const availability = await detectAvailability(config);
  const writeTarget = await resolveHarnessWriteTarget(config, persona);
  const routing = config.harnesses.pi.routing ?? {};

  return {
    persona,
    availability: () => detectAvailability(config),
    installCommand: piInstallCommand().join(" "),
    installPi: async () => {
      const { withPromptTerminal } = await import("./prompts.ts");
      const ok = await withPromptTerminal(async () =>
        installPi(defaultInstallRunner, {
          note: (body: string, title?: string) =>
            options?.setNotice?.(
              title ? `${title}: ${body.split("\n")[0]}` : body,
            ),
        } as never),
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
    piInstances: {
      primary: {
        routing: config.harnesses.instances?.["pi-primary"]?.routing ?? {},
        storedKey: await getPersonaSecret(
          config,
          piInstanceSecretName("pi-primary"),
          persona,
        ),
      },
      fallback: {
        routing: config.harnesses.instances?.["pi-fallback"]?.routing ?? {},
        storedKey: await getPersonaSecret(
          config,
          piInstanceSecretName("pi-fallback"),
          persona,
        ),
      },
    },
    targetPath: writeTarget.path,
    personaScope: writeTarget.scope === "persona",
    piBin: availability.pi,
    listModels: (extraEnv) =>
      listPiModels(availability.pi!, undefined, extraEnv),
    setSecret: (value, instanceId) =>
      setPersonaSecret(
        config,
        instanceId ? piInstanceSecretName(instanceId) : ENV_PI_API_KEY,
        value,
        persona,
      ),
    unsetSecret: (instanceId) =>
      unsetPersonaSecret(
        config,
        instanceId ? piInstanceSecretName(instanceId) : ENV_PI_API_KEY,
        persona,
      ),
    writeAuth: (provider, value) => writePiApiKey(provider, value),
    applyChain: (chain) =>
      applyHarnessChain(
        writeTarget.path,
        chain as never,
        persona,
        writeTarget.scope,
      ),
    applyRouting: (choices, instanceId) =>
      applyRouting(writeTarget.path, choices, instanceId),
    clearRouting: async (opts, instanceId) => {
      await clearPiRouting(writeTarget.path, opts, instanceId);
    },
    snapshotWrites: async () => {
      const slots: (string | undefined)[] = [
        undefined,
        "pi-primary",
        "pi-fallback",
      ];
      const routing: Record<string, Record<string, unknown> | undefined> = {};
      const secrets: Record<string, string | undefined> = {};
      for (const instanceId of slots) {
        const key = instanceId ?? "";
        routing[key] = await snapshotPiRouting(writeTarget.path, instanceId);
        secrets[key] = await getPersonaSecret(
          config,
          instanceId ? piInstanceSecretName(instanceId) : ENV_PI_API_KEY,
          persona,
        );
      }
      return { routing, secrets, auth: await snapshotPiAuth() };
    },
    restoreWrites: async (snapshot) => {
      let ok = true;
      for (const [key, table] of Object.entries(snapshot.routing)) {
        const instanceId = key === "" ? undefined : key;
        await restorePiRouting(writeTarget.path, table, instanceId);
      }
      for (const [key, value] of Object.entries(snapshot.secrets)) {
        const instanceId = key === "" ? undefined : key;
        const name = instanceId
          ? piInstanceSecretName(instanceId)
          : ENV_PI_API_KEY;
        if (value === undefined) {
          await unsetPersonaSecret(config, name, persona);
        } else {
          const wrote = await setPersonaSecret(config, name, value, persona);
          if (!wrote.ok) ok = false;
        }
      }
      const auth = await restorePiAuth(snapshot.auth);
      return ok && auth.ok;
    },
    probe: async (id) => {
      const { probeHarness } = await import("../lib/harnessProbe.ts");
      return probeHarness({ config: await loadConfig(persona), id });
    },
    probeProviderKey: (providerId, key) => probeProviderKey(providerId, key),
    maybePromptRestart: async () => {
      const { maybePromptRestart } = await import("../cli/harness.ts");
      const { defaultServiceControl } = await import("../lib/platform.ts");
      await maybePromptRestart(
        defaultServiceControl(),
        async (message) =>
          options?.askConfirmValue
            ? await options.askConfirmValue({
                title: message,
                consequence: {
                  summary: "",
                  detail: "",
                  longRunning: false,
                  restarts: true,
                },
              })
            : true,
        {
          note: (body: string, title?: string) =>
            options?.setNotice?.(
              title ? `${title}: ${body.split("\n")[0]}` : body,
            ),
        } as never,
      );
    },
  };
}


export interface BrainOnboardingDeps {
  persona: string;
  /** Re-resolvable availability — an install changes it mid-flow. */
  availability(): Promise<Record<string, string | undefined>>;
  /** The official Pi installer invocation, as text — shown when Pi is missing. */
  installCommand: string;
  /** Run the official Pi installer. Returns whether Pi is usable afterwards. */
  installPi(): Promise<boolean>;
  /** The chain this persona effectively runs with now (host chain on first run). */
  chain: readonly string[];
  /** The EFFECTIVE Pi routing (provider + three model slots). */
  routing: {
    provider?: string;
    primaryModel?: string;
    imageModel?: string;
    codingModel?: string;
  };
  storedKey?: string;
  piInstances?: Partial<Record<"primary" | "fallback", {
    routing: BrainOnboardingDeps["routing"];
    storedKey?: string;
  }>>;
  targetPath: string;
  personaScope: boolean;
  piBin?: string;
  listModels(extraEnv?: Record<string, string>): Promise<PiModel[]>;
  probeProviderKey?(providerId: string, key: string): Promise<KeyProbeResult>;
  setSecret(value: string, instanceId?: string): Promise<{ ok: boolean; persona?: string; error?: string }>;
  unsetSecret(instanceId?: string): Promise<unknown>;
  writeAuth(provider: string, value: string): Promise<PiAuthWriteResult>;
  applyChain(chain: readonly string[]): Promise<void>;
  applyRouting(choices: RoutingChoices, instanceId?: string): Promise<unknown>;
  clearRouting(opts?: { tombstone?: boolean }, instanceId?: string): Promise<void>;
  /** One real turn through the named harness. The truth, not a `which`. */
  probe(id: string): Promise<{ ok: boolean; detail: string }>;
  maybePromptRestart?(): Promise<void>;
  /**
   * Capture every store the interview is about to write — routing tables, the
   * vault secret and Pi's auth.json — so a discarded or failed run can be
   * rolled back. Optional only so existing test fixtures keep compiling;
   * production deps always provide it, and without it the flow refuses to
   * claim the brain is unchanged (see `rollback`).
   */
  snapshotWrites?(): Promise<BrainWriteSnapshot>;
  /** Put a `snapshotWrites` result back. Returns false if anything failed. */
  restoreWrites?(snapshot: BrainWriteSnapshot): Promise<boolean>;
}

/**
 * Opaque to the flow: it snapshots before the interview and hands the same
 * object back on rollback. Shaped by `createBrainOnboardingDeps`.
 */
export interface BrainWriteSnapshot {
  routing: Record<string, Record<string, unknown> | undefined>;
  secrets: Record<string, string | undefined>;
  auth: string | undefined;
}

export interface BrainOnboardingResult {
  /** "chat" — brain configured AND verified by a real turn. "configure" — anything else. */
  landing: "chat" | "configure";
  /** Notice-bar line for what happened to the config. */
  notice: string;
  /** Set when the live test failed — the wrapper offers a full restart. */
  retry?: true;
  /** Probe error detail, when retry is set. */
  detail?: string;
}

const SKIP_NOTICE = "no brain yet — Configure's Brain row (marked required) finishes setup";

const HARNESS_LABELS: Record<string, string> = {
  pi: "Pi",
  codex: "Codex",
  claude: "Claude",
};

function hostConfigHint(id: string, available: boolean): string {
  const label = HARNESS_LABELS[id] ?? id;
  const found = available ? "" : " (not on PATH — will fail)";
  return `uses this host's ${label} configuration — nothing to set up${found}`;
}

/**
 * Run the Brain steps. Every cancel (esc) at every question lands in
 * CONFIGURE with the config untouched — a cancel during setup must never
 * half-save a brain the user didn't finish choosing.
 */
/**
 * Run the Brain steps. Every cancel (esc) at every question lands in
 * CONFIGURE with the config untouched — a cancel during setup must never
 * half-save a brain the user didn't finish choosing.
 *
 * A failed live test is different from a cancel: the wrapper below loops
 * the whole flow back to the top so the user can fix the key/model and
 * retest, instead of being dumped in Configure.
 */
export async function runBrainOnboarding(
  q: BrainQuestions,
  deps: BrainOnboardingDeps,
): Promise<BrainOnboardingResult> {
  for (;;) {
    const result = await runOnce(q, deps);
    if (result.retry !== true) return result;
    if (!q.testBrain) {
      const again = await q.choose({
        title: "Brain test failed",
        description:
          `Nothing was saved. ${(result.detail ?? "").split("\n")[0]}\nRun the brain setup again from the top to fix it — nothing was written, so you lose nothing by retrying.`,
        options: [
          { value: "restart", label: "Start over (recommended)", hint: "run the brain setup from the top, then retest" },
          { value: "configure", label: "Back to Configure", hint: "leave it for now; Brain stays marked required" },
        ],
        initial: "restart",
      });
      if (again !== "restart") {
        return { landing: "configure", notice: result.notice };
      }
    }
  }
}

async function runOnce(
  q: BrainQuestions,
  deps: BrainOnboardingDeps,
): Promise<BrainOnboardingResult> {
  let availability = await deps.availability();

  // Steps 1–3: primary, with the Pi install offer.
  let primary: string | undefined;
  while (primary === undefined) {
    const pick = await q.choose({
      title: `Primary brain for ${deps.persona}`,
      description: PRIMARY_DESCRIPTION,
      options: [
        {
          value: "pi",
          label: "Pi",
          hint: availability.pi
            ? "installed — provider + model routing configured here (recommended)"
            : "not installed — you'll be offered the official installer",
        },
        {
          value: "claude",
          label: "Claude",
          hint: hostConfigHint("claude", Boolean(availability.claude)),
        },
        {
          value: "codex",
          label: "Codex",
          hint: hostConfigHint("codex", Boolean(availability.codex)),
        },
        {
          value: "skip",
          label: "Skip — set up later",
          hint: "lands in Configure with Brain marked required",
        },
      ],
      initial: "pi",
    });
    if (pick === undefined || pick === "skip") {
      return { landing: "configure", notice: SKIP_NOTICE };
    }
    primary = pick;

    if (pick === "pi" && !availability.pi) {
      const install = await q.choose({
        title: "Pi is not installed",
        description:
          `Pi is the default brain, but it isn't on this host yet. The official installer is user-space (no sudo):\n\n  ${deps.installCommand}`,
        options: [
          {
            value: "install",
            label: "Install Pi now",
            hint: "runs the official installer right here, then re-checks",
          },
          { value: "back", label: "Pick a different brain" },
          { value: "skip", label: "Skip — set up later in Configure" },
        ],
        initial: "install",
      });
      if (install === "install") {
        q.note(
          "Installing Pi",
          "running the official installer — this can take a minute",
        );
        const installed = await deps.installPi();
        availability = await deps.availability();
        if (installed && availability.pi) {
          q.note("Pi installed", `found at ${availability.pi}`);
        } else {
          q.note(
            "Pi still missing",
            "the install didn't put pi on PATH — a new terminal may be needed, or pick a different brain",
          );
          primary = undefined;
          continue;
        }
      } else if (install === "back") {
        primary = undefined;
        continue;
      } else {
        return { landing: "configure", notice: SKIP_NOTICE };
      }
    }
  }

  // Step 4: fallback — (none) is a first-class answer. Pi remains available
  // behind Pi because each occurrence becomes an independent named instance.
  const fallback = await q.choose({
    title: "Fallback brain (optional)",
    description: FALLBACK_DESCRIPTION,
    options: [
      { value: "", label: "(none)", hint: "no fallback if the primary fails" },
      ...(["pi", "claude", "codex"] as const)
        .filter((id) => id !== primary || id === "pi")
        .map((id) => ({
          value: id,
          label: HARNESS_LABELS[id] ?? id,
          hint: hostConfigHint(id, Boolean(availability[id])),
        })),
    ],
    initial: "",
  });
  if (fallback === undefined) {
    return { landing: "configure", notice: "brain unchanged — finish it in Configure" };
  }

  const bothPi = primary === "pi" && fallback === "pi";
  const brainDeps = {
    persona: deps.persona,
    chain: deps.chain,
    availability,
    routing: deps.routing,
    storedKey: deps.storedKey,
    piInstances: deps.piInstances,
    targetPath: deps.targetPath,
    personaScope: deps.personaScope,
    piBin: availability.pi,
    installCommand: deps.installCommand,
    listModels: deps.listModels,
    probeProviderKey: deps.probeProviderKey,
    setSecret: deps.setSecret,
    unsetSecret: deps.unsetSecret,
    writeAuth: deps.writeAuth,
    applyChain: deps.applyChain,
    applyRouting: deps.applyRouting,
    clearRouting: deps.clearRouting,
  };
  // Everything below this line WRITES as it goes: each model slot, the API
  // key and Pi's auth store are persisted the moment they are answered, long
  // before the "apply?" question at the end. Snapshot first so declining to
  // apply — or a failed test, or a cancel — can put the previous brain back
  // instead of leaving the new provider/model/key committed under a notice
  // that claims nothing changed (PR #539 review, Kai).
  let snapshot: BrainWriteSnapshot | undefined;
  if (deps.snapshotWrites) snapshot = await deps.snapshotWrites();

  /**
   * Roll the interview's writes back and report honestly. When there is no
   * snapshot (a test fixture without the dep) or the restore itself failed,
   * the notice says the choices were kept rather than lying about it.
   */
  const discard = async (
    reason: string,
    extra?: Partial<BrainOnboardingResult>,
  ): Promise<BrainOnboardingResult> => {
    let restored = false;
    if (snapshot && deps.restoreWrites) {
      restored = await deps.restoreWrites(snapshot);
    }
    return {
      landing: "configure",
      notice: restored
        ? `brain unchanged — ${reason}`
        : `brain partly saved — ${reason}`,
      ...extra,
    };
  };

  let primaryMode: "configure" | "host" | undefined;
  if (primary === "pi") {
    const cancelled = await configurePi(
      q,
      brainDeps,
      "primary",
      { onMode: (m) => { primaryMode = m; } },
      bothPi ? "pi-primary" : undefined,
    );
    if (cancelled) return discard("finish it in Configure");
  }
  if (fallback === "pi") {
    const cancelled = await configurePi(
      q,
      brainDeps,
      "fallback",
      { allowHostConfig: primaryMode !== "host" },
      bothPi ? "pi-fallback" : undefined,
    );
    if (cancelled) return discard("finish it in Configure");
  }

  const chain = bothPi
    ? ["pi-primary", "pi-fallback"]
    : [primary, ...(fallback !== "" ? [fallback] : [])];

  // Step 6: prove it. Test now / Skip.
  const testPick = await q.choose({
    title: "Test the brain?",
    description:
      `Sends one short prompt through ${HARNESS_LABELS[primary] ?? primary} — the same path a real conversation takes. A bad key, dead model or missing binary surfaces here, in seconds.`,
    options: [
      { value: "test", label: "Test now (recommended)", hint: "one real turn; on success you land in chat" },
      { value: "skip", label: "Skip — verify later", hint: "saves the chain untested; lands in Configure" },
    ],
    initial: "test",
  });
  if (testPick === undefined) {
    return discard("finish it in Configure");
  }

  if (testPick === "test") {
    if (q.testBrain) {
      const testResult = await q.testBrain({
        persona: deps.persona,
        harness: HARNESS_LABELS[chain[0]!] ?? chain[0]!,
        probe: () => deps.probe(chain[0]!),
      });

      if (testResult.ok) {
        if (testResult.apply) {
          await deps.applyChain(chain);
          if (deps.maybePromptRestart) {
            await deps.maybePromptRestart();
          }
          return {
            landing: "chat",
            notice: `brain verified: ${chain.join(" → ")}`,
          };
        } else {
          // "No, discard and keep previous" — the chain was never applied,
          // and now neither is anything the interview wrote.
          return discard(`verified ${chain.join(" → ")}, discarded on request`);
        }
      } else {
        return discard(
          `test failed: ${testResult.detail.split("\n")[0]}`,
          {
            retry: testResult.retry ? true : undefined,
            detail: testResult.detail,
          },
        );
      }
    }

    q.note(
      `Testing ${HARNESS_LABELS[primary] ?? primary}`,
      "sending one short prompt — up to a minute on a cold start",
    );
    const result = await deps.probe(chain[0]!);
    if (!result.ok) {
      const rolledBack = await discard(
        `test failed: ${result.detail.split("\n")[0]}`,
        { retry: true, detail: result.detail },
      );
      q.note(
        "Brain test failed",
        `${result.detail}\n\n${
          rolledBack.notice.startsWith("brain unchanged")
            ? "The previous brain was put back"
            : "Your choices were kept"
        } — retry or finish in Configure.`,
      );
      return rolledBack;
    }
    q.note("Brain test passed", `reply: ${result.detail}`);
    await deps.applyChain(chain);
    if (deps.maybePromptRestart) {
      await deps.maybePromptRestart();
    }
    return {
      landing: "chat",
      notice: `brain verified: ${chain.join(" → ")}`,
    };
  }

  // Skipped the test: the choices were real, so they're saved — but an
  // unverified brain doesn't earn chat. Configure is the honest landing.
  await deps.applyChain(chain);
  if (deps.maybePromptRestart) {
    await deps.maybePromptRestart();
  }
  return {
    landing: "configure",
    notice: `brain saved (untested): ${chain.join(" → ")}`,
  };
}

const PRIMARY_DESCRIPTION =
  "The primary brain answers every turn first — it is the model the phantom thinks with. The fallback, asked next, only steps in when the primary fails.";

const FALLBACK_DESCRIPTION =
  "Used when the primary errors, hangs, or returns an empty reply. Leave it as (none) if you don't want a safety net — everything still works, there is just nothing to fall back to.";
