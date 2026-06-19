/**
 * Communication skills for mc-agent-service.
 * Handles chat message sending.
 */
import { z } from "zod";
import type { Bot } from "mineflayer";
import type { SkillDefinition, SkillExecutionContext } from "../bots/skill-executor.js";
import type { SkillResult } from "../types/skills.js";

// ─── chat.send ──────────────────────────────────────────────────────────────

const ChatSendSchema = z.object({
  message: z.string().min(1).max(256),
}).strict();

export const chatSend: SkillDefinition<z.infer<typeof ChatSendSchema>> = {
  name: "chat.send",
  description: "Send a Minecraft chat message.",
  category: "communication",
  permissions: ["chat"],
  timeoutMs: 5000,
  busyPolicy: "queue",
  readOnly: false,
  parameters: ChatSendSchema,
  async run(ctx, params) {
    const bot = ctx.bot;
    const { message } = params;

    try {
      bot.chat(message);
      ctx.log(`Sent: ${message}`);

      return {
        ok: true,
        status: "success",
        data: { sent: true, message },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: "failed",
        error: { code: "MINEFLAYER_ERROR", message: `Failed to send chat: ${msg}`, retryable: true },
      };
    }
  },
};

// ─── Export all communication skills ────────────────────────────────────────

export const communicationSkills = [
  chatSend,
];
