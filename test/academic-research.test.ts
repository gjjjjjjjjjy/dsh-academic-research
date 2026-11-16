/**
 * Behaviour of the program-built checkpoint: what reaches the next window
 * verbatim, who it is attributed to, what is dropped and where it can be read
 * back, and how an earlier checkpoint is carried forward.
 */

import { CompactionId } from '@deepseek-ai/dsh-compaction';
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint';
import {
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm';
import type { ContentBlock, Message, MessageSource } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';

import { CHECKPOINT_MARK, buildCheckpoint, regionEntries } from '../src/checkpoint.ts';
import type { RegionEntry, SurfaceSession } from '../src/checkpoint.ts';

function user(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
}

function assistant(content: ContentBlock[]): Message {
  return createAssistantMessage({ content, source: { provider: 'p', model: 'm' } });
}

function call(id: string, name: string, args: Record<string, unknown>): ContentBlock {
  return { type: 'tool-call', id: ToolCallId(id), name, arguments: JSON.stringify(args) };
}

function result(id: string, text: string, isError = false): Message {
  return createToolResultMessage({ callId: ToolCallId(id), content: [{ type: 'text', text }], isError });
}

function injected(text: string, source: Record<string, unknown>): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: source as unknown as MessageSource });
}

/** The checkpoint message the base engine lands, framing `text`. */
function landed(text: string): Message {
  return createUserMessage({
    content: [
      { type: 'text', text: 'This is an automatically generated checkpoint …\n\n<compacted-summary>' },
      { type: 'text', text },
      { type: 'text', text: '</compacted-summary>' },
    ],
    source: compactCheckpointSource(CompactionId('c1')),
  });
}

/** Number messages with consecutive seqs from `first`. */
function numbered(messages: readonly Message[], first: number): RegionEntry[] {
  return messages.map((message, index) => ({ seq: first + index, message }));
}

const REGION: readonly Message[] = [
  user('用 split-A 评价，不要改 baseline。'),
  assistant([
    { type: 'reasoning', text: '也许掉点是因为光照分布不同（推测）' },
    { type: 'text', text: '先读评价脚本。' },
    call('c1', 'read', { file_path: '/p/eval.py' }),
    call('c2', 'bash', { command: 'python eval.py --split A', description: 'Run evaluation on split A' }),
  ]),
  result('c1', 'def evaluate(): ...'),
  result('c2', 'Traceback: CUDA OOM', true),
  assistant([{ type: 'text', text: 'E3 在 split-A 上 accuracy=81.3%。' }, call('c3', 'edit', { file_path: '/p/eval.py', old_string: 'a', new_string: 'b' })]),
  result('c3', 'ok'),
];

describe('dsh-academic-research checkpoint', () => {
  it('逐字保留用户原话与助手文字并标明作者，推理不进入检查点', () => {
    const text = buildCheckpoint('s-1', numbered(REGION, 10));

    expect(text.split('\n')[0]).toBe(CHECKPOINT_MARK);
    expect(text).toContain('[用户 · seq 10]\n用 split-A 评价，不要改 baseline。');
    expect(text).toContain('[助手 · seq 11]\n先读评价脚本。');
    expect(text).toContain('[助手 · seq 14]\nE3 在 split-A 上 accuracy=81.3%。');
    /* The assistant's guess never reaches the next window, so it cannot be
       re-read later as a premise. */
    expect(text).not.toContain('光照分布');
  });

  it('工具调用压成一行，指向结果的 seq；工具输出不保留但计数', () => {
    const text = buildCheckpoint('s-1', numbered(REGION, 10));

    expect(text).toContain('- 调用 read：/p/eval.py → 结果 seq 12（19 字符，未保留）');
    expect(text).toContain('- 调用 bash：Run evaluation on split A → 结果 seq 13（19 字符，出错，未保留）');
    expect(text).not.toContain('Traceback');
    expect(text).toContain('本会话 id：s-1');
    expect(text).toContain('- 第 1 次：seq 10–15，6 条消息；未保留：推理 17 字符，工具输出 40 字符（3 次调用），注入上下文 0 条');
  });

  it('读写过的文件由程序从工具调用提取', () => {
    const text = buildCheckpoint('s-1', numbered(REGION, 10));
    expect(text).toContain('## [files] 涉及的文件\n- /p/eval.py（读、改）');
  });

  it('注入的上下文只留一行出处，不保留正文；notice 的一行说明保留', () => {
    const text = buildCheckpoint('s-1', numbered([
      injected('<system-reminder>AGENTS.md 全文</system-reminder>', { kind: 'agent-instructions', form: 'instructions' }),
      injected('[model changed]', { kind: 'plugin', plugin: 'model-selection', form: 'notice', summary: 'a/x → b/y' }),
      user('继续'),
    ], 1));

    expect(text).toContain('[注入 · seq 1] agent-instructions · instructions（未保留）');
    expect(text).toContain('[注入 · seq 2] plugin · notice：a/x → b/y（未保留）');
    expect(text).not.toContain('AGENTS.md 全文');
  });

  it('前次检查点按格式合并：轮次、文件与记录都接上，不嵌套', () => {
    const first = buildCheckpoint('s-1', numbered(REGION, 10));
    const second = buildCheckpoint('s-1', numbered([
      landed(first),
      user('改用 split-B 复核。'),
      assistant([call('c9', 'read', { file_path: '/p/config.yml' })]),
      result('c9', 'split: B'),
    ], 30));

    expect(second.split(CHECKPOINT_MARK).length - 1).toBe(1);
    expect(second).toContain('- 第 1 次：seq 10–15');
    expect(second).toContain('- 第 2 次：seq 30–33');
    expect(second).toContain('- /p/eval.py（读、改）\n- /p/config.yml（读）');
    const record = second.slice(second.indexOf('## [record]'));
    expect(record.indexOf('用 split-A 评价')).toBeLessThan(record.indexOf('改用 split-B 复核。'));
    expect(record).toContain('[用户 · seq 31]\n改用 split-B 复核。');
  });

  it('其它格式的前次检查点整段逐字携带', () => {
    const legacy = '## [goal] 当前目标与假设\nmainline: 旧格式';
    const text = buildCheckpoint('s-1', numbered([landed(legacy), user('继续')], 5));

    expect(text).toContain(`[前次检查点 · 其它格式 · seq 5]\n${legacy}`);
    expect(text).toContain('- 第 1 次：seq 5–6');
  });

  it('工具结果的调用不在本区段时，仍留下指向结果的一行', () => {
    const text = buildCheckpoint('s-1', numbered([result('c0', 'late output'), user('好')], 7));
    expect(text).toContain('[工具结果 · seq 7] 对应调用不在本次区段（11 字符，未保留）');
  });

  it('按会话可见面把区段消息映射回 seq；对不上的消息直接报错', () => {
    const messages = [user('a'), user('b')];
    const events = new Map<number, Message>([[40, messages[0]!], [41, messages[1]!]]);
    const session = {
      id: 's-1',
      surface: { nodes: [40, 41] },
      eventAt: (seq: number) => ({ seq }),
      deriveEventMessage: (event: { seq: number }) => events.get(event.seq)!,
    } as unknown as SurfaceSession;

    expect(regionEntries(session, messages).map((entry) => entry.seq)).toEqual([40, 41]);
    expect(() => regionEntries(session, [user('不在可见面上')])).toThrow(/has no surface node/);
  });
});
