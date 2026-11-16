/**
 * The checkpoint, built by the program from the session log — no model call.
 *
 * What is kept, and why:
 * - the user's own words, verbatim: research constraints and decisions are
 *   mostly stated by the user, and a rewritten summary is exactly where they get
 *   narrowed, reworded or attributed to the wrong speaker;
 * - the assistant's prose, verbatim and labelled as the assistant's: its claims
 *   stay the assistant's claims and never turn into premises the user confirmed;
 * - one line per tool call, pointing at the seq of its result.
 *
 * What is dropped is counted and pointed at, never silently lost: reasoning,
 * tool output and injected context leave the window, the log keeps them, and
 * every dropped tool result keeps the seq `session_event_read` reads it back by.
 *
 * A previous checkpoint inside the region is carried forward: this module's own
 * format is merged (rounds, files, record), any other format is carried verbatim
 * as one record entry.
 *
 * @module dsh-academic-research/checkpoint
 */

import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint';
import type { ContentBlock, Message, ToolCallBlock } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';

/** First line of every checkpoint this module writes; it identifies the format when carried. */
export const CHECKPOINT_MARK = '本检查点由 dsh-academic-research 按固定规则从会话日志生成，没有调用模型改写。';

const ROUNDS_HEADING = '## [rounds] 压缩记录';
const FILES_HEADING = '## [files] 涉及的文件';
const RECORD_HEADING = '## [record] 逐字记录';

const SUMMARY_OPEN = '<compacted-summary>';
const SUMMARY_CLOSE = '</compacted-summary>';

/**
 * File-touching tools and the verb recorded for each. Same tool set as the
 * host's `dsh-agent-instructions` uses to detect file touches (`read`, `write`,
 * `edit`, each with a `file_path` argument).
 */
const FILE_TOOL_VERBS: Readonly<Record<string, string>> = { read: '读', write: '写', edit: '改' };

/** Verb order in the file index. */
const VERB_ORDER = ['读', '写', '改'];

/** Longest tool-call detail kept on one line. */
const DETAIL_MAX_CHARS = 120;

/** One region message and the session-log seq it was derived from. */
export interface RegionEntry {
  readonly seq: number;
  readonly message: Message;
}

/** The part of the session this module reads. */
export type SurfaceSession = Pick<Session, 'id' | 'surface' | 'eventAt' | 'deriveEventMessage'>;

/**
 * Pair every region message with its session-log seq.
 *
 * The base engine derives the region from surface nodes but hands `summarize()`
 * only the messages. A derived message keeps its event's stable id, so deriving
 * the surface again maps each id back to its seq. A region message with no
 * surface node is a contract break, not a case to paper over.
 *
 * @param session - the compacting session, whose surface still holds the region.
 * @param region - the region messages, in surface order.
 * @returns the region with seqs.
 */
export function regionEntries(session: SurfaceSession, region: readonly Message[]): RegionEntry[] {
  const seqById = new Map<string, number>();
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    const message = session.deriveEventMessage(event);
    if (message !== null) seqById.set(message.id, Number(seq));
  }
  return region.map((message) => {
    const seq = seqById.get(message.id);
    if (seq === undefined) {
      throw new Error(
        `dsh-academic-research: region message ${message.id} (role=${message.role}) has no surface node; `
        + 'the surface changed under the compaction',
      );
    }
    return { seq, message };
  });
}

/** What one round dropped from the window. */
interface Omitted {
  reasoningChars: number;
  toolOutputChars: number;
  toolCalls: number;
  injected: number;
}

/** A tool result, indexed by the call it answers. */
interface ToolResultRef {
  readonly seq: number;
  readonly chars: number;
  readonly isError: boolean;
}

/** A previous checkpoint's contribution. */
interface Carried {
  readonly rounds: string[];
  readonly record: string[];
}

/** Characters of text a block tree carries; non-text blocks count as zero. */
function textChars(content: readonly ContentBlock[]): number {
  return content.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0);
}

/** The text blocks of a message, joined as written. */
function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** Name the attachments a user message carried, which the checkpoint does not keep. */
function attachmentNote(content: readonly ContentBlock[]): string | undefined {
  const images = content.filter((block) => block.type === 'image').length;
  const files = content.filter((block) => block.type === 'file').length;
  const parts = [
    ...(images > 0 ? [`${images} 张图片`] : []),
    ...(files > 0 ? [`${files} 个文件`] : []),
  ];
  return parts.length === 0 ? undefined : `（附 ${parts.join('、')}，未保留）`;
}

/** Flatten to one line and cap at {@link DETAIL_MAX_CHARS}. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= DETAIL_MAX_CHARS ? flat : `${flat.slice(0, DETAIL_MAX_CHARS)}…`;
}

/** Parsed tool arguments, or undefined when the arguments are not a JSON object. */
function argumentsOf(call: ToolCallBlock): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    /* Not JSON: the raw argument text is what the call carried. */
    return undefined;
  }
}

/** A non-empty string argument. */
function stringArg(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * What one tool call did, in one line: a bash call's own description (its
 * command when it has none), a file tool's path, otherwise the arguments.
 */
function callDetail(call: ToolCallBlock): string {
  const args = argumentsOf(call);
  if (call.name === 'bash') {
    const description = stringArg(args, 'description');
    if (description !== undefined) return oneLine(description);
    const command = stringArg(args, 'command');
    if (command !== undefined) return oneLine(command);
  }
  const path = stringArg(args, 'file_path');
  if (path !== undefined) return path;
  return oneLine(call.arguments);
}

/** The tool-call line under an assistant entry. */
function callLine(call: ToolCallBlock, result: ToolResultRef | undefined): string {
  const head = `- 调用 ${call.name}：${callDetail(call)}`;
  if (result === undefined) return `${head} → 结果不在本次区段`;
  const outcome = result.isError ? '，出错' : '';
  return `${head} → 结果 seq ${result.seq}（${result.chars} 字符${outcome}，未保留）`;
}

/** One-line description of injected context. */
function injectedLine(seq: number, message: Message): string {
  const source = message.source as { readonly kind: string; readonly form?: string; readonly summary?: string; readonly name?: string };
  const what = [source.kind, ...(source.form === undefined ? [] : [source.form]), ...(source.name === undefined ? [] : [source.name])].join(' · ');
  const summary = source.form === 'notice' && source.summary !== undefined ? `：${source.summary}` : '';
  return `[注入 · seq ${seq}] ${what}${summary}（未保留）`;
}

/**
 * True for the checkpoint message a previous compaction landed, by the host's
 * own backend-independent predicate. Missing it would file the whole earlier
 * history under "injected context" and drop it.
 */
function isCheckpoint(message: Message): boolean {
  return message.role === 'user' && isCompactCheckpointSource(message.source);
}

/** The checkpoint text between the framing tags. */
function checkpointBody(message: Message): string {
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  const open = text.indexOf(SUMMARY_OPEN);
  const close = text.lastIndexOf(SUMMARY_CLOSE);
  if (open < 0 || close < open) {
    throw new Error('dsh-academic-research: a previous checkpoint in the region has no <compacted-summary> frame');
  }
  return text.slice(open + SUMMARY_OPEN.length, close).trim();
}

/** Lines strictly between two headings of this module's format. */
function between(lines: readonly string[], from: string, to: string | undefined): string[] {
  const start = lines.indexOf(from);
  const end = to === undefined ? lines.length : lines.indexOf(to, start + 1);
  if (start < 0 || end < 0) {
    throw new Error(`dsh-academic-research: carried checkpoint is missing "${start < 0 ? from : to}"`);
  }
  return lines.slice(start + 1, end);
}

/** Trim leading and trailing blank lines, keeping inner ones. */
function trimBlank(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim().length === 0) start += 1;
  while (end > start && lines[end - 1]!.trim().length === 0) end -= 1;
  return lines.slice(start, end);
}

/** `- <path>（读、改）` */
const FILE_LINE = /^- (.+)（([^（）]+)）$/;

/** Read a previous checkpoint into what this one carries. */
function carryCheckpoint(
  seq: number,
  message: Message,
  carried: Carried,
  files: Map<string, Set<string>>,
): void {
  const body = checkpointBody(message);
  const lines = body.split('\n');
  if (lines[0] !== CHECKPOINT_MARK) {
    /* Another backend's format (or an earlier version of this one): carried
       verbatim as one record entry, since its structure is not this module's
       to parse. */
    carried.record.push(`[前次检查点 · 其它格式 · seq ${seq}]`, body, '');
    return;
  }
  for (const line of trimBlank(between(lines, ROUNDS_HEADING, FILES_HEADING))) carried.rounds.push(line);
  for (const line of trimBlank(between(lines, FILES_HEADING, RECORD_HEADING))) {
    if (line === '(none)') continue;
    const match = FILE_LINE.exec(line);
    if (match === null) throw new Error(`dsh-academic-research: carried file index line is malformed: ${line}`);
    addFile(files, match[1]!, ...match[2]!.split('、'));
  }
  const record = trimBlank(between(lines, RECORD_HEADING, undefined));
  if (record.length > 0) carried.record.push(...record, '');
}

/** Record that a path was touched with the given verbs. */
function addFile(files: Map<string, Set<string>>, path: string, ...verbs: string[]): void {
  const known = files.get(path) ?? new Set<string>();
  for (const verb of verbs) known.add(verb);
  files.set(path, known);
}

/** Render the file index. */
function fileLines(files: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  if (files.size === 0) return ['(none)'];
  return [...files.entries()].map(([path, verbs]) => {
    const ordered = VERB_ORDER.filter((verb) => verbs.has(verb));
    return `- ${path}（${ordered.join('、')}）`;
  });
}

/**
 * Build the checkpoint for one region.
 *
 * @param sessionId - the compacting session, named so a pointer can be read back from another session.
 * @param entries - the region messages with their seqs, in surface order.
 * @returns the checkpoint text.
 */
export function buildCheckpoint(sessionId: string, entries: readonly RegionEntry[]): string {
  if (entries.length === 0) throw new Error('dsh-academic-research: the region to compact is empty');

  const results = new Map<string, ToolResultRef>();
  for (const { seq, message } of entries) {
    if (message.role === 'tool') {
      results.set(message.toolCallId, { seq, chars: textChars(message.content), isError: message.isError === true });
    }
  }

  const carried: Carried = { rounds: [], record: [] };
  const files = new Map<string, Set<string>>();
  const record: string[] = [];
  /* Calls rendered so far; a result always follows its call, so a result whose
     call is not here by then answers a call outside the region. */
  const rendered = new Set<string>();
  const omitted: Omitted = { reasoningChars: 0, toolOutputChars: 0, toolCalls: 0, injected: 0 };

  for (const { seq, message } of entries) {
    switch (message.role) {
      case 'user': {
        if (isCheckpoint(message)) {
          carryCheckpoint(seq, message, carried, files);
          break;
        }
        if (message.source.kind !== 'user') {
          omitted.injected += 1;
          record.push(injectedLine(seq, message), '');
          break;
        }
        const note = attachmentNote(message.content);
        record.push(`[用户 · seq ${seq}]`, textOf(message.content), ...(note === undefined ? [] : [note]), '');
        break;
      }
      case 'assistant': {
        const prose = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n\n');
        const calls = message.content.filter((block): block is ToolCallBlock => block.type === 'tool-call');
        for (const block of message.content) {
          if (block.type === 'reasoning') omitted.reasoningChars += block.text.length;
        }
        if (prose.trim().length === 0 && calls.length === 0) break;
        record.push(`[助手 · seq ${seq}]`);
        if (prose.trim().length > 0) record.push(prose);
        for (const call of calls) {
          rendered.add(call.id);
          omitted.toolCalls += 1;
          record.push(callLine(call, results.get(call.id)));
          const verb = FILE_TOOL_VERBS[call.name];
          const path = stringArg(argumentsOf(call), 'file_path');
          if (verb !== undefined && path !== undefined) addFile(files, path, verb);
        }
        record.push('');
        break;
      }
      case 'tool': {
        const chars = textChars(message.content);
        omitted.toolOutputChars += chars;
        if (!rendered.has(message.toolCallId)) {
          record.push(`[工具结果 · seq ${seq}] 对应调用不在本次区段（${chars} 字符，未保留）`, '');
        }
        break;
      }
      case 'system':
      case 'developer': {
        omitted.injected += 1;
        record.push(injectedLine(seq, message), '');
        break;
      }
    }
  }

  /* The range is the first and last surface node, as the base engine records it
     (`shadowedRange`). Not min/max: a replacement node (a rewritten tool result)
     carries a later seq than the node it stands in for. */
  const round = carried.rounds.length + 1;
  const thisRound = `- 第 ${round} 次：seq ${entries[0]!.seq}–${entries[entries.length - 1]!.seq}，${entries.length} 条消息；`
    + `未保留：推理 ${omitted.reasoningChars} 字符，工具输出 ${omitted.toolOutputChars} 字符（${omitted.toolCalls} 次调用），`
    + `注入上下文 ${omitted.injected} 条`;

  return [
    CHECKPOINT_MARK,
    '- 「用户」条目是用户原话，逐字保留。「助手」条目是助手当时写的文字，逐字保留；其中的结论、数值和状态没有经过核实，不是用户确认过的前提。',
    `- 推理、工具输出和注入上下文没有保留。需要原文时用 session_event_read 按 seq 读回（本会话 id：${sessionId}），或重新读取文件、重新运行命令。`,
    '- 工作区规则（AGENTS.md 等）由宿主在压缩后重新注入，不在本检查点里。',
    '- 研究状态以项目里的状态文件为准（如 .research/STATE.md）；接着做之前先核对真实代码、产物与作业状态。',
    '',
    ROUNDS_HEADING,
    ...carried.rounds,
    thisRound,
    '',
    FILES_HEADING,
    ...fileLines(files),
    '',
    RECORD_HEADING,
    ...trimBlank([...carried.record, ...record]),
  ].join('\n');
}
