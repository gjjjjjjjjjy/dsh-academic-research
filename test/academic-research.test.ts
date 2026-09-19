/**
 * The one test file Schema §6.1 asks for: a few key cases over the pure logic,
 * plus a scripted model stream for the repair and truncation paths.
 *
 * Scope note: these cases check what the mechanism actually guarantees. V2/V3
 * prove that a cited fragment was copied without being rewritten; they do not
 * prove the selection was complete, that a range semantically belongs to the
 * experiment it names, or that the record itself is correct.
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { describe, expect, it } from 'vitest';

import { assertMaxTokens } from '../src/index.ts';
import { SECTION_SKELETON, buildInstruction, partialInstruction } from '../src/prompt.ts';
import {
  buildSourceIndex,
  CARRIED_SOURCE,
  extractCarriedFragments,
  extractCarriedOutcome,
  parseRefs,
  renderUnits,
} from '../src/sources.ts';
import { summarizeRegion } from '../src/summarize.ts';
import type { ResolvedAcademicResearchConfig, SourceIndex, SummarizationInput } from '../src/types.ts';
import {
  DECISION_KEYS,
  DECISION_STATES,
  GOAL_KEYS,
  SECTION_KEYS,
  parseSections,
  validateBinding,
  validateStructure,
} from '../src/validate.ts';

const BASE: ResolvedConfig = {
  thresholdRatio: 0.7,
  retainRatio: 0.16,
  summarizationProvider: '',
  summarizationModel: '',
  maxTokens: 32768,
  compactionRetries: 1,
  maxOverflowRetries: 1,
  modelPolicies: [],
  auto: false,
};

const ACADEMIC_RESEARCH: ResolvedAcademicResearchConfig = {
  domain: 'ml',
  summaryLanguage: 'auto',
  recursive: true,
  chunkMessages: 40,
  domainExtra: '',
};

const AGENT = {
  options: { provider: 'test', model: 'test' },
  session: { id: 'session-test', requestHeader: () => undefined },
} as unknown as Agent;

/** The same case in two session languages. */
const REGIONS: Readonly<Record<string, readonly string[]>> = {
  zh: ['E3 使用 test-v2 进行评价。', 'seed=42', 'accuracy=81.3%', 'checkpoint=/project/results/E3.pt'],
  en: ['E3 evaluated on test-v2.', 'seed=42', 'accuracy=81.3%', 'checkpoint=/project/results/E3.pt'],
};

const GOOD_LEDGER = [
  'E3',
  'purpose: H1',
  'design: test-v2 评价；对照 baseline',
  'config: seed=42',
  'status: 已完成',
  'result: accuracy=81.3%',
  'artifacts: /project/results/E3.pt',
  'conclusion: 原文报告已验证',
].join('\n');

/** Build one six-section reply whose `[invariants]` body is `invariants`. */
function replyWith(invariants: string, ledger: string = GOOD_LEDGER): string {
  return [
    '## [goal] 当前目标与假设',
    'mainline: 项目主线：在 test-v2 上验证聚合口径；当前条目 M1；验收：accuracy 优于 baseline。',
    'progress: 本次推进：完成 E3 并取得 accuracy=81.3%，尚未在第二个 split 复核。',
    '- H1：新聚合口径提升 accuracy；判据：test-v2 上 accuracy > baseline；状态：部分支持；依据：E3。',
    '',
    '## [experiments] 实验台账',
    ledger,
    '',
    '## [evidence] 记录与来源',
    '- accuracy=81.3% ← E3',
    '',
    '## [analysis] 已有分析与判断边界',
    'decision: 采用新聚合口径',
    'state: 已确认',
    'basis: 用户指令',
    'judgement: 原文称新口径更好；依据 E3。',
    '',
    '## [invariants] 精确保留区',
    invariants,
    '',
    '## [open] 待决策问题与下一步',
    '- 已确定下一步：在第二个 split 上复核。',
    '- 已否决方案：(none)',
  ].join('\n');
}

type ScriptedReply = string | readonly StreamChunk[];

/** A context whose only service is a scripted model stream. */
function fakeContext(replies: readonly ScriptedReply[]): {
  readonly ctx: Context;
  readonly calls: () => number;
  readonly options: () => readonly GenerateOptions[];
} {
  let served = 0;
  const seen: GenerateOptions[] = [];
  const llm = {
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      seen.push(options);
      const reply = replies[served];
      served += 1;
      if (reply === undefined) throw new Error(`test: unexpected model call ${served}`);
      const chunks: readonly StreamChunk[] =
        typeof reply === 'string'
          ? [
              { type: 'text-delta', index: 0, text: reply },
              { type: 'finish', reason: { kind: 'stop' } },
            ]
          : reply;
      return (async function* generate(): AsyncIterable<StreamChunk> {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
  return { ctx: { llm } as unknown as Context, calls: () => served, options: () => seen };
}

/** One region as the summarizer's input. */
function input(lines: readonly string[]): SummarizationInput {
  return {
    messages: [
      createUserMessage({ content: [{ type: 'text', text: lines.join('\n') }], source: { kind: 'user' } }),
    ],
  };
}

/** Read the assembled checkpoint text back out of a result. */
function textOf(result: { summary: readonly { type: string; text?: string }[] }): string {
  return result.summary.map((block) => (block.type === 'text' ? block.text ?? '' : '')).join('');
}

describe('dsh-academic-research', () => {
  it.each(Object.entries(REGIONS))(
    '六节摘要通过，并把引用范围逐字复制进最终摘要（%s）',
    async (_language, lines) => {
      const { ctx, calls } = fakeContext([replyWith('- S1:L1-L4')]);
      const result = await summarizeRegion(ctx, BASE, ACADEMIC_RESEARCH, input(lines), AGENT);
      const text = textOf(result);

      for (const key of SECTION_KEYS) expect(text).toContain(`## [${key}]`);
      expect(text).toContain('来源：S1:L1-L4（本次压缩定位）');
      expect(text).toContain(lines.join('\n'));
      expect(calls()).toBe(1);
    },
  );

  it('第一次失败只修复一次，修复成功则提交', async () => {
    const missingField = replyWith('- S1:L1-L4', GOOD_LEDGER.replace('result: accuracy=81.3%\n', ''));
    const { ctx, calls } = fakeContext([missingField, replyWith('- S1:L1-L4')]);
    const result = await summarizeRegion(ctx, BASE, ACADEMIC_RESEARCH, input(REGIONS.zh!), AGENT);

    expect(calls()).toBe(2);
    expect(textOf(result)).toContain('result: accuracy=81.3%');
  });

  it('漏字段持续存在时不提交，且不再多轮自我修复', async () => {
    const missingField = replyWith('- S1:L1-L4', GOOD_LEDGER.replace('result: accuracy=81.3%\n', ''));
    const { ctx, calls } = fakeContext([missingField, missingField]);

    await expect(
      summarizeRegion(ctx, BASE, ACADEMIC_RESEARCH, input(REGIONS.zh!), AGENT),
    ).rejects.toThrow(/缺少字段 result/);
    expect(calls()).toBe(2);
  });

  it('在保留区改写数值而不是引用来源时失败', async () => {
    const rewritten = replyWith(
      ['来源：S1:L1-L4', '原文：', 'E3 使用 test-v2 进行评价。', 'seed=42', 'accuracy=81.30%'].join('\n'),
    );
    const { ctx, calls } = fakeContext([rewritten, rewritten]);

    await expect(
      summarizeRegion(ctx, BASE, ACADEMIC_RESEARCH, input(REGIONS.zh!), AGENT),
    ).rejects.toThrow(/只允许来源引用/);
    expect(calls()).toBe(2);
  });

  it('引用不存在的来源时失败', async () => {
    const badRef = replyWith('- S9:L1-L2');
    const { ctx, calls } = fakeContext([badRef, badRef]);

    await expect(
      summarizeRegion(ctx, BASE, ACADEMIC_RESEARCH, input(REGIONS.zh!), AGENT),
    ).rejects.toThrow(/S9 不存在/);
    expect(calls()).toBe(2);
  });

  it('只选到裸数字时失败', async () => {
    const bare = replyWith('- S1:L1');
    const { ctx, calls } = fakeContext([bare, bare]);

    await expect(
      summarizeRegion(ctx, BASE, ACADEMIC_RESEARCH, input(['81.3', '0.42']), AGENT),
    ).rejects.toThrow(/裸数字/);
    expect(calls()).toBe(2);
  });

  it('模型被截断时不提交', async () => {
    const truncated: readonly StreamChunk[] = [{ type: 'finish', reason: { kind: 'max-tokens' } }];
    const { ctx, calls } = fakeContext([truncated]);

    await expect(
      summarizeRegion(ctx, BASE, ACADEMIC_RESEARCH, input(REGIONS.zh!), AGENT),
    ).rejects.toThrow(/truncated at the token cap/);
    expect(calls()).toBe(1);
  });

  it('模型改用工具调用时不提交，即使已经吐了一段文本', async () => {
    const diverted: readonly StreamChunk[] = [
      { type: 'text-delta', index: 0, text: '## [goal] 当前目标与假设\nmainline: —\nprogress: —' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ];
    const { ctx, calls } = fakeContext([diverted]);

    await expect(
      summarizeRegion(ctx, BASE, ACADEMIC_RESEARCH, input(REGIONS.zh!), AGENT),
    ).rejects.toThrow(/tool call/);
    expect(calls()).toBe(1);
  });

  it('空正文的失败报文说清 finish、块类型、用量与是第几次调用', async () => {
    /* 真实 /compact 只回了一句 `produced no text summary content`：日志里没有 finish、
       没有用量，也没有区段大小（失败尝试的区段不落盘），因此无法判断是流被截断、只吐了
       reasoning，还是修复调用空手而归。空正文是信息量最少的 V4 失败，恰恰最需要自述。 */
    const reasoningOnly: readonly StreamChunk[] = [
      { type: 'reasoning-delta', index: 0, text: '先把区段读一遍再决定怎么写' },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const { ctx, calls } = fakeContext([reasoningOnly]);

    const failure = await summarizeRegion(ctx, BASE, ACADEMIC_RESEARCH, input(REGIONS.zh!), AGENT)
      .then(() => undefined, (error: Error) => error);

    expect(failure?.message).toMatch(/produced no text summary content/);
    expect(failure?.message).toMatch(/finish=stop/);
    expect(failure?.message).toMatch(/收到的块=reasoning/);
    expect(failure?.message).toMatch(/用量未报告/);
    expect(failure?.message).toMatch(/第 1 次调用，区段 \d+ 行 \/ \d+ 字符/);
    expect(calls()).toBe(1);
  });

  it('压缩调用不携带工具 schema，模型因此没有可调用的工具', async () => {
    /* 真实 /compact 在 13 秒内因为这一条失败：把会话的全部工具 schema 一起发过去，
       等于亲手给出调工具的能力，再靠提示词求它别调。 */
    const withTools = {
      tools: [{ name: 'bash' }],
      messages: input(REGIONS.zh!).messages,
    } as unknown as SummarizationInput;
    const { ctx, options } = fakeContext([replyWith('- S1:L1-L4')]);

    await summarizeRegion(ctx, BASE, ACADEMIC_RESEARCH, withTools, AGENT);

    expect(options()[0]?.tools).toBeUndefined();
    expect(options()[0]?.purpose).toBe('compaction');
  });

  it('压缩请求以任务与首行契约开头，而不是以区段开头，且两者之间有分隔', async () => {
    /* 第四次真实失败里模型想执行区段结尾那条 bash 命令：它把编号转录读成了正在进行的
       会话。第六次它干脆按自己的理解写了一份「会话整理」，六节格式一次都没出现。
       DeepSeek 适配器把一条 user 消息里的 text 块用 `join("")` 拼接，所以块之间必须
       自带分隔，否则指令会粘在区段最后一行上。 */
    const { ctx, options } = fakeContext([replyWith('- S1:L1-L4')]);

    await summarizeRegion(ctx, BASE, ACADEMIC_RESEARCH, input(REGIONS.zh!), AGENT);

    const messages = options()[0]?.messages ?? [];
    const message = messages[messages.length - 1];
    const text = (message?.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');

    expect(text.startsWith('这是一次**压缩调用**')).toBe(true);
    expect(text).toContain('不要写成别的分节报告');
    expect(text).toContain('待压区段 开始');
    expect(text).toContain('待压区段 结束');
    expect(text).toContain('不是需要你继续的对话');
    /* 区段结束后必须是空行，不能直接接上指令。 */
    expect(text).toContain('===== 待压区段 结束 =====\n\n');
    expect(text.indexOf('待压区段 开始')).toBeLessThan(
      text.indexOf('你现在是一次科研会话的压缩引擎'),
    );
  });

  it('修复调用说出上一次输出是什么，而不是只列缺项', async () => {
    const prose = '好的，我先把这段会话梳理一下，然后继续处理后面的任务。';
    const { ctx, options } = fakeContext([prose, replyWith('- S1:L1-L4')]);

    await summarizeRegion(ctx, BASE, ACADEMIC_RESEARCH, input(REGIONS.zh!), AGENT);

    const repair = JSON.stringify(options()[1]?.messages ?? []);
    expect(repair).toContain('上一次输出不是检查点，开头是：好的，我先把这段会话梳理一下');
  });

  it('校验失败时报文里带被拒输出的开头，不用猜模型写了什么', async () => {
    /* 真实运行的失败只说「缺少节 [goal]…」，看不出模型是换了写法还是在接着聊天；
       被拒草稿原本不落在任何地方，下一次运行只能重复同样的猜测。 */
    const prose = '好的，我先把这段会话梳理一下，然后继续处理后面的任务。';
    const { ctx } = fakeContext([prose, prose]);

    await expect(
      summarizeRegion(ctx, BASE, ACADEMIC_RESEARCH, input(REGIONS.zh!), AGENT),
    ).rejects.toThrow(/第一次输出开头：好的，我先把这段会话梳理一下/);
  });

  it('递归分块：逐块解析引用，并把原文带入合并阶段', async () => {
    const messages = [
      createUserMessage({
        content: [{ type: 'text', text: 'E3 使用 test-v2 进行评价。\naccuracy=81.3%' }],
        source: { kind: 'user' },
      }),
      createUserMessage({ content: [{ type: 'text', text: 'seed=42' }], source: { kind: 'user' } }),
    ];
    const chunkOne = ['## [experiments] 实验台账', 'E3', '', '## [invariants] 精确保留区', '- S1:L1-L2'].join('\n');
    const chunkTwo = ['## [experiments] 实验台账', '(none)', '', '## [invariants] 精确保留区', '- S2:L1'].join('\n');
    const { ctx, calls } = fakeContext([chunkOne, chunkTwo, replyWith('(none)')]);

    const result = await summarizeRegion(
      ctx,
      BASE,
      { ...ACADEMIC_RESEARCH, chunkMessages: 1 },
      { messages },
      AGENT,
    );

    expect(calls()).toBe(3);
    expect(textOf(result)).toContain(
      '来源：S1:L1-L2（本次压缩定位）\n原文：\nE3 使用 test-v2 进行评价。\naccuracy=81.3%',
    );
    expect(textOf(result)).toContain('来源：S2:L1（本次压缩定位）\n原文：\nseed=42');
  });

  it('同一行用逗号并列多个引用时逐个解析并逐字复制', async () => {
    /* 真实运行里模型写过 `- S139:L2, S139:L7-L8, S139:L20-L21`。逗号并列没有被合同禁止，
       按「整行一个引用」解析会把整次压缩打死，而每个引用仍然逐字复制，保真不打折。 */
    const { ctx, calls } = fakeContext([replyWith('- S1:L1, S1:L3-L4')]);
    const result = await summarizeRegion(ctx, BASE, ACADEMIC_RESEARCH, input(REGIONS.zh!), AGENT);
    const text = textOf(result);

    expect(calls()).toBe(1);
    expect(text).toContain('来源：S1:L1（本次压缩定位）\n原文：\nE3 使用 test-v2 进行评价。');
    expect(text).toContain(
      '来源：S1:L3-L4（本次压缩定位）\n原文：\naccuracy=81.3%\ncheckpoint=/project/results/E3.pt',
    );
  });

  it('引用解析：接受一行多个引用，仍然拒绝夹带文字的行', () => {
    const cases: readonly [string, number, boolean][] = [
      ['- S7:L1-L4', 1, false],
      ['S7:L3', 1, false],
      ['- S139:L2, S139:L7-L8, S139:L20-L21', 3, false],
      ['- S1:L1、S1:L2', 2, false],
      ['- S1:L1，S1:L2', 2, false],
      ['- S1:L1, S1:L2,', 2, false],
      ['- S1:L1（本次压缩定位）', 0, true],
      ['- 来源：S1:L1', 0, true],
      ['- ', 0, true],
      ['- S1:L1 and S2:L2', 0, true],
    ];
    for (const [line, count, failed] of cases) {
      const parsed = parseRefs([line]);
      expect(parsed.refs, line).toHaveLength(count);
      expect(parsed.problems.length > 0, line).toBe(failed);
    }
  });

  it('递归分块：分段阶段的引用不合法时不提交，也不浪费一次合并修复', async () => {
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: 'accuracy=81.3%' }], source: { kind: 'user' } }),
      createUserMessage({ content: [{ type: 'text', text: 'seed=42' }], source: { kind: 'user' } }),
    ];
    const badChunk = ['## [invariants] 精确保留区', '- S9:L1'].join('\n');
    const goodChunk = ['## [invariants] 精确保留区', '- S2:L1'].join('\n');
    const { ctx, calls } = fakeContext([badChunk, goodChunk]);

    await expect(
      summarizeRegion(ctx, BASE, { ...ACADEMIC_RESEARCH, chunkMessages: 1 }, { messages }, AGENT),
    ).rejects.toThrow(/分段摘要未通过检查/);
    /* 第一块就不合法时立即停：后面的分块改变不了结果，每跑一块都是一整次模型调用
       （真实区段实测约 2 分钟），合并与修复更不可能触达分段阶段。 */
    expect(calls()).toBe(1);
  });

  it('编号与行号按消息建立，结构标记不带行号，并在标题上标出总行数', () => {
    const index = buildSourceIndex(input(REGIONS.zh!).messages);
    expect(renderUnits(index)).toBe(
      [
        '[S1] role=user lines=4',
        'L1: E3 使用 test-v2 进行评价。',
        'L2: seed=42',
        'L3: accuracy=81.3%',
        'L4: checkpoint=/project/results/E3.pt',
      ].join('\n'),
    );
  });

  it('实验台账接受字母编号：项目把「实验 B」记为 EB，不能逼它编一个数字号', () => {
    const summary = [
      '## [goal] 当前目标与假设',
      'mainline: M1',
      'progress: —',
      '## [experiments] 实验台账',
      'E3',
      'purpose: —',
      'design: —',
      'config: —',
      'status: 已完成',
      'result: —',
      'artifacts: —',
      'conclusion: —',
      'EB',
      'purpose: —',
      'design: —',
      'config: —',
      'status: 已完成',
      'result: —',
      'artifacts: —',
      'conclusion: —',
      '## [evidence] 记录与来源',
      '(none)',
      '## [analysis] 已有分析与判断边界',
      'decision: 无',
      'state: 已确认',
      'basis: 用户指令',
      'judgement: 无',
      '## [invariants] 精确保留区',
      '(none)',
      '## [open] 待决策问题与下一步',
      '- (none)',
    ].join('\n');
    expect(validateStructure(parseSections(summary))).toEqual([]);
  });

  it('前次检查点已保留的原文被识别为独立必保集合并继续携带', async () => {
    const prior = [
      '<compacted-summary>',
      '## [goal] 当前目标与假设',
      '- H1：……',
      '',
      '## [invariants] 精确保留区',
      '来源：S3:L1-L2（本次压缩定位）',
      '原文：',
      'seed=7',
      'lr=0.001',
      '',
      '## [open] 待决策问题与下一步',
      '- (none)',
      '</compacted-summary>',
    ].join('\n');
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: prior }], source: { kind: 'user' } }),
      createUserMessage({
        content: [{ type: 'text', text: 'accuracy=90.0%' }],
        source: { kind: 'user' },
      }),
    ];

    const carried = extractCarriedFragments(buildSourceIndex(messages));
    expect(carried).toEqual([{ source: 'S3:L1-L2（本次压缩定位）', lines: ['seed=7', 'lr=0.001'] }]);

    const { ctx } = fakeContext([replyWith('(none)')]);
    const result = await summarizeRegion(ctx, BASE, ACADEMIC_RESEARCH, { messages }, AGENT);
    expect(textOf(result)).toContain(`来源：${CARRIED_SOURCE}\n原文：\nseed=7\nlr=0.001`);
    /* 携带片段不得沿用上一轮的压缩内定位标签：那个编号在自己的压缩之外没有意义，
       照抄既会把它谎报成「本轮定位」，又会在下一次压缩里套成两层包装。 */
    expect(textOf(result)).not.toContain('S3:L1-L2（本次压缩定位）');
    expect(textOf(result).match(new RegExp(CARRIED_SOURCE, 'g'))).toHaveLength(1);
  });

  it('携带片段不得吞掉被它包含的新值：seed=421 吸收 seed=42', async () => {
    const prior = [
      '<compacted-summary>',
      '## [invariants] 精确保留区',
      '来源：S9:L1（本次压缩定位）',
      '原文：',
      'seed=421',
      '</compacted-summary>',
    ].join('\n');
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: prior }], source: { kind: 'user' } }),
      createUserMessage({ content: [{ type: 'text', text: 'seed=42' }], source: { kind: 'user' } }),
    ];

    const { ctx } = fakeContext([replyWith('- S2:L1')]);
    const result = await summarizeRegion(ctx, BASE, ACADEMIC_RESEARCH, { messages }, AGENT);
    const text = textOf(result);
    expect(text).toContain(`来源：${CARRIED_SOURCE}\n原文：\nseed=421`);
    /* 子串包含会把 seed=42 判成「已携带」而静默丢弃，且被丢弃的引用不进 resolved，
       V2 也就查不到它。按行边界判等价后，新值必须作为本轮定位出现在摘要里。 */
    expect(text).toContain('（本次压缩定位）\n原文：\nseed=42');
  });

  it('携带片段的值被更晚的记录取代时淘汰，并留痕一次', async () => {
    /* 真实检查点里同时躺着 Tests 31 / 33 / 34，读者无从判断哪个是当前值；
       而携带集合只增不减，过期事实会被永久搬运。 */
    const prior = [
      '<compacted-summary>',
      '## [invariants] 精确保留区',
      '来源：S1:L1（本次压缩定位）',
      '原文：',
      'Tests  31 passed (31)',
      '</compacted-summary>',
    ].join('\n');
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: prior }], source: { kind: 'user' } }),
      createUserMessage({
        content: [{ type: 'text', text: 'Tests  34 passed (34)' }],
        source: { kind: 'user' },
      }),
    ];

    const outcome = extractCarriedOutcome(buildSourceIndex(messages));
    expect(outcome.kept).toEqual([]);
    expect(outcome.evicted).toEqual([
      { source: 'S1:L1（本次压缩定位）', lines: ['Tests  31 passed (31)'], key: 'Tests' },
    ]);

    const { ctx } = fakeContext([replyWith('(none)')]);
    const text = textOf(await summarizeRegion(ctx, BASE, ACADEMIC_RESEARCH, { messages }, AGENT));
    /* 留痕：原文照旧逐字，标签说明为什么不再携带。 */
    expect(text).toContain('来源：前次检查点（已淘汰 · Tests 已有更新值）\n原文：\nTests  31 passed (31)');
    /* 淘汰不是继续携带，V2 也不再要求这一段出现。 */
    expect(text).not.toContain(`${CARRIED_SOURCE}\n原文：\nTests  31 passed (31)`);
  });

  it('淘汰判据只认更晚的记录，同值与数字扩展都不算取代', () => {
    const withPrior = (preserved: string, later: readonly string[]): SourceIndex =>
      buildSourceIndex([
        createUserMessage({ content: [{ type: 'text', text: 'maxTokens: 32768' }], source: { kind: 'user' } }),
        createUserMessage({
          content: [{
            type: 'text',
            text: ['<compacted-summary>', '## [invariants] 精确保留区', '来源：S1:L1（本次压缩定位）', '原文：', preserved, '</compacted-summary>'].join('\n'),
          }],
          source: { kind: 'user' },
        }),
        ...later.map((text) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })),
      ]);

    /* 写在前次检查点之前的旧值不是更新：那是更早的记录，不是取代。 */
    expect(extractCarriedOutcome(withPrior('maxTokens: 32768', [])).kept).toHaveLength(1);
    /* 同样的值再次出现，说明它仍然成立。 */
    expect(extractCarriedOutcome(withPrior('maxTokens: 65536', ['maxTokens: 65536'])).kept).toHaveLength(1);
    /* 数字扩展是两个不同的值，不是同一个槽的新值（Schema §4.1 的 seed=42/421）。 */
    expect(extractCarriedOutcome(withPrior('seed=42', ['seed=421'])).kept).toHaveLength(1);
    /* 真的换了值才淘汰。 */
    expect(extractCarriedOutcome(withPrior('maxTokens: 32768', ['maxTokens: 65536'])).evicted).toHaveLength(1);
  });

  it('携带片段里还有非键行时，不因其中一行被取代而整体淘汰', () => {
    const prior = [
      '<compacted-summary>',
      '## [invariants] 精确保留区',
      '来源：S1:L1-L3（本次压缩定位）',
      '原文：',
      'accuracy=81.3%',
      'E3 使用 test-v2 进行评价。',
      '</compacted-summary>',
    ].join('\n');
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: prior }], source: { kind: 'user' } }),
      createUserMessage({
        content: [{ type: 'text', text: 'accuracy=90.0%' }],
        source: { kind: 'user' },
      }),
    ];

    /* 淘汰只能整块进行：逐行改写会毁掉「逐字保留」本身。整块里还有一行不是键值时，
       判据不足以证明整块都过期，因此保留。 */
    const outcome = extractCarriedOutcome(buildSourceIndex(messages));
    expect(outcome.evicted).toEqual([]);
    expect(outcome.kept).toEqual([
      { source: 'S1:L1-L3（本次压缩定位）', lines: ['accuracy=81.3%', 'E3 使用 test-v2 进行评价。'] },
    ]);
  });

  it('被引用的代码行不算键值对，不因同名标识符出现在别处而淘汰', () => {
    const withPrior = (preserved: string, later: string): SourceIndex =>
      buildSourceIndex([
        createUserMessage({
          content: [{
            type: 'text',
            text: ['<compacted-summary>', '## [invariants] 精确保留区', '来源：S1:L1（本次压缩定位）', '原文：', preserved, '</compacted-summary>'].join('\n'),
          }],
          source: { kind: 'user' },
        }),
        createUserMessage({ content: [{ type: 'text', text: later }], source: { kind: 'user' } }),
      ]);

    /* 真实检查点里保留过源码片段。`maxTokens: config.maxTokens,` 后面还有逗号，
       `return 0;` 的数字后面只有分号：两者都不是「一个可替换的值」，因此不参与淘汰。 */
    const code = extractCarriedOutcome(
      withPrior('\t\tmaxTokens: config.maxTokens,', '\t\tmaxTokens: config.maxTokens ?? 8192,'),
    );
    expect(code.kept).toHaveLength(1);
    expect(code.evicted).toHaveLength(0);

    expect(extractCarriedOutcome(withPrior('\treturn 0;', '\treturn 1;')).evicted).toHaveLength(0);
  });

  it('淘汰留痕只公示一轮，下一轮不再作为必保集合', async () => {
    const prior = [
      '<compacted-summary>',
      '## [invariants] 精确保留区',
      '来源：前次检查点（已淘汰 · Tests 已有更新值）',
      '原文：',
      'Tests  31 passed (31)',
      '</compacted-summary>',
    ].join('\n');
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: prior }], source: { kind: 'user' } }),
    ];

    const outcome = extractCarriedOutcome(buildSourceIndex(messages));
    expect(outcome.kept).toEqual([]);
    expect(outcome.evicted).toEqual([]);

    const { ctx } = fakeContext([replyWith('(none)')]);
    const text = textOf(await summarizeRegion(ctx, BASE, ACADEMIC_RESEARCH, { messages }, AGENT));
    /* 留痕本身不被搬运：下一轮的保留区里只剩 (none)，不是上一轮的淘汰公示。 */
    expect(text).toContain('(none)');
    expect(text).not.toContain('已淘汰');
    expect(text).not.toContain('Tests  31 passed (31)');
  });

  it('已携带片段的子区间引用仍算已携带，不重复搬运', async () => {
    const prior = [
      '<compacted-summary>',
      '## [invariants] 精确保留区',
      '来源：S9:L1-L2（本次压缩定位）',
      '原文：',
      'seed=7',
      'lr=0.001',
      '</compacted-summary>',
    ].join('\n');
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: prior }], source: { kind: 'user' } }),
      createUserMessage({ content: [{ type: 'text', text: 'lr=0.001' }], source: { kind: 'user' } }),
    ];

    const { ctx } = fakeContext([replyWith('- S2:L1')]);
    const result = await summarizeRegion(ctx, BASE, ACADEMIC_RESEARCH, { messages }, AGENT);
    const text = textOf(result);
    expect(text).toContain(`来源：${CARRIED_SOURCE}\n原文：\nseed=7\nlr=0.001`);
    expect(text).not.toContain('S2:L1（本次压缩定位）');
  });

  it('携带片段逐字保留内部空行，只去掉块间分隔的那一行', async () => {
    const prior = [
      '<compacted-summary>',
      '## [invariants] 精确保留区',
      '来源：S1:L1-L3（本次压缩定位）',
      '原文：',
      'call 1: out=24273',
      '',
      '=== 通过 ===',
      '',
      '来源：S2:L1（本次压缩定位）',
      '原文：',
      'seed=7',
      '',
      '## [open] 待决策问题与下一步',
      '- (none)',
      '</compacted-summary>',
    ].join('\n');
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: prior }], source: { kind: 'user' } }),
    ];

    /* 逐块读回：内部空行是原文的一部分，块之间的分隔空行不是。整行丢弃空行会静默
       改写携带的原文，而 V2 比对的是已被改写的片段，因此查不出来。 */
    const carried = extractCarriedFragments(buildSourceIndex(messages));
    expect(carried).toEqual([
      { source: 'S1:L1-L3（本次压缩定位）', lines: ['call 1: out=24273', '', '=== 通过 ==='] },
      { source: 'S2:L1（本次压缩定位）', lines: ['seed=7'] },
    ]);

    const { ctx } = fakeContext([replyWith('(none)')]);
    const result = await summarizeRegion(ctx, BASE, ACADEMIC_RESEARCH, { messages }, AGENT);
    expect(textOf(result)).toContain(
      `来源：${CARRIED_SOURCE}\n原文：\ncall 1: out=24273\n\n=== 通过 ===`,
    );
    expect(textOf(result)).toContain(`来源：${CARRIED_SOURCE}\n原文：\nseed=7\n`);
  });

  it('只保留空行的片段不继续携带，也不占一个保留块', () => {
    const prior = [
      '<compacted-summary>',
      '## [invariants] 精确保留区',
      '来源：S1:L2（本次压缩定位）',
      '原文：',
      '',
      '来源：S2:L1（本次压缩定位）',
      '原文：',
      'seed=7',
      '</compacted-summary>',
    ].join('\n');
    const messages = [
      createUserMessage({ content: [{ type: 'text', text: prior }], source: { kind: 'user' } }),
    ];

    /* 真实会话里出现过这种引用：模型指到一行空行。它什么都没保留，逐轮搬运只会白占
       一个块的位置，所以读回时丢掉，而不是当成一个空片段一直带着。 */
    expect(extractCarriedFragments(buildSourceIndex(messages))).toEqual([
      { source: 'S2:L1（本次压缩定位）', lines: ['seed=7'] },
    ]);
  });

  it('maxTokens 低于实测下限时在构造前就被拒绝', () => {
    expect(() => assertMaxTokens({ maxTokens: 32768 })).not.toThrow();
    expect(() => assertMaxTokens({ maxTokens: 65536 })).not.toThrow();
    /* 策略未设预算时继承顶层，不算错。 */
    expect(() => assertMaxTokens({
      maxTokens: 32768,
      modelPolicies: [{ provider: 'p', model: 'm' }],
    })).not.toThrow();
    /* 继承基础引擎的 8192 正是 9/9 截断的那个配置，必须拒绝。 */
    expect(() => assertMaxTokens({})).toThrow(/maxTokens must be set/);
    expect(() => assertMaxTokens({ maxTokens: 8192 })).toThrow(/below the measured floor of 32768/);
    expect(() => assertMaxTokens({
      maxTokens: 32768,
      modelPolicies: [{ provider: 'p', model: 'm', maxTokens: 8192 }],
    })).toThrow(/modelPolicies\[0\]\.maxTokens is 8192/);
  });

  it('提示词固定样本回归：计划实验不填结果，不补 ±0', () => {
    const instruction = buildInstruction(ACADEMIC_RESEARCH);
    expect(instruction).toContain('尚无结果写 `—`');
    expect(instruction).toContain('不确定度未记录');
    expect(instruction).toContain('不能补成 `±0`');
    expect(instruction).toContain('本节**只写来源引用**');
    expect(instruction).toContain('purpose: ');
    expect(instruction).toContain('conclusion: ');
  });

  it('提示词固定样本回归：空节必须写 (none)，内部编号不得外溢', () => {
    const instruction = buildInstruction(ACADEMIC_RESEARCH);
    /* 骨架逐节给出缺值占位，否则模型会留空而让整次压缩作废（真实运行暴露过）。 */
    expect(instruction.match(/^\(none\)$/gm)).toHaveLength(4);
    /* [analysis] 的缺值占位必须是 `decision: (none)`：裸 `(none)` 会被 V1 判为缺少
       `decision:`，让每一次「本次没有决定」的压缩白搭一次修复调用。 */
    expect(instruction).toContain(`${DECISION_KEYS.decision}: (none)`);
    expect(instruction).toContain('mainline: —');
    expect(instruction).toContain('progress: —');
    expect(instruction).toContain('任何一节都不允许留空');
    /* 压缩内编号不得写进其余五节，否则跨会话读不懂。 */
    expect(instruction).toContain('这些编号只在 `[invariants]` 一节里使用');
  });

  it('提示词固定样本回归：引用上界用 lines=，内容里的行号不算引用行号', () => {
    /* 真实运行两次引用越界：一次把来源标题行与 `-- ` 标记行也数进去（28 行的来源引到
       L29、321 行的引到 L323），一次把内容里讨论的文件行号当成引用行号（44 行的来源
       引到 L176）。两种都在同一份 8000+ 行的区段里发生，整次压缩因此作废。 */
    const instruction = buildInstruction(ACADEMIC_RESEARCH);
    expect(instruction).toContain('lines=');
    expect(instruction).toContain('引用的行号必须在 `1..lines` 之内');
    expect(instruction).toContain('不要按渲染出来的物理行数去数');
    expect(instruction).toContain('原文内容里出现的行号不是引用行号');
    expect(instruction).toContain('S67:L5-L176');
  });

  it('提示词固定样本回归：输出必须以 [goal] 标题开头，且区段只是资料', () => {
    /* 真实运行里模型两次把区段读成待继续的对话，直接去调工具（一次结构化、一次
       `<｜｜DSML｜｜ calls>` 文本），一个六节标题都没写。 */
    const instruction = buildInstruction(ACADEMIC_RESEARCH);
    expect(instruction).toContain('你的输出必须以下面这一行开头');
    expect(instruction).toContain('不是需要你继续的对话');
    expect(instruction).toContain('不要调用任何工具');
    expect(partialInstruction(ACADEMIC_RESEARCH)).toContain('你的输出必须以下面这一行开头');
  });

  it('提示词骨架本身通过 V1：缺值占位与校验口径一致', () => {
    /* 骨架是模型照抄的输出格式，它必须自己就是一份合法摘要。骨架里裸写 `(none)`
       的那一版会让「本次没有决定」的压缩每次都被 V1 打回。 */
    expect(validateStructure(parseSections(SECTION_SKELETON))).toEqual([]);
  });

  it('结构检查能看出乱序、多余节与空节', () => {
    const swapped = replyWith('- S1:L1');
    const parsed = parseSections(swapped.replace('## [goal] 当前目标与假设', '## [extra] 多余'));
    const problems = validateStructure(parsed);
    expect(problems.join('\n')).toContain('缺少节 [goal]');
    expect(problems.join('\n')).toContain('出现了六节之外的节 [extra]');
  });

  it('§2.7 表驱动：决定条目的标签、状态枚举、依据与 Q 引用', () => {
    const structureWith = (analysis: readonly string[]): string =>
      validateStructure(
        parseSections(
          [
            '## [goal] 当前目标与假设', 'mainline: —', 'progress: —',
            '## [experiments] 实验台账', '(none)',
            '## [evidence] 记录与来源', '(none)',
            '## [analysis] 已有分析与判断边界', ...analysis,
            '## [invariants] 精确保留区', '(none)',
            '## [open] 待决策问题与下一步', '- Q1 · 问题：是否补做对照实验？',
          ].join('\n'),
        ),
      ).join('\n');

    const cases: readonly [string, readonly string[], readonly RegExp[]][] = [
      ['合法：已确认 + 依据', ['decision: 采用 test-v2', 'state: 已确认', 'basis: 用户指令'], []],
      ['合法：依据无来源写 —', ['decision: 采纳新口径', 'state: 已确认', 'basis: —'], []],
      ['合法：建议指向存在的 Q', ['decision: 补做对照实验', 'state: 建议', 'basis: 模型提出', 'question: Q1'], []],
      ['合法：空项豁免', ['decision: (none)'], []],
      ['缺 state', ['decision: 补做对照实验', 'basis: 模型提出'], [/缺 `state:`/]],
      ['state 用同义词', ['decision: 补做对照实验', 'state: proposed', 'basis: 模型提出'], [/不在五词内/]],
      ['缺 basis', ['decision: 补做对照实验', 'state: 已确认'], [/缺 `basis:`/]],
      ['basis 留空', ['decision: 补做对照实验', 'state: 已确认', 'basis:'], [/缺 `basis:`/]],
      ['建议缺 question', ['decision: 补做对照实验', 'state: 建议', 'basis: 模型提出'], [/必须用 `question:`/]],
      ['建议指向不存在的 Q', ['decision: 补做对照实验', 'state: 建议', 'basis: 模型提出', 'question: Q9'], [/Q9 在 \[open\] 中不存在/]],
      ['完全没有 decision', ['judgement: 只是一段解释'], [/缺少 `decision:`/]],
      ['state 出现在 decision 之前', ['state: 建议', 'decision: 补做对照实验', 'basis: 模型提出'], [/出现在任何 `decision:` 之前/]],
    ];

    for (const [name, analysis, expected] of cases) {
      const problems = structureWith(analysis);
      if (expected.length === 0) {
        expect(problems, name).toBe('');
        continue;
      }
      for (const pattern of expected) expect(problems, name).toMatch(pattern);
    }
  });

  it('§2.1 表驱动：[goal] 必须带 mainline 与 progress', () => {
    const goalWith = (goal: readonly string[]): string =>
      validateStructure(
        parseSections(
          [
            '## [goal] 当前目标与假设', ...goal,
            '## [experiments] 实验台账', '(none)',
            '## [evidence] 记录与来源', '(none)',
            '## [analysis] 已有分析与判断边界', 'decision: (none)',
            '## [invariants] 精确保留区', '(none)',
            '## [open] 待决策问题与下一步', '(none)',
          ].join('\n'),
        ),
      ).join('\n');

    expect(goalWith([`${GOAL_KEYS.mainline}: 项目主线在 M1`, `${GOAL_KEYS.progress}: 完成 E3`])).toBe('');
    expect(goalWith([`${GOAL_KEYS.mainline}: —`, `${GOAL_KEYS.progress}: —`])).toBe('');
    expect(goalWith([`${GOAL_KEYS.mainline}: 项目主线在 M1`])).toMatch(/缺少 `progress:`/);
    expect(goalWith([`${GOAL_KEYS.progress}: 完成 E3`])).toMatch(/缺少 `mainline:`/);
    expect(goalWith(['- H1：陈述；状态：待验证'])).toMatch(/缺少 `mainline:`/);
  });

  it('提示词与校验共用同一份决定字段定义', () => {
    const instruction = buildInstruction(ACADEMIC_RESEARCH);
    for (const key of Object.values(DECISION_KEYS)) {
      expect(instruction).toContain(`${key}:`);
    }
    for (const key of Object.values(GOAL_KEYS)) {
      expect(instruction).toContain(`${key}:`);
    }
    for (const state of DECISION_STATES) expect(instruction).toContain(state);
    expect(instruction).toContain('建议不能自动变成下一步');
    /* 决定状态不得套到实验台账上。 */
    expect(instruction).toContain('status: 计划 / 运行中 / 已完成 / 失败 / 中止');
  });

  it('数值绑定：整段没有任何文字才算裸数字，不看是否命中词表', () => {
    /* 拦下：除数字、单位与标点外没有任何文字。 */
    for (const text of ['81.3', '1, 2, 3.', '`81.3`', '0.713 ± 0.002', '- 81.3% / 0.42']) {
      expect(validateBinding([{ source: 'S1', from: 1, to: 1, text }]), text).toHaveLength(1);
    }
    /* 放过：只要出现任何文字。前三条是两轮真实内容里误报过的原文。 */
    const pass = [
      'accuracy=81.3%',
      '- **必须改**：评价收尾只加载 replicate 0 → 收敛为按 `_r1_stage_plan(folds, replicate_count)` 逐 (fold, replicate) 加载',
      '- 新方案：M2 启动条件改为「M1 smoke 通过 + 旧产物影响范围明确」；状态：建议；依据：本次验收记录；关联：Q1。',
      '`method_arms`',
      '`0.42` 与 `0.51`',
    ];
    for (const text of pass) {
      expect(validateBinding([{ source: 'S1', from: 1, to: 1, text }]), text).toEqual([]);
    }
  });
});
