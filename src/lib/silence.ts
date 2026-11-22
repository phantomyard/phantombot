/**
 * The explicit "nothing to say" token, shared by every wake-but-silent path:
 * emoji reactions and PhantomChat phantom handoffs (invariant 90).
 *
 * The prompts ask for exactly `SILENT`, but models decorate it: a trailing
 * full stop, brackets, quotes, markdown emphasis, lower case. All of those are
 * the token. Anything with another word in it is prose and is delivered.
 * Empty text is NOT the token: an empty phantom reply is a failure to recover.
 */
const SILENCE_TOKEN = /^[[("'`*_]*silent[.!\])"'`*_]*$/i;

export function isSilenceToken(text: string): boolean {
  return SILENCE_TOKEN.test(text.trim());
}
