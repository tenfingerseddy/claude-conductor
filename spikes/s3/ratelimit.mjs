// Spike S3 follow-up: characterize rate_limit_event.
// How often does it fire, what fields does it carry, does it cover seven_day?
// Also probes the experimental get_usage control method, which the SDK typings
// say returns the structured /usage data. Throwaway.
import { query } from "@anthropic-ai/claude-agent-sdk";

const TURNS = [
  "Reply with exactly: one",
  "Reply with exactly: two",
  "Reply with exactly: three",
];

let turnIndex = 0;
let releaseNext;
const nextGate = () => new Promise((r) => (releaseNext = r));
let gate = nextGate();

async function* prompts() {
  for (const text of TURNS) {
    yield {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "s3rl",
    };
    turnIndex += 1;
    await gate;
    gate = nextGate();
  }
}

const events = [];

const q = query({
  prompt: prompts(),
  options: {
    model: "haiku",
    permissionMode: "bypassPermissions",
    allowedTools: [],
    settingSources: [],
    maxTurns: 20,
  },
});

let usageProbed = false;

try {
  for await (const msg of q) {
    if (msg.type === "rate_limit_event") {
      events.push({ afterTurn: turnIndex, msg });
      console.log(
        `[rate_limit_event #${events.length}] (during turn ${turnIndex}) RAW:`,
        JSON.stringify(msg),
      );
    } else if (msg.type === "system" && msg.subtype === "init") {
      console.log("[init] session_id:", msg.session_id, "| model:", msg.model);
    } else if (msg.type === "assistant") {
      const t = (msg.message?.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (t.trim()) console.log("[assistant]", JSON.stringify(t));
    } else if (msg.type === "result") {
      console.log(`[result turn ${turnIndex}] subtype:`, msg.subtype);

      if (!usageProbed) {
        usageProbed = true;
        const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
        console.log("[usage-probe] method present:", typeof fn === "function");
        if (typeof fn === "function") {
          try {
            const u = await fn.call(q);
            console.log("[usage-probe] subscription_type:", u.subscription_type);
            console.log("[usage-probe] rate_limits_available:", u.rate_limits_available);
            console.log("[usage-probe] rate_limits RAW:", JSON.stringify(u.rate_limits));
            console.log("[usage-probe] top-level keys:", Object.keys(u).join(", "));
          } catch (e) {
            console.log("[usage-probe] FAILED:", e?.message ?? e);
          }
        }
      }

      releaseNext?.();
      if (turnIndex >= TURNS.length) break;
    }
  }
} catch (err) {
  console.error("ITERATION ERROR:", err?.message ?? err);
}

console.log("\n=== SUMMARY ===");
console.log("turns run:", turnIndex);
console.log("rate_limit_event count:", events.length);
console.log(
  "fired during turns:",
  events.map((e) => e.afterTurn).join(", ") || "(none)",
);
const keys = new Set();
for (const e of events) for (const k of Object.keys(e.msg.rate_limit_info)) keys.add(k);
console.log("union of rate_limit_info keys observed:", [...keys].join(", ") || "(none)");
