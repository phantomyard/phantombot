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
  createPersonaIdentityIfAbsent,
  readPersonaIdentityNsec,
} from "../lib/personaIdentity.ts";
import { fetchCanonicalRelays } from "../channels/phantomchat/relaysSource.ts";
import { defaultServiceControl, type ServiceControl } from "../lib/platform.ts";
import type { WriteSink } from "../lib/io.ts";
import { maybePromptRestart } from "./harness.ts";

/**
 * Where users install the PhantomChat app / PWA. Surfaced in the onboarding
 * wizard so operators can hand the link to whoever will DM the persona.
 */
const PHANTOMCHAT_APP_URL = "https://chat.phantomyard.ai";

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

/**
 * The persona's Nostr identity, minting one only if it genuinely has none.
 *
 * Adoption order is load-bearing and belongs in ONE place: identity.json also
 * derives the persona's VAULT key, so generating a second nsec would orphan
 * every secret already encrypted under the first. Order: phantomchat.json →
 * identity.json → mint (atomic create-if-absent, so a vault minting one
 * concurrently wins and we adopt it).
 *
 * `minted` says whether this call created the key — the CLI prints the
 * back-it-up warning on that, and the TUI shows it in its notice.
 */
export async function ensurePhantomchatIdentity(
  agentDir: string,
  generate: () => { nsec: string; npub: string } = generateIdentity,
  load: typeof loadPhantomchatPersonaConfig = loadPhantomchatPersonaConfig,
): Promise<{ nsec: string; npub: string; minted: boolean }> {
  const existing = load(agentDir);
  if (existing) {
    return {
      nsec: existing.identity.nsec,
      npub: existing.identity.npub,
      minted: false,
    };
  }
  const adopted = readPersonaIdentityNsec(agentDir);
  if (adopted) {
    const identity = identityFromNsec(adopted);
    return { nsec: identity.nsec, npub: identity.npub, minted: false };
  }
  const persistedNsec = await createPersonaIdentityIfAbsent(
    agentDir,
    generate().nsec,
  );
  const persisted = identityFromNsec(persistedNsec);
  return { nsec: persisted.nsec, npub: persisted.npub, minted: true };
}

/**
 * Write the persona's phantomchat block. Shared by the CLI flow and the TUI so
 * the two cannot write different files for the same answers.
 *
 * Relays are never asked for: canonical list → whatever was cached → the PWA
 * seed. `greeted` is preserved so editing the allowlist does not re-greet
 * contacts already onboarded. An empty allowlist arms trust-on-first-use.
 */
export async function savePhantomchatAllowlist(input: {
  agentDir: string;
  nsec: string;
  allowedNpubs: string[];
  save?: typeof savePhantomchatPersonaConfig;
  load?: typeof loadPhantomchatPersonaConfig;
}): Promise<{ path: string; relays: number; tofu: boolean }> {
  const existing = (input.load ?? loadPhantomchatPersonaConfig)(input.agentDir);
  const relays =
    (await fetchCanonicalRelays()) ??
    existing?.relays ??
    [...DEFAULT_PHANTOMCHAT_RELAYS];
  const save = input.save ?? savePhantomchatPersonaConfig;
  const path = await save(input.agentDir, {
    nsec: input.nsec,
    relays,
    allowedNpubs: input.allowedNpubs,
    tofu: input.allowedNpubs.length === 0,
    greeted: existing?.greeted,
  });
  return { path, relays: relays.length, tofu: input.allowedNpubs.length === 0 };
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
  //    The adoption order lives in ensurePhantomchatIdentity so the TUI's
  //    Channels screen cannot mint a second nsec where this flow reuses one.
  const existing = loadPersonaConfig(agentDir);
  const { nsec, npub, minted } = await ensurePhantomchatIdentity(
    agentDir,
    generate,
    loadPersonaConfig,
  );
  if (!minted) {
    p.note(
      `Persona '${persona}' already has a Nostr identity. Reusing it.\n\n` +
        `Its npub (paste this into the PhantomChat app to DM '${persona}'):\n\n` +
        `  ${npub}`,
      "Existing identity",
    );
  } else {
    p.note(
      `Generated a new Nostr keypair for '${persona}'. The secret (nsec) will be\n` +
        `saved to <persona-dir>/identity.json (mode 0600). Back it up — this\n` +
        `nsec now also derives the persona's VAULT encryption key, so losing it\n` +
        `means a new identity (re-add the new npub in the app) AND the existing\n` +
        `vault ciphertext can no longer be decrypted. This is a reconfigure, not\n` +
        `a catastrophe: if you lose it, mint a fresh identity, re-add your secrets\n` +
        `with 'phantombot vault set', and re-pair PhantomChat with the new npub.\n\n` +
        `  nsec (one-time display): ${nsec}\n\n` +
        `Its npub (paste this into the PhantomChat app to DM '${persona}'):\n\n` +
        `  ${npub}`,
      "New identity created",
    );
  }

  // 2. Relays are NOT prompted any more — they come from the canonical
  //    /relays.json, resolved inside savePhantomchatAllowlist below.

  // 3. Tell the operator how to get PhantomChat on their own device and where
  //    to find THEIR npub, so the allowlist prompt below has a sensible value to
  //    paste. Without this the wizard silently assumed the app was already set
  //    up and the user knew what an npub was (issue #333).
  p.note(
    `To message '${persona}' you need the PhantomChat app on your device.\n\n` +
      `1. Get PhantomChat: ${PHANTOMCHAT_APP_URL}\n` +
      `   (open in a browser, or install the PWA / mobile app from there)\n` +
      `2. Create your identity in the app, then copy YOUR npub\n` +
      `   (Settings → Profile → "Copy npub"). It starts with 'npub1…'.\n` +
      `3. Paste your npub at the prompt below so '${persona}' can reach you.`,
    "Set up PhantomChat on your device",
  );

  // 4. Allowlist (prefill from the existing file). The bot REACHES OUT to these
  //    npubs — on start it sends each one a friendly "Hello" (in the persona's
  //    voice) that lands in their PhantomChat app as a contact request to
  //    approve. No need to DM the bot first. Empty means TRUST-ON-FIRST-USE
  //    (TOFU): the first npub to DM the bot is trusted, added here, and the bot
  //    locks to it — much safer than the old "answer anyone".
  const currentAllowed = existing?.allowedNpubs.join(", ") ?? "";
  const allowedRaw = await p.text({
    message:
      "Paste YOUR npub from the PhantomChat app (comma-separate several; the bot greets each one. Empty = the first npub to DM the bot is trusted and added)",
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

  const saved = await savePhantomchatAllowlist({
    agentDir,
    nsec,
    allowedNpubs,
    save: savePersonaConfig,
    load: loadPersonaConfig,
  });
  const savedPath = saved.path;
  p.note(
    `persona: ${persona}\n` +
      `npub: ${npub}\n` +
      `relays: ${saved.relays}\n` +
      `allowed npubs: ${
        allowedNpubs.length === 0
          ? "(TOFU — first DM trusted)"
          : allowedNpubs.join(", ")
      }\n` +
      `saved to ${savedPath}`,
    "Saved",
  );

  // Final step: hand the user the persona's npub to add as a contact in their
  // app, closing the loop (issue #333). The bot also greets allow-listed npubs
  // on start, but adding the contact manually works immediately and regardless.
  p.note(
    `Copy ${persona}'s npub and add it as a contact in PhantomChat:\n\n` +
      `  ${npub}\n\n` +
      `In the app: Contacts → Add → paste the npub above → save. You can then\n` +
      `start a DM with '${persona}'. (If your npub is on the allowlist, the bot\n` +
      `also sends you a "Hello" on its next start — approve it to connect.)`,
    "Add this persona as a contact",
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
