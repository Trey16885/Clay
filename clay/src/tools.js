// Clay's hands: the client-side tools it can call, their JSON schemas, and
// their implementations. Every tool returns a string; anything that throws is
// reported back to the model as an error result rather than crashing the loop.

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { truncate } from "./ui.js";

const MAX_RESULT_CHARS = 40000;
const IGNORED_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", ".cache",
  "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", "target",
]);

function clamp(text) {
  const s = String(text);
  if (s.length <= MAX_RESULT_CHARS) return s;
  return s.slice(0, MAX_RESULT_CHARS) + `\n... [truncated, ${s.length - MAX_RESULT_CHARS} more characters]`;
}

// Resolve a model-supplied path against the workspace and refuse to escape it
// unless the session was started with --allow-outside.
async function resolvePath(ctx, p, { mustExist = false } = {}) {
  const abs = path.resolve(ctx.workspace, p ?? ".");
  if (!ctx.allowOutside) {
    const rel = path.relative(ctx.workspace, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(
        `"${p}" is outside the workspace (${ctx.workspace}). Restart clay with --allow-outside to permit this.`,
      );
    }
    // Follow symlinks for anything that already exists, so a link cannot be
    // used to step out of the workspace.
    try {
      const real = await fs.realpath(abs);
      const realRel = path.relative(await fs.realpath(ctx.workspace), real);
      if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
        throw new Error(`"${p}" resolves outside the workspace via a symlink.`);
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  if (mustExist) await fs.access(abs);
  return abs;
}

const rel = (ctx, abs) => path.relative(ctx.workspace, abs) || path.basename(abs);

// Translate a glob to a regular expression one character at a time - a chain
// of string replacements would rewrite the regex syntax it just inserted.
// A glob with no "/" matches the basename at any depth, as ripgrep's -g does.
function globMatcher(glob) {
  let body = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          body += "(?:.*/)?"; // "**/" - any number of directories, including none
        } else {
          body += ".*";
        }
      } else {
        body += "[^/]*";
      }
    } else if (ch === "?") {
      body += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      body += "\\" + ch;
    } else {
      body += ch;
    }
  }
  const re = new RegExp(`^${body}$`);
  const basenameOnly = !glob.includes("/");
  return (relPath) => re.test(basenameOnly ? path.basename(relPath) : relPath);
}

async function* walk(ctx, dir, depth) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      yield { abs, dir: true };
      if (depth > 1) yield* walk(ctx, abs, depth - 1);
    } else if (entry.isFile()) {
      yield { abs, dir: false };
    }
  }
}

const isBinary = (buf) => buf.includes(0);

export const TOOLS = [
  {
    name: "read_file",
    approval: false,
    description:
      "Read a UTF-8 text file from the workspace. Returns the contents with 1-based line numbers so you can cite file:line. Use offset/limit for large files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the workspace root." },
        offset: { type: "integer", description: "1-based line to start at. Default 1." },
        limit: { type: "integer", description: "Maximum number of lines to return. Default 800." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    summary: (i) => i.path,
    async run(input, ctx) {
      const abs = await resolvePath(ctx, input.path, { mustExist: true });
      const buf = await fs.readFile(abs);
      if (isBinary(buf)) return `${rel(ctx, abs)} is a binary file (${buf.length} bytes).`;
      const all = buf.toString("utf8").split("\n");
      const offset = Math.max(1, input.offset ?? 1);
      const limit = Math.max(1, input.limit ?? 800);
      const slice = all.slice(offset - 1, offset - 1 + limit);
      if (slice.length === 0) return `${rel(ctx, abs)} has ${all.length} lines; offset ${offset} is past the end.`;
      const width = String(offset + slice.length - 1).length;
      const body = slice
        .map((l, n) => `${String(offset + n).padStart(width)}  ${l}`)
        .join("\n");
      const tail =
        offset - 1 + slice.length < all.length
          ? `\n... ${all.length - (offset - 1 + slice.length)} more lines (file has ${all.length}).`
          : "";
      return clamp(body + tail);
    },
  },

  {
    name: "write_file",
    approval: true,
    description:
      "Create a file or replace its entire contents. Parent directories are created as needed. Prefer edit_file for changes to an existing file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the workspace root." },
        content: { type: "string", description: "The complete new contents of the file." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    summary: (i) => `${i.path} (${String(i.content ?? "").split("\n").length} lines)`,
    async run(input, ctx) {
      const abs = await resolvePath(ctx, input.path);
      const existed = await fs
        .stat(abs)
        .then(() => true)
        .catch(() => false);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, input.content, "utf8");
      const lines = input.content.split("\n").length;
      return `${existed ? "Overwrote" : "Created"} ${rel(ctx, abs)} (${lines} lines, ${Buffer.byteLength(input.content)} bytes).`;
    },
  },

  {
    name: "edit_file",
    approval: true,
    description:
      "Replace an exact string in a file. old_text must appear exactly once unless replace_all is true. Read the file first so the match is exact, including indentation.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the workspace root." },
        old_text: { type: "string", description: "Exact text to replace, including whitespace." },
        new_text: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
    summary: (i) => `${i.path} ${truncate(JSON.stringify(i.old_text ?? ""), 60)}`,
    async run(input, ctx) {
      const abs = await resolvePath(ctx, input.path, { mustExist: true });
      const original = await fs.readFile(abs, "utf8");
      if (input.old_text === input.new_text) throw new Error("old_text and new_text are identical.");
      const count = original.split(input.old_text).length - 1;
      if (count === 0) {
        throw new Error(`old_text was not found in ${rel(ctx, abs)}. Read the file and match it exactly.`);
      }
      if (count > 1 && !input.replace_all) {
        throw new Error(
          `old_text appears ${count} times in ${rel(ctx, abs)}. Add surrounding context to make it unique, or set replace_all.`,
        );
      }
      const updated = input.replace_all
        ? original.split(input.old_text).join(input.new_text)
        : original.replace(input.old_text, input.new_text);
      await fs.writeFile(abs, updated, "utf8");
      const at = original.slice(0, original.indexOf(input.old_text)).split("\n").length;
      return `Edited ${rel(ctx, abs)} - ${count > 1 ? `${count} occurrences` : `1 occurrence at line ${at}`} replaced.`;
    },
  },

  {
    name: "list_files",
    approval: false,
    description:
      "List files and directories under a workspace path. Hidden files, VCS metadata and dependency directories are skipped.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list. Default: the workspace root." },
        depth: { type: "integer", description: "How many directory levels to descend. Default 2." },
      },
      additionalProperties: false,
    },
    summary: (i) => i.path ?? ".",
    async run(input, ctx) {
      const abs = await resolvePath(ctx, input.path ?? ".", { mustExist: true });
      const depth = Math.max(1, Math.min(input.depth ?? 2, 8));
      const rows = [];
      let hidden = 0;
      for await (const item of walk(ctx, abs, depth)) {
        if (rows.length >= 500) {
          hidden++;
          continue;
        }
        const r = path.relative(abs, item.abs);
        if (item.dir) {
          rows.push(`${r}/`);
        } else {
          const stat = await fs.stat(item.abs).catch(() => null);
          rows.push(`${r}  ${stat ? stat.size : 0}b`);
        }
      }
      if (rows.length === 0) return `${rel(ctx, abs)} is empty (or contains only ignored entries).`;
      const tail = hidden ? `\n... ${hidden} more entries not shown.` : "";
      return clamp(`${rel(ctx, abs) || "."}:\n` + rows.join("\n") + tail);
    },
  },

  {
    name: "search_files",
    approval: false,
    description:
      "Search workspace file contents with a JavaScript regular expression. Returns matching lines as path:line: text. Use this to locate code before reading whole files.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression." },
        path: { type: "string", description: "Directory to search. Default: the workspace root." },
        glob: { type: "string", description: "Only search paths matching this glob, e.g. **/*.js" },
        ignore_case: { type: "boolean", description: "Case-insensitive search." },
        max_results: { type: "integer", description: "Maximum matching lines to return. Default 80." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    summary: (i) => `/${i.pattern}/${i.glob ? ` in ${i.glob}` : ""}`,
    async run(input, ctx) {
      const abs = await resolvePath(ctx, input.path ?? ".", { mustExist: true });
      let re;
      try {
        re = new RegExp(input.pattern, input.ignore_case ? "i" : "");
      } catch (err) {
        throw new Error(`invalid regular expression: ${err.message}`);
      }
      const matchGlob = input.glob ? globMatcher(input.glob) : null;
      const max = Math.max(1, Math.min(input.max_results ?? 80, 500));
      const hits = [];
      let scanned = 0;
      for await (const item of walk(ctx, abs, 12)) {
        if (item.dir || hits.length >= max) continue;
        const r = path.relative(ctx.workspace, item.abs);
        if (matchGlob && !matchGlob(r)) continue;
        let buf;
        try {
          buf = await fs.readFile(item.abs);
        } catch {
          continue;
        }
        if (buf.length > 2000000 || isBinary(buf)) continue;
        scanned++;
        const lines = buf.toString("utf8").split("\n");
        for (let n = 0; n < lines.length && hits.length < max; n++) {
          if (re.test(lines[n])) hits.push(`${r}:${n + 1}: ${truncate(lines[n].trim(), 200)}`);
        }
      }
      if (hits.length === 0) return `No matches for /${input.pattern}/ in ${scanned} file(s).`;
      return clamp(`${hits.length} match(es) in ${scanned} file(s) searched:\n` + hits.join("\n"));
    },
  },

  {
    name: "run_command",
    approval: true,
    description:
      "Run a shell command with bash in the workspace root. Use it to run tests, linters, git, or build tools. Returns exit code, stdout and stderr. Not for long-running servers.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
        timeout_ms: { type: "integer", description: "Kill the command after this many milliseconds. Default 120000." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    summary: (i) => truncate(i.command ?? "", 100),
    run(input, ctx) {
      const timeout = Math.max(1000, Math.min(input.timeout_ms ?? ctx.commandTimeoutMs, 600000));
      return new Promise((resolve) => {
        const child = spawn("bash", ["-lc", input.command], {
          cwd: ctx.workspace,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let killed = false;
        const timer = setTimeout(() => {
          killed = true;
          child.kill("SIGKILL");
        }, timeout);
        child.stdout.on("data", (d) => {
          stdout += d;
        });
        child.stderr.on("data", (d) => {
          stderr += d;
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          resolve(`Failed to start command: ${err.message}`);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          const parts = [`exit ${killed ? "timeout" : code}`];
          if (stdout.trim()) parts.push(`stdout:\n${stdout.trimEnd()}`);
          if (stderr.trim()) parts.push(`stderr:\n${stderr.trimEnd()}`);
          if (killed) parts.push(`Command exceeded ${timeout}ms and was killed.`);
          resolve(clamp(parts.join("\n")));
        });
      });
    },
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// The wire-format definitions sent to the API. Order is stable so the cached
// prefix stays valid between requests.
export const toolSchemas = () =>
  TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

export const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search", max_uses: 8 };
