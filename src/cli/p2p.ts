/**
 * `phantombot p2p` — inspect the P2P WebRTC transport (phantombot#258, #61).
 *
 * The node itself runs inside `phantombot run`; this command is a read-only
 * window on it. `p2p status` prints the resolved config. There is no loopback
 * bridge to probe (retired in #61) — live peer/connection state surfaces in the
 * `phantombot run` logs (`[p2p] peer …`).
 */

import { defineCommand } from "citty";

import { DEFAULT_P2P, loadConfig } from "../config.ts";

const statusCmd = defineCommand({
  meta: {
    name: "status",
    description: "Show P2P transport config and whether a local node is listening.",
  },
  async run() {
    const config = await loadConfig();
    const p2p = config.p2p ?? DEFAULT_P2P;

    console.log("P2P WebRTC transport (phantombot#258, #61)");
    console.log(`  enabled:  ${p2p.enabled ? "yes" : "no (relay-only)"}`);
    console.log(
      `  STUN:     ${p2p.stunServers.length ? p2p.stunServers.join(", ") : "none (host candidates only)"}`,
    );

    if (!p2p.enabled) {
      console.log(
        "\nP2P is disabled. Enable it with `p2p.enabled = true` in config.toml " +
          "(or PHANTOMBOT_P2P_ENABLED=1), then restart the service.",
      );
      process.exitCode = 0;
      return;
    }

    console.log(
      "\n  Peers connect on demand over WebRTC (STUN-traversed) with a Nostr " +
        "relay fallback. Live peer state appears in the `phantombot run` logs " +
        "(`[p2p] peer …`).",
    );
    process.exitCode = 0;
  },
});

export default defineCommand({
  meta: {
    name: "p2p",
    description: "Relay-free P2P transport node (phantombot#258).",
  },
  subCommands: {
    status: statusCmd,
  },
});
