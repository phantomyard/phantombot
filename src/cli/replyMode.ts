import { defineCommand } from "citty";
import {
  clearReplyModeOverride,
  normalizeReplyModeRequest,
  setReplyModeOverride,
} from "../lib/replyMode.ts";

export default defineCommand({
  meta: {
    name: "reply-mode",
    description: "Set or clear this turn's temporary text/voice reply override",
  },
  args: {
    mode: {
      type: "positional",
      required: true,
      description: "text, voice, or default",
    },
    conversation: {
      type: "string",
      description:
        "Conversation key. Defaults to PHANTOMBOT_CONVERSATION when run by a harness.",
    },
    persona: {
      type: "string",
      description:
        "Persona key. Defaults to PHANTOMBOT_PERSONA when run by a harness.",
    },
  },
  async run({ args }) {
    const persona = args.persona || process.env.PHANTOMBOT_PERSONA;
    const conversation =
      args.conversation || process.env.PHANTOMBOT_CONVERSATION;
    if (!persona || !conversation) {
      throw new Error(
        "reply-mode needs --persona/--conversation or PHANTOMBOT_PERSONA/PHANTOMBOT_CONVERSATION",
      );
    }

    const replyMode = normalizeReplyModeRequest(String(args.mode).toLowerCase());
    if (!replyMode) {
      throw new Error("mode must be one of: text, voice, default, disable");
    }
    if (replyMode === "default") {
      await clearReplyModeOverride({ persona, conversation });
      process.stdout.write("reply mode override cleared\n");
      return;
    }
    await setReplyModeOverride({
      persona,
      conversation,
      mode: replyMode,
    });
    process.stdout.write(`reply mode override set to ${replyMode}\n`);
  },
});
