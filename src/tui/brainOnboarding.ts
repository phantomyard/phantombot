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
import { configurePi, type BrainQuestions } from "./brainFlow.ts";

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
  targetPath: string;
  personaScope: boolean;
  piBin?: string;
  listModels(extraEnv?: Record<string, string>): Promise<PiModel[]>;
  setSecret(value: string): Promise<{ ok: boolean; persona?: string; error?: string }>;
  unsetSecret(): Promise<unknown>;
  writeAuth(provider: string, value: string): Promise<PiAuthWriteResult>;
  applyChain(chain: readonly string[]): Promise<void>;
  applyRouting(choices: RoutingChoices): Promise<unknown>;
  clearRouting(opts?: { tombstone?: boolean }): Promise<void>;
  /** One real turn through the named harness. The truth, not a `which`. */
  probe(id: string): Promise<{ ok: boolean; detail: string }>;
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

const PI_MODE_DESCRIPTION =
  "Configure here picks the provider and which model handles primary, vision and coding turns — recommended. Use Host Configuration hands model choice back to Pi itself (whatever you set up by running `pi` on this host).";

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

  // Step 4: Pi's model configuration — only when Pi is the primary AND
  // installed. Claude/Codex are chain-only: nothing to configure, ever.
  if (primary === "pi" && availability.pi) {
    const mode = await q.choose({
      title: "Pi — how should its models be configured?",
      description: PI_MODE_DESCRIPTION,
      options: [
        {
          value: "configure",
          label: "Configure Provider and Model Swap Settings",
          hint: "pick provider, API key, and the primary / vision / coder models here (recommended)",
        },
        {
          value: "host",
          label: "Use Host Configuration",
          hint: "reuse the Pi provider and model routing already configured on this host",
        },
      ],
      initial: "configure",
    });
    if (mode === undefined) {
      return { landing: "configure", notice: "brain unchanged — finish it in Configure" };
    }
    if (mode === "configure") {
      const cancelled = await configurePi(q, {
        persona: deps.persona,
        chain: deps.chain,
        availability,
        routing: deps.routing,
        storedKey: deps.storedKey,
        targetPath: deps.targetPath,
        personaScope: deps.personaScope,
        piBin: availability.pi,
        installCommand: deps.installCommand,
        listModels: deps.listModels,
        setSecret: deps.setSecret,
        unsetSecret: deps.unsetSecret,
        writeAuth: deps.writeAuth,
        applyChain: deps.applyChain,
        applyRouting: deps.applyRouting,
        clearRouting: deps.clearRouting,
      }, "primary", { askMode: false });
      if (cancelled) {
        return { landing: "configure", notice: "brain unchanged — finish it in Configure" };
      }
    } else {
      await deps.clearRouting({ tombstone: deps.personaScope });
      q.note(
        "Pi: using host configuration",
        `cleared phantombot's Pi routing from ${deps.targetPath} — Pi decides for itself`,
      );
    }
  }

  // Step 5: fallback — (none) is a first-class answer.
  const fallback = await q.choose({
    title: "Fallback brain (optional)",
    description: FALLBACK_DESCRIPTION,
    options: [
      { value: "", label: "(none)", hint: "no fallback if the primary fails" },
      ...(["pi", "claude", "codex"] as const)
        .filter((id) => id !== primary)
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

  const chain = [primary, ...(fallback !== "" ? [fallback] : [])];

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
    return { landing: "configure", notice: "brain unchanged — finish it in Configure" };
  }

  if (testPick === "test") {
    q.note(
      `Testing ${HARNESS_LABELS[primary] ?? primary}`,
      "sending one short prompt — up to a minute on a cold start",
    );
    const result = await deps.probe(primary);
    if (!result.ok) {
      q.note(
        "Brain test failed",
        `${result.detail}\n\nNothing was saved — retry or finish in Configure.`,
      );
      return {
        landing: "configure",
        notice: `brain test failed: ${result.detail.split("\n")[0]}`,
        retry: true,
        detail: result.detail,
      };
    }
    q.note("Brain test passed", `reply: ${result.detail}`);
    await deps.applyChain(chain);
    return {
      landing: "chat",
      notice: `brain verified: ${chain.join(" → ")}`,
    };
  }

  // Skipped the test: the choices were real, so they're saved — but an
  // unverified brain doesn't earn chat. Configure is the honest landing.
  await deps.applyChain(chain);
  return {
    landing: "configure",
    notice: `brain saved (untested): ${chain.join(" → ")}`,
  };
}

const PRIMARY_DESCRIPTION =
  "The primary brain answers every turn first — it is the model the phantom thinks with. The fallback, asked next, only steps in when the primary fails.";

const FALLBACK_DESCRIPTION =
  "Used when the primary errors, hangs, or returns an empty reply. Leave it as (none) if you don't want a safety net — everything still works, there is just nothing to fall back to.";
