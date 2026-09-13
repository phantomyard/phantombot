/**
 * The first-run wizard's Brain steps, as one async flow.
 *
 * Runs AFTER the wizard has created the persona (the writes need a persona to
 * target) but is presented as the wizard's continuation — the last questions
 * before the app lands somewhere real. Order is Andrew's spec:
 *
 *   1. Primary brain — Native (default, always offered: the pi engine built
 *      into this binary) / Claude / Codex / Pi host configuration / Skip.
 *      Host harnesses are detected live and offered ONLY when installed;
 *      nothing is installed from here.
 *   2. Skip → land in CONFIGURE, Brain row red `required`.
 *   3. Native → provider → key → model slots, configured here.
 *   4. Fallback brain — `(none)` allowed (a single-harness chain is valid).
 *   5. Test now / Skip: a REAL one-shot turn through the primary. Pass →
 *      chain saved, land in CHAT. Fail → nothing saved, land in Configure
 *      with Brain still red `required` and the actual error on screen.
 *      Skip test → chain saved (the choices were real), land in Configure —
 *      unverified, so no chat yet.
 *
 * Claude, Codex and host Pi are chain-only picks: they inherit the host's
 * harness configuration, exactly as the Configure Brain flow says — so for
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
import {
  brainMenuId,
  configureNative,
  HARNESS_LABELS as MENU_LABELS,
  offeredBrains,
  type BrainQuestions,
} from "./brainFlow.ts";
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
    restorePiRouting,
    snapshotPiRouting,
    detectAvailability,
  } = await import("../cli/harness.ts");
  const { embeddedPiCommand } = await import("../lib/embeddedPi.ts");
  const { resolveHarnessWriteTarget } = await import(
    "../lib/harnessWriteTarget.ts"
  );
  const { harnessChainIds, piInstanceSecretName } = await import(
    "../harnesses/buildChain.ts"
  );
  const { listPiModels } = await import("../lib/piModels.ts");
  const {
    getPersonaSecret,
    getPersonaSecretStrict,
    setPersonaSecret,
    unsetPersonaSecret,
  } = await import("../lib/vaultSecrets.ts");
  const { restorePiAuth, snapshotPiAuth, writePiApiKey } = await import(
    "../lib/piAuthStore.ts"
  );
  const { nativeAgentDir, nativeAgentEnv } = await import(
    "../lib/nativeAgentDir.ts"
  );
  const { probeProviderKey } = await import("../lib/providerKeyProbe.ts");

  const config = await loadConfig(persona);
  const writeTarget = await resolveHarnessWriteTarget(config, persona);
  const routing = config.harnesses.pi.routing ?? {};

  return {
    persona,
    availability: () => detectAvailability(config),
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
    listModels: (extraEnv) =>
      // The embedded engine's catalog lives in its ISOLATED agent dir — merge
      // the isolation env so a plain listing reads NATIVE auth, never ~/.pi.
      listPiModels(embeddedPiCommand(), undefined, {
        ...nativeAgentEnv(),
        ...extraEnv,
      }),
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
    // Write into the NATIVE engine's isolated agent dir, never ~/.pi.
    writeAuth: (provider, value) =>
      writePiApiKey(provider, value, { agentDir: nativeAgentDir() }),
    applyChain: (chain) =>
      applyHarnessChain(
        writeTarget.path,
        chain as never,
        persona,
        writeTarget.scope,
      ),
    applyRouting: (choices, instanceId) =>
      applyRouting(writeTarget.path, choices, instanceId),
    snapshotWrites: () =>
      snapshotBrainWrites(
        BRAIN_WRITE_SLOT_IDS.map((instanceId) => ({
          instanceId,
          secretName: instanceId
            ? piInstanceSecretName(instanceId)
            : ENV_PI_API_KEY,
        })),
        {
        snapshotRouting: (instanceId) =>
          snapshotPiRouting(writeTarget.path, instanceId),
        // STRICT: the persona's own vault row and nothing else. The effective
        // read (`getPersonaSecret`) falls back to process.env, and restoring
        // that fallback would MINT a persona override where there was no row
        // (PR #539 review, Kai/Lena).
        readVaultSecret: (name) =>
          getPersonaSecretStrict(config, name, persona),
          snapshotAuth: () => snapshotPiAuth({ agentDir: nativeAgentDir() }),
        },
      ),
    restoreWrites: (snapshot) =>
      restoreBrainWrites(snapshot, {
        restoreRouting: (table, instanceId) =>
          restorePiRouting(writeTarget.path, table, instanceId),
        setVaultSecret: (name, value) =>
          setPersonaSecret(config, name, value, persona),
        unsetVaultSecret: (name) => unsetPersonaSecret(config, name, persona),
        restoreAuth: (auth) => restorePiAuth(auth, { agentDir: nativeAgentDir() }),
      }),
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
  /** Live harness detection — re-run every time the flow starts. */
  availability(): Promise<Record<string, string | undefined>>;
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
  listModels(extraEnv?: Record<string, string>): Promise<PiModel[]>;
  probeProviderKey?(providerId: string, key: string): Promise<KeyProbeResult>;
  setSecret(value: string, instanceId?: string): Promise<{ ok: boolean; persona?: string; error?: string }>;
  unsetSecret(instanceId?: string): Promise<unknown>;
  writeAuth(provider: string, value: string): Promise<PiAuthWriteResult>;
  applyChain(chain: readonly string[]): Promise<void>;
  applyRouting(choices: RoutingChoices, instanceId?: string): Promise<unknown>;
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
 * object back on rollback. Shaped by `snapshotBrainWrites`.
 *
 * Secrets are keyed by VAULT NAME and record two independent facts: the
 * persona's own vault row (`vault`, undefined = no row) and what this process
 * saw in `process.env` (`env`). They are not the same thing — a host-wide
 * export can stand in for a missing row — and conflating them is how a
 * rollback turns an inherited key into a persona override.
 */
export interface BrainWriteSnapshot {
  routing: Record<string, Record<string, unknown> | undefined>;
  secrets: Record<string, { vault: string | undefined; env: string | undefined }>;
  auth: string | undefined;
}

/** A Pi routing slot the interview may write, and its vault secret name. */
export interface BrainWriteSlot {
  /** undefined = the single-Pi `[harnesses.pi]` table. */
  instanceId: string | undefined;
  secretName: string;
}

/** The slots the interview can touch. Secret names resolved at wire time. */
export const BRAIN_WRITE_SLOT_IDS: readonly (string | undefined)[] = [
  undefined,
  "pi-primary",
  "pi-fallback",
];

export interface BrainSnapshotStores {
  snapshotRouting(instanceId?: string): Promise<Record<string, unknown> | undefined>;
  /** Persona vault row only — NEVER an ambient fallback. */
  readVaultSecret(name: string): Promise<string | undefined>;
  snapshotAuth(): Promise<string | undefined>;
}

export interface BrainRestoreStores {
  restoreRouting(
    table: Record<string, unknown> | undefined,
    instanceId?: string,
  ): Promise<unknown>;
  setVaultSecret(name: string, value: string): Promise<{ ok: boolean }>;
  unsetVaultSecret(name: string): Promise<{ ok: boolean }>;
  restoreAuth(auth: string | undefined): Promise<{ ok: boolean }>;
}

/** Capture every store the brain interview is about to write. */
export async function snapshotBrainWrites(
  slots: readonly BrainWriteSlot[],
  stores: BrainSnapshotStores,
): Promise<BrainWriteSnapshot> {
  const routing: BrainWriteSnapshot["routing"] = {};
  const secrets: BrainWriteSnapshot["secrets"] = {};
  for (const { instanceId, secretName } of slots) {
    routing[instanceId ?? ""] = await stores.snapshotRouting(instanceId);
    secrets[secretName] = {
      vault: await stores.readVaultSecret(secretName),
      env: process.env[secretName],
    };
  }
  return { routing, secrets, auth: await stores.snapshotAuth() };
}

/**
 * Put a `snapshotBrainWrites` result back. Returns true only if EVERY store
 * came back.
 *
 * Every store is attempted even when an earlier one fails or throws: a
 * rollback that stops at the first error leaves the rest of the new brain
 * committed, and one that lets the error escape skips the caller's honest
 * "brain partly saved" notice. So each step is caught on its own, a `{ok:false}`
 * counts exactly like a throw, and the verdict is the AND of all of them.
 *
 * A secret with no vault row before the interview is UNSET, never set to the
 * ambient value: re-creating the row would turn an inherited host key into a
 * persona override. The process env is then put back as it was, because
 * `setPersonaSecret` / `unsetPersonaSecret` both mirror into it and the TUI
 * process would otherwise lose a host-wide key until restart.
 */
export async function restoreBrainWrites(
  snapshot: BrainWriteSnapshot,
  stores: BrainRestoreStores,
): Promise<boolean> {
  let ok = true;
  const attempt = async (step: () => Promise<unknown>) => {
    try {
      const r = await step();
      if (r && typeof r === "object" && (r as { ok?: unknown }).ok === false) {
        ok = false;
      }
    } catch {
      ok = false;
    }
  };
  for (const [key, table] of Object.entries(snapshot.routing)) {
    const instanceId = key === "" ? undefined : key;
    await attempt(() => stores.restoreRouting(table, instanceId));
  }
  for (const [name, prior] of Object.entries(snapshot.secrets)) {
    await attempt(() =>
      prior.vault === undefined
        ? stores.unsetVaultSecret(name)
        : stores.setVaultSecret(name, prior.vault),
    );
    if (prior.env === undefined) delete process.env[name];
    else process.env[name] = prior.env;
  }
  await attempt(() => stores.restoreAuth(snapshot.auth));
  return ok;
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

/** Short harness names for notices and the test screen (menus use MENU_LABELS). */
const HARNESS_LABELS: Record<string, string> = {
  native: "Native",
  "pi-host": "Pi (host configuration)",
  codex: "Codex",
  claude: "Claude",
};

function onboardingHint(id: string): string {
  if (id === "native") {
    return "built in — provider + model routing configured here (recommended)";
  }
  const label = id === "pi-host" ? "pi" : (HARNESS_LABELS[id] ?? id);
  return `uses this host's ${label} configuration — nothing to set up`;
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
  // Detected LIVE on every run: a harness installed or removed since last
  // time appears (or disappears) here, never from a cached path.
  const availability = await deps.availability();
  const offered = offeredBrains(availability);

  // Step 1: primary. Native is the default and always offered — it is built
  // in, so there is nothing to install. Host harnesses only when found.
  const primary = await q.choose({
    title: `Primary brain for ${deps.persona}`,
    description: PRIMARY_DESCRIPTION,
    options: [
      ...offered.map((id) => ({
        value: id,
        label: MENU_LABELS[id] ?? id,
        hint: onboardingHint(id),
      })),
      {
        value: "skip",
        label: "Skip — set up later",
        hint: "lands in Configure with Brain marked required",
      },
    ],
    initial: "native",
  });
  if (primary === undefined || primary === "skip") {
    return { landing: "configure", notice: SKIP_NOTICE };
  }

  // Step 4: fallback — (none) is a first-class answer. Native remains
  // available behind native because each occurrence becomes an independent
  // named instance.
  const fallback = await q.choose({
    title: "Fallback brain (optional)",
    description: FALLBACK_DESCRIPTION,
    options: [
      { value: "", label: "(none)", hint: "no fallback if the primary fails" },
      ...offered
        .filter((id) => id !== primary || id === "native")
        .map((id) => ({
          value: id,
          label: MENU_LABELS[id] ?? id,
          hint: onboardingHint(id),
        })),
    ],
    initial: "",
  });
  if (fallback === undefined) {
    return { landing: "configure", notice: "brain unchanged — finish it in Configure" };
  }

  const bothNative = primary === "native" && fallback === "native";
  const brainDeps = {
    persona: deps.persona,
    chain: deps.chain,
    availability,
    routing: deps.routing,
    storedKey: deps.storedKey,
    piInstances: deps.piInstances,
    targetPath: deps.targetPath,
    personaScope: deps.personaScope,
    listModels: deps.listModels,
    probeProviderKey: deps.probeProviderKey,
    setSecret: deps.setSecret,
    unsetSecret: deps.unsetSecret,
    writeAuth: deps.writeAuth,
    applyChain: deps.applyChain,
    applyRouting: deps.applyRouting,
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
      try {
        restored = await deps.restoreWrites(snapshot);
      } catch {
        restored = false; // a throw must still reach the honest notice
      }
    }
    return {
      landing: "configure",
      notice: restored
        ? `brain unchanged — ${reason}`
        : `brain partly saved — ${reason}`,
      ...extra,
    };
  };

  if (primary === "native") {
    const cancelled = await configureNative(
      q,
      brainDeps,
      "primary",
      bothNative ? "pi-primary" : undefined,
    );
    if (cancelled) return discard("finish it in Configure");
  }
  if (fallback === "native") {
    const cancelled = await configureNative(
      q,
      brainDeps,
      "fallback",
      bothNative ? "pi-fallback" : undefined,
    );
    if (cancelled) return discard("finish it in Configure");
  }

  const chain = bothNative
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
        harness: HARNESS_LABELS[brainMenuId(chain[0]) ?? ""] ?? chain[0]!,
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
