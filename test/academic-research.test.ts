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
import { buildInstruction } from '../src/prompt.ts';
import { buildSourceIndex, CARRIED_SOURCE, extractCarriedFragments, renderUnits } from '../src/sources.ts';
import { summarizeRegion } from '../src/summarize.ts';
import type { ResolvedAcademicResearchConfig, SummarizationInput } from '../src/types.ts';
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
} {
  let served = 0;
  const llm = {
    stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
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
  return { ctx: { llm } as unknown as Context, calls: () => served };
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
    /* Both chunks were digested; the third call would be a merge repair that
       cannot reach the chunk stage, so it must not happen. */
    expect(calls()).toBe(2);
  });

  it('编号与行号按消息建立，结构标记不带行号', () => {
    const index = buildSourceIndex(input(REGIONS.zh!).messages);
    expect(renderUnits(index)).toBe(
      [
        '[S1] role=user',
        'L1: E3 使用 test-v2 进行评价。',
        'L2: seed=42',
        'L3: accuracy=81.3%',
        'L4: checkpoint=/project/results/E3.pt',
      ].join('\n'),
    );
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
    /* 骨架逐节给出 (none) 占位，否则模型会留空而让整次压缩作废（真实运行暴露过）。 */
    expect(instruction.match(/^\(none\)$/gm)).toHaveLength(5);
    expect(instruction).toContain('mainline: —');
    expect(instruction).toContain('progress: —');
    expect(instruction).toContain('任何一节都不允许留空');
    /* 压缩内编号不得写进其余五节，否则跨会话读不懂。 */
    expect(instruction).toContain('这些编号只在 `[invariants]` 一节里使用');
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
