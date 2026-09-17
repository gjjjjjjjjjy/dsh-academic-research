/**
 * Compaction orchestration: number the region, let the model cite, copy the
 * cited text verbatim, then run the four bounded checks with one repair.
 *
 * @module dsh-academic-research/summarize
 */

import { BlockAssembler, LlmError, contentHasImage, createUserMessage } from '@deepseek-ai/dsh-llm';
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  Message,
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic';

import {
  buildInstruction,
  mergeInstruction,
  partialInstruction,
  withRepair,
} from './prompt.ts';
import {
  buildSourceIndex,
  CARRIED_SOURCE,
  extractCarriedFragments,
  isSubsumed,
  parseRefs,
  refLabel,
  renderInvariantBlock,
  renderUnits,
  resolveRef,
} from './sources.ts';
import {
  parseSections,
  replaceSection,
  sectionBody,
  validateBinding,
  validateCarried,
  validateStructure,
} from './validate.ts';
import type {
  CarriedFragment,
  ResolvedRef,
  ResolvedAcademicResearchConfig,
  SourceIndex,
  SummarizationInput,
  SummaryResult,
} from './types.ts';

/** The engine's own name, used as the plugin source tag on every call. */
const PLUGIN = 'dsh-academic-research';

/** One streamed summarization result. */
interface StreamText {
  readonly text: string;
  readonly usage: TokenUsage | undefined;
}

/** Map a terminal finish to its fail-closed error (V4). */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'max-tokens':
      return new Error('dsh-academic-research: summarization truncated at the token cap (incomplete checkpoint)');
    case 'tool-calls':
      /* Tools are forwarded to the compaction call, and the prompt forbids the
         model from using them. A tool call means the turn was diverted, so
         whatever text came with it is not a checkpoint the model finished. */
      return new Error(
        'dsh-academic-research: summarization ended in a tool call instead of a checkpoint (the compaction prompt forbids tools)',
      );
    case 'aborted':
    case 'error':
      return new Error(finish.failure.message);
    default:
      /* `stop` and any future benign finish: the non-empty text check below is
         what decides whether a summary was actually produced. */
      return undefined;
  }
}

/** Run one `ctx.llm.stream()` call and return its text (V4 rejects truncation and empty output). */
async function streamText(ctx: Context, options: GenerateOptions): Promise<StreamText> {
  const assembler = new BlockAssembler();
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
  const failure = finishError(assembler.finish);
  if (failure !== undefined) throw failure;
  const raw = assembler.blocks();
  if (contentHasImage(raw)) {
    throw new LlmError('dsh-academic-research: compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT');
  }
  const text = raw
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (text.trim().length === 0) {
    throw new Error('dsh-academic-research: summarization produced no text summary content');
  }
  return { text, usage: assembler.usage };
}

/** Resolve the provider/model pair to summarize with, mirroring the base precedence. */
function resolveTarget(agent: Agent, base: ResolvedConfig): { provider: string; model: string } {
  const configured =
    base.summarizationProvider.length === 0
      ? undefined
      : { provider: base.summarizationProvider, model: base.summarizationModel };
  const latest = agent.session.requestHeader()?.config;
  const options = agent.options;
  const agentTarget =
    options.provider !== undefined && options.provider.length > 0
    && options.model !== undefined && options.model.length > 0
      ? { provider: options.provider, model: options.model }
      : undefined;
  const target = configured ?? latest ?? agentTarget;
  if (target === undefined) {
    throw new Error(
      'dsh-academic-research: no provider/model available for summarization '
      + '(set summarizationProvider/summarizationModel, route one request, or set AgentOptions)',
    );
  }
  return { provider: target.provider, model: target.model };
}

/** Build the final preserved section from carried fragments and this compaction's citations. */
/**
 * Build the final preserved section: carried fragments first, then this
 * compaction's citations.
 *
 * Carried fragments are labelled with {@link CARRIED_SOURCE}, never with the
 * label read back from the previous checkpoint. That label was a
 * compaction-local locator (`S120:L1（本次压缩定位）`) whose numbers mean nothing
 * outside their own compaction; echoing it would both misreport a carried
 * fragment as newly located this round, and nest one wrapper inside the next on
 * every subsequent compaction.
 */
function buildInvariantBody(
  carried: readonly CarriedFragment[],
  resolved: readonly ResolvedRef[],
): string[] {
  const lines: string[] = [];
  for (const fragment of carried) {
    lines.push(renderInvariantBlock(CARRIED_SOURCE, fragment.lines), '');
  }
  for (const ref of resolved) {
    lines.push(
      renderInvariantBlock(`${refLabel(ref)}（本次压缩定位）`, ref.text.split('\n')),
      '',
    );
  }
  return lines.length === 0 ? ['(none)'] : lines.slice(0, -1);
}

/** The three checks that run on the assembled summary. */
function audit(
  text: string,
  carried: readonly CarriedFragment[],
  resolved: readonly ResolvedRef[],
): string[] {
  return [
    ...validateStructure(parseSections(text)),
    ...validateCarried(text, carried, resolved),
    ...validateBinding(resolved),
  ];
}

/** One compaction's model calls and their single-call usage. */
class Runner {
  private calls = 0;
  private usage: TokenUsage | undefined;

  constructor(
    private readonly ctx: Context,
    private readonly base: ResolvedConfig,
    private readonly agent: Agent,
    private readonly target: { provider: string; model: string },
    private readonly head: readonly Message[],
    private readonly tools: readonly ToolSchema[] | undefined,
    private readonly signal: AbortSignal | undefined,
  ) {}

  /**
   * Run one summarization call. A non-empty `document` is the numbered region;
   * the merge call has no region and passes `''`.
   *
   * @param document - the numbered region, or `''`.
   * @param instruction - the directive delivered as the same user message.
   * @returns the model's text output.
   */
  async ask(document: string, instruction: string): Promise<string> {
    const content: ContentBlock[] = [];
    if (document.length > 0) {
      content.push({
        type: 'text',
        text: `以下是本次待压缩的会话原文，已按来源编号标注。\n\n${document}`,
      });
    }
    content.push({ type: 'text', text: instruction });

    const options: GenerateOptions = {
      provider: this.target.provider,
      model: this.target.model,
      messages: [
        ...this.head,
        createUserMessage({ content, source: { kind: 'plugin', plugin: PLUGIN } }),
      ],
      ...(this.tools === undefined ? {} : { tools: [...this.tools] }),
      maxTokens: this.base.maxTokens,
      sessionId: this.agent.session.id,
      purpose: 'compaction',
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    };

    this.calls += 1;
    const streamed = await streamText(this.ctx, options);
    if (this.calls === 1) this.usage = streamed.usage;
    return streamed.text;
  }

  /** True when exactly one model call was made, so a single call identity is honest. */
  get singleCall(): boolean {
    return this.calls === 1;
  }

  /** Usage from the first call; reported only when that call is the only one. */
  get firstCallUsage(): TokenUsage | undefined {
    return this.usage;
  }
}

/**
 * Resolve one draft's citations, then replace the preserved section with the
 * text copied from them.
 *
 * A draft with no preserved section is returned unchanged: V1 reports that gap
 * so the citation-only rule and the missing section are not both reported.
 */
function assembleCitations(
  draft: string,
  index: SourceIndex,
  carried: readonly CarriedFragment[],
): { readonly text: string; readonly resolved: readonly ResolvedRef[]; readonly problems: readonly string[] } {
  const parsed = parseSections(draft);
  if (!parsed.sections.some((section) => section.key === 'invariants')) {
    return { text: draft, resolved: [], problems: [] };
  }

  const problems: string[] = [];
  const resolved: ResolvedRef[] = [];
  const parsedRefs = parseRefs(sectionBody(parsed, 'invariants'));
  problems.push(...parsedRefs.problems);
  if (parsedRefs.refs.length === 0 && !parsedRefs.none && parsedRefs.problems.length === 0) {
    problems.push('[invariants] 既没有来源引用也没有 (none)');
  }
  for (const ref of parsedRefs.refs) {
    const outcome = resolveRef(index, ref);
    if (!outcome.ok) {
      problems.push(outcome.problem);
      continue;
    }
    if (isSubsumed(outcome.resolved, carried)) continue;
    resolved.push(outcome.resolved);
  }

  return {
    text: replaceSection(draft, 'invariants', buildInvariantBody(carried, resolved)),
    resolved,
    problems,
  };
}

/** Single-pass compaction: one call, one repair at most. */
async function singlePass(
  runner: Runner,
  academicResearch: ResolvedAcademicResearchConfig,
  index: SourceIndex,
  carried: readonly CarriedFragment[],
): Promise<string> {
  const document = renderUnits(index);
  const instruction = buildInstruction(academicResearch);

  const first = assembleCitations(await runner.ask(document, instruction), index, carried);
  let problems = [...first.problems, ...audit(first.text, carried, first.resolved)];
  if (problems.length === 0) return first.text;

  const repaired = assembleCitations(
    await runner.ask(document, withRepair(instruction, problems)),
    index,
    carried,
  );
  problems = [...repaired.problems, ...audit(repaired.text, carried, repaired.resolved)];
  if (problems.length === 0) return repaired.text;

  throw new Error(
    `dsh-academic-research: 摘要未通过检查，且一次修复仍未通过：\n- ${problems.join('\n- ')}`,
  );
}

/** Split sources into consecutive chunks of at most `size`. */
function chunkUnits(units: SourceIndex, size: number): SourceIndex[] {
  const chunks: SourceIndex[] = [];
  for (let start = 0; start < units.length; start += size) {
    chunks.push(units.slice(start, start + size));
  }
  return chunks;
}

/**
 * Chunked compaction: digest each chunk with its own citations, copy the cited
 * text, then merge the digests with the copied text already in place.
 *
 * A chunk-stage failure is terminal. The one repair re-asks the merge, which
 * never sees the chunks, so it cannot fix a chunk's citations; retrying it
 * would spend a call on something it cannot reach.
 */
async function chunked(
  runner: Runner,
  academicResearch: ResolvedAcademicResearchConfig,
  index: SourceIndex,
  carried: readonly CarriedFragment[],
): Promise<string> {
  const partials: string[] = [];
  const resolved: ResolvedRef[] = [];
  const problems: string[] = [];

  for (const units of chunkUnits(index, academicResearch.chunkMessages)) {
    const digest = await runner.ask(renderUnits(units), partialInstruction(academicResearch));
    partials.push(digest);
    const parsedRefs = parseRefs(sectionBody(parseSections(digest), 'invariants'));
    problems.push(...parsedRefs.problems);
    for (const ref of parsedRefs.refs) {
      const outcome = resolveRef(units, ref);
      if (!outcome.ok) {
        problems.push(outcome.problem);
        continue;
      }
      if (isSubsumed(outcome.resolved, carried)) continue;
      if (resolved.some((existing) => existing.text === outcome.resolved.text)) continue;
      resolved.push(outcome.resolved);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `dsh-academic-research: 分段摘要未通过检查，而一次修复只能触达合并阶段，故不提交：\n- ${problems.join('\n- ')}`,
    );
  }

  const body = buildInvariantBody(carried, resolved);
  const instruction = mergeInstruction(academicResearch, partials, body);

  let text = replaceSection(await runner.ask('', instruction), 'invariants', body);
  let failures = audit(text, carried, resolved);
  if (failures.length === 0) return text;

  text = replaceSection(await runner.ask('', withRepair(instruction, failures)), 'invariants', body);
  failures = audit(text, carried, resolved);
  if (failures.length === 0) return text;

  throw new Error(
    `dsh-academic-research: 摘要未通过检查，且一次修复仍未通过：\n- ${failures.join('\n- ')}`,
  );
}

/**
 * Run dsh-academic-research summarization for one region.
 *
 * @param ctx - context providing the LLM service.
 * @param base - the inherited, resolved base compaction policy.
 * @param academicResearch - the resolved dsh-academic-research configuration.
 * @param input - the derived system head followed by the shadowed region.
 * @param agent - supplies the routed target and session identity.
 * @param signal - optional cancellation, forwarded into every call.
 * @returns the assembled checkpoint and its call envelope.
 */
export async function summarizeRegion(
  ctx: Context,
  base: ResolvedConfig,
  academicResearch: ResolvedAcademicResearchConfig,
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  let cut = 0;
  while (cut < input.messages.length && input.messages[cut]?.role === 'system') cut += 1;
  const head = input.messages.slice(0, cut);
  const region = input.messages.slice(cut);

  const index = buildSourceIndex(region);
  const carried = extractCarriedFragments(index);
  const target = resolveTarget(agent, base);
  const runner = new Runner(ctx, base, agent, target, head, input.tools, signal);

  const text =
    academicResearch.recursive && region.length > academicResearch.chunkMessages
      ? await chunked(runner, academicResearch, index, carried)
      : await singlePass(runner, academicResearch, index, carried);

  const summary: ContentBlock[] = [{ type: 'text', text }];
  const common = {
    summary,
    rawOutput: summary,
    provider: target.provider,
    model: target.model,
    maxTokens: base.maxTokens,
  };
  if (!runner.singleCall) return { ...common };
  const usage = runner.firstCallUsage;
  return {
    ...common,
    ...(usage === undefined ? {} : { usage }),
    llmStreamCall: true,
  };
}
