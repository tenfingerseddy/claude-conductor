// Spike S1: does an Agent SDK query() run on a subscription login with
// ANTHROPIC_API_KEY unset, and does CLAUDE_CONFIG_DIR pick the account?
// Throwaway. Prints env facts, then one tiny query, then result metadata.
import { query } from "@anthropic-ai/claude-agent-sdk";

const keyState =
  "ANTHROPIC_API_KEY" in process.env
    ? `PRESENT (len ${String(process.env.ANTHROPIC_API_KEY).length})`
    : "UNSET (not in process.env)";

console.log("ANTHROPIC_API_KEY:", keyState);
console.log("ANTHROPIC_AUTH_TOKEN:", "ANTHROPIC_AUTH_TOKEN" in process.env ? "PRESENT" : "UNSET");
console.log("ANTHROPIC_BASE_URL:", process.env.ANTHROPIC_BASE_URL ?? "(unset)");
console.log("CLAUDE_CONFIG_DIR:", process.env.CLAUDE_CONFIG_DIR ?? "(unset)");
console.log("---");

const run = query({
  prompt: "Reply with exactly the word: pong. Nothing else.",
  options: {
    model: "haiku",
    maxTurns: 1,
    permissionMode: "bypassPermissions",
    allowedTools: [],
    // No apiKey passed. No auth of any kind supplied by this script.
  },
});

for await (const msg of run) {
  if (msg.type === "system" && msg.subtype === "init") {
    console.log("[init] model:", msg.model, "| cwd:", msg.cwd);
    console.log("[init] apiKeySource:", msg.apiKeySource ?? "(field absent)");
  } else if (msg.type === "auth_status") {
    console.log("[auth_status]", JSON.stringify(msg));
  } else if (msg.type === "assistant") {
    const text = msg.message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    console.log("[assistant]", JSON.stringify(text));
  } else if (msg.type === "result") {
    console.log("[result] subtype:", msg.subtype, "| is_error:", msg.is_error);
    console.log("[result] text:", JSON.stringify(msg.result ?? null));
    console.log("[result] total_cost_usd:", msg.total_cost_usd);
    console.log("[result] usage:", JSON.stringify(msg.usage));
    console.log("[result] modelUsage:", JSON.stringify(msg.modelUsage));
  }
}
