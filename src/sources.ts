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
  CarriedOutcome,
  EvictedFragment,
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

/**
 * Label prefix of the eviction trace the program writes for a fragment it
 * dropped. It is written once, in the compaction that drops the fragment; the
 * next compaction reads it back and ignores it rather than carrying it on.
 */
export const EVICTED_SOURCE = '前次检查点（已淘汰';

/**
 * The label of one eviction trace block.
 *
 * @param key - the line key whose later value superseded the fragment.
 * @returns the recorded label.
 */
export function evictionLabel(key: string): string {
  return `${EVICTED_SOURCE} · ${key} 已有更新值）`;
}

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

/** Separator between several citations written on one line. */
const REF_SEPARATOR = /[,，、]/;

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
 * One line may carry several citations of the same source, separated by a
 * comma. That is what a real model wrote (`- S139:L2, S139:L7-L8, S139:L20-L21`)
 * and rejecting it would fail the whole compaction on a formatting choice the
 * contract never forbade. Every citation in the list is still resolved and
 * copied verbatim, so accepting the list costs no fidelity.
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
    const listed: SourceRef[] = [];
    const parts = line
      .replace(/^[-*]\s*/, '')
      .split(REF_SEPARATOR)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    /* An empty list means the line held separators or a bullet and nothing else. */
    let legal = parts.length > 0;
    for (const part of parts) {
      const match = REF_PATTERN.exec(part);
      if (match === null) {
        legal = false;
        break;
      }
      /* The pattern requires groups 1 and 2, so both are present. */
      const from = Number(match[2]!);
      const to = match[3] === undefined ? from : Number(match[3]);
      listed.push({ source: match[1]!, from, to });
    }
    if (!legal) {
      problems.push(
        `[invariants] 只允许来源引用（形如 S7:L1-L4；同一来源的多个行段可写在一行，用逗号分隔），实际出现了：${line}`,
      );
      continue;
    }
    refs.push(...listed);
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
 * Drop the one blank line the block format leaves after a fragment's content.
 *
 * Exactly one line, never "every trailing blank": a blank line **inside** a
 * preserved excerpt is part of the verbatim text, and a real checkpoint already
 * holds one (`call 1: …` / blank / `=== 通过 ===`). Discarding blank lines
 * wholesale rewrote carried text on its way from one checkpoint into the next,
 * and V2 could not see it — it compares the fragment that was already rewritten.
 * The one ambiguity the line format cannot resolve is a fragment whose own last
 * line is blank: that is indistinguishable from the separator.
 *
 * @param lines - the lines collected after one `原文：` marker.
 * @returns the same lines without the single trailing separator.
 */
function withoutBlockSeparator(lines: readonly string[]): readonly string[] {
  const last = lines[lines.length - 1];
  return last !== undefined && last.trim().length === 0 ? lines.slice(0, -1) : lines;
}

/** One line's replaceable value: a name-like key and the value recorded under it. */
interface KeyedLine {
  readonly key: string;
  readonly value: string;
}

/** `<key>=<scalar>` / `<key>: <scalar>` — an assignment or a labelled scalar. */
const ASSIGNED_VALUE = /^([A-Za-z_][A-Za-z0-9_.]*)\s*[=:：]\s*(\S{1,64})$/;

/** A scalar value: one run with no code or list punctuation in it. */
const SCALAR_VALUE = /^[^\s,;()\[\]{}'"]+$/;

/** `<key> <number> <rest>` — a counted or measured value, e.g. `Tests  31 passed`. */
const COUNTED_VALUE = /^([A-Za-z_][A-Za-z0-9_.]*)\s+(-?\d[\d,_]*(?:\.\d+)?%?)(?=\s|$)(.*)$/;

/**
 * Read a line's key and value, or null when the line records no single value.
 *
 * Deliberately narrow, and narrower than "looks like `key: value`". It must not
 * fire on a quoted code line — a real checkpoint preserves `maxTokens:
 * config.maxTokens,` and `return 0;` from source excerpts, and those are not
 * settings whose later value replaces them:
 *
 * - a value must be one scalar run with no `,;()[]{}'"` in it, so
 *   `maxTokens: config.maxTokens,` is unkeyed;
 * - a counted line needs the number to be followed by a word or nothing, so
 *   `return 0;` is unkeyed;
 * - `dsh-academic-research: 摘要未通过…` (spaces in the value), `call 1: …`
 *   (a `:` after the counted number), `raw     : [{...}]` (JSON) and
 *   `M README.md` (no separator, not a number) are unkeyed as well;
 * - multi-word values (`baseline: resnet50 on split-A`) are unkeyed: an update
 *   to one is not mechanically recognisable, and guessing would drop text that
 *   may still hold.
 *
 * @param line - one line of a preserved fragment or of a later record.
 * @returns the line's key and value, or null when it has none.
 */
function keyedLine(line: string): KeyedLine | null {
  const text = line.trim();
  if (text.length === 0) return null;
  const assigned = ASSIGNED_VALUE.exec(text);
  if (assigned !== null) {
    return SCALAR_VALUE.test(assigned[2]!) ? { key: assigned[1]!, value: assigned[2]! } : null;
  }
  const counted = COUNTED_VALUE.exec(text);
  if (counted === null) return null;
  const rest = counted[3]!.trim();
  if (rest.length > 0 && !/^\p{L}/u.test(rest)) return null;
  return { key: counted[1]!, value: `${counted[2]!} ${rest}`.trim() };
}

/**
 * True when two recorded values are numbers and one merely spells out more
 * digits of the other.
 *
 * `seed=421` and `seed=42` are two recorded seeds, not a newer value of one
 * setting — Schema §4.1 uses exactly that pair to require both to survive. A
 * longer number that extends a shorter one is therefore read as a different
 * value, so the fragment stays; the cost is a missed eviction (`steps=42` →
 * `steps=421`) in exchange for never dropping a record that is still valid.
 *
 * @param earlier - the value recorded in the preserved fragment.
 * @param later - the value recorded after the checkpoint.
 * @returns true when the two differ only by extra digits.
 */
function extendsDigits(earlier: string, later: string): boolean {
  const pureNumber = /^-?\d+(?:\.\d+)?%?$/;
  const a = earlier.replace(/[,_]/g, '');
  const b = later.replace(/[,_]/g, '');
  if (!pureNumber.test(a) || !pureNumber.test(b)) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Say whether a fragment has been replaced, and by which key.
 *
 * Only records **after** the checkpoint count: a value written earlier is the
 * older one, not an update. A fragment qualifies only when every one of its
 * lines is a keyed line and every one of those keys has a later value that
 * differs from the fragment's — the whole fragment is stale, not part of it.
 * That is what keeps the rule from dropping mixed blocks (a log excerpt with
 * prose in it) and from rewriting a fragment line by line, which would stop it
 * being the verbatim text the checkpoint promised to preserve.
 *
 * @param fragment - the preserved lines, exactly as recorded.
 * @param later - every region line after the previous checkpoint.
 * @returns the superseding key, or undefined when the fragment is still current.
 */
function supersededBy(
  fragment: readonly string[],
  later: readonly string[],
): KeyedLine | undefined {
  const keys = fragment.map(keyedLine);
  if (keys.length === 0 || keys.some((keyed) => keyed === null)) return undefined;
  let superseding: KeyedLine | undefined;
  for (const keyed of keys as readonly KeyedLine[]) {
    let latest: string | undefined;
    for (const line of later) {
      const other = keyedLine(line);
      if (other !== null && other.key === keyed.key) latest = other.value;
    }
    /* A key that disappears later is not an update: the record was not replaced. */
    if (latest === undefined || latest === keyed.value) return undefined;
    if (extendsDigits(keyed.value, latest)) return undefined;
    superseding ??= { key: keyed.key, value: latest };
  }
  return superseding;
}

/**
 * Read the previous checkpoint's preserved fragments out of the region.
 *
 * This is the only independently specified must-keep set the program has
 * (Schema §1.3): the fragments an earlier checkpoint already preserved. They
 * are not re-selected by the model, so carry-forward does not depend on a weak
 * model noticing them. What is carried is the recorded text itself, blank lines
 * included; a fragment that preserves nothing but blank lines is dropped.
 *
 * A fragment whose value a later record replaced is **not** carried: keeping
 * `Tests  31 passed (31)` next to `Tests  34 passed (34)` leaves the reader to
 * guess which number is current, and the carry set otherwise only grows. The
 * decision is mechanical ({@link supersededBy}) and never silent — evicted
 * fragments come back in `evicted` so the compaction can publish them once.
 *
 * @param index - the region's source index.
 * @returns the carried fragments and the ones dropped as superseded.
 */
export function extractCarriedOutcome(index: SourceIndex): CarriedOutcome {
  const lines = index.flatMap((unit) => unit.lines);
  const open = lines.lastIndexOf(SUMMARY_OPEN);
  if (open < 0) return { kept: [], evicted: [] };
  const close = lines.indexOf(SUMMARY_CLOSE, open + 1);
  const end = close < 0 ? lines.length : close;
  const heading = lastIndexOfPattern(lines, INVARIANT_HEADING, open, end);
  if (heading < 0) return { kept: [], evicted: [] };
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
    if (label !== null) body.push(line);
  }
  if (label !== null) fragments.push({ source: label, lines: body });

  const readable = fragments
    .map((fragment) => ({ source: fragment.source, lines: withoutBlockSeparator(fragment.lines) }))
    .filter((fragment) => fragment.lines.some((line) => line.trim().length > 0));

  const later = lines.slice(end);
  const kept: CarriedFragment[] = [];
  const evicted: EvictedFragment[] = [];
  for (const fragment of readable) {
    /* The program's own eviction trace is published once, then dropped here
       instead of being carried on as if it were preserved source text. */
    if (fragment.source.startsWith(EVICTED_SOURCE)) continue;
    const superseding = supersededBy(fragment.lines, later);
    if (superseding === undefined) kept.push(fragment);
    else evicted.push({ ...fragment, key: superseding.key });
  }
  return { kept, evicted };
}

/**
 * The fragments the next compaction must carry, in recorded order.
 *
 * @param index - the region's source index.
 * @returns the fragments still current, empty when there are none.
 */
export function extractCarriedFragments(index: SourceIndex): readonly CarriedFragment[] {
  return extractCarriedOutcome(index).kept;
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
