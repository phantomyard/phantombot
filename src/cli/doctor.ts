import { defineCommand } from "citty";

export default defineCommand({
  meta: {
    name: "doctor",
    description:
      "Check that configured harness binaries (claude, pi) are on PATH and authenticated.",
  },
  async run() {
    console.error("doctor: not yet implemented (phase 8)");
    process.exitCode = 1;
  },
});
