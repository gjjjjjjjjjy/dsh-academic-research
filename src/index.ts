/**
 * dsh-academic-research — a research-fidelity compaction backend for DeepSeek Harness.
 *
 * Extends the official `BasicCompactionEngine` and overrides only the
 * documented `summarize()` hook, so pressure, retention, token metering, and
 * the compaction transaction stay inherited. What changes is the checkpoint:
 * the program builds it from the session log without a model call — the user's
 * words and the assistant's prose verbatim and attributed, one line per tool
 * call with the seq its result is read back by (see `checkpoint.ts`).
 *
 * Configuration is exactly the base engine's. Keys of the earlier model-written
 * checkpoint (`domain`, `summaryLanguage`, `recursive`, `chunkMessages`,
 * `domainExtra`) are rejected by the base engine's own key validation.
 *
 * @module dsh-academic-research
 */

import type { Agent } from '@deepseek-ai/dsh-agent';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';

import { buildCheckpoint, regionEntries } from './checkpoint.ts';
import type { SummarizationInput, SummaryResult } from './types.ts';

/**
 * Recorded as the checkpoint's provider/model on `compaction/summary`. No
 * model produced it, so the record names the program instead of a route.
 */
export const CHECKPOINT_PROVIDER = 'dsh-academic-research';
export const CHECKPOINT_MODEL = 'program';

/**
 * Registers as the single `ctx.compaction` provider for its realm.
 *
 * Mount it where the deployment's compaction lives: a host-plane row needs the
 * built-in `dsh-compaction-basic` disabled in the same composition, and an
 * agent preset must replace its own backend row so two engines never race for
 * the same compaction decision.
 */
export class AcademicResearchCompactionEngine extends BasicCompactionEngine {
  /**
   * The sole subclass hook, per the base engine's contract.
   *
   * @param input - the derived system head followed by the shadowed region.
   * @param agent - the compacting agent; its session maps the region back to seqs.
   * @returns the program-built checkpoint.
   */
  protected override async summarize(input: SummarizationInput, agent: Agent): Promise<SummaryResult> {
    let cut = 0;
    while (cut < input.messages.length && input.messages[cut]?.role === 'system') cut += 1;
    const region = input.messages.slice(cut);
    const text = buildCheckpoint(agent.session.id, regionEntries(agent.session, region));
    return {
      summary: [{ type: 'text', text }],
      provider: CHECKPOINT_PROVIDER,
      model: CHECKPOINT_MODEL,
    };
  }
}

export default AcademicResearchCompactionEngine;
