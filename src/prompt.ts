/**
 * Compaction instruction builders.
 *
 * The prompt carries the Schema's contract: the compaction model organizes
 * records, preserves original text, and lists existing problems and obvious
 * gaps. It does not add conclusions, choose a research route, or perform the
 * cross-experiment reasoning that belongs to the user or a stronger model.
 *
 * @module dsh-academic-research/prompt
 */

import { DOMAIN_PACKS } from './domains.ts';
import { DECISION_KEYS, DECISION_STATES, GOAL_KEYS } from './validate.ts';
import type { ResolvedAcademicResearchConfig } from './types.ts';

/** Instruction fragment selecting the output language. */
function languageGuidance(cfg: ResolvedAcademicResearchConfig): string {
  switch (cfg.summaryLanguage) {
    case 'zh':
      return '用简体中文写标题标签和叙述。代码、标识符、路径、公式和数字保持原样，不要翻译。';
    case 'en':
      return 'Write the section labels and narrative in English. Keep code, identifiers, paths, formulas, and numbers verbatim.';
    default:
      return '标题标签和叙述跟随用户的自然语言：用户主要用中文就用中文，主要用英文就用英文。'
        + '不要因为代码、日志或工具输出是英文就整篇改写成英文。';
  }
}

/** The six-section skeleton, in the only accepted order. `(none)` is the literal default. */
const SECTION_SKELETON = [
  '## [goal] 当前目标与假设',
  `${GOAL_KEYS.mainline}: —`,
  `${GOAL_KEYS.progress}: —`,
  '',
  '## [experiments] 实验台账',
  '(none)',
  '',
  '## [evidence] 记录与来源',
  '(none)',
  '',
  '## [analysis] 已有分析与判断边界',
  '(none)',
  '',
  '## [invariants] 精确保留区',
  '(none)',
  '',
  '## [open] 待决策问题与下一步',
  '(none)',
].join('\n');

/** The citation-only rule for the preserved section. */
const CITATION_RULE = [
  '本节**只写来源引用**，不要抄写内容：',
  '',
  '```',
  '- S7:L1-L4',
  '```',
  '',
  '程序会按你给的范围逐字取出原文、填入最终摘要，所以不要在这里重写数值。',
  '选范围时要带上实验归属（H/E 编号）、指标名和必要条件；不能只选一行裸数字。',
  '没有需要保留的原文时写 `(none)`。',
].join('\n');

/** How the model must read the numbering the program assigned. */
const NUMBERING_RULE = [
  '待压原文已经按消息编号为 `[S1]`、`[S2]`…，每条消息内部逐行编号为 `L1`、`L2`…。',
  '`S7:L1-L4` 表示「第 7 条来源的第 1 到第 4 行（含两端）」。',
  '以 `-- ` 开头的行是结构标记（例如工具调用与工具结果的分界），它们没有行号，不能被引用。',
  '**这些编号只在 `[invariants]` 一节里使用。** 其余五节不得出现 `S<n>`、`L<n>` 或 `S7:L1-L4` —— 它们只在本次压缩内有效，换一个会话就读不懂。`[evidence]` 的出处写 `E<n>`、精确文件路径或 `(未溯源)`。',
].join('\n');

/** Sections shared by the single-pass and chunked prompts. */
function bodyContract(cfg: ResolvedAcademicResearchConfig): string {
  const pack = DOMAIN_PACKS[cfg.domain];
  const extra = cfg.domainExtra.trim().length > 0 ? `\n${cfg.domainExtra.trim()}` : '';
  return [
    '## [goal] 当前目标与假设',
    '',
    '这一节要让**没看过本会话的人先看懂项目在做什么、这一步推到哪了**，然后才是当前任务。开头两条固定字段（字段键保持 ASCII）：',
    '',
    '```',
    `${GOAL_KEYS.mainline}: <项目主线——整体目标、当前处于主线的哪一步/哪个条目、该条目的验收标准>`,
    `${GOAL_KEYS.progress}: <本次推进——相对上一状态做了什么、到了哪一步、还差什么>`,
    '```',
    '',
    `- \`${GOAL_KEYS.mainline}:\` 以项目权威文件为准（如 \`docs/MAINLINE.md\`、\`ARCHITECTURE.md\`），**保留出处路径与所处条目编号**，只摘当前相关部分，不复制整份规范；原文没有就写 \`—\`。`,
    `- \`${GOAL_KEYS.progress}:\` 写成进展汇报而不是待办清单：**从什么状态到什么状态**、产出了什么、还差什么。本次没有推进就写 \`—\`。`,
    '- 两条都**只写原文已有的内容**，不得据推测补全主线阶段或推进幅度。',
    '',
    '然后保留当前研究问题、最新明确任务、交付物和用户的实现约束。不要只记录长远研究目标而漏掉当前要完成的代码或实验任务。',
    '',
    '每条已有假设写一行：`H<n>：陈述；适用范围；支持/否定判据；状态；依据。`',
    '判据中的公式、阈值和单位逐字保留；未定义写 `—`。',
    '状态沿用 `待验证 / 部分支持 / 被否定 / 已确认` 四值，但**你不要自行升级状态**；'
      + '原文已有判断而依据不足时写「原文判断：……；依据：未溯源」，不要代替原作者证明或否定它。',
    '没有正式假设就写 `假设：(none)`。目标或判据是否需要修改，转入 `[open]`。',
    '已有 MAINLINE、AGENTS.md 或用户指令中当前适用的条款，带出处保留；只提供转述时注明「据输入转述」。只摘实际相关条款，不复制整份规范。',
    '任务排除条件必须保留作用阶段，不把「不参与评价」外推成「不参与训练」。',
    '',
    '## [experiments] 实验台账',
    '',
    'E 编号是记录标识，不占字段。每条实验先单独写一行 `E<编号>`，再写七个 ASCII 字段键；键固定、顺序固定，缺值写 `—`，不许省略字段：',
    '',
    '```',
    'E3',
    'purpose: 关联的 H 编号或明确任务，说明这条实验要回答什么',
    'design: 已确定的方法、数据与划分、对照及控制变量；保留各阶段的参与/排除集合和评价口径，未定部分显式写出',
    'config: 本次实际使用或已确定将使用的关键参数；区分计划配置与实际配置',
    'status: 计划 / 运行中 / 已完成 / 失败 / 中止；只保留有记录的进展，失败原因有记录才写',
    'result: 原始指标和条件；尚无结果写 `—`，不要把预期结果填进来',
    'artifacts: 精确路径及角色（选中模型 / 最后状态 / 续跑状态等）；已知 epoch、版本和下游读取者一并保留，不从名称猜测；区分预期与已产生',
    'conclusion: 无判断写 `—`；有判断则标「原文报告已验证 / 推断 / 待判定」，并记录依据',
    '```',
    '',
    '结果**不统一强制成 `value±err`**，按记录实际形态保留：有 `±` 才保留 `±`，已有 SD/SE/CI 定义则一并保留；没有就写「不确定度未记录」，不能补成 `±0`。',
    'baseline 和 Δ 已给出就原样保留；baseline 给了而 Δ 没给，保留两边原值并写 `Δ=—（未计算）`；压缩调用不承担新计算。',
    '不清楚单位或是否可比时，保留原文并列为缺口，不自行解释。',
    '不新增实验编号，不使用输入里没有的 H/E 编号；不把每次代码编辑登记为一个实验。代码修复不自动变成一次成功实验。',
    `配置字段里还要记住本领域已经记录的内容：${pack.configFields}${extra}`,
    '',
    '## [evidence] 记录与来源',
    '',
    '每条写成 `主张或记录 ← 来源`。来源只分三类：文献（已有 citation key / DOI / arXiv id）、实验（已有 `E<n>`）、文件（精确路径，附原记录提供的字段、行号或图号）。',
    '缺出处写 `← (未溯源)`。不要补造引用，也不要在压缩时主动检索文献。',
    '区分「工具输出记录」「用户报告」「模型意见」；对话中给出的模型建议不会因为附上 E 编号就变成实测事实。',
    '重要结论的原始来源要随摘要保留，不能只剩「上次摘要说它是对的」。文件内容未提供时，只保留路径和可见描述。',
    '',
    '## [analysis] 已有分析与判断边界',
    '',
    '本节是**已有分析的交接区，不是你的推理区**。用下面两种条目，字段键保持 ASCII 不翻译：',
    '',
    '```',
    `${DECISION_KEYS.decision}: <已提出的方案或决定>`,
    `${DECISION_KEYS.state}: <${DECISION_STATES.join(' | ')}>`,
    `${DECISION_KEYS.basis}: <依据；没有来源写 —>`,
    `${DECISION_KEYS.question}: <状态为「建议」时必填，指向 [open] 里存在的 Q 编号>`,
    `${DECISION_KEYS.judgement}: <解释、分析、推断及其依据>`,
    '```',
    '',
    `- \`${DECISION_KEYS.decision}:\` 收纳**已提出的方案及其当前状态**，包括尚未确认的建议。**出现在这里不等于已经获准执行。**`,
    `- 没有决定时写一行 \`${DECISION_KEYS.decision}: (none)\`；该空项不需要 \`${DECISION_KEYS.state}:\` 与 \`${DECISION_KEYS.basis}:\`，也不要为了填满而编一条决定。`,
    `- 每条非空 \`${DECISION_KEYS.decision}:\` 必须带 \`${DECISION_KEYS.state}:\`（五词之一）与 \`${DECISION_KEYS.basis}:\`；没有来源时 \`${DECISION_KEYS.basis}:\` 写 \`—\`，**不得为了通过校验编造确认记录**。`,
    `- 状态为 \`建议\` 的条目必须用 \`${DECISION_KEYS.question}:\` 指向 \`[open]\` 中已有的 \`Q<n>\`。`,
    `- \`${DECISION_KEYS.judgement}:\` 只放解释、分析、推断以及已有疑点 —— 它**不带**这套状态；这两类不要混写。`,
    '',
    '**建议不能自动变成下一步。** 只有后续输入明确给出确认依据，才能据此更新状态、并把动作写进 `[open]` 的 `已确定下一步：`。强模型提出过、或被重复写过几次，都不构成升级理由。',
    '原文有跨实验关系就点名 E 编号；没有就不要强行寻找矛盾、不要强行排除替代解释、不要强行生成反证条件。',
    '同一指标出现不同数值但实验条件是否一致未知时，只写「记录存在差异，可比性未定」，不要直接宣布互相矛盾。',
    '已有的「已验证 / 推断 / 猜测」标记原样保留，不要重新评级；可以把推断性结论写成推断，禁止把推断升级成已验证事实。',
    `本领域要留意的是：${pack.recordedHints}`,
    '已审查但未采纳的建议，保留「不改的理由」并把当前执行限制放入 `[open]`；不要把「审查建议」改写成「必须修复」。',
    '',
    '## [invariants] 精确保留区',
    '',
    CITATION_RULE,
    '',
    '选择范围时优先保留带上下文的原始行或小段，不只摘出裸数字；数值必须仍能对应到原实验、指标和条件。',
    '重复中间输出可以不选；但仍被分析、调试或下一步决策引用的记录不得漏选。',
    '当前任务已有下列执行契约时同样选中其原文与适用范围；无关项不展开，不凭模板补全：',
    '范围与顺序（训练/开发/评价各用哪些任务、评价臂固定顺序、baseline 的明确身份）；计算定义（目标函数、阈值比较符、平局规则、聚合对象与权重与分母与去重规则）；'
      + '产物身份（产物对应选中 epoch、最后 epoch 还是续跑状态，下游实际读取哪个产物）；执行边界（进程分工、共享文件写入者与同步条件、缺关键数据时的停止规则、seed 的角色与约束）。',
    `本领域优先保留：${pack.invariantFields}`,
    '',
    '## [open] 待决策问题与下一步',
    '',
    '按需要记录四类，不强制每类都有条目：',
    '',
    '1. `已确定下一步：` 目标、最小实施动作、必须不变的条件和验收方式。**只有已获确认的动作放这里**；仍属建议的留在 `[analysis]` 的 `decision:` 条目里。',
    '2. 待决策问题：交给用户或高能力模型，不要代答。使用这个紧凑数据包：',
    '',
    '```',
    'Q<n> · 问题：究竟需要决定什么？',
    '依据与缺口：相关 E 编号、关键原值或精确保留区位置；缺少哪些信息。',
    '需要的答复：例如确定对照、解释差异、选择下一步实验；不预设正确答案。',
    '执行边界：哪些既定任务仍可继续，哪一步需要等该问题解决；原文未定则写 —。',
    '```',
    '',
    '3. 阻塞项：明确缺少的数据、权限、算力、接口或参数。',
    '4. `已否决方案：` 方案、原有否决理由、已有重启条件；不要编造永久禁止条件。',
    '',
    '不要求你提供候选方案、优先级评分或推荐答案；不要制造「有深度」的问题。',
    '代码修改期间，用普通条目交接这些实际状态：工作树（是否未提交；基准 commit、修改文件和 diff 定位有记录则保留，否则 `—`）、'
      + '处理（哪些条目报告已改、已删或未采纳；谁报告的）、验证（实际运行过的命令、观察结果与未覆盖项）、产物影响（哪些既有结果或模型需重算或复核；没有决定则列为待决策）。',
    '「报告已修」不等于已查看当前 diff，也不等于回归通过或正式重跑完成；提交状态另行记录。',
  ].join('\n');
}

/** Boundary rules that keep the compaction model out of scientific decisions. */
const BOUNDARY_RULES = [
  '## 你的职责边界（最重要）',
  '',
  '- 只整理原文里已经存在的记录。不得新增科研结论，不得替用户或执行者选择研究路线，不得编造指标、证据、单位、不确定度、重复次数、baseline、Δ、显著性、路径、进度、因果解释或结论。',
  '- 没有记录时写 `—` 或 `(none)`，不要补全。',
  '- 只有「准备运行」不能写「运行中」；有命令不能写「已执行」；进程结束不能写「假设已确认」。',
  '- 看见路径不等于已经读取文件；看见工具输出不等于科研结果已经独立核验。',
  '- 高能力模型给出的方案不等于已经通过实验验证；审查意见是建议，不自动覆盖已确认规格。',
  '- `[analysis]` 只整理已经存在的分析，不承担新的交叉推理。',
].join('\n');

/** Merge and verbatim rules shared by every prompt shape. */
const FIDELITY_RULES = [
  '## 保真要求',
  '',
  '- 公式、单位、阈值、常量、路径、命令、报错串、标识符一律逐字保留：禁止四舍五入、单位换算、符号替换、公式化简和路径改写。',
  '- 原文里若出现 `<compacted-summary>` 块，它是前次检查点：保留仍成立的事实，丢弃已过时的，合并成一份，不要逐字照抄。',
  '- 不同条件下的旧结果不能被新结果静默覆盖；明确纠正的记录写「旧值 → 新值，纠正依据」。重复出现的说法不算新增证据。',
  '- 不要提及这次压缩请求，不要说明上下文被压缩过。只输出检查点文本，不要调用任何工具。',
].join('\n');

/**
 * Build the single-pass compaction directive.
 *
 * @param cfg - resolved dsh-academic-research configuration.
 * @returns the instruction appended after the numbered region.
 */
export function buildInstruction(cfg: ResolvedAcademicResearchConfig): string {
  return [
    '你现在是一次科研会话的压缩引擎。把上方按来源编号给出的待压原文，整理成一份保真的科研交接记录，让下一位决策者看清「确实记录了什么、尚不知道什么、需要决定什么」，让下一位执行者看清「按什么方案实现、哪些条件不能动、如何报告结果」。',
    '',
    BOUNDARY_RULES,
    '',
    '## 来源编号怎么读',
    '',
    NUMBERING_RULE,
    '',
    '## 输出格式',
    '',
    '输出恰好六节，顺序固定；`[key]` 原样保留 ASCII，不要新增第七节、不要改名。段内用紧凑条目，不写散文。',
    '',
    '**骨架里每节下面的 `(none)` 是占位**：有内容就替换它，没有内容就原样保留 `(none)`。**任何一节都不允许留空** —— 留空会被判为结构失败，整次压缩作废。',
    '',
    '```markdown',
    SECTION_SKELETON,
    '```',
    '',
    languageGuidance(cfg),
    '',
    bodyContract(cfg),
    '',
    FIDELITY_RULES,
  ].join('\n');
}

/**
 * Build the chunk digest directive for the recursive path.
 *
 * @param cfg - resolved dsh-academic-research configuration.
 * @returns the instruction for one chunk of the region.
 */
export function partialInstruction(cfg: ResolvedAcademicResearchConfig): string {
  return [
    '你现在是一次科研会话的压缩引擎。上面是待压原文的一个分段。把这一段整理成分段摘要，供后续合并。',
    '',
    BOUNDARY_RULES,
    '',
    '## 来源编号怎么读',
    '',
    NUMBERING_RULE,
    '',
    '## 输出格式',
    '',
    '同样输出六节，但内容从简：前五节写这一段的紧凑要点，`[invariants]` 只写这一段里需要逐字保留的来源引用。',
    '',
    '```markdown',
    SECTION_SKELETON,
    '```',
    '',
    languageGuidance(cfg),
    '',
    '`[invariants]` 的写法：',
    '',
    CITATION_RULE,
    '',
    FIDELITY_RULES,
  ].join('\n');
}

/**
 * Build the merge directive that folds chunk digests into the final summary.
 *
 * @param cfg - resolved dsh-academic-research configuration.
 * @param partials - ordered chunk digests.
 * @param invariantBlocks - already-resolved preserved blocks, verbatim.
 * @returns the merge instruction.
 */
export function mergeInstruction(
  cfg: ResolvedAcademicResearchConfig,
  partials: readonly string[],
  invariantBlocks: readonly string[],
): string {
  return [
    '下面按顺序给出了同一次压缩中各分段的摘要。把它们合并成一份六节交接记录。',
    '',
    BOUNDARY_RULES,
    '',
    '## 输出格式',
    '',
    '输出恰好六节，顺序固定；`[key]` 原样保留 ASCII，不要新增第七节。',
    '',
    '```markdown',
    SECTION_SKELETON,
    '```',
    '',
    languageGuidance(cfg),
    '',
    '## 精确保留区（程序已解析，必须逐字保留）',
    '',
    '`[invariants]` 一节必须原样包含下面这些块，不要改写、不要合并、不要重新编号。若下面为空，`[invariants]` 写 `(none)`。',
    '',
    invariantBlocks.length === 0 ? '(none)' : invariantBlocks.join('\n\n'),
    '',
    FIDELITY_RULES,
    '',
    '## 各分段摘要',
    '',
    partials.join('\n\n---\n\n'),
  ].join('\n');
}

/**
 * Append the one repair directive to any base instruction.
 *
 * @param instruction - the directive that produced the failed draft.
 * @param problems - the failure list produced by the checks.
 * @returns the repair instruction.
 */
export function withRepair(instruction: string, problems: readonly string[]): string {
  return [
    instruction,
    '',
    '## 上一次输出没有通过检查，请完整重做',
    '',
    '下面逐条列出了缺失或不合法的地方。请输出一份**完整**的六节交接记录，逐条修掉这些问题；不要只输出被修复的部分，也不要解释。',
    '',
    ...problems.map((problem) => `- ${problem}`),
  ].join('\n');
}
