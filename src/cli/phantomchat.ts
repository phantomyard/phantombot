/**
 * `phantombot phantomchat` — interactive TUI to configure the phantomchat
 * (Nostr NIP-17 DM) channel FOR A PERSONA.
 *
 * phantomchat connects phantombot to the SAME Nostr relays as the PhantomChat
 * PWA as just another client (there is no server). Identity is PER-PERSONA and
 * lives inside the persona's own agent directory, next to SOUL.md, in
 * `phantomchat.json` (mode 0600). That keeps a persona folder self-contained
 * and portable — copy it to another PC/VM and its npub travels with it — and
 * lets one machine run many personas, each with its own npub, exactly like
 * Telegram runs one bot token per persona.
 *
 * This command:
 *   1. Targets a persona (default: the resolved default persona; override with
 *      `--persona <name>`).
 *   2. Ensures that persona has a Nostr keypair. If `phantomchat.json` has no
 *      nsec yet, it GENERATES one and writes it (the nsec is shown ONCE for
 *      backup, otherwise only confirmed by name).
 *   3. Prints the persona's npub PROMINENTLY — paste it into the PhantomChat
 *      PWA to start a DM with that persona.
 *   4. Lets the operator set the relay list and the npub allowlist, written to
 *      the SAME `phantomchat.json`.
 */

import { defineCommand } from "citty";
import * as p from "@clack/prompts";

import { pickChannelPersona } from "./channelPersona.ts";

import {
  DEFAULT_PHANTOMCHAT_RELAYS,
  personaDir,
  type Config,
  loadConfig,
} from "../config.ts";
import {
  loadPhantomchatPersonaConfig,
  savePhantomchatPersonaConfig,
} from "../channels/phantomchat/personaStore.ts";
import {
  decodeNpubToHex,
  generateIdentity,
  identityFromNsec,
} from "../lib/nostrIdentity.ts";
import {
  readPersonaIdentityNsec,
  writePersonaIdentity,
} from "../lib/personaIdentity.ts";
import { fetchCanonicalRelays } from "../channels/phantomchat/relaysSource.ts";
import { defaultServiceControl, type ServiceControl } from "../lib/platform.ts";
import type { WriteSink } from "../lib/io.ts";
import { maybePromptRestart } from "./harness.ts";

/**
 * Parse a comma/whitespace-separated list of npubs, keeping only entries that
 * decode to a valid pubkey. Returns the cleaned npub strings (not the hex) so
 * the human-readable form is what lands in phantomchat.json.
 */
export function parseAllowedNpubs(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => {
      try {
        decodeNpubToHex(s);
        return true;
      } catch {
        return false;
      }
    });
}

/** Parse a comma/whitespace-separated relay list, keeping only wss:// URLs. */
export function parseRelays(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => s.startsWith("wss://") || s.startsWith("ws://"));
}

interface RunInput {
  /** Persona to configure. Defaults to the resolved default persona. */
  persona?: string;
  config?: Config;
  serviceControl?: ServiceControl;
  out?: WriteSink;
  /** Override identity generation (for testing). */
  generate?: typeof generateIdentity;
  /** Override the per-persona loader (for testing). */
  loadPersonaConfig?: typeof loadPhantomchatPersonaConfig;
  /** Override the per-persona writer (for testing). */
  savePersonaConfig?: typeof savePhantomchatPersonaConfig;
}

export async function runPhantomchat(input: RunInput = {}): Promise<number> {
  const config = input.config ?? (await loadConfig());
  const svc = input.serviceControl ?? defaultServiceControl();
  const generate = input.generate ?? generateIdentity;
  const loadPersonaConfig =
    input.loadPersonaConfig ?? loadPhantomchatPersonaConfig;
  const savePersonaConfig =
    input.savePersonaConfig ?? savePhantomchatPersonaConfig;

  // Target persona: an explicit `--persona` wins; otherwise pick from the
  // detected personas (default pre-selected, "None" to skip) — same pattern as
  // `phantombot persona`.
  let persona = input.persona;
  if (!persona) {
    const picked = await pickChannelPersona(config, "PhantomChat");
    if (!picked) {
      p.cancel("No persona selected — phantomchat not configured.");
      return 0;
    }
    persona = picked;
  }
  const agentDir = personaDir(config, persona);

  p.intro(`Configure phantomchat (Nostr NIP-17 DMs) for persona '${persona}'`);

  // 1. Ensure a key exists for THIS persona. Existing → reuse; absent → make.
  const existing = loadPersonaConfig(agentDir);
  let nsec: string;
  let npub: string;
  if (existing) {
    nsec = existing.identity.nsec;
    npub = existing.identity.npub;
    p.note(
      `Persona '${persona}' already has a phantomchat identity.\n\n` +
        `Its npub (paste this into the PhantomChat app to DM '${persona}'):\n\n` +
        `  ${npub}`,
      "Existing identity",
    );
  } else {
    // No phantomchat.json yet — but identity.json may already exist (e.g. the
    // vault minted it first). ADOPT an existing identity rather than generating
    // a fresh nsec, which would orphan everything the vault already encrypted
    // under the old key. Only mint when there is genuinely no identity yet.
    const adopted = readPersonaIdentityNsec(agentDir);
    if (adopted) {
      const identity = identityFromNsec(adopted);
      nsec = identity.nsec;
      npub = identity.npub;
      p.note(
        `Persona '${persona}' already has a Nostr identity (identity.json). Reusing it.\n\n` +
          `Its npub (paste this into the PhantomChat app to DM '${persona}'):\n\n` +
          `  ${npub}`,
        "Existing identity",
      );
    } else {
      const identity = generate();
      nsec = identity.nsec;
      npub = identity.npub;
      // The nsec is the persona's SHARED identity (used by the vault too), so it
      // lives in <persona-dir>/identity.json (mode 0600), not phantomchat.json.
      await writePersonaIdentity(agentDir, nsec);
      p.note(
        `Generated a new Nostr keypair for '${persona}'. The secret (nsec) will be\n` +
          `saved to <persona-dir>/identity.json (mode 0600). Back it up — losing\n` +
          `it means a new identity (and re-adding the new npub in the app).\n\n` +
          `  nsec (one-time display): ${identity.nsec}\n\n` +
          `Its npub (paste this into the PhantomChat app to DM '${persona}'):\n\n` +
          `  ${npub}`,
        "New identity created",
      );
    }
  }

  // 2. Relays are NOT prompted any more — they come from the canonical
  //    /relays.json (single source of truth shared with the PWA). We warm the
  //    cache here best-effort; startup re-fetches and re-caches on every run.
  //    Fallback chain: canonical fetch → existing cached relays → PWA seed.
  const relays =
    (await fetchCanonicalRelays()) ??
    existing?.relays ??
    [...DEFAULT_PHANTOMCHAT_RELAYS];

  // 3. Allowlist (prefill from the existing file). The bot REACHES OUT to these
  //    npubs — on start it sends each one a friendly "Hello" (in the persona's
  //    voice) that lands in their PhantomChat app as a contact request to
  //    approve. No need to DM the bot first. Empty means TRUST-ON-FIRST-USE
  //    (TOFU): the first npub to DM the bot is trusted, added here, and the bot
  //    locks to it — much safer than the old "answer anyone".
  const currentAllowed = existing?.allowedNpubs.join(", ") ?? "";
  const allowedRaw = await p.text({
    message:
      "Allowed npubs (comma-separated; the bot greets each one. Empty = the first npub to DM the bot is trusted and added)",
    placeholder: "npub1…",
    defaultValue: currentAllowed,
  });
  if (p.isCancel(allowedRaw)) {
    p.cancel("cancelled");
    return 1;
  }
  const allowedNpubs = parseAllowedNpubs(allowedRaw as string);
  // Empty allowlist arms TOFU; a set allowlist clears it. The FIRST npub on a
  // set list is the incident-notification target (surfaced in the note below).
  const tofu = allowedNpubs.length === 0;
  if (tofu) {
    p.note(
      "No allowlist set — trust-on-first-use is ON. The FIRST npub that DMs\n" +
        "this persona will be trusted, added to the allowlist, and the bot then\n" +
        "locks to it. Re-run this command to set the allowlist explicitly.",
      "Trust-on-first-use",
    );
  } else {
    p.note(
      `On its next start the bot sends a "Hello" to each of these npubs —\n` +
        `that DM shows up in their PhantomChat app as a contact request to\n` +
        `approve. Already-greeted npubs are remembered and not re-greeted.\n\n` +
        `The FIRST npub on the allowlist is also the incident-notification\n` +
        `target — where held-request / security alerts for '${persona}' are\n` +
        `sent. Re-run this command to change the order or the list.`,
      "Bot greets these · incident target",
    );
  }

  const savedPath = await savePersonaConfig(agentDir, {
    nsec,
    relays,
    allowedNpubs,
    tofu,
    // Preserve the greeted markers across edits so adding/removing an npub
    // doesn't re-trigger greetings for contacts already onboarded.
    greeted: existing?.greeted,
  });
  p.note(
    `persona: ${persona}\n` +
      `npub: ${npub}\n` +
      `relays: ${relays.length}\n` +
      `allowed npubs: ${
        allowedNpubs.length === 0
          ? "(TOFU — first DM trusted)"
          : allowedNpubs.join(", ")
      }\n` +
      `saved to ${savedPath}`,
    "Saved",
  );

  await maybePromptRestart(svc);

  p.outro("done");
  return 0;
}

export default defineCommand({
  meta: {
    name: "phantomchat",
    description:
      "Configure the phantomchat channel (Nostr NIP-17 DMs) for a persona. Generates a per-persona keypair on first run, prints the npub to share, and sets relays + allowed npubs (stored in the persona dir's phantomchat.json).",
  },
  args: {
    persona: {
      type: "string",
      description:
        "Persona to configure. Defaults to the resolved default persona.",
    },
  },
  async run({ args }) {
    const code = await runPhantomchat({
      persona: args.persona ? String(args.persona) : undefined,
    });
    process.exitCode = code;
  },
});
