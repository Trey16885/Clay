// The agent loop: stream a turn, run whatever tools Claude asks for, feed the
// results back, repeat until it stops asking. Conversation state lives here.

import Anthropic from "@anthropic-ai/sdk";
import { TOOL_BY_NAME, toolSchemas, WEB_SEARCH_TOOL } from "./tools.js";
import { buildSystemPrompt } from "./prompt.js";
import { costOf, DEFAULTS } from "./config.js";

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export class Clay {
  constructor(opts) {
    this.opts = opts;
    // opts.client lets tests inject a stub in place of the real SDK client.
    this.client = opts.client ?? new Anthropic();
    this.messages = [];
    this.usage = emptyUsage();
    this.turnUsage = emptyUsage();
    this.system = "";
    // Set if the model rejects adaptive thinking / effort, so we stop sending
    // them for the rest of the session instead of failing every request.
    this.simpleParams = false;
    this.ctx = {
      workspace: opts.workspace,
      allowOutside: opts.allowOutside,
      commandTimeoutMs: DEFAULTS.commandTimeoutMs,
    };
  }

  async init() {
    this.system = await buildSystemPrompt(this.ctx);
  }

  reset() {
    this.messages = [];
    this.turnUsage = emptyUsage();
  }

  get cost() {
    return costOf(this.opts.model, this.usage);
  }

  #tools() {
    const tools = toolSchemas();
    return this.opts.web ? [...tools, WEB_SEARCH_TOOL] : tools;
  }

  #params(messages) {
    const params = {
      model: this.opts.model,
      max_tokens: DEFAULTS.maxTokens,
      // Stable prefix first, so the cache covers the system prompt and tools.
      system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
      tools: this.#tools(),
      messages,
    };
    if (!this.simpleParams) {
      params.thinking = { type: "adaptive" };
      params.output_config = { effort: this.opts.effort };
    }
    return params;
  }

  #record(usage) {
    if (!usage) return;
    const add = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    };
    for (const k of Object.keys(add)) {
      this.usage[k] += add[k];
      this.turnUsage[k] += add[k];
    }
  }

  // One streamed request. Retries once without thinking/effort if the model
  // rejects them, so older model ids still work.
  async #stream(messages, { signal, onText }) {
    const send = () => {
      const stream = this.client.messages.stream(this.#params(messages), { signal });
      if (onText) stream.on("text", onText);
      return stream.finalMessage();
    };
    try {
      return await send();
    } catch (err) {
      if (err instanceof Anthropic.BadRequestError && !this.simpleParams) {
        this.simpleParams = true;
        return await send();
      }
      throw err;
    }
  }

  /**
   * Run one user turn to completion.
   *
   * handlers: { onText, onToolCall, onToolResult, onNotice, onStepStart, approvals }
   * Returns { text, stopReason, steps } - or { aborted: true } if interrupted.
   */
  async run(userText, handlers = {}) {
    const {
      onText = () => {},
      onToolCall = () => {},
      onToolResult = () => {},
      onNotice = () => {},
      onStepStart = () => {},
      approvals,
      signal,
    } = handlers;

    this.turnUsage = emptyUsage();
    // Where this turn starts. If it ends badly we rewind to here, so history
    // never keeps an assistant tool_use with no matching tool_result.
    const baseline = this.messages.length;
    const rewind = () => {
      this.messages.length = baseline;
    };
    this.messages.push({ role: "user", content: userText });

    let steps = 0;
    let lastText = "";

    while (true) {
      if (steps >= this.opts.maxSteps) {
        onNotice(`Stopped after ${steps} tool rounds (--max-steps). Ask Clay to continue if it was not done.`);
        return { text: lastText, stopReason: "max_steps", steps };
      }
      steps++;
      onStepStart(steps);

      let message;
      try {
        message = await this.#stream(this.messages, { signal, onText });
      } catch (err) {
        rewind();
        if (err instanceof Anthropic.APIUserAbortError) return { aborted: true, steps };
        throw err;
      }

      this.#record(message.usage);
      lastText = textOf(message) || lastText;

      if (message.stop_reason === "refusal") {
        rewind();
        const why = message.stop_details?.explanation ?? "no explanation given";
        onNotice(`Claude declined this request (${message.stop_details?.category ?? "unspecified"}): ${why}`);
        return { text: lastText, stopReason: "refusal", steps };
      }

      // A server-side tool ran out of turn budget - hand the same turn back.
      if (message.stop_reason === "pause_turn") {
        this.messages.push({ role: "assistant", content: message.content });
        continue;
      }

      const calls = message.content.filter((b) => b.type === "tool_use");
      if (calls.length === 0) {
        this.messages.push({ role: "assistant", content: message.content });
        if (message.stop_reason === "max_tokens") {
          onNotice("Response hit the output limit and was cut off.");
        }
        return { text: lastText, stopReason: message.stop_reason, steps };
      }

      this.messages.push({ role: "assistant", content: message.content });

      // Every tool_use block needs a result, and they all go back in one
      // user message - splitting them teaches the model to stop batching.
      const results = [];
      for (const call of calls) {
        const tool = TOOL_BY_NAME.get(call.name);
        if (!tool) {
          results.push(errorResult(call.id, `Unknown tool "${call.name}".`));
          continue;
        }

        let summary = "";
        try {
          summary = tool.summary(call.input) ?? "";
        } catch {
          summary = "";
        }
        // Ask first, then announce: the approval prompt already shows the
        // call, so tracing it beforehand would print the same line twice.
        if (approvals) {
          const verdict = await approvals.request(tool, call.input);
          if (!verdict.ok) {
            onToolCall(call.name, summary);
            onToolResult(verdict.reason, true);
            results.push({ type: "tool_result", tool_use_id: call.id, content: verdict.reason });
            continue;
          }
        }

        onToolCall(call.name, summary);

        try {
          const output = await tool.run(call.input, this.ctx);
          const content = String(output ?? "").trim() || "(no output)";
          onToolResult(content, false);
          results.push({ type: "tool_result", tool_use_id: call.id, content });
        } catch (err) {
          const msg = err?.message ?? String(err);
          onToolResult(msg, true);
          results.push(errorResult(call.id, msg));
        }
      }

      this.messages.push({ role: "user", content: results });
    }
  }

  /**
   * Replace the conversation with a summary of it, for when a session has run
   * long. Returns the summary text.
   */
  async compact({ signal } = {}) {
    if (this.messages.length === 0) return null;
    const asked = [
      ...this.messages,
      {
        role: "user",
        content:
          "Summarize this session for your own future reference: what the user " +
          "wants, what you changed (with paths), what you learned about this " +
          "codebase, and what is left to do. Be specific and complete; this " +
          "summary will replace the transcript.",
      },
    ];
    const message = await this.#stream(asked, { signal });
    this.#record(message.usage);
    const summary = textOf(message);
    this.messages = [
      { role: "user", content: `Summary of our session so far:\n\n${summary}` },
      { role: "assistant", content: "Understood. I have the context above and will continue from there." },
    ];
    return summary;
  }
}

const errorResult = (id, message) => ({
  type: "tool_result",
  tool_use_id: id,
  content: `Error: ${message}`,
  is_error: true,
});

function textOf(message) {
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}
