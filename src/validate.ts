/**
 * The four bounded checks of Schema §4.2, plus the section parsing the
 * assembly step needs.
 *
 * The checks are deliberately narrow. V2 proves that a selected fragment was
 * copied without being rewritten; it does not prove the selection was complete
 * or that the record is correct. V3 only refuses a bare-number slice; it does
 * not verify that a range semantically belongs to the experiment it names.
 * Neither claims to detect every implied semantic error.
 *
 * @module dsh-academic-research/validate
 */

import { refLabel } from './sources.ts';
import type { CarriedFragment, ResolvedRef } from './types.ts';

/** The six section keys, in the only accepted order. */
export const SECTION_KEYS = [
  'goal',
  'experiments',
  'evidence',
  'analysis',
  'invariants',
  'open',
] as const;

/** The seven experiment-ledger field keys. */
export const EXPERIMENT_FIELDS = [
  'purpose',
  'design',
  'config',
  'status',
  'result',
  'artifacts',
  'conclusion',
] as const;

/**
 * The five stage words of Schema §2.7. Frozen — do not add synonyms, and do not
 * reuse them for `[experiments].status` or `conclusion`: whether an experiment
 * ran, whether a plan was confirmed, and whether a claim is verified are three
 * different questions.
 */
export const DECISION_STATES = ['建议', '已确认', '已实现', '已验证', '已否认'] as const;

/**
 * Machine-stable field keys of one `[analysis]` decision entry (Schema §2.4).
 *
 * ASCII on purpose: the checks must never depend on the session language, while
 * the prose around them follows the conversation. The prompt renders its
 * template from this same object, so prompt and validator cannot drift apart.
 */
export const DECISION_KEYS = {
  /** Opens an entry: a proposed action or decision, including unconfirmed ones. */
  decision: 'decision',
  /** One of {@link DECISION_STATES}. Required on every non-empty entry. */
  state: 'state',
  /** The recorded basis. Required; `—` is allowed when no source exists. */
  basis: 'basis',
  /** Required when the state is `建议`; names a `Q<n>` present in `[open]`. */
  question: 'question',
  /** Explanation, analysis, or inference. Carries no state. */
  judgement: 'judgement',
} as const;

/**
 * Machine-stable field keys of `[goal]` (Schema §2.1).
 *
 * A checkpoint is a progress report, not a task dump: a reader who never saw the
 * session must first learn what the project's mainline is and how far this step
 * moved it, before reading the current task.
 */
export const GOAL_KEYS = {
  /** Project mainline: the overall goal, the current stage or item, its acceptance. */
  mainline: 'mainline',
  /** This session's advance: what moved, to where, what is still missing. */
  progress: 'progress',
} as const;

/** One `[analysis]` decision entry under construction. */
interface DecisionEntry {
  readonly label: string;
  readonly value: string;
  state: string | undefined;
  basis: string | undefined;
  question: string | undefined;
}

/** One parsed section. */
export interface SummarySection {
  readonly key: string;
  readonly heading: string;
  readonly bodyLines: readonly string[];
}

/** A summary parsed into its sections, in document order. */
export interface ParsedSummary {
  readonly sections: readonly SummarySection[];
}

/** `## [key] label`. */
const HEADING = /^##\s*\[([a-z]+)\]\s*(.*)$/;

/** A bare experiment entry line. */
const ENTRY = /^E(\d+)$/;

/** One experiment-ledger field line. */
const FIELD = /^(purpose|design|config|status|result|artifacts|conclusion)\s*[:：]\s*(.*)$/;

/** A number that is not part of a longer identifier. */
const BARE_NUMBER = /(?<![\w.])[-+]?\d[\d,]*(?:\.\d+)?(?:[eE][-+]?\d+)?(?![\w])/;

/**
 * Any Unicode letter, in any script — CJK ideographs included.
 *
 * The whole V3 predicate: a range that carries numbers and **no letter at all**
 * is a bare-number slice. Deliberately not a list of recognised anchor words.
 * Two real rounds produced false positives from such a list — first on
 * identifier-rich prose with no colon or path, then on a purely Chinese decision
 * record (`状态：建议；依据：…；关联：Q1`) that matched no ASCII anchor — and the
 * only way to keep a word list alive is to keep adding to it. Requiring merely
 * *some* letter cannot drift that way, and cannot fail on real prose.
 */
const HAS_LETTER = /\p{L}/u;

/** Strip an optional list bullet from one line. */
function stripBullet(line: string): string {
  return line.trim().replace(/^[-*]\s*/, '');
}

/**
 * Split a summary into its sections.
 *
 * @param text - the model's checkpoint text.
 * @returns every `## [key]` section in document order.
 */
export function parseSections(text: string): ParsedSummary {
  const sections: SummarySection[] = [];
  let key: string | null = null;
  let heading = '';
  let body: string[] = [];
  for (const line of text.split('\n')) {
    const matched = HEADING.exec(line);
    if (matched !== null) {
      if (key !== null) sections.push({ key, heading, bodyLines: body });
      key = matched[1]!;
      heading = line;
      body = [];
      continue;
    }
    if (key !== null) body.push(line);
  }
  if (key !== null) sections.push({ key, heading, bodyLines: body });
  return { sections };
}

/** Return one section's body, or an empty list when the section is absent. */
export function sectionBody(parsed: ParsedSummary, key: string): readonly string[] {
  return parsed.sections.find((section) => section.key === key)?.bodyLines ?? [];
}

/**
 * Replace one section's body, keeping its heading and every other line.
 *
 * Returns the text unchanged when the section is absent: `validateStructure`
 * reports that gap, so a missing section reaches the one repair attempt instead
 * of aborting the compaction, and the gap is reported exactly once.
 *
 * @param text - the checkpoint text.
 * @param key - the section to rewrite.
 * @param bodyLines - the lines that become the section body.
 * @returns the rewritten text.
 */
export function replaceSection(
  text: string,
  key: string,
  bodyLines: readonly string[],
): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => HEADING.exec(line)?.[1] === key);
  if (start < 0) return text;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (HEADING.test(lines[index] ?? '')) {
      end = index;
      break;
    }
  }
  return [
    ...lines.slice(0, start + 1),
    '',
    ...bodyLines,
    '',
    ...lines.slice(end),
  ].join('\n');
}

/** V1: the six keys, their order, and the experiment ledger's seven fields. */
function checkExperiments(bodyLines: readonly string[]): string[] {
  const problems: string[] = [];
  const significant = bodyLines.map(stripBullet).filter((line) => line.length > 0);
  if (significant.length === 1 && (significant[0] === '(none)' || significant[0] === '—')) {
    return problems;
  }

  let entry: string | null = null;
  let fields = new Map<string, string>();
  const flush = (): void => {
    if (entry === null) return;
    for (const field of EXPERIMENT_FIELDS) {
      const value = fields.get(field);
      if (value === undefined) problems.push(`实验 ${entry} 缺少字段 ${field}`);
      else if (value.trim().length === 0) {
        problems.push(`实验 ${entry} 的字段 ${field} 是空白（缺值必须写 —）`);
      }
    }
  };

  for (const line of significant) {
    const matchedEntry = ENTRY.exec(line);
    if (matchedEntry !== null) {
      flush();
      entry = `E${matchedEntry[1]!}`;
      fields = new Map();
      continue;
    }
    const matchedField = FIELD.exec(line);
    if (matchedField !== null) {
      if (entry === null) {
        problems.push(`字段 ${matchedField[1]!} 出现在任何 E 编号之前`);
        continue;
      }
      fields.set(matchedField[1]!, matchedField[2] ?? '');
      continue;
    }
    problems.push(
      `实验台账只允许 \`E<编号>\` 行和七个字段键，实际出现了：${line}`,
    );
  }
  flush();
  return problems;
}

/**
 * Split `[analysis]` into decision entries.
 *
 * Only the decision field keys are interpreted; every other line is narrative
 * and is deliberately left alone. The check never scans for decisions the model
 * failed to register — that would be guessing at intent, not reading a contract.
 *
 * @param bodyLines - the `[analysis]` body.
 * @returns the entries, plus any decision key that appeared before its opener.
 */
function readDecisionEntries(bodyLines: readonly string[]): {
  readonly entries: readonly DecisionEntry[];
  readonly problems: readonly string[];
} {
  const entries: DecisionEntry[] = [];
  const problems: string[] = [];
  let current: DecisionEntry | null = null;
  for (const raw of bodyLines) {
    const matched = /^([a-z]+)\s*[:：]\s*(.*)$/.exec(stripBullet(raw));
    if (matched === null) continue;
    const key = matched[1]!;
    const value = (matched[2] ?? '').trim();
    if (key === DECISION_KEYS.decision) {
      current = {
        label: `第 ${entries.length + 1} 条 \`decision:\``,
        value,
        state: undefined,
        basis: undefined,
        question: undefined,
      };
      entries.push(current);
      continue;
    }
    if (
      key !== DECISION_KEYS.state
      && key !== DECISION_KEYS.basis
      && key !== DECISION_KEYS.question
    ) {
      continue;
    }
    if (current === null) {
      problems.push(`[analysis] 的 \`${key}:\` 出现在任何 \`decision:\` 之前`);
      continue;
    }
    if (key === DECISION_KEYS.state) current.state = value;
    else if (key === DECISION_KEYS.basis) current.basis = value;
    else current.question = value;
  }
  return { entries, problems };
}

/**
 * V1 (Schema §2.7): `[analysis]` decision entries are labelled and carry a
 * state and a basis, and a `建议` entry cites a `Q<n>` that `[open]` contains.
 *
 * Passing this check means the record is well formed. It does **not** mean the
 * state agrees with the underlying evidence, and it grants no authorization to
 * execute anything — `basis: 用户已确认` is the model's record, not the
 * program's finding.
 *
 * @param analysis - the `[analysis]` body.
 * @param open - the `[open]` body, or `undefined` when that section is absent.
 * @returns one line per failure.
 */
function checkDecisions(
  analysis: readonly string[],
  open: readonly string[] | undefined,
): string[] {
  const read = readDecisionEntries(analysis);
  const problems: string[] = [...read.problems];
  if (read.entries.length === 0) {
    problems.push(
      `[analysis] 缺少 \`${DECISION_KEYS.decision}:\`（没有决定时写一行 \`${DECISION_KEYS.decision}: (none)\`）`,
    );
    return problems;
  }

  const questions = new Set<string>();
  for (const raw of open ?? []) {
    for (const matched of stripBullet(raw).matchAll(/\bQ\d+\b/g)) questions.add(matched[0]!);
  }

  for (const entry of read.entries) {
    if (entry.value === '(none)') continue; // 空项豁免：不要求状态，也不要求编造决定
    if (entry.value.length === 0) {
      problems.push(
        `[analysis] ${entry.label} 的值为空（没有决定写 (none)）`,
      );
      continue;
    }
    if (entry.state === undefined || entry.state.length === 0) {
      problems.push(
        `[analysis] ${entry.label} 缺 \`${DECISION_KEYS.state}:\`（取值：${DECISION_STATES.join(' / ')}）`,
      );
    } else if (!(DECISION_STATES as readonly string[]).includes(entry.state)) {
      problems.push(
        `[analysis] ${entry.label} 的 \`${DECISION_KEYS.state}:\` 取值「${entry.state}」不在五词内（${DECISION_STATES.join(' / ')}）`,
      );
    }
    if (entry.basis === undefined || entry.basis.length === 0) {
      problems.push(
        `[analysis] ${entry.label} 缺 \`${DECISION_KEYS.basis}:\`（没有来源写 —）`,
      );
    }
    if (entry.state !== '建议') continue;
    if (entry.question === undefined || entry.question.length === 0) {
      problems.push(
        `[analysis] ${entry.label} 状态为「建议」，必须用 \`${DECISION_KEYS.question}:\` 指向 [open] 里存在的 Q 编号`,
      );
      continue;
    }
    const refs = [...entry.question.matchAll(/\bQ\d+\b/g)].map((matched) => matched[0]!);
    if (refs.length === 0) {
      problems.push(`[analysis] ${entry.label} 的 \`${DECISION_KEYS.question}:\` 没有写出 Q 编号`);
      continue;
    }
    if (open === undefined) continue; // [open] 缺失已由结构检查报出
    for (const ref of refs) {
      if (!questions.has(ref)) {
        problems.push(`[analysis] ${entry.label} 指向的 ${ref} 在 [open] 中不存在`);
      }
    }
  }
  return problems;
}

/**
 * V1 (Schema §2.1): `[goal]` names the project mainline position and this
 * session's progress. Only the labels are checked — whether the recorded
 * mainline is accurate stays the model's record, and `—` is the accepted empty
 * value when the input carried nothing to report.
 *
 * @param bodyLines - the `[goal]` body.
 * @returns one line per missing label.
 */
function checkGoal(bodyLines: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of bodyLines) {
    const matched = /^([a-z]+)\s*[:：]/.exec(stripBullet(raw));
    if (matched !== null) seen.add(matched[1]!);
  }
  const problems: string[] = [];
  if (!seen.has(GOAL_KEYS.mainline)) {
    problems.push(
      `[goal] 缺少 \`${GOAL_KEYS.mainline}:\`（项目整体目标、当前处于主线的哪一步；以项目权威文件为准并保留出处，没有记录写 —）`,
    );
  }
  if (!seen.has(GOAL_KEYS.progress)) {
    problems.push(
      `[goal] 缺少 \`${GOAL_KEYS.progress}:\`（本次相对上一状态推进了什么、到哪一步、还差什么；没有记录写 —）`,
    );
  }
  return problems;
}

/**
 * V1: structure. Six keys, unique, in order; no extra section; no blank body
 * standing in for the agreed missing-value markers; seven ledger fields; a
 * labelled decision entry with a state and a basis (Schema §2.7); the mainline
 * and progress fields of `[goal]` (Schema §2.1).
 *
 * @param parsed - the parsed summary.
 * @returns one line per structural failure.
 */
export function validateStructure(parsed: ParsedSummary): string[] {
  const problems: string[] = [];
  const keys = parsed.sections.map((section) => section.key);

  for (const required of SECTION_KEYS) {
    const count = keys.filter((key) => key === required).length;
    if (count === 0) problems.push(`缺少节 [${required}]`);
    else if (count > 1) problems.push(`节 [${required}] 出现了 ${count} 次`);
  }
  for (const key of keys) {
    if (!(SECTION_KEYS as readonly string[]).includes(key)) {
      problems.push(`出现了六节之外的节 [${key}]`);
    }
  }
  const present = keys.filter((key) => (SECTION_KEYS as readonly string[]).includes(key));
  if (present.join(',') !== SECTION_KEYS.join(',')) {
    problems.push(`六节顺序必须是 ${SECTION_KEYS.map((key) => `[${key}]`).join(' → ')}，实际是 ${present.map((key) => `[${key}]`).join(' → ')}`);
  }
  for (const section of parsed.sections) {
    if (section.bodyLines.every((line) => line.trim().length === 0)) {
      problems.push(`节 [${section.key}] 是空的（空节必须写 (none) 或 —）`);
    }
  }
  const goal = parsed.sections.find((section) => section.key === 'goal');
  if (goal !== undefined) problems.push(...checkGoal(goal.bodyLines));

  const ledger = parsed.sections.find((section) => section.key === 'experiments');
  if (ledger !== undefined) problems.push(...checkExperiments(ledger.bodyLines));

  const analysis = parsed.sections.find((section) => section.key === 'analysis');
  if (analysis !== undefined) {
    const open = parsed.sections.find((section) => section.key === 'open');
    problems.push(...checkDecisions(analysis.bodyLines, open?.bodyLines));
  }
  return problems;
}

/**
 * V2, in its honest scope: the independently specified must-keep set is
 * carried verbatim, and every citation the model produced appears verbatim.
 *
 * @param text - the assembled final summary.
 * @param carried - fragments carried from the previous checkpoint.
 * @param resolved - citations resolved for this compaction.
 * @returns one line per fragment that is missing.
 */
export function validateCarried(
  text: string,
  carried: readonly CarriedFragment[],
  resolved: readonly ResolvedRef[],
): string[] {
  const problems: string[] = [];
  for (const fragment of carried) {
    const block = fragment.lines.join('\n');
    if (!text.includes(block)) {
      problems.push(
        `前次检查点已明确保留的原文没有继续携带（来源：${fragment.source}）：${fragment.lines[0] ?? ''}`,
      );
    }
  }
  for (const ref of resolved) {
    if (!text.includes(ref.text)) {
      problems.push(`引用 ${refLabel(ref)} 的原文没有出现在最终摘要中`);
    }
  }
  return problems;
}

/**
 * V3, in its honest scope: refuse a slice that carries numbers and nothing else.
 *
 * The predicate is "no letter at all, in any script" — deliberately NOT "must
 * match a known anchor word". V3 does not prove the fragment's scientific
 * meaning, and it does not prove the range belongs to the experiment it names.
 * **Failing to match a known lexical anchor is not by itself sufficient evidence
 * that context is missing**: legal expressions exist with no filename, no code
 * identifier and no listed metric, pure-Chinese decisions and constraints being
 * the obvious case. Treat this as a floor, not a guarantee, and never grow it
 * into an allowlist of metric words.
 *
 * @param resolved - citations resolved for this compaction.
 * @returns one line per bare-number slice.
 */
export function validateBinding(resolved: readonly ResolvedRef[]): string[] {
  const problems: string[] = [];
  for (const ref of resolved) {
    if (!BARE_NUMBER.test(ref.text)) continue;
    if (HAS_LETTER.test(ref.text)) continue;
    problems.push(
      `引用 ${refLabel(ref)} 只选到裸数字：整段除数字、单位与标点外没有任何文字。请把范围扩大，使它带上实验归属、指标名或条件`,
    );
  }
  return problems;
}
