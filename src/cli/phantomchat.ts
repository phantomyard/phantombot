/**
 * `phantombot phantomchat` — interactive TUI to configure the phantomchat
 * (Nostr NIP-17 DM) channel.
 *
 * phantomchat connects phantombot to the SAME Nostr relays as the PhantomChat
 * PWA as just another client (there is no server). This command:
 *
 *   1. Ensures the bot has a Nostr keypair. If `PHANTOMCHAT_NSEC` isn't set in
 *      ~/.env, it GENERATES one and saves the nsec there (atomic, mode 0o600,
 *      via the same `phantombot env set` path Telegram tokens never touch —
 *      the nsec is a SECRET and stays out of config.toml). The value is shown
 *      ONCE for backup and otherwise only confirmed by name.
 *   2. Prints the bot's npub PROMINENTLY — this is what Andrew pastes into the
 *      PhantomChat PWA to start a DM with phantombot.
 *   3. Lets the operator set the relay list and the npub allowlist into the
 *      `[channels.phantomchat]` block of config.toml (the non-secret knobs).
 *
 * Mirrors src/cli/telegram.ts: same clack style, same config-writer helper,
 * same restart prompt.
 */

import { defineCommand } from "citty";
import * as p from "@clack/prompts";

import {
  DEFAULT_PHANTOMCHAT_RELAYS,
  type Config,
  loadConfig,
} from "../config.ts";
import { setIn, updateConfigToml } from "../lib/configWriter.ts";
import {
  decodeNpubToHex,
  generateIdentity,
  loadIdentityFromEnv,
} from "../lib/nostrIdentity.ts";
import { defaultServiceControl, type ServiceControl } from "../lib/platform.ts";
import type { WriteSink } from "../lib/io.ts";
import { maybePromptRestart } from "./harness.ts";
import { runEnvSet } from "./env.ts";

export interface PhantomchatTuiInputs {
  relays: string[];
  allowedNpubs: string[];
}

/**
 * Write the relay list + allowlist to the `[channels.phantomchat]` block,
 * preserving other config sections. The nsec is NOT written here — it lives in
 * ~/.env. Pure side effect.
 */
export async function applyPhantomchatConfig(
  configPath: string,
  inputs: PhantomchatTuiInputs,
): Promise<void> {
  await updateConfigToml(configPath, (toml) => {
    setIn(toml, ["channels", "phantomchat", "relays"], inputs.relays);
    setIn(
      toml,
      ["channels", "phantomchat", "allowed_npubs"],
      inputs.allowedNpubs,
    );
  });
}

/**
 * Parse a comma/whitespace-separated list of npubs, keeping only entries that
 * decode to a valid pubkey. Returns the cleaned npub strings (not the hex) so
 * the human-readable form is what lands in config.toml.
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
  config?: Config;
  serviceControl?: ServiceControl;
  out?: WriteSink;
  /** Override identity generation (for testing). */
  generate?: typeof generateIdentity;
  /** Override env load (for testing). */
  loadIdentity?: typeof loadIdentityFromEnv;
  /** Override the ~/.env writer (for testing). */
  saveNsec?: (nsec: string) => Promise<void>;
}

export async function runPhantomchat(input: RunInput = {}): Promise<number> {
  const config = input.config ?? (await loadConfig());
  const svc = input.serviceControl ?? defaultServiceControl();
  const generate = input.generate ?? generateIdentity;
  const loadIdentity = input.loadIdentity ?? loadIdentityFromEnv;
  const saveNsec =
    input.saveNsec ??
    (async (nsec: string) => {
      await runEnvSet({ name: "PHANTOMCHAT_NSEC", value: nsec });
    });

  p.intro("Configure the phantomchat channel (Nostr NIP-17 DMs)");

  // 1. Ensure a key exists. Existing → print npub; absent → generate + save.
  let npub: string;
  const existing = loadIdentity();
  if (existing) {
    npub = existing.npub;
    p.note(
      `phantombot already has a phantomchat identity.\n\n` +
        `Your npub (paste this into the PhantomChat app to DM phantombot):\n\n` +
        `  ${npub}`,
      "Existing identity",
    );
  } else {
    const identity = generate();
    npub = identity.npub;
    await saveNsec(identity.nsec);
    p.note(
      `Generated a new Nostr keypair and saved the secret (nsec) to ~/.env\n` +
        `as PHANTOMCHAT_NSEC (mode 0600). Back it up somewhere safe — losing\n` +
        `it means a new identity (and Andrew re-adding the new npub in the app).\n\n` +
        `  nsec (one-time display): ${identity.nsec}\n\n` +
        `Your npub (paste this into the PhantomChat app to DM phantombot):\n\n` +
        `  ${npub}`,
      "New identity created",
    );
  }

  // 2. Relays.
  const currentRelays =
    config.channels.phantomchat?.relays?.join(", ") ??
    [...DEFAULT_PHANTOMCHAT_RELAYS].join(", ");
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

  // 3. Allowlist.
  const currentAllowed =
    config.channels.phantomchat?.allowedNpubs?.join(", ") ?? "";
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

  await applyPhantomchatConfig(config.configPath, { relays, allowedNpubs });
  p.note(
    `npub: ${npub}\n` +
      `relays: ${relays.length}\n` +
      `allowed npubs: ${
        allowedNpubs.length === 0 ? "(any)" : allowedNpubs.join(", ")
      }\n` +
      `saved to ${config.configPath}`,
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
      "Configure the phantomchat channel (Nostr NIP-17 DMs). Generates a keypair on first run, prints the npub to share, and sets relays + allowed npubs.",
  },
  async run() {
    const code = await runPhantomchat();
    process.exitCode = code;
  },
});
