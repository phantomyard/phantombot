/**
 * Dependency-free constants for the pbot_* tools (#820). Kept apart from the
 * catalog so harnesses and the embedded-pi bootstrap can name them without
 * importing every CLI action module.
 */

/** Set to "1" by a harness on a spawn that hosts the pbot_* tools. Runtime-owned. */
export const ENV_PBOT_TOOLS = "PHANTOMBOT_PBOT_TOOLS";

/** The discovery tool every harness starts with. */
export const PBOT_TOOLS_NAME = "pbot_tools";
