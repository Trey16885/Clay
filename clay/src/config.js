// Configuration: defaults, CLI argument parsing, and the pricing table used
// for the per-session cost readout.

import path from "node:path";

export const VERSION = "0.1.0";

export const DEFAULTS = {
  model: "claude-opus-5",
  effort: "high",       // low | medium | high | xhigh | max
  maxTokens: 64000,     // streaming, so there is room to work
  maxSteps: 50,         // tool-use rounds per user turn before Clay stops
  commandTimeoutMs: 120000,
};

// USD per million tokens. Cache writes bill ~1.25x input, reads ~0.1x.
const PRICING = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-fable-5": { input: 10, output: 50 },
};

export function priceOf(model) {
  return PRICING[model] ?? null;
}

export function costOf(model, usage) {
  const p = priceOf(model);
  if (!p) return null;
  const m = 1e6;
  return (
    (usage.input * p.input) / m +
    (usage.cacheWrite * p.input * 1.25) / m +
    (usage.cacheRead * p.input * 0.1) / m +
    (usage.output * p.output) / m
  );
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export const HELP = `Clay — a terminal AI agent for your workspace.

Usage:
  clay                       start an interactive session
  clay "fix the failing test"  run one task, print the answer, exit
  clay -p "..."              same, forced non-interactive (pipe friendly)

Options:
  -C, --cwd <dir>       workspace root Clay may touch (default: current dir)
  -m, --model <id>      model id (default: ${DEFAULTS.model})
  -e, --effort <level>  low | medium | high | xhigh | max (default: ${DEFAULTS.effort})
      --max-steps <n>   tool rounds per turn before Clay stops (default: ${DEFAULTS.maxSteps})
  -y, --yolo            run commands and edits without asking first
      --allow-outside   let Clay read and write outside the workspace root
      --no-web          disable the hosted web_search tool
  -p, --print           non-interactive: answer once and exit
  -q, --quiet           hide the tool-call trace
  -h, --help            show this help
  -v, --version         show the version

Environment:
  ANTHROPIC_API_KEY     API key (or run \`ant auth login\`)
  CLAY_MODEL            default model id
  CLAY_EFFORT           default effort level
  NO_COLOR              disable colour output

In a session, type /help for slash commands.`;

export function parseArgs(argv) {
  const opts = {
    model: process.env.CLAY_MODEL || DEFAULTS.model,
    effort: process.env.CLAY_EFFORT || DEFAULTS.effort,
    maxSteps: DEFAULTS.maxSteps,
    workspace: process.cwd(),
    yolo: false,
    allowOutside: false,
    web: true,
    print: false,
    quiet: false,
    help: false,
    version: false,
    prompt: "",
  };
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "-C": case "--cwd": opts.workspace = path.resolve(next()); break;
      case "-m": case "--model": opts.model = next(); break;
      case "-e": case "--effort": opts.effort = next(); break;
      case "--max-steps": opts.maxSteps = Number(next()); break;
      case "-y": case "--yolo": opts.yolo = true; break;
      case "--allow-outside": opts.allowOutside = true; break;
      case "--no-web": opts.web = false; break;
      case "-p": case "--print": opts.print = true; break;
      case "-q": case "--quiet": opts.quiet = true; break;
      case "-h": case "--help": opts.help = true; break;
      case "-v": case "--version": opts.version = true; break;
      default:
        if (a.startsWith("-") && a !== "-") throw new Error(`unknown option: ${a}`);
        rest.push(a);
    }
  }

  if (!EFFORTS.has(opts.effort)) {
    throw new Error(`invalid effort "${opts.effort}" (use ${[...EFFORTS].join(", ")})`);
  }
  if (!Number.isInteger(opts.maxSteps) || opts.maxSteps < 1) {
    throw new Error("--max-steps must be a positive integer");
  }

  opts.prompt = rest.join(" ").trim();
  return opts;
}
