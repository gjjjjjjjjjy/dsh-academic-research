/**
 * `summarize()` contract mirrors plus dsh-academic-research's own vocabulary.
 *
 * @module dsh-academic-research/types
 */

import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic';
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
 * The installed 0.1.5-rc.2 shape has no `system` field: the derived system
 * head, when present, is `messages[0]`. A mirror taken from the older
 * 0.1.0-rc.6 shape still carries one, so that mirror does not typecheck
 * against this runtime.
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
      /** Multiple calls (chunk merge or one repair) mean no single call identity. */
      llmStreamCall?: never;
    }
);

/** Domain pack selecting the extra preservation vocabulary. */
export type ScienceDomain = 'general' | 'ml' | 'optics';

/**
 * Output language of the checkpoint. `auto` follows the user's natural
 * language rather than the language of code and logs.
 */
export type SummaryLanguage = 'en' | 'zh' | 'auto';

/** Additive dsh-academic-research configuration on top of the inherited base policy. */
export interface AcademicResearchCompactionConfig extends BasicCompactionConfig {
  /** Domain pack. Allowed values: `'general' | 'ml' | 'optics'`. Default `'general'`. */
  domain?: string;
  /** Allowed values: `'en' | 'zh' | 'auto'`. Default `'auto'`. */
  summaryLanguage?: string;
  /** Split oversized regions into chunks, then merge. Default `true`. */
  recursive?: boolean;
  /** Messages per chunk when `recursive` is on. Default `40`. */
  chunkMessages?: number;
  /** Extra preservation hints appended to the selected domain pack. */
  domainExtra?: string;
}

/** Additive configuration resolved to concrete values. */
export interface ResolvedAcademicResearchConfig {
  readonly domain: ScienceDomain;
  readonly summaryLanguage: SummaryLanguage;
  readonly recursive: boolean;
  readonly chunkMessages: number;
  readonly domainExtra: string;
}

/** One content block of a numbered source, with an unaddressable structural marker. */
export interface SourceBlock {
  /** Unaddressable descriptor line printed before the block's lines. */
  readonly header?: string;
  /** The block's text lines, in order. These are what a citation resolves to. */
  readonly lines: readonly string[];
}

/** One input message rendered as an addressable source. */
export interface SourceUnit {
  /** Stable citation id, `S<n>`, valid only for this compaction. */
  readonly id: string;
  /** Provider-neutral message role. */
  readonly role: string;
  /** Blocks in order; `lines` is their concatenation. */
  readonly blocks: readonly SourceBlock[];
  /** Every addressable line of this source, in order; 1-based `L<n>`. */
  readonly lines: readonly string[];
}

/** Every source of one compaction's input region, in order. */
export type SourceIndex = readonly SourceUnit[];

/** One citation produced by the compaction model. */
export interface SourceRef {
  readonly source: string;
  /** 1-based inclusive first line. */
  readonly from: number;
  /** 1-based inclusive last line. */
  readonly to: number;
}

/** A citation resolved to the exact lines it names. */
export interface ResolvedRef extends SourceRef {
  readonly text: string;
}

/**
 * Outcome of resolving one citation. A citation naming a missing source or an
 * out-of-range line is expected model output, not an exception, so it is
 * reported so the one repair attempt can name it.
 */
export type ResolveOutcome =
  | { readonly ok: true; readonly resolved: ResolvedRef }
  | { readonly ok: false; readonly problem: string };

/** A preserved fragment carried forward from the previous checkpoint. */
export interface CarriedFragment {
  /** The `来源：` label recorded with the fragment. */
  readonly source: string;
  /** The verbatim preserved lines. */
  readonly lines: readonly string[];
}

/**
 * A preserved fragment dropped because a later record replaced the value it
 * holds. The lines are kept so the program can publish the eviction once: a
 * dropped fragment that left no trace would be an unrecorded loss of preserved
 * text (Schema §3).
 */
export interface EvictedFragment extends CarriedFragment {
  /** The line key whose later value replaced this fragment's value. */
  readonly key: string;
}

/** What the previous checkpoint contributes to this compaction. */
export interface CarriedOutcome {
  /** Fragments carried verbatim, in recorded order. */
  readonly kept: readonly CarriedFragment[];
  /** Superseded fragments, in recorded order, for the eviction trace. */
  readonly evicted: readonly EvictedFragment[];
}
