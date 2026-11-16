/**
 * `summarize()` contract mirrors.
 *
 * @module dsh-academic-research/types
 */

import type { ContentBlock, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm';

/**
 * The replayed conversation surface the summarizer condenses.
 *
 * Mirrored from the INSTALLED `@deepseek-ai/dsh-compaction-basic`
 * `lib/types/summarizer.d.ts`. That package neither re-exports these two types
 * from its root nor publishes the `src/` its `"./src/*"` export subpath points
 * at, so a consumer cannot import them; mirroring depends only on `dsh-llm`
 * root exports, which are published.
 *
 * The installed 0.2.2-rc.1 shape has no `system` field: the derived system
 * head, when present, is `messages[0]`.
 */
export interface SummarizationInput {
  /** The conversation's tool schemas, reused for prefix alignment; absent when the request carried none. */
  readonly tools?: readonly ToolSchema[];
  /** The derived system head, when present, followed by the shadowed region in surface order. */
  readonly messages: readonly Message[];
}

/** Safe summary content plus the exact auxiliary call envelope recorded with it. */
export type SummaryResult = {
  summary: ContentBlock[];
  provider: string;
  model: string;
  maxTokens?: number;
  /** Provider-reported usage for this summarization request. */
  usage?: TokenUsage;
} & (
  | {
      /** Complete provider output before the text-only summary projection. */
      rawOutput: ContentBlock[];
      /** Identifies exactly one call through this context's `ctx.llm.stream()`. */
      llmStreamCall: true;
    }
  | {
      /** Complete output, present whenever the backend captured one. */
      rawOutput?: ContentBlock[];
      /** No model call, or several, means no single call identity. */
      llmStreamCall?: never;
    }
);
