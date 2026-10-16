import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import type { z } from "zod";
import { FatalError, RetryableError } from "./errors";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface StructuredRequest<S extends z.ZodType> {
  /** Stable label for logs and test fakes. */
  task: string;
  system: string;
  prompt: string;
  schema: S;
  effort?: Effort;
}

export interface AgentRequest {
  task: string;
  system: string;
  prompt: string;
  tools: BetaRunnableTool<any>[];
  /** Adds Anthropic's server-side web search tool. */
  webSearch?: boolean;
  maxIterations?: number;
  effort?: Effort;
}

/** The LLM surface agents depend on. Swapped for a scripted fake in tests. */
export interface Llm {
  structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<z.infer<S>>;
  /** Tool-using loop; returns the agent's final text. */
  runAgent(req: AgentRequest): Promise<string>;
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Map SDK errors onto the workflow's retry taxonomy (SDK already retried internally). */
function classify(err: unknown): never {
  if (err instanceof Anthropic.RateLimitError) throw new RetryableError(`claude rate limited: ${err.message}`, 15_000);
  if (err instanceof Anthropic.InternalServerError) throw new RetryableError(`claude ${err.status}: ${err.message}`);
  if (err instanceof Anthropic.APIConnectionError) throw new RetryableError(`claude connection: ${err.message}`);
  if (err instanceof Anthropic.APIError) throw new FatalError(`claude ${err.status}: ${err.message}`);
  throw err;
}

function checkStop(msg: Anthropic.Beta.BetaMessage, task: string) {
  if (msg.stop_reason === "refusal") {
    throw new FatalError(`claude declined task ${task} (${msg.stop_details?.category ?? "unspecified"})`);
  }
  if (msg.stop_reason === "max_tokens") throw new FatalError(`claude hit max_tokens on task ${task}`);
}

export class ClaudeLlm implements Llm {
  private readonly client: Anthropic;
  constructor(
    apiKey: string,
    private readonly model = "claude-opus-5-5",
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 3, timeout: 120_000 });
  }

  async structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<z.infer<S>> {
    let msg;
    try {
      msg = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: 16_000,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
        output_config: { effort: req.effort ?? "medium", format: betaZodOutputFormat(req.schema) },
      });
    } catch (err) {
      classify(err);
    }
    checkStop(msg, req.task);
    if (msg.parsed_output == null) throw new RetryableError(`claude output for ${req.task} did not match schema`);
    return msg.parsed_output as z.infer<S>;
  }

  async runAgent(req: AgentRequest): Promise<string> {
    const tools: Parameters<typeof this.client.beta.messages.toolRunner>[0]["tools"] = [...req.tools];
    if (req.webSearch) tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 5 });

    try {
      const runner = this.client.beta.messages.toolRunner({
        model: this.model,
        max_tokens: 16_000,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
        tools,
        max_iterations: req.maxIterations ?? 8,
        output_config: { effort: req.effort ?? "medium" },
      });
      // The runner doesn't auto-resume server-tool pauses; push the turn back so it continues.
      for await (const message of runner) {
        if (message.stop_reason === "pause_turn") runner.pushMessages({ role: "assistant", content: message.content });
      }
      const final = await runner.done();
      checkStop(final, req.task);
      return final.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
    } catch (err) {
      if (err instanceof FatalError || err instanceof RetryableError) throw err;
      classify(err);
    }
  }
}

/** Untrusted text (Slack messages, emails, web pages) goes inside tags, never into instructions. */
export function untrusted(tag: string, text: string): string {
  return `<${tag}>\n${text.replaceAll(`</${tag}>`, "")}\n</${tag}>`;
}
