/**
 * Source numbering and verbatim extraction — "模型选来源，程序复制原文".
 *
 * Before the compaction call, the program renders the region being compacted
 * into addressable lines (`[S7]` followed by `L1: ...`) while keeping the
 * original text. The program does not decide what matters; it only records
 * where each line came from. The model cites ranges; the program resolves them
 * back to the exact rendered lines. Nothing in this module judges importance,
 * and nothing here claims a citation is semantically correct (Schema §1.3).
 *
 * @module dsh-academic-research/sources
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm';
import type {
  CarriedFragment,
  ResolveOutcome,
  SourceBlock,
  SourceIndex,
  SourceRef,
  SourceUnit,
} from './types.ts';

/** Prefix of an unaddressable structural marker line. Markers can never be cited. */
const MARKER = '-- ';

/** Label recorded on fragments carried forward from the previous checkpoint. */
export const CARRIED_SOURCE = '前次检查点（继续携带）';

/** Opening tag of a checkpoint written by any compaction backend. */
const SUMMARY_OPEN = '<compacted-summary>';

/** Closing tag of a checkpoint. */
const SUMMARY_CLOSE = '</compacted-summary>';

/** Heading of the precisely-preserved section. */
const INVARIANT_HEADING = /^##\s*\[invariants\]/;

/** Any six-section heading, used to bound the preserved section. */
const ANY_HEADING = /^##\s*\[/;

/** `来源：<label>` line inside a preserved section. */
const SOURCE_LABEL = /^来源[：:]\s*(.*)$/;

/** `原文：` line introducing the preserved lines. */
const ORIGIN_LABEL = /^原文[：:]\s*$/;

/** One citation line, with the bullet optional and the end line optional. */
const REF_PATTERN = /^(S\d+)\s*:\s*L(\d+)\s*(?:-\s*L?(\d+))?$/;

/**
 * The label one citation is recorded and reported under.
 *
 * A single-line citation keeps the `S7:L3` shape the model wrote, so a recorded
 * label reads the same as the citation that produced it.
 *
 * @param ref - the citation.
 * @returns its label.
 */
export function refLabel(ref: SourceRef): string {
  return ref.from === ref.to
    ? `${ref.source}:L${ref.from}`
    : `${ref.source}:L${ref.from}-L${ref.to}`;
}

/** Render one content block tree into addressable blocks. */
function renderContent(content: readonly ContentBlock[], out: SourceBlock[]): void {
  for (const block of content) {
    switch (block.type) {
      case 'text':
        out.push({ lines: block.text.split('\n') });
        break;
      case 'reasoning':
        out.push({ header: 'reasoning', lines: block.text.split('\n') });
        break;
      case 'tool-call':
        out.push({
          header: `tool-call name=${block.name} id=${block.id}`,
          lines: block.arguments.split('\n'),
        });
        break;
      case 'tool-result':
        out.push({
          header: `tool-result id=${block.toolCallId} isError=${block.isError === true}`,
          lines: [],
        });
        renderContent(block.content, out);
        break;
      case 'image':
        out.push({ header: 'image', lines: [] });
        break;
      case 'file':
        out.push({ header: 'file', lines: [] });
        break;
      default:
        /* Unreachable for the blocks this runtime defines; a future block type
           must be rendered deliberately rather than silently dropped. */
        throw new Error(
          `dsh-academic-research: unsupported content block "${(block as { type: string }).type}" in the region being compacted`,
        );
    }
  }
}

/**
 * Number every message of the region, preserving its text verbatim.
 *
 * @param messages - the shadowed region in surface order.
 * @returns the addressable index, with `S1` naming the first message.
 */
export function buildSourceIndex(messages: readonly Message[]): SourceIndex {
  const units: SourceUnit[] = [];
  let ordinal = 1;
  for (const message of messages) {
    const blocks: SourceBlock[] = [];
    renderContent(message.content, blocks);
    units.push({
      id: `S${ordinal}`,
      role: message.role,
      blocks,
      lines: blocks.flatMap((block) => block.lines),
    });
    ordinal += 1;
  }
  return units;
}

/** Render the given sources as the numbered document the model receives. */
export function renderUnits(units: SourceIndex): string {
  const out: string[] = [];
  for (const unit of units) {
    out.push(`[${unit.id}] role=${unit.role}`);
    let lineNumber = 1;
    for (const block of unit.blocks) {
      if (block.header !== undefined) out.push(`${MARKER}${block.header}`);
      for (const text of block.lines) {
        out.push(`L${lineNumber}: ${text}`);
        lineNumber += 1;
      }
    }
  }
  return out.join('\n');
}

/** Citations parsed out of a `[invariants]` draft. */
export interface ParsedRefs {
  readonly refs: readonly SourceRef[];
  readonly none: boolean;
  /** Lines that are not citations; each one is a V1 failure. */
  readonly problems: readonly string[];
}

/**
 * Parse the citation-only `[invariants]` draft body.
 *
 * @param bodyLines - the section body exactly as the model wrote it.
 * @returns parsed citations plus every line that breaks the citation-only rule.
 */
export function parseRefs(bodyLines: readonly string[]): ParsedRefs {
  const refs: SourceRef[] = [];
  const problems: string[] = [];
  let none = false;
  for (const raw of bodyLines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line === '(none)') {
      none = true;
      continue;
    }
    const match = REF_PATTERN.exec(line.replace(/^[-*]\s*/, ''));
    if (match === null) {
      problems.push(`[invariants] 只允许来源引用（形如 S7:L1-L4），实际出现了：${line}`);
      continue;
    }
    /* The pattern requires groups 1 and 2, so both are present. */
    const from = Number(match[2]!);
    const to = match[3] === undefined ? from : Number(match[3]);
    refs.push({ source: match[1]!, from, to });
  }
  if (none && refs.length > 0) problems.push('[invariants] 同时写了 (none) 和来源引用');
  return { refs, none, problems };
}

/**
 * Resolve one citation to the exact lines it names.
 *
 * @param index - the index the citation was written against.
 * @param ref - the citation.
 * @returns the resolved text, or the reason the citation is unusable.
 */
export function resolveRef(index: SourceIndex, ref: SourceRef): ResolveOutcome {
  const unit = index.find((candidate) => candidate.id === ref.source);
  if (unit === undefined) {
    if (index.length === 0) {
      return { ok: false, problem: `引用 ${ref.source} 不存在：本次没有可引用的来源` };
    }
    const first = index[0]!;
    const last = index[index.length - 1]!;
    return {
      ok: false,
      problem: `引用 ${ref.source} 不存在（本次可引用范围：${first.id}–${last.id}）`,
    };
  }
  if (ref.from < 1 || ref.to < ref.from || ref.to > unit.lines.length) {
    return {
      ok: false,
      problem: `引用 ${refLabel(ref)} 越界（${ref.source} 共 ${unit.lines.length} 行）`,
    };
  }
  return {
    ok: true,
    resolved: { ...ref, text: unit.lines.slice(ref.from - 1, ref.to).join('\n') },
  };
}

/** Find the last line matching `pattern` within `[from, to)`. */
function lastIndexOfPattern(
  lines: readonly string[],
  pattern: RegExp,
  from: number,
  to: number,
): number {
  for (let index = to - 1; index >= from; index -= 1) {
    if (pattern.test(lines[index] ?? '')) return index;
  }
  return -1;
}

/** Find the first line matching `pattern` within `[from, to)`. */
function firstIndexOfPattern(
  lines: readonly string[],
  pattern: RegExp,
  from: number,
  to: number,
): number {
  for (let index = from; index < to; index += 1) {
    if (pattern.test(lines[index] ?? '')) return index;
  }
  return -1;
}

/**
 * Read the previous checkpoint's preserved fragments out of the region.
 *
 * This is the only independently specified must-keep set the program has
 * (Schema §1.3): the fragments an earlier checkpoint already preserved. They
 * are not re-selected by the model, so carry-forward does not depend on a weak
 * model noticing them.
 *
 * @param index - the region's source index.
 * @returns the preserved fragments in recorded order, empty when none.
 */
export function extractCarriedFragments(index: SourceIndex): readonly CarriedFragment[] {
  const lines = index.flatMap((unit) => unit.lines);
  const open = lines.lastIndexOf(SUMMARY_OPEN);
  if (open < 0) return [];
  const close = lines.indexOf(SUMMARY_CLOSE, open + 1);
  const end = close < 0 ? lines.length : close;
  const heading = lastIndexOfPattern(lines, INVARIANT_HEADING, open, end);
  if (heading < 0) return [];
  const nextHeading = firstIndexOfPattern(lines, ANY_HEADING, heading + 1, end);
  const stop = nextHeading < 0 ? end : nextHeading;

  const fragments: CarriedFragment[] = [];
  let label: string | null = null;
  let body: string[] = [];
  for (let index_ = heading + 1; index_ < stop; index_ += 1) {
    const line = lines[index_] ?? '';
    const matched = SOURCE_LABEL.exec(line);
    if (matched !== null) {
      if (label !== null) fragments.push({ source: label, lines: body });
      label = matched[1] ?? '';
      body = [];
      continue;
    }
    if (ORIGIN_LABEL.test(line)) continue;
    if (label !== null && line.trim().length > 0) body.push(line);
  }
  if (label !== null) fragments.push({ source: label, lines: body });
  return fragments.filter((fragment) => fragment.lines.length > 0);
}

/** Render one `来源：`/`原文：` block for the final preserved section. */
export function renderInvariantBlock(source: string, lines: readonly string[]): string {
  return [`来源：${source}`, '原文：', ...lines].join('\n');
}

/**
 * True when a fragment carried from the previous checkpoint already preserves
 * this citation **on line boundaries**.
 *
 * Not a plain substring test. `seed=421` contains `seed=42`, and treating that
 * as "already carried" silently drops a genuinely new value: the dropped ref
 * never reaches `resolved`, so V2 cannot see it, no repair is triggered, and the
 * checkpoint is accepted with the new value missing. Matching whole lines keeps
 * the legitimate case — a citation that is a sub-range of a carried fragment
 * really is preserved already — without conflating distinct values.
 */
export function isSubsumed(
  resolved: { readonly text: string },
  carried: readonly CarriedFragment[],
): boolean {
  return carried.some((fragment) => {
    const haystack = fragment.lines.join('\n');
    const needle = resolved.text;
    return (
      haystack === needle
      || haystack.startsWith(`${needle}\n`)
      || haystack.endsWith(`\n${needle}`)
      || haystack.includes(`\n${needle}\n`)
    );
  });
}
