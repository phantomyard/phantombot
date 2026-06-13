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
} from "../lib/nostrIdentity.ts";
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

  const persona = input.persona ?? config.defaultPersona;
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
    const identity = generate();
    nsec = identity.nsec;
    npub = identity.npub;
    p.note(
      `Generated a new Nostr keypair for '${persona}'. The secret (nsec) will be\n` +
        `saved to <persona-dir>/phantomchat.json (mode 0600). Back it up — losing\n` +
        `it means a new identity (and re-adding the new npub in the app).\n\n` +
        `  nsec (one-time display): ${identity.nsec}\n\n` +
        `Its npub (paste this into the PhantomChat app to DM '${persona}'):\n\n` +
        `  ${npub}`,
      "New identity created",
    );
  }

  // 2. Relays (prefill from the existing file, else the PWA defaults).
  const currentRelays =
    existing?.relays.join(", ") ?? [...DEFAULT_PHANTOMCHAT_RELAYS].join(", ");
  const relaysRaw = await p.text({
    message:
      "Relays (comma-separated wss:// URLs; empty = keep the 5 default PWA relays)",
    placeholder: [...DEFAULT_PHANTOMCHAT_RELAYS].join(", "),
    defaultValue: currentRelays,
  });
  if (p.isCancel(relaysRaw)) {
    p.cancel("cancelled");
    return 1;
  }
  const parsedRelays = parseRelays(relaysRaw as string);
  const relays =
    parsedRelays.length > 0 ? parsedRelays : [...DEFAULT_PHANTOMCHAT_RELAYS];

  // 3. Allowlist (prefill from the existing file).
  const currentAllowed = existing?.allowedNpubs.join(", ") ?? "";
  const allowedRaw = await p.text({
    message:
      "Allowed npubs (comma-separated; empty = anyone can DM the bot, with a warning)",
    placeholder: "npub1…",
    defaultValue: currentAllowed,
  });
  if (p.isCancel(allowedRaw)) {
    p.cancel("cancelled");
    return 1;
  }
  const allowedNpubs = parseAllowedNpubs(allowedRaw as string);
  if (allowedNpubs.length === 0) {
    const proceed = await p.confirm({
      message:
        "No allowlist set — anyone who DMs the bot will be answered. Proceed?",
      initialValue: false,
    });
    if (p.isCancel(proceed) || !proceed) {
      p.cancel("cancelled");
      return 1;
    }
  }

  const savedPath = await savePersonaConfig(agentDir, {
    nsec,
    relays,
    allowedNpubs,
  });
  p.note(
    `persona: ${persona}\n` +
      `npub: ${npub}\n` +
      `relays: ${relays.length}\n` +
      `allowed npubs: ${
        allowedNpubs.length === 0 ? "(any)" : allowedNpubs.join(", ")
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
