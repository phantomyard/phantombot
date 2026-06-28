/**
 * Manifest invariants — the load-bearing contract between package.json and the
 * runtime participant id. These guard the exact regression that produced
 * `No activated agent with id "phantombot"`:
 *
 *  - With `canDelegate: true`, VS Code registers a delegate agent whose id is
 *    the chatSession `type` and routes requests to it via `agentIdSilent`. The
 *    agent stays implementation-less until an extension creates a participant
 *    with the SAME id. So PARTICIPANT_ID in extension.ts MUST equal the type.
 *  - A manifest-declared `chatParticipants` entry eagerly calls registerAgent(id)
 *    which THROWS on a duplicate id, so no declared participant may collide with
 *    the session type. We attach the implementation dynamically instead.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
const extensionSrc = readFileSync(`${root}/src/extension.ts`, "utf8");

describe("manifest / participant invariants", () => {
  const sessions = pkg.contributes?.chatSessions ?? [];

  test("declares exactly one phantombot chat session with canDelegate", () => {
    expect(sessions).toHaveLength(1);
    expect(sessions[0].type).toBe("phantombot");
    // canDelegate is what registers the per-type open commands (button +
    // sticky) — and what makes the participant-id contract load-bearing.
    expect(sessions[0].canDelegate).toBe(true);
  });

  test("declares supportsAutoModel to clear the entitlement 'Upgrade' gate", () => {
    // VS Code 1.126+ greys out canDelegate session types behind an "Upgrade"
    // gate for Copilot Free/Edu plans. The picker gate fn (WLo in the bundle)
    // returns "not locked" when supportsAutoModelForSessionType(type) is true,
    // which reads this contribution flag. We route to phantombot's own backend
    // and ignore VS Code's model picker, so "auto model" is honest for us — and
    // it clears the gate WITHOUT touching canDelegate (button + sticky survive).
    expect(sessions[0].supportsAutoModel).toBe(true);
  });

  test("PARTICIPANT_ID equals the chat-session type", () => {
    const sessionType = sessions[0].type;
    const m = extensionSrc.match(/const PARTICIPANT_ID = "([^"]+)"/);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe(sessionType);
  });

  test("no manifest chatParticipant collides with the session type", () => {
    const sessionType = sessions[0].type;
    const declared = (pkg.contributes?.chatParticipants ?? []).map(
      (p: { id: string }) => p.id,
    );
    // A declared participant with this id would double-register the agent and
    // throw "Agent already registered" against the canDelegate agent.
    expect(declared).not.toContain(sessionType);
  });
});
