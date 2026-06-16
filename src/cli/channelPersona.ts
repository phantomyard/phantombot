/**
 * Shared persona picker for channel-config steps (`phantombot phantomchat` /
 * `phantombot telegram`, and the `init` wizard's channel steps).
 *
 * Mirrors `phantombot persona`: the personas on disk are DETECTED and the user
 * chooses which one to bind the channel to. The resolved default persona is
 * pre-selected, and a "None — skip" option is appended so opting OUT of a
 * channel is just another choice in the same list — there is no separate
 * skip/ignore confirm.
 */

import * as p from "@clack/prompts";

import { type Config } from "../config.ts";
import { loadState } from "../state.ts";
import { listExistingPersonas } from "./persona.ts";

const NONE = "__none__";

/**
 * Prompt for the persona to configure a channel for. Returns the chosen persona
 * name, or `null` to skip the channel (the user picked "None", cancelled, or no
 * personas exist yet).
 *
 * @param channelLabel Human label used in the prompt, e.g. "PhantomChat".
 */
export async function pickChannelPersona(
  config: Config,
  channelLabel: string,
): Promise<string | null> {
  const personas = listExistingPersonas(config);
  if (personas.length === 0) return null;

  // The default may have just been (re)set in the persona step, so read it
  // fresh from state rather than trusting the config captured at startup.
  const def = (await loadState()).default_persona ?? config.defaultPersona;
  const initialValue = personas.includes(def) ? def : personas[0];

  const chosen = await p.select<string>({
    message: `Set up ${channelLabel} for which persona?`,
    initialValue,
    options: [
      ...personas.map((n) => ({
        value: n,
        label: n,
        hint: n === def ? "default" : undefined,
      })),
      { value: NONE, label: `None — skip ${channelLabel}` },
    ],
  });

  if (p.isCancel(chosen) || chosen === NONE) return null;
  return chosen;
}
