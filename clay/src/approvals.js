// The approval gate. Tools marked `approval: true` stop here first, so the
// user sees what Clay is about to write or run before it happens.

import { c, line, truncate } from "./ui.js";

export class Approvals {
  #always = new Set();
  #ask;

  constructor({ yolo = false, ask }) {
    this.yolo = yolo;
    this.#ask = ask;
  }

  allowAll(name) {
    this.#always.add(name);
  }

  // Resolves to { ok: true } or { ok: false, reason } - a decline is a normal
  // tool result, not an error, so the model can adapt instead of retrying.
  async request(tool, input) {
    if (!tool.approval || this.yolo || this.#always.has(tool.name)) return { ok: true };
    if (!this.#ask) {
      return { ok: false, reason: "No interactive terminal available to approve this." };
    }

    line();
    line(`  ${c.yellow("?")} ${c.bold(tool.name)} ${c.dim(tool.summary(input) ?? "")}`);
    for (const l of preview(tool, input)) line(`    ${c.dim(l)}`);
    line(`    ${c.dim("[y] once   [a] always this session   [n] no")}`);

    const answer = (await this.#ask(`  ${c.yellow("›")} `)).trim().toLowerCase();
    line();

    if (answer === "a" || answer === "always") {
      this.#always.add(tool.name);
      return { ok: true };
    }
    if (answer === "" || answer === "y" || answer === "yes") return { ok: true };
    return { ok: false, reason: "The user declined this action." };
  }
}

// A short, honest look at what the call will do - the first lines of a write,
// the before/after of an edit, the command itself.
function preview(tool, input) {
  const cap = (text, n) => {
    const lines = String(text ?? "").split("\n");
    const head = lines.slice(0, n).map((l) => truncate(l, 120));
    if (lines.length > n) head.push(`... ${lines.length - n} more line(s)`);
    return head;
  };

  switch (tool.name) {
    case "write_file":
      return cap(input.content, 8);
    case "edit_file":
      return [
        ...cap(input.old_text, 4).map((l) => `- ${l}`),
        ...cap(input.new_text, 4).map((l) => `+ ${l}`),
      ];
    case "run_command":
      return cap(input.command, 4).map((l) => `$ ${l}`);
    default:
      return cap(JSON.stringify(input), 3);
  }
}
