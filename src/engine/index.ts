/**
 * Public entry point of the embeddable phantombot engine.
 *
 *   import { createEngine } from "phantombot/engine";
 *
 * Everything exported here is the supported surface. Anything imported from
 * deeper paths is internal and may change in any release.
 */

export { createEngine, Engine, Persona } from "./engine.ts";
export { EngineError, isEngineError, type EngineErrorCode } from "./errors.ts";
export type * from "./types.ts";
