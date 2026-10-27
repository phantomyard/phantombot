/**
 * The two "bring your own endpoint" Pi providers (issue #694):
 *
 *   openai-compatible — any server speaking the OpenAI Chat Completions API
 *                       (vLLM, Ollama, llama.cpp, LM Studio, LocalAI, a proxy).
 *   phantomops        — the PhantomOps gateway, keyed with the user's personal
 *                       API token (`pok_…`), where `phantomops/auto` runs their
 *                       hosted phantom server-side (phantomops #326 / #327).
 *
 * THE PROBLEM. Every entry in `PI_PROVIDER_CATALOG` is a fixed hosted vendor
 * with a hardcoded endpoint: Pi resolves the key from the provider's native env
 * var and knows where to send it. A self-hosted endpoint has no such entry, and
 * Pi has no base-URL env var for one (only Azure publishes `AZURE_OPENAI_BASE_URL`;
 * see pi's docs/environment-variables.md). Pi's own answer is `models.json` in
 * its agent dir — a provider entry that carries `baseUrl`, the API flavour, the
 * key reference and the model list (`docs/models.md#configure-a-compatible-endpoint`).
 *
 * SO: these providers work by ENTRY, not by hardcoded endpoint. Phantombot owns
 * the agent dir in native mode (`lib/nativeAgentDir.ts`), so it can write that
 * entry itself — which is exactly what makes the feature possible without
 * asking the operator to hand-edit a file in Pi's data directory:
 *
 *   - at CONFIG time (both wizards) so `pi --list-models` knows the provider and
 *     the model pickers can fill from it;
 *   - again at SPAWN time (harnesses/pi.ts) if the entry has drifted from the
 *     configured base URL or lost models — a turn must never depend on a write
 *     that happened an upgrade ago.
 *
 * VERIFIED against the embedded pi 1.0.4: a `models.json` provider named
 * `mybox` with `baseUrl` + `api: "openai-completions"` + `apiKey: "$VAR"` shows
 * up in `pi --list-models` and serves a real completion via
 * `pi --provider mybox --model …` with the key taken from `$VAR`.
 *
 * THE KEY IS NEVER IN THIS FILE. `apiKey` holds a `$NAME` reference, and the
 * value is relayed per-turn through the provider's native env var exactly like
 * every catalog provider (see `ENV_PI_API_KEY` / `ENV_PI_KEY_ENV` in
 * `lib/piRouting.ts`) — env, never argv, never disk (#602).
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The file Pi reads custom providers from, inside its agent dir. */
export const MODELS_JSON_FILE = "models.json";

/** Provider ids, as `pi --provider` sees them. */
export const OPENAI_COMPATIBLE_PROVIDER = "openai-compatible";
export const PHANTOOPS_PROVIDER = "phantomops";

/**
 * The provider's native env var — the name Pi interpolates in `models.json`
 * (`apiKey: "$OPENAI_COMPATIBLE_API_KEY"`) and the var the harness relays the
 * per-turn key through. `PI_PROVIDER_CATALOG` exposes the same names, so the
 * wizard's key prompt, the vault secret and the relay all agree.
 */
export const OPENAI_COMPATIBLE_KEY_ENV = "OPENAI_COMPATIBLE_API_KEY";
export const PHANTOOPS_KEY_ENV = "PHANTOOPS_API_KEY";

/**
 * PhantomOps' gateway base URL — an OpenAI-shaped `/api/v1` root serving
 * `POST /chat/completions` and `GET /models`. Prod FQDN comes from the
 * phantomops promote workflow (APP_BASE_URL), so this is the same host the PWA
 * runs on; `/api/v1` is the router prefix in `backend/openai_gateway.py`.
 */
export const PHANTOOPS_DEFAULT_BASE_URL = "https://phantomops.app/api/v1";

/**
 * The model that runs the FULL phantom (memory, drawers, vault, skills, tools,
 * confirmation gates, history) server-side. It is the provider default: a
 * PhantomOps user wants their phantom, not a raw model.
 */
export const PHANTOOPS_AUTO_MODEL = "phantomops/auto";

export interface CustomProviderSpec {
  id: string;
  /** Menu label. */
  label: string;
  /** Native env var Pi interpolates and the harness relays the key through. */
  keyEnv: string;
  /**
   * Does the operator have to supply a base URL? true for openai-compatible
   * (nobody can guess their inference server); false for PhantomOps, which is
   * one credential by design — the gateway endpoint is the provider's default.
   */
  needsBaseUrl: boolean;
  /** Endpoint used when the operator states none (PhantomOps only). */
  defaultBaseUrl?: string;
  /** Preselected model id — the "what almost everyone wants" answer. */
  defaultModel?: string;
  /** Prompt label for the credential. */
  keyLabel: string;
  /** One line for the picker, so the choice is self-explanatory. */
  hint: string;
}

export const CUSTOM_PROVIDERS: readonly CustomProviderSpec[] = [
  {
    id: OPENAI_COMPATIBLE_PROVIDER,
    label: "OpenAI-Compatible (self-hosted)",
    keyEnv: OPENAI_COMPATIBLE_KEY_ENV,
    needsBaseUrl: true,
    keyLabel: "API key for your endpoint (blank is allowed for an unauthenticated server)",
    hint: "vLLM, Ollama, llama.cpp, LM Studio, LocalAI — you give the base URL",
  },
  {
    id: PHANTOOPS_PROVIDER,
    label: "PhantomOps",
    keyEnv: PHANTOOPS_KEY_ENV,
    needsBaseUrl: false,
    defaultBaseUrl: PHANTOOPS_DEFAULT_BASE_URL,
    defaultModel: PHANTOOPS_AUTO_MODEL,
    keyLabel: "PhantomOps personal API token (pok_…)",
    hint: "your personal token — runs your full phantom on the gateway",
  },
];

/** The spec for a custom provider id, or undefined for a catalog provider. */
export function customProviderSpec(id: string | undefined): CustomProviderSpec | undefined {
  if (!id) return undefined;
  return CUSTOM_PROVIDERS.find((p) => p.id === id);
}

/**
 * The stored endpoint a wizard may REUSE for the provider it is configuring.
 *
 * `[harnesses.pi.routing].base_url` belongs to the provider that was configured
 * with it, so it is reusable ONLY while the operator keeps that provider. Both
 * wizards had been feeding it to any custom provider: switching from a
 * self-hosted `openai-compatible` box to PhantomOps made PhantomOps inherit
 * `http://old-inference.example/v1`, announce it, and persist it — after which
 * the operator's personal token was sent to their old inference server. A
 * switched provider starts from its own default or collects a fresh endpoint.
 *
 * Pure and shared so the two flows cannot drift apart again.
 */
export function storedBaseUrlForProvider(
  provider: string | undefined,
  currentProvider: string | undefined,
  storedBaseUrl: string | undefined,
): string | undefined {
  if ((provider ?? "") !== (currentProvider ?? "")) return undefined;
  return storedBaseUrl;
}

export function isCustomProvider(id: string | undefined): boolean {
  return customProviderSpec(id) !== undefined;
}

/**
 * Custom providers that may legitimately run with NO credential.
 *
 * A self-hosted OpenAI-compatible server (Ollama, LM Studio, llama.cpp) often
 * ignores the Authorization header entirely, so "no key" is a real, supported
 * configuration for it — the wizard accepts it and the entry carries the literal
 * {@link NO_KEY_PLACEHOLDER} so pi can still resolve the provider. PhantomOps is
 * the opposite: the personal token IS the configuration, so it never qualifies.
 *
 * ONE definition, read by the wizard (to decide whether the key prompt may be
 * left empty) and by the harness's native pre-spawn guard (to decide whether a
 * missing key is fatal) — they must never disagree, or a keyless brain saves
 * cleanly and then fails its first turn (review, Kai).
 */
export function customProviderAllowsKeyless(id: string | undefined): boolean {
  // Deliberately an ID check, not "does it need a base URL": a future custom
  // provider must opt in here explicitly before it can run unauthenticated.
  return customProviderSpec(id)?.id === OPENAI_COMPATIBLE_PROVIDER;
}

/**
 * Issue #696: providers whose wizard asks for NO model selector at all.
 *
 * PhantomOps is the case: `phantomops/auto` runs the full phantom server-side
 * and IS the reason the provider exists, so a picker whose only meaningful
 * answer is the preselected default is friction, not choice. Both wizards
 * check THIS one predicate (the CLI and the TUI flow must not drift apart —
 * the #694 review history is the lesson: two wizards, one rule). The wizard
 * path becomes key → test, and every routing slot resolves to
 * {@link PHANTOOPS_AUTO_MODEL} silently.
 */
export function usesAutoRouting(
  id: string | undefined,
): id is typeof PHANTOOPS_PROVIDER {
  return customProviderSpec(id)?.id === PHANTOOPS_PROVIDER;
}

/**
 * Normalise an operator-entered base URL.
 *
 * Operators paste what their server prints — often with a trailing slash, and
 * sometimes the full completion URL rather than the root. Pi appends
 * `/chat/completions` and `/models` to whatever it is given, so a pasted
 * endpoint path would double up and 404. Strip the suffixes we know and the
 * trailing slash; require an explicit http(s) scheme so "localhost:11434/v1"
 * fails loudly at the prompt instead of silently at request time.
 */
export function normalizeBaseUrl(
  raw: string | undefined,
): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, error: "a base URL is required" };
  if (!/^https?:\/\//i.test(trimmed)) {
    return {
      ok: false,
      error: "the base URL must start with http:// or https:// (e.g. http://localhost:11434/v1)",
    };
  }
  let value = trimmed.replace(/\/+$/, "");
  for (const suffix of ["/chat/completions", "/completions", "/models"]) {
    if (value.toLowerCase().endsWith(suffix)) {
      value = value.slice(0, value.length - suffix.length).replace(/\/+$/, "");
      break;
    }
  }
  if (!/^https?:\/\/[^/]/i.test(value)) {
    return { ok: false, error: `'${trimmed}' is not a usable base URL` };
  }
  return { ok: true, value };
}

/**
 * Prompt-copy warning for a plain-`http` endpoint (review, Lena).
 *
 * `http://` is rightly accepted — LM Studio / Ollama / llama.cpp on loopback
 * speak it — but once a key is configured the wizard sends it as a Bearer
 * header, and beyond loopback that puts the token (an endpoint key, or a
 * `pok_…` when a PhantomOps base_url override points at a dev ring) on the
 * wire unencrypted. One warning line at the prompt; this never blocks and
 * never rewrites the URL.
 */
export function plaintextKeyWarning(baseUrl: string): string | undefined {
  if (!/^http:\/\//i.test(baseUrl)) return undefined;
  let host: string;
  try {
    // WHATWG URL keeps IPv6 brackets in `hostname` (`[::1]`), so strip them
    // before the loopback check.
    host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host.startsWith("127.");
  if (loopback) return undefined;
  return `${baseUrl} is plain http — an API key sent to it travels unencrypted. Prefer https:// unless this link is trusted.`;
}

/**
 * The base URL a custom provider should use, given the operator's stored value.
 *
 * `stored` is `[harnesses.pi.routing].base_url`. An operator value always wins
 * (a PhantomOps dev ring, a self-hosted gateway, a port that moved). Falling
 * back to the spec default is what lets PhantomOps need nothing but a token.
 * Returns undefined when nothing usable exists — callers treat that as "this
 * provider is not configured yet", never as "use a guess".
 */
export function resolveCustomProviderBaseUrl(
  id: string,
  stored: string | undefined,
): string | undefined {
  const spec = customProviderSpec(id);
  if (!spec) return undefined;
  if (stored !== undefined && stored.trim() !== "") {
    const norm = normalizeBaseUrl(stored);
    return norm.ok ? norm.value : undefined;
  }
  return spec.defaultBaseUrl;
}

/** A model row as it goes into `models.json`. */
export interface CustomProviderModel {
  id: string;
  name?: string;
}

/**
 * The model rows for a provider entry: the provider's own defaults first (so
 * `phantomops/auto` is always resolvable), then whatever the caller knows.
 * De-duplicated, order preserved.
 */
export function customProviderModels(
  id: string,
  extra: readonly string[] = [],
): CustomProviderModel[] {
  const spec = customProviderSpec(id);
  const out: CustomProviderModel[] = [];
  const seen = new Set<string>();
  for (const raw of [spec?.defaultModel, ...extra]) {
    const model = (raw ?? "").trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push({ id: model });
  }
  return out;
}

/** One `models.json` provider entry. `apiKey` is a `$NAME` reference. */
export interface ModelsJsonProviderEntry {
  baseUrl: string;
  api: "openai-completions";
  apiKey: string;
  models: CustomProviderModel[];
}

/**
 * A key pi will accept for an UNAUTHENTICATED endpoint.
 *
 * VERIFIED against pi 1.0.4: a provider whose `apiKey` cannot be resolved —
 * an unset `$VAR` — is not merely unauthenticated, it is INVISIBLE (`pi
 * --list-models` omits it and a turn dies with "Use /login to log into a
 * provider"). Self-hosted Ollama / LM Studio / llama.cpp servers ignore the
 * Authorization header entirely, and pi's own docs use a dummy key for Ollama
 * for exactly this reason (docs/models.md). So "no key" is expressed as a
 * literal placeholder rather than an unresolvable reference.
 */
export const NO_KEY_PLACEHOLDER = "no-key-required";

export function buildProviderEntry(input: {
  id: string;
  baseUrl: string;
  models?: readonly string[];
  /**
   * Is a key stored for this provider? false ⇒ pi gets the literal
   * NO_KEY_PLACEHOLDER instead of the `$VAR` reference (see above). PhantomOps
   * always requires its token, so it always uses the reference.
   */
  keyAvailable?: boolean;
}): ModelsJsonProviderEntry {
  const spec = customProviderSpec(input.id);
  if (!spec) throw new Error(`not a custom provider: ${input.id}`);
  const useEnvRef = input.keyAvailable ?? true;
  return {
    baseUrl: input.baseUrl,
    api: "openai-completions",
    // `$NAME` is pi's own env interpolation (docs/models.md). A `$$` escape is
    // needed only for a literal `$` — never our case.
    apiKey: useEnvRef ? `$${spec.keyEnv}` : NO_KEY_PLACEHOLDER,
    models: customProviderModels(input.id, input.models),
  };
}

/**
 * Merge our provider entry into an existing `models.json` document.
 *
 * PURE, so the merge rules are unit-tested without touching a filesystem:
 *   - the file may not exist (undefined / "") → we create the shape;
 *   - every other key and every other provider survives verbatim — Pi's agent
 *     dir is shared with whatever the operator (or a host pi) put there;
 *   - an unparseable or non-object document is REFUSED rather than clobbered:
 *     silently overwriting user state is worse than a loud error the wizard can
 *     show.
 */
export function mergeProviderEntry(
  existingText: string | undefined,
  id: string,
  entry: ModelsJsonProviderEntry,
): { ok: true; text: string } | { ok: false; error: string } {
  let doc: unknown = {};
  if (existingText !== undefined && existingText.trim() !== "") {
    try {
      doc = JSON.parse(existingText);
    } catch (err) {
      return {
        ok: false,
        error: `${MODELS_JSON_FILE} is not valid JSON (${(err as Error).message}) — refusing to overwrite it`,
      };
    }
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: `${MODELS_JSON_FILE} is not a JSON object — refusing to overwrite it` };
  }
  const root = doc as Record<string, unknown>;
  const providers = root.providers;
  if (
    providers !== undefined &&
    (providers === null || typeof providers !== "object" || Array.isArray(providers))
  ) {
    return {
      ok: false,
      error: `${MODELS_JSON_FILE} has a non-object "providers" key — refusing to overwrite it`,
    };
  }
  const nextProviders: Record<string, unknown> = {
    ...((providers as Record<string, unknown> | undefined) ?? {}),
    [id]: entry,
  };
  const next = { ...root, providers: nextProviders };
  return { ok: true, text: `${JSON.stringify(next, null, 2)}\n` };
}

/**
 * Remove our provider entry, leaving everything else alone. Returns the text to
 * write, or undefined when there is nothing of ours to remove; an unparseable
 * document is left untouched (same refusal rule as the merge).
 */
export function removeProviderEntry(
  existingText: string | undefined,
  id: string,
): { ok: true; text?: string } | { ok: false; error: string } {
  if (existingText === undefined || existingText.trim() === "") return { ok: true };
  let doc: unknown;
  try {
    doc = JSON.parse(existingText);
  } catch (err) {
    return {
      ok: false,
      error: `${MODELS_JSON_FILE} is not valid JSON (${(err as Error).message}) — refusing to rewrite it`,
    };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: `${MODELS_JSON_FILE} is not a JSON object — refusing to rewrite it` };
  }
  const root = doc as Record<string, unknown>;
  const providers = root.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return { ok: true };
  }
  const map = providers as Record<string, unknown>;
  if (!(id in map)) return { ok: true };
  const nextMap = { ...map };
  delete nextMap[id];
  const next = { ...root, providers: nextMap };
  return { ok: true, text: `${JSON.stringify(next, null, 2)}\n` };
}

/** `models.json` inside an agent dir. */
export function modelsJsonPath(agentDir: string): string {
  return join(agentDir, MODELS_JSON_FILE);
}

/**
 * In-process serialisation of writers, keyed by path — the same guard
 * `piAuthStore` uses, for the same reason: read → merge → rename is only safe
 * if two writers in this process never interleave. A turn's spawn-time refresh
 * and a wizard's write can otherwise cross and drop one of the two.
 */
const writeChains = new Map<string, Promise<void>>();

async function serialized<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(path) ?? Promise.resolve();
  let result!: T;
  const next = prev.then(async () => {
    result = await fn();
  });
  writeChains.set(path, next.catch(() => {}));
  await next;
  return result;
}

async function readText(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Write `text` atomically (temp + rename) into `dir`, 0600. */
async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export type CustomProviderWriteResult =
  | { ok: true; path: string; changed: boolean }
  | { ok: false; error: string };

/**
 * Persist (or refresh) a custom provider entry in `agentDir/models.json`.
 *
 * Idempotent: an entry that already matches is left byte-identical and reported
 * as `changed: false`, so the per-turn spawn check costs one read and no write.
 */
export async function writeCustomProviderEntry(
  agentDir: string,
  id: string,
  entry: ModelsJsonProviderEntry,
): Promise<CustomProviderWriteResult> {
  const path = modelsJsonPath(agentDir);
  return serialized(path, async () => {
    const existing = await readText(path);
    const merged = mergeProviderEntry(existing, id, entry);
    if (!merged.ok) return merged;
    if (existing !== undefined && existing === merged.text) {
      return { ok: true, path, changed: false };
    }
    try {
      await writeAtomic(path, merged.text);
      return { ok: true, path, changed: true };
    } catch (err) {
      return { ok: false, error: `could not write ${path}: ${(err as Error).message}` };
    }
  });
}

/**
 * Drop our provider entry — the "operator switched to another provider" path.
 * Mirrors the routing rule that a cleared choice must be SPELLED, not implied:
 * a leftover entry keeps the provider visible in `pi --list-models` and keeps
 * its (now stale) models selectable.
 */
export async function clearCustomProviderEntry(
  agentDir: string,
  id: string,
): Promise<CustomProviderWriteResult> {
  const path = modelsJsonPath(agentDir);
  return serialized(path, async () => {
    const existing = await readText(path);
    const removed = removeProviderEntry(existing, id);
    if (!removed.ok) return removed;
    if (removed.text === undefined) return { ok: true, path, changed: false };
    try {
      await writeAtomic(path, removed.text);
      return { ok: true, path, changed: true };
    } catch (err) {
      return { ok: false, error: `could not write ${path}: ${(err as Error).message}` };
    }
  });
}

/**
 * Read `models.json` as-is, for a rollback image (the wizard's brain interview
 * writes provider entries into it, so "put the brain back" has to include it).
 */
export async function snapshotModelsJson(agentDir: string): Promise<string | undefined> {
  return readText(modelsJsonPath(agentDir));
}

/**
 * Put a {@link snapshotModelsJson} image back. `undefined` means the file did not
 * exist before the interview, so the restore REMOVES it rather than leaving the
 * new entries behind as un-owned state.
 */
export async function restoreModelsJson(
  agentDir: string,
  text: string | undefined,
): Promise<{ ok: boolean; error?: string }> {
  const path = modelsJsonPath(agentDir);
  return serialized(path, async () => {
    try {
      if (text === undefined) {
        if (existsSync(path)) await unlink(path);
        return { ok: true };
      }
      await writeAtomic(path, text);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `could not restore ${path}: ${(err as Error).message}` };
    }
  });
}

/**
 * Read back the provider entry as it sits on disk, if any. Used by the harness's
 * spawn-time drift check and by the wizards' "what is configured now" hints.
 */
export async function readCustomProviderEntry(
  agentDir: string,
  id: string,
): Promise<ModelsJsonProviderEntry | undefined> {
  const text = await readText(modelsJsonPath(agentDir));
  if (text === undefined || text.trim() === "") return undefined;
  try {
    const doc = JSON.parse(text) as Record<string, unknown>;
    const providers = doc.providers as Record<string, unknown> | undefined;
    const entry = providers?.[id];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    return entry as ModelsJsonProviderEntry;
  } catch {
    return undefined;
  }
}

/**
 * Does the on-disk entry still say what the config says? Compares the endpoint
 * and that every configured model is present — a provider that moved ports, or
 * a model the operator picked after the entry was written, both need a rewrite.
 */
export function entryMatches(
  entry: ModelsJsonProviderEntry | undefined,
  want: ModelsJsonProviderEntry,
): boolean {
  if (!entry) return false;
  if (entry.baseUrl !== want.baseUrl) return false;
  if (entry.api !== want.api) return false;
  if (entry.apiKey !== want.apiKey) return false;
  const have = new Set((entry.models ?? []).map((m) => m.id));
  return want.models.every((m) => have.has(m.id));
}

/**
 * Make the on-disk entry agree with a desired state, writing only when it has
 * drifted. ONE definition for the two callers that must not diverge:
 *
 *   - the wizard, which knows the models the operator just picked and passes
 *     them as `models`;
 *   - the harness, at spawn, which passes no models and therefore keeps
 *     whatever the entry already lists (a turn must never shrink the list under
 *     the operator — it is there to refresh the ENDPOINT and the key
 *     availability).
 *
 * Models are UNIONED, never replaced: the provider's defaults come first (so
 * `phantomops/auto` is always resolvable), then what the entry already had, then
 * the caller's additions. Dropping a model the operator can still select in
 * `pi --list-models` is how a turn fails at the one moment nobody is watching.
 */
export async function ensureCustomProviderEntry(
  agentDir: string,
  id: string,
  opts: { baseUrl: string; models?: readonly string[]; keyAvailable?: boolean },
): Promise<CustomProviderWriteResult> {
  const existing = await readCustomProviderEntry(agentDir, id);
  const models = [
    ...(existing?.models ?? []).map((m) => m.id),
    ...(opts.models ?? []),
  ];
  const want = buildProviderEntry({
    id,
    baseUrl: opts.baseUrl,
    models,
    keyAvailable: opts.keyAvailable,
  });
  if (entryMatches(existing, want)) {
    return { ok: true, path: modelsJsonPath(agentDir), changed: false };
  }
  return writeCustomProviderEntry(agentDir, id, want);
}
