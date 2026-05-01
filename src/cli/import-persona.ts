import { defineCommand } from "citty";

export default defineCommand({
  meta: {
    name: "import-persona",
    description:
      "Import a persona from an OpenClaw agent directory. Copies BOOT.md / SOUL.md / IDENTITY.md / MEMORY.md / tools.md / AGENTS.md and any other markdown files into the phantombot personas dir.",
  },
  args: {
    path: {
      type: "positional",
      description: "Path to the OpenClaw agent directory to import.",
      required: true,
    },
    as: {
      type: "string",
      description:
        "Target persona name (defaults to the basename of the source directory).",
    },
    overwrite: {
      type: "boolean",
      description: "Replace any existing persona with the same name.",
      default: false,
    },
  },
  async run() {
    console.error("import-persona: not yet implemented (phase 7)");
    process.exitCode = 1;
  },
});
