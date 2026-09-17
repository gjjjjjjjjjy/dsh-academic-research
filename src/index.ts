/**
 * dsh-academic-research — a research-fidelity compaction backend for DeepSeek Harness.
 *
 * Extends the official `BasicCompactionEngine` and overrides only the
 * documented `summarize()` hook, so pressure, retention, token metering, and
 * the compaction transaction stay inherited. What changes is the checkpoint:
 * a six-section research handover whose precisely-preserved section the
 * program copies verbatim from source ranges the model cited.
 *
 * @module dsh-academic-research
 */

import type { Agent } from '@deepseek-ai/dsh-agent';
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

import { resolveDomain } from './domains.ts';
import { summarizeRegion } from './summarize.ts';
import type {
  ResolvedAcademicResearchConfig,
  AcademicResearchCompactionConfig,
  SummarizationInput,
  SummaryLanguage,
  SummaryResult,
} from './types.ts';

export type {
  ResolvedAcademicResearchConfig,
  AcademicResearchCompactionConfig,
  ScienceDomain,
  SummaryLanguage,
} from './types.ts';

const num = z.number();
const str = z.string();

const modelPolicy = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: num,
  retainRatio: num,
  retainTokens: z.number().step(1).min(0),
  summarizationProvider: str,
  summarizationModel: str,
  maxTokens: z.number().step(1).min(1),
  compactionRetries: z.number().step(1).min(0),
  maxOverflowRetries: z.number().step(1).min(0),
});

/**
 * Keys owned by `BasicCompactionEngine`. Its constructor validates its config
 * against `BasicCompactionConfig` and throws on an unknown key, so additive
 * keys are stripped before `super()` and resolved separately.
 *
 * The split is written field by field so the compiler checks every policy key:
 * a key list would silently drop a field it omitted or misspelled, and the base
 * would then run on its default instead of the configured value.
 */
function baseConfigOf(config: AcademicResearchCompactionConfig): BasicCompactionConfig {
  const base: BasicCompactionConfig = {};
  if (config.thresholdRatio !== undefined) base.thresholdRatio = config.thresholdRatio;
  if (config.retainRatio !== undefined) base.retainRatio = config.retainRatio;
  if (config.retainTokens !== undefined) base.retainTokens = config.retainTokens;
  if (config.summarizationProvider !== undefined) {
    base.summarizationProvider = config.summarizationProvider;
  }
  if (config.summarizationModel !== undefined) base.summarizationModel = config.summarizationModel;
  if (config.maxTokens !== undefined) base.maxTokens = config.maxTokens;
  if (config.compactionRetries !== undefined) base.compactionRetries = config.compactionRetries;
  if (config.maxOverflowRetries !== undefined) base.maxOverflowRetries = config.maxOverflowRetries;
  if (config.modelPolicies !== undefined) base.modelPolicies = config.modelPolicies;
  if (config.auto !== undefined) base.auto = config.auto;
  return base;
}

/** Validate the configured summary language. */
function resolveLanguage(value: string): SummaryLanguage {
  if (value === 'en' || value === 'zh' || value === 'auto') return value;
  throw new Error(`dsh-academic-research: unknown summaryLanguage "${value}" (allowed: en, zh, auto)`);
}

/**
 * The smallest summary budget this backend runs on.
 *
 * Measured, not chosen: at the base engine's inherited default of 8192 the
 * six-section checkpoint was truncated on 9 of 9 real compaction attempts
 * (`summarization truncated at the token cap`), and V4 then refused every one.
 * A deployment that leaves the key unset inherits exactly that broken default,
 * so it is rejected at construction instead of failing on every compaction.
 */
const MIN_MAX_TOKENS = 32768;

/**
 * Refuse any configured summary budget the six-section checkpoint cannot fit in.
 *
 * The top-level `maxTokens` is required, and a per-route policy override may
 * only raise it. Both forms are checked because either one below the floor
 * reproduces the truncation incident.
 *
 * @param config - the raw engine configuration.
 */
export function assertMaxTokens(config: AcademicResearchCompactionConfig): void {
  const budgets: readonly (number | undefined)[] = [
    config.maxTokens,
    ...(config.modelPolicies ?? []).map((policy) => policy.maxTokens),
  ];
  for (const [index, budget] of budgets.entries()) {
    const where = index === 0 ? 'maxTokens' : `modelPolicies[${index - 1}].maxTokens`;
    if (budget === undefined) {
      if (index > 0) continue; // a policy without a budget inherits the top-level one
      throw new Error(
        `dsh-academic-research: maxTokens must be set (>= ${MIN_MAX_TOKENS}); the inherited default of 8192 `
        + 'truncates the six-section checkpoint, which fails every compaction',
      );
    }
    if (budget < MIN_MAX_TOKENS) {
      throw new Error(
        `dsh-academic-research: ${where} is ${budget}, below the measured floor of ${MIN_MAX_TOKENS}; `
        + 'a smaller budget truncates the six-section checkpoint and fails every compaction',
      );
    }
  }
}

/** Resolve the additive configuration to concrete values. */
function resolveAcademicResearchConfig(config: AcademicResearchCompactionConfig): ResolvedAcademicResearchConfig {
  return {
    domain: resolveDomain(config.domain ?? 'general'),
    summaryLanguage: resolveLanguage(config.summaryLanguage ?? 'auto'),
    recursive: config.recursive ?? true,
    chunkMessages: config.chunkMessages ?? 40,
    domainExtra: config.domainExtra ?? '',
  };
}

/**
 * Registers as the single `ctx.compaction` provider for its realm.
 *
 * Mount it where the deployment's compaction lives: a host-plane row needs the
 * built-in `dsh-compaction-basic` disabled in the same composition, and an
 * agent preset must replace its own backend row so two engines never race for
 * the same compaction decision.
 */
export class AcademicResearchCompactionEngine extends BasicCompactionEngine {
  static override inject = ['llm', 'tokenMeter', 'sessions'];

  static override Config = z.object({
    thresholdRatio: num,
    retainRatio: num,
    retainTokens: z.number().step(1).min(0),
    summarizationProvider: str,
    summarizationModel: str,
    maxTokens: z.number().step(1).min(1),
    compactionRetries: z.number().step(1).min(0),
    maxOverflowRetries: z.number().step(1).min(0),
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
    domain: str,
    /* Allowed values: 'en' | 'zh' | 'auto'. schemastery v3 exposes no static
       literal/union factory, so the value set is validated in resolveLanguage. */
    summaryLanguage: str,
    recursive: z.boolean(),
    chunkMessages: z.number().step(1).min(1),
    domainExtra: str,
  });

  /** Resolved additive configuration. */
  readonly academicResearchConfig: ResolvedAcademicResearchConfig;

  constructor(ctx: Context, config: AcademicResearchCompactionConfig = {}) {
    assertMaxTokens(config);
    super(ctx, baseConfigOf(config));
    this.academicResearchConfig = resolveAcademicResearchConfig(config);
    ctx.logger.info(
      `[dsh-academic-research] registered as the ctx.compaction provider `
      + `(domain=${this.academicResearchConfig.domain}, language=${this.academicResearchConfig.summaryLanguage}, `
      + `recursive=${String(this.academicResearchConfig.recursive)}). `
      + 'If startup fails with "already provided", a second ctx.compaction backend '
      + 'is enabled in this same realm.',
    );
  }

  /**
   * The sole subclass hook, per the base engine's contract.
   *
   * @param input - the derived system head followed by the shadowed region.
   * @param agent - supplies the routed target and session identity.
   * @param signal - optional cancellation forwarded into every call.
   * @returns the assembled six-section checkpoint.
   */
  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    return summarizeRegion(this.ctx, this.config, this.academicResearchConfig, input, agent, signal);
  }
}

export default AcademicResearchCompactionEngine;
