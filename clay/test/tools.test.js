// Tool behaviour: the file operations, the search, the sandbox, the shell.
// Run with: node --test

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TOOL_BY_NAME } from "../src/tools.js";

const call = (name, input, ctx) => TOOL_BY_NAME.get(name).run(input, ctx);

async function workspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clay-test-"));
  return {
    ctx: { workspace: dir, allowOutside: false, commandTimeoutMs: 10000 },
    dir,
    async cleanup() {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test("read_file numbers lines and honours offset/limit", async (t) => {
  const ws = await workspace();
  t.after(ws.cleanup);
  await fs.writeFile(path.join(ws.dir, "a.txt"), "one\ntwo\nthree\nfour\n");

  const all = await call("read_file", { path: "a.txt" }, ws.ctx);
  assert.match(all, /1 {2}one/);
  assert.match(all, /3 {2}three/);

  const slice = await call("read_file", { path: "a.txt", offset: 3, limit: 1 }, ws.ctx);
  assert.match(slice, /3 {2}three/);
  assert.doesNotMatch(slice, /two/);
  assert.match(slice, /more lines/);
});

test("read_file reports binary files instead of dumping them", async (t) => {
  const ws = await workspace();
  t.after(ws.cleanup);
  await fs.writeFile(path.join(ws.dir, "blob.bin"), Buffer.from([1, 0, 2, 3]));
  assert.match(await call("read_file", { path: "blob.bin" }, ws.ctx), /binary file/);
});

test("write_file creates parent directories and reports create vs overwrite", async (t) => {
  const ws = await workspace();
  t.after(ws.cleanup);

  const created = await call("write_file", { path: "deep/nested/x.txt", content: "hi\n" }, ws.ctx);
  assert.match(created, /^Created/);
  assert.equal(await fs.readFile(path.join(ws.dir, "deep/nested/x.txt"), "utf8"), "hi\n");

  const again = await call("write_file", { path: "deep/nested/x.txt", content: "bye\n" }, ws.ctx);
  assert.match(again, /^Overwrote/);
});

test("edit_file replaces a unique match and reports the line", async (t) => {
  const ws = await workspace();
  t.after(ws.cleanup);
  await fs.writeFile(path.join(ws.dir, "code.js"), "const a = 1;\nconst b = 2;\n");

  const result = await call("edit_file", { path: "code.js", old_text: "const b = 2;", new_text: "const b = 3;" }, ws.ctx);
  assert.match(result, /line 2/);
  assert.equal(await fs.readFile(path.join(ws.dir, "code.js"), "utf8"), "const a = 1;\nconst b = 3;\n");
});

test("edit_file refuses ambiguous and missing matches", async (t) => {
  const ws = await workspace();
  t.after(ws.cleanup);
  await fs.writeFile(path.join(ws.dir, "dup.txt"), "x\nx\n");

  await assert.rejects(
    () => call("edit_file", { path: "dup.txt", old_text: "x", new_text: "y" }, ws.ctx),
    /appears 2 times/,
  );
  await assert.rejects(
    () => call("edit_file", { path: "dup.txt", old_text: "zzz", new_text: "y" }, ws.ctx),
    /not found/,
  );

  const all = await call("edit_file", { path: "dup.txt", old_text: "x", new_text: "y", replace_all: true }, ws.ctx);
  assert.match(all, /2 occurrences/);
  assert.equal(await fs.readFile(path.join(ws.dir, "dup.txt"), "utf8"), "y\ny\n");
});

test("search_files finds matches, filters by glob, and reports misses", async (t) => {
  const ws = await workspace();
  t.after(ws.cleanup);
  await fs.mkdir(path.join(ws.dir, "src"));
  await fs.writeFile(path.join(ws.dir, "src/app.js"), "function boot() {}\n");
  await fs.writeFile(path.join(ws.dir, "notes.md"), "boot notes\n");

  const hits = await call("search_files", { pattern: "boot" }, ws.ctx);
  assert.match(hits, /src\/app\.js:1/);
  assert.match(hits, /notes\.md:1/);

  const scoped = await call("search_files", { pattern: "boot", glob: "**/*.js" }, ws.ctx);
  assert.match(scoped, /app\.js/);
  assert.doesNotMatch(scoped, /notes\.md/);

  assert.match(await call("search_files", { pattern: "nowhere" }, ws.ctx), /No matches/);
  await assert.rejects(() => call("search_files", { pattern: "(" }, ws.ctx), /invalid regular expression/);
});

test("list_files skips dependency and VCS directories", async (t) => {
  const ws = await workspace();
  t.after(ws.cleanup);
  await fs.mkdir(path.join(ws.dir, "node_modules"));
  await fs.writeFile(path.join(ws.dir, "node_modules/dep.js"), "x");
  await fs.writeFile(path.join(ws.dir, "keep.js"), "x");

  const listing = await call("list_files", {}, ws.ctx);
  assert.match(listing, /keep\.js/);
  assert.doesNotMatch(listing, /node_modules/);
});

test("the workspace sandbox blocks escapes unless allow_outside is set", async (t) => {
  const ws = await workspace();
  t.after(ws.cleanup);

  await assert.rejects(() => call("read_file", { path: "../../etc/hostname" }, ws.ctx), /outside the workspace/);
  await assert.rejects(() => call("write_file", { path: "/tmp/clay-escape", content: "x" }, ws.ctx), /outside the workspace/);

  const open = { ...ws.ctx, allowOutside: true };
  const target = path.join(ws.dir, "..", `clay-outside-${process.pid}.txt`);
  await call("write_file", { path: target, content: "ok" }, open);
  assert.equal(await fs.readFile(target, "utf8"), "ok");
  await fs.rm(target, { force: true });
});

test("the sandbox is not fooled by a symlink out of the workspace", async (t) => {
  const ws = await workspace();
  t.after(ws.cleanup);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "clay-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "secret.txt"), "shh");
  await fs.symlink(outside, path.join(ws.dir, "link"));

  await assert.rejects(() => call("read_file", { path: "link/secret.txt" }, ws.ctx), /symlink|outside the workspace/);
});

test("run_command returns exit code and both streams", async (t) => {
  const ws = await workspace();
  t.after(ws.cleanup);

  const ok = await call("run_command", { command: "echo hello && echo oops >&2" }, ws.ctx);
  assert.match(ok, /exit 0/);
  assert.match(ok, /hello/);
  assert.match(ok, /oops/);

  assert.match(await call("run_command", { command: "exit 3" }, ws.ctx), /exit 3/);
  assert.match(await call("run_command", { command: "pwd" }, ws.ctx), new RegExp(path.basename(ws.dir)));
});

test("run_command kills a command that overruns its timeout", async (t) => {
  const ws = await workspace();
  t.after(ws.cleanup);
  const result = await call("run_command", { command: "sleep 30", timeout_ms: 1000 }, ws.ctx);
  assert.match(result, /exit timeout/);
  assert.match(result, /was killed/);
});
