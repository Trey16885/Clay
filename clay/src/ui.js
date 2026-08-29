// Terminal presentation: colour, the tool-call trace, spinners, errors.

const useColor =
  !process.env.NO_COLOR && process.stdout.isTTY && process.env.TERM !== "dumb";

const wrap = (open, close) => (s) =>
  useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
};

export const out = (s = "") => process.stdout.write(s);
export const line = (s = "") => process.stdout.write(s + "\n");

export function banner(opts) {
  line();
  line(`  ${c.cyan(c.bold("clay"))} ${c.dim("·")} ${c.dim(opts.model)} ${c.dim("·")} ${c.dim(opts.workspace)}`);
  const mode = opts.yolo ? c.yellow("auto-approve") : c.dim("asks before writing");
  line(`  ${c.dim("effort " + opts.effort)} ${c.dim("·")} ${mode} ${c.dim("·")} ${c.dim("/help for commands")}`);
  line();
}

export function toolCall(name, summary) {
  line(`  ${c.magenta("→")} ${c.bold(name)} ${c.dim(summary ?? "")}`.trimEnd());
}

export function toolResult(text, isError) {
  const body = String(text ?? "");
  const lines = body.split("\n").filter((l) => l.trim() !== "");
  const head = lines.slice(0, 4);
  const mark = isError ? c.red("✗") : c.green("✓");
  if (head.length === 0) {
    line(`    ${mark} ${c.dim("done")}`);
    return;
  }
  // Only the first line carries the mark; the rest align under it.
  head.forEach((l, i) => line(`    ${i === 0 ? mark : " "} ${c.dim(truncate(l, 140))}`));
  if (lines.length > head.length) {
    line(`    ${c.dim(`… ${lines.length - head.length} more line(s)`)}`);
  }
}

export function truncate(s, n) {
  const str = String(s);
  return str.length <= n ? str : str.slice(0, n - 1) + "…";
}

export function note(s) { line(`  ${c.dim(s)}`); }
export function warn(s) { line(`  ${c.yellow("!")} ${s}`); }
export function fail(s) { line(`  ${c.red("✗")} ${s}`); }

// A spinner that stays quiet on non-TTY output.
export function spinner(label) {
  if (!process.stdout.isTTY || process.env.NO_COLOR) {
    return { stop() {} };
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const tick = () => {
    process.stdout.write(`\r  ${c.cyan(frames[i++ % frames.length])} ${c.dim(label)}`);
  };
  tick();
  const id = setInterval(tick, 80);
  return {
    stop() {
      clearInterval(id);
      process.stdout.write("\r\x1b[2K");
    },
  };
}

export function usageLine(model, usage, cost, elapsedMs) {
  const bits = [
    `${usage.input + usage.cacheRead + usage.cacheWrite} in`,
    `${usage.output} out`,
  ];
  if (usage.cacheRead) bits.push(`${usage.cacheRead} cached`);
  bits.push(`${(elapsedMs / 1000).toFixed(1)}s`);
  if (cost != null) bits.push(`$${cost.toFixed(4)}`);
  line(`  ${c.dim(bits.join(" · "))}`);
}
