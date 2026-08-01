// Spike S3: does /compact with focus instructions work through the Agent SDK?
// Two questions: is the focus honoured, and is the compact boundary visible to
// the host program? Streaming input mode so the whole thing is ONE session and
// ONE cold start (S1 measured ~26k cache-creation tokens per cold start).
// Throwaway.
import { query } from "@anthropic-ai/claude-agent-sdk";

const FACT_CODENAME = "FALCONRIDGE";
const FACT_PORT = "8347";
const FACT_OWNER = "Marguerite Delacroix";

// The turns, in order. Each is sent only after the previous one produced a
// result message, so the session really is multi-turn.
const TURNS = [
  `Remember two facts about a made-up project, exactly as written. ` +
    `The project codename is ${FACT_CODENAME}. The service listens on port ${FACT_PORT}. ` +
    `Reply with just: noted 1.`,
  `Remember a third fact about the same made-up project. ` +
    `The owner is ${FACT_OWNER}. ` +
    `Also remember this filler so there is something to throw away: the build runs nightly ` +
    `at 03:15, the log format is JSON lines, and the mascot is a grey heron named Pemberton. ` +
    `Reply with just: noted 2.`,
  `/compact Preserve ONLY the project codename. Drop the port number, the owner name, ` +
    `and every other detail. The codename is the single thing that matters.`,
  `Answer from memory only. Do not use any tool and do not guess. ` +
    `Three lines, exactly this shape:\n` +
    `CODENAME: <value or UNKNOWN>\nPORT: <value or UNKNOWN>\nOWNER: <value or UNKNOWN>`,
];

let turnIndex = 0;
let releaseNext;
const nextGate = () => new Promise((r) => (releaseNext = r));
let gate = nextGate();

async function* prompts() {
  for (const text of TURNS) {
    console.log(`\n=== TURN ${turnIndex + 1} SENT ===\n${text}\n`);
    yield {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "s3",
    };
    turnIndex += 1;
    await gate; // wait for this turn's result before sending the next
    gate = nextGate();
  }
}

const hookLog = [];
const mkHook = (name) => async (input, toolUseId, opts) => {
  const line = `[hook ${name}] ${JSON.stringify(input)}`;
  hookLog.push(line);
  console.log(line);
  return {};
};

const run = query({
  prompt: prompts(),
  options: {
    model: "haiku",
    permissionMode: "bypassPermissions",
    allowedTools: [],
    settingSources: [], // keep context small: no repo CLAUDE.md, no settings files
    maxTurns: 30,
    hooks: {
      PreCompact: [{ hooks: [mkHook("PreCompact")] }],
      PostCompact: [{ hooks: [mkHook("PostCompact")] }],
    },
  },
});

const text = (msg) =>
  (msg.message?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

try {
  for await (const msg of run) {
    if (msg.type === "system" && msg.subtype === "init") {
      console.log("[init] model:", msg.model, "| session_id:", msg.session_id);
      console.log(
        "[init] compact in slash_commands:",
        (msg.slash_commands ?? []).includes("compact"),
      );
    } else if (msg.type === "system") {
      // The interesting one: compact_boundary. Print the whole raw message.
      console.log(`[system ${msg.subtype}] RAW:`, JSON.stringify(msg));
    } else if (msg.type === "assistant") {
      const t = text(msg);
      if (t.trim()) console.log("[assistant]", JSON.stringify(t));
    } else if (msg.type === "user") {
      const c = msg.message?.content;
      if (typeof c === "string" && c.length < 400)
        console.log("[user-echo]", JSON.stringify(c));
    } else if (msg.type === "result") {
      console.log(
        `[result turn ${turnIndex}] subtype: ${msg.subtype} | is_error: ${msg.is_error} | session_id: ${msg.session_id}`,
      );
      console.log(`[result turn ${turnIndex}] text:`, JSON.stringify(msg.result ?? null));
      console.log(`[result turn ${turnIndex}] usage:`, JSON.stringify(msg.usage));
      releaseNext?.();
      if (turnIndex >= TURNS.length) break;
    } else {
      console.log(`[${msg.type}]`, JSON.stringify(msg).slice(0, 300));
    }
  }
} catch (err) {
  console.error("ITERATION ERROR:", err?.message ?? err);
}

console.log("\n=== HOOK LOG ===");
console.log(hookLog.length ? hookLog.join("\n") : "(no compaction hooks fired)");
