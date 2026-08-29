// The agent loop, driven against a stub client so no network or API key is
// needed. Run with: node --test

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

import { Clay } from "../src/agent.js";
import { Approvals } from "../src/approvals.js";

// A stand-in for client.messages.stream(): replays scripted responses and
// records the params each request was made with.
function stubClient(script) {
  const calls = [];
  const queue = [...script];
  return {
    calls,
    messages: {
      stream(params) {
        calls.push(params);
        const step = queue.shift();
        if (!step) throw new Error("stub client ran out of scripted responses");
        return {
          on(event, handler) {
            if (event === "text" && step.text) handler(step.text);
          },
          async finalMessage() {
            if (step.throw) throw step.throw;
            return {
              stop_reason: step.stop_reason ?? "end_turn",
              stop_details: step.stop_details ?? null,
              usage: step.usage ?? { input_tokens: 10, output_tokens: 5 },
              content: step.content ?? [{ type: "text", text: step.text ?? "" }],
            };
          },
        };
      },
    },
  };
}

const say = (text) => ({ text, content: [{ type: "text", text }] });
const useTool = (id, name, input) => ({
  stop_reason: "tool_use",
  content: [{ type: "tool_use", id, name, input }],
});

async function makeClay(script, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clay-agent-"));
  const client = stubClient(script);
  const clay = new Clay({
    client,
    model: "claude-opus-5",
    effort: "high",
    maxSteps: 10,
    workspace: dir,
    allowOutside: false,
    web: true,
    ...extra,
  });
  await clay.init();
  return { clay, client, dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test("a plain answer streams text and records the exchange", async (t) => {
  const { clay, cleanup } = await makeClay([say("The answer is 4.")]);
  t.after(cleanup);

  let streamed = "";
  const result = await clay.run("what is 2+2", { onText: (d) => (streamed += d) });

  assert.equal(result.text, "The answer is 4.");
  assert.equal(streamed, "The answer is 4.");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(clay.messages.length, 2);
  assert.equal(clay.messages[0].role, "user");
  assert.equal(clay.messages[1].role, "assistant");
});

test("a tool call runs, results go back in one user message, and the loop continues", async (t) => {
  const { clay, client, dir, cleanup } = await makeClay([
    useTool("t1", "write_file", { path: "hello.txt", content: "hi there\n" }),
    say("Written."),
  ]);
  t.after(cleanup);

  const seen = [];
  const result = await clay.run("make hello.txt", {
    approvals: new Approvals({ yolo: true }),
    onToolCall: (name) => seen.push(name),
  });

  assert.deepEqual(seen, ["write_file"]);
  assert.equal(await fs.readFile(path.join(dir, "hello.txt"), "utf8"), "hi there\n");
  assert.equal(result.text, "Written.");
  assert.equal(result.steps, 2);

  // user, assistant(tool_use), user(tool_result), assistant(text)
  assert.equal(clay.messages.length, 4);
  const results = clay.messages[2];
  assert.equal(results.role, "user");
  assert.equal(results.content.length, 1);
  assert.equal(results.content[0].type, "tool_result");
  assert.equal(results.content[0].tool_use_id, "t1");
  assert.equal(client.calls.length, 2);
});

test("parallel tool calls come back as one user message with every result", async (t) => {
  const { clay, dir, cleanup } = await makeClay([
    {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "a", name: "write_file", input: { path: "a.txt", content: "A" } },
        { type: "tool_use", id: "b", name: "write_file", input: { path: "b.txt", content: "B" } },
      ],
    },
    say("Both written."),
  ]);
  t.after(cleanup);

  await clay.run("write two files", { approvals: new Approvals({ yolo: true }) });

  const results = clay.messages[2];
  assert.equal(results.content.length, 2);
  assert.deepEqual(results.content.map((r) => r.tool_use_id), ["a", "b"]);
  assert.equal(await fs.readFile(path.join(dir, "b.txt"), "utf8"), "B");
});

test("a failing tool is reported to the model instead of throwing", async (t) => {
  const { clay, cleanup } = await makeClay([
    useTool("t1", "read_file", { path: "does-not-exist.txt" }),
    say("That file is not there."),
  ]);
  t.after(cleanup);

  const errors = [];
  await clay.run("read it", { onToolResult: (body, isError) => isError && errors.push(body) });

  assert.equal(errors.length, 1);
  const sent = clay.messages[2].content[0];
  assert.equal(sent.is_error, true);
  assert.match(sent.content, /Error:/);
});

test("an unknown tool name is answered with an error result, not a crash", async (t) => {
  const { clay, cleanup } = await makeClay([useTool("t1", "launch_rocket", {}), say("Cannot do that.")]);
  t.after(cleanup);

  await clay.run("launch it", {});
  const sent = clay.messages[2].content[0];
  assert.equal(sent.is_error, true);
  assert.match(sent.content, /Unknown tool/);
});

test("a declined approval blocks the tool and tells the model why", async (t) => {
  const { clay, dir, cleanup } = await makeClay([
    useTool("t1", "run_command", { command: "rm -rf ." }),
    say("Understood, I will not run that."),
  ]);
  t.after(cleanup);

  const approvals = new Approvals({ yolo: false, ask: async () => "n" });
  await clay.run("clean up", { approvals });

  const sent = clay.messages[2].content[0];
  assert.match(sent.content, /declined/);
  assert.deepEqual(await fs.readdir(dir), []);
});

test("read-only tools never ask for approval", async (t) => {
  const { clay, dir, cleanup } = await makeClay([useTool("t1", "list_files", {}), say("Empty.")]);
  t.after(cleanup);
  await fs.writeFile(path.join(dir, "seen.txt"), "x");

  let asked = 0;
  const approvals = new Approvals({
    yolo: false,
    ask: async () => {
      asked++;
      return "n";
    },
  });
  await clay.run("what is here", { approvals });

  assert.equal(asked, 0);
  assert.match(clay.messages[2].content[0].content, /seen\.txt/);
});

test("pause_turn is resumed rather than treated as the end of the turn", async (t) => {
  const { clay, client, cleanup } = await makeClay([
    { stop_reason: "pause_turn", content: [{ type: "text", text: "searching" }] },
    say("Here is what I found."),
  ]);
  t.after(cleanup);

  const result = await clay.run("look it up", {});
  assert.equal(result.text, "Here is what I found.");
  assert.equal(client.calls.length, 2);
});

test("a refusal rewinds the turn and reports the category", async (t) => {
  const { clay, cleanup } = await makeClay([
    {
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "no" },
      content: [],
    },
  ]);
  t.after(cleanup);

  const notices = [];
  const result = await clay.run("do something disallowed", { onNotice: (m) => notices.push(m) });

  assert.equal(result.stopReason, "refusal");
  assert.match(notices[0], /cyber/);
  assert.deepEqual(clay.messages, []); // history left clean
});

test("max_steps stops the loop and leaves history valid", async (t) => {
  const script = Array.from({ length: 6 }, (_, i) =>
    useTool(`t${i}`, "list_files", {}),
  );
  const { clay, cleanup } = await makeClay(script, { maxSteps: 3 });
  t.after(cleanup);

  const notices = [];
  const result = await clay.run("loop forever", { onNotice: (m) => notices.push(m) });

  assert.equal(result.stopReason, "max_steps");
  assert.match(notices[0], /Stopped after 3 tool rounds/);
  // Every assistant tool_use still has its matching tool_result.
  const toolUses = clay.messages.filter((m) => m.role === "assistant").length;
  const toolResults = clay.messages.filter(
    (m) => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "tool_result",
  ).length;
  assert.equal(toolUses, toolResults);
});

test("an interrupt mid-tool-use rewinds the whole turn", async (t) => {
  const { clay, cleanup } = await makeClay([
    // Turn one completes normally...
    useTool("t1", "list_files", {}),
    say("here you go"),
    // ...turn two gets through a tool round, then the user hits Ctrl-C.
    useTool("t2", "list_files", {}),
    { throw: new Anthropic.APIUserAbortError({ message: "aborted" }) },
  ]);
  t.after(cleanup);

  await clay.run("first", { approvals: new Approvals({ yolo: true }) });
  const after = clay.messages.length;
  assert.equal(after, 4);

  const result = await clay.run("second", { approvals: new Approvals({ yolo: true }) });
  assert.equal(result.aborted, true);
  // The abandoned turn left nothing behind - no orphaned tool_use.
  assert.equal(clay.messages.length, after);
});

test("an API error rewinds the turn and propagates", async (t) => {
  const { clay, cleanup } = await makeClay([{ throw: new Error("boom") }]);
  t.after(cleanup);

  await assert.rejects(() => clay.run("hi", {}), /boom/);
  assert.deepEqual(clay.messages, []);
});

test("requests carry a cached system prompt, the tools, and effort", async (t) => {
  const { clay, client, cleanup } = await makeClay([say("ok")]);
  t.after(cleanup);

  await clay.run("hi", {});
  const params = client.calls[0];

  assert.equal(params.model, "claude-opus-5");
  assert.deepEqual(params.thinking, { type: "adaptive" });
  assert.deepEqual(params.output_config, { effort: "high" });
  assert.deepEqual(params.system[0].cache_control, { type: "ephemeral" });
  assert.match(params.system[0].text, /You are Clay/);
  assert.ok(params.tools.some((t) => t.name === "read_file"));
  assert.ok(params.tools.some((t) => t.type === "web_search_20260209"));
});

test("--no-web drops the hosted search tool", async (t) => {
  const { clay, client, cleanup } = await makeClay([say("ok")], { web: false });
  t.after(cleanup);

  await clay.run("hi", {});
  assert.ok(!client.calls[0].tools.some((t) => t.type === "web_search_20260209"));
});

test("CLAY.md in the workspace becomes project instructions", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clay-guide-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "CLAY.md"), "Always use tabs.\n");

  const client = stubClient([say("ok")]);
  const clay = new Clay({
    client, model: "claude-opus-5", effort: "high", maxSteps: 5,
    workspace: dir, allowOutside: false, web: false,
  });
  await clay.init();
  await clay.run("hi", {});

  assert.match(client.calls[0].system[0].text, /Always use tabs/);
  assert.match(client.calls[0].system[0].text, /CLAY\.md/);
});

test("usage and cost accumulate across a turn", async (t) => {
  const { clay, cleanup } = await makeClay([
    {
      ...useTool("t1", "list_files", {}),
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 },
    },
    { ...say("done"), usage: { input_tokens: 200, output_tokens: 25 } },
  ]);
  t.after(cleanup);

  await clay.run("look", {});
  assert.equal(clay.usage.input, 300);
  assert.equal(clay.usage.output, 75);
  assert.equal(clay.usage.cacheRead, 20);
  assert.equal(clay.usage.cacheWrite, 10);
  // 300 in + 10 cache write @1.25x + 20 cache read @0.1x, 75 out, opus-5 rates.
  assert.ok(Math.abs(clay.cost - (300 * 5 + 10 * 6.25 + 20 * 0.5 + 75 * 25) / 1e6) < 1e-9);
});

test("compact replaces the transcript with a summary", async (t) => {
  const { clay, cleanup } = await makeClay([say("first answer"), say("A summary of everything.")]);
  t.after(cleanup);

  await clay.run("hello", {});
  const summary = await clay.compact();

  assert.equal(summary, "A summary of everything.");
  assert.equal(clay.messages.length, 2);
  assert.equal(clay.messages[0].role, "user");
  assert.match(clay.messages[0].content, /A summary of everything/);
  assert.equal(clay.messages[1].role, "assistant");
});
