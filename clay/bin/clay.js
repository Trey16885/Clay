#!/usr/bin/env node
// clay - terminal entry point: argument handling, the REPL, slash commands,
// and the glue between the agent loop and the terminal.

import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import Anthropic from "@anthropic-ai/sdk";

import { parseArgs, HELP, VERSION, costOf } from "../src/config.js";
import { Clay } from "../src/agent.js";
import { Approvals } from "../src/approvals.js";
import { TOOLS } from "../src/tools.js";
import { c, line, out, banner, toolCall, toolResult, note, warn, fail, spinner, usageLine } from "../src/ui.js";

const SLASH_HELP = `  ${c.bold("/help")}            this list
  ${c.bold("/reset")}           forget the conversation and start fresh
  ${c.bold("/compact")}         replace the history with a summary of it
  ${c.bold("/cost")}            token use and estimated spend so far
  ${c.bold("/model")} [id]      show or switch the model
  ${c.bold("/effort")} [level]  show or set effort (low|medium|high|xhigh|max)
  ${c.bold("/yolo")}            toggle approval prompts on or off
  ${c.bold("/tools")}           list the tools Clay can use
  ${c.bold("/cwd")}             show the workspace root
  ${c.bold("/save")} [file]     write the transcript to a JSON file
  ${c.bold("/exit")}            quit (Ctrl-D also works)`;

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  fail(err.message);
  line(`  ${c.dim("clay --help for usage")}`);
  process.exit(2);
}

if (opts.help) {
  line(HELP);
  process.exit(0);
}
if (opts.version) {
  line(`clay ${VERSION}`);
  process.exit(0);
}

// Fail early and clearly on a workspace that is not there.
const stat = await fs.stat(opts.workspace).catch(() => null);
if (!stat?.isDirectory()) {
  fail(`workspace is not a directory: ${opts.workspace}`);
  process.exit(2);
}

const interactive = stdin.isTTY && stdout.isTTY && !opts.print;

let clay;
try {
  clay = new Clay(opts);
} catch (err) {
  // The SDK throws here when it cannot find any credential at all.
  fail(err?.message ?? String(err));
  line(`  ${c.dim("Set ANTHROPIC_API_KEY, or run `ant auth login`.")}`);
  process.exit(2);
}
await clay.init();

// A writer that knows whether the cursor sits at column zero, so the tool
// trace and the streamed text never collide on the same line.
let atLineStart = true;
function write(text) {
  if (!text) return;
  out(text);
  atLineStart = text.endsWith("\n");
}
function ensureLine() {
  if (!atLineStart) {
    out("\n");
    atLineStart = true;
  }
}

let rl = null;
const ask = (q) => (rl ? rl.question(q) : Promise.resolve("n"));

// ---------------------------------------------------------------- one turn

// Set while a turn is in flight, so Ctrl-C can abort it from either the
// readline interface (interactive) or the process (one-shot).
let interruptTurn = null;

async function turn(text, approvals) {
  const started = Date.now();
  const controller = new AbortController();
  let spin = null;
  const stopSpin = () => {
    if (spin) {
      spin.stop();
      spin = null;
    }
  };

  interruptTurn = () => {
    stopSpin();
    ensureLine();
    warn("interrupted");
    controller.abort();
  };
  if (!rl) process.on("SIGINT", interruptTurn);

  try {
    const result = await clay.run(text, {
      approvals,
      signal: controller.signal,
      onStepStart: () => {
        if (interactive) spin = spinner("thinking");
      },
      onText: (delta) => {
        stopSpin();
        write(delta);
      },
      onToolCall: (name, summary) => {
        stopSpin();
        ensureLine();
        if (!opts.quiet) toolCall(name, summary);
      },
      onToolResult: (body, isError) => {
        if (!opts.quiet) toolResult(body, isError);
        atLineStart = true;
      },
      onNotice: (msg) => {
        stopSpin();
        ensureLine();
        warn(msg);
      },
    });

    stopSpin();
    ensureLine();
    if (!result.aborted && interactive && !opts.quiet) {
      usageLine(opts.model, clay.turnUsage, costOf(opts.model, clay.turnUsage), Date.now() - started);
    }
    return result;
  } catch (err) {
    stopSpin();
    ensureLine();
    reportError(err);
    return { error: err };
  } finally {
    if (!rl) process.off("SIGINT", interruptTurn);
    interruptTurn = null;
  }
}

function reportError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    fail("authentication failed - check ANTHROPIC_API_KEY, or run `ant auth login`.");
  } else if (err instanceof Anthropic.RateLimitError) {
    fail("rate limited - wait a moment and try again.");
  } else if (err instanceof Anthropic.NotFoundError) {
    fail(`model "${opts.model}" was not found for this account.`);
  } else if (err instanceof Anthropic.APIConnectionError) {
    fail(`could not reach the API: ${err.message}`);
  } else if (err instanceof Anthropic.APIError) {
    fail(`API error ${err.status ?? ""}: ${err.message}`);
  } else {
    fail(err?.message ?? String(err));
  }
}

// ----------------------------------------------------------- one-shot mode

if (!interactive) {
  const text = opts.prompt || (await readStdin());
  if (!text) {
    fail("nothing to do - pass a prompt, or pipe one in.");
    process.exit(2);
  }
  // Nobody is there to answer prompts, so writes need --yolo to proceed.
  const approvals = new Approvals({ yolo: opts.yolo, ask: null });
  const result = await turn(text, approvals);
  process.exit(result?.error ? 1 : 0);
}

// -------------------------------------------------------------- REPL mode

banner(opts);
if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  note("No ANTHROPIC_API_KEY set - falling back to an `ant auth login` profile if you have one.");
  line();
}

rl = readline.createInterface({ input: stdin, output: stdout, prompt: `${c.cyan("clay")} ${c.dim("›")} ` });
const approvals = new Approvals({ yolo: opts.yolo, ask });

// Ctrl-C stops whatever Clay is doing; at an idle prompt it ends the session.
// Readline swallows SIGINT once it has a listener, so this is the only handler
// that runs in interactive mode.
rl.on("SIGINT", () => {
  if (interruptTurn) interruptTurn();
  else rl.close();
});

rl.on("close", () => {
  line();
  goodbye();
});

while (true) {
  let input;
  try {
    input = await rl.question(`${c.cyan("clay")} ${c.dim("›")} `);
  } catch {
    break; // Ctrl-C at an idle prompt, or the stream closed.
  }
  const text = input.trim();
  if (!text) continue;

  if (text.startsWith("/")) {
    const [cmd, ...args] = text.slice(1).split(/\s+/);
    const done = await slash(cmd.toLowerCase(), args);
    if (done === "exit") break;
    continue;
  }

  line();
  await turn(text, approvals);
  line();
}

rl.close();

// ---------------------------------------------------------- slash commands

async function slash(cmd, args) {
  switch (cmd) {
    case "help":
      line();
      line(SLASH_HELP);
      line();
      return;

    case "exit":
    case "quit":
      return "exit";

    case "reset":
      clay.reset();
      note("conversation cleared");
      return;

    case "compact": {
      const spin = spinner("summarizing");
      try {
        const summary = await clay.compact();
        spin.stop();
        if (!summary) note("nothing to compact");
        else {
          note("history replaced with a summary:");
          line();
          line(summary);
          line();
        }
      } catch (err) {
        spin.stop();
        reportError(err);
      }
      return;
    }

    case "cost": {
      const u = clay.usage;
      const total = clay.cost;
      line();
      line(`  input ${u.input} · cache read ${u.cacheRead} · cache write ${u.cacheWrite} · output ${u.output}`);
      line(
        total == null
          ? `  ${c.dim(`no price on file for ${opts.model}`)}`
          : `  ${c.bold(`$${total.toFixed(4)}`)} ${c.dim("estimated this session")}`,
      );
      line();
      return;
    }

    case "model":
      if (args[0]) {
        opts.model = args[0];
        clay.simpleParams = false;
        note(`model set to ${opts.model}`);
      } else {
        note(`model is ${opts.model}`);
      }
      return;

    case "effort": {
      const levels = ["low", "medium", "high", "xhigh", "max"];
      if (!args[0]) {
        note(`effort is ${opts.effort}`);
      } else if (levels.includes(args[0])) {
        opts.effort = args[0];
        note(`effort set to ${opts.effort}`);
      } else {
        warn(`effort must be one of ${levels.join(", ")}`);
      }
      return;
    }

    case "yolo":
      approvals.yolo = !approvals.yolo;
      opts.yolo = approvals.yolo;
      if (approvals.yolo) warn("auto-approve on - Clay will write files and run commands without asking");
      else note("auto-approve off");
      return;

    case "tools":
      line();
      for (const t of TOOLS) {
        line(`  ${c.bold(t.name.padEnd(14))} ${t.approval ? c.yellow("asks first") : c.dim("read-only")}`);
      }
      if (opts.web) line(`  ${c.bold("web_search".padEnd(14))} ${c.dim("hosted by the API")}`);
      line();
      return;

    case "cwd":
      note(opts.workspace);
      return;

    case "save": {
      const file = path.resolve(
        opts.workspace,
        args[0] ?? `clay-session-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      );
      const body = {
        model: opts.model,
        workspace: opts.workspace,
        saved_at: new Date().toISOString(),
        usage: clay.usage,
        estimated_cost_usd: clay.cost,
        messages: clay.messages,
      };
      await fs.writeFile(file, JSON.stringify(body, null, 2));
      note(`saved to ${path.relative(opts.workspace, file) || file}`);
      return;
    }

    default:
      warn(`unknown command /${cmd} - try /help`);
  }
}

function goodbye() {
  const total = clay.cost;
  if (clay.usage.output > 0 && total != null) {
    note(`${clay.usage.output} output tokens · about $${total.toFixed(4)} this session`);
  }
  process.exit(0);
}

async function readStdin() {
  if (stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}
