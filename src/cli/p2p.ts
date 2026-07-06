/**
 * `phantombot p2p` — inspect the relay-free P2P transport (phantombot#258).
 *
 * The node itself runs inside `phantombot run`; this command is a read-only
 * window on it. `p2p status` prints the resolved config and probes the loopback
 * bridge port to report whether a node is actually listening on this machine.
 */

import { defineCommand } from "citty";

import { DEFAULT_P2P, loadConfig } from "../config.ts";

/** Probe whether something is accepting ws connections on the loopback port. */
async function bridgeListening(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      done(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      done(false);
    }, timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      done(true);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

const statusCmd = defineCommand({
  meta: {
    name: "status",
    description: "Show P2P transport config and whether a local node is listening.",
  },
  async run() {
    const config = await loadConfig();
    const p2p = config.p2p ?? DEFAULT_P2P;

    console.log("P2P transport (phantombot#258)");
    console.log(`  enabled:  ${p2p.enabled ? "yes" : "no (relay-only)"}`);
    console.log(`  port:     ${p2p.port} (ws://127.0.0.1:${p2p.port}, loopback only)`);
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

    const listening = await bridgeListening(p2p.port);
    console.log(`\n  bridge:   ${listening ? "listening ✓" : "not listening ✗"}`);
    if (!listening) {
      console.log(
        "  A node is not currently bound to the port. Is `phantombot run` " +
          "(or the service) up on this machine?",
      );
    }
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
