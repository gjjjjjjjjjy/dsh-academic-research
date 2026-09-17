# dsh-academic-research

> DeepSeek Harness 的**科研保真**上下文压缩后端：把长会话压成一份六节科研交接记录，
> 其中「精确保留区」由**程序**按模型给出的来源范围**逐字复制**，不由模型重写。

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-compaction-4D6BFE?style=flat-square)](https://github.com/topics/dsh-plugin)

---

## 已实现 / 未实现

包的最终目标是**一个完整的科研 agent**（见 [`docs/ROADMAP.md`](docs/ROADMAP.md)）。
**版本 0 只做了其中一环：压缩后端。** 工作流的可调用入口与科研工具都不在这一版里。

| | |
|---|---|
| **版本 0 已实现** | `ctx.compaction` 后端：六节科研交接记录、`[goal]` 的 `mainline:`/`progress:` 汇报字段、实验台账七字段、来源引用逐字复制、V1–V4 校验 + 一次修复、`general` / `ml` / `optics` 三个领域包。`[analysis]` 的 `decision:` 条目带 `state:`（`建议 / 已确认 / 已实现 / 已验证 / 已否认`）与 `basis:`，由 V1 校验格式 |
| **随包附带，但不是功能入口** | `research-workflow` 技能（四种场景 + 决策包与实施卡两个模板）——**纯提示模板**，没有对应的斜杠命令或工具入口 |
| **尚未实现** | 工作流的可调用入口；文献检索与引用溯源、附件（PDF 等）解析、实验设计与统计检查、可复现性核对、跨会话科研记忆等科研工具。**本包当前不提供任何 `research_*` 之类的科研工具** |

**版本 0 与同概念区其它包的区别只有一条：只做压缩后端 + 附带的提示模板，不做科研工具。**
那是这一版的范围，不是最终目标——最终目标是完整的科研 agent。

---

## `research-workflow` 技能

四种场景（研究梳理 / 实验设计 / 科研实现 / 实验复盘）与两种交接物（决策包 / 实施卡），
位于 [`skills/research-workflow/`](skills/research-workflow/SKILL.md)。**它是提示模板，不是运行时**：
不注册命令、不新增服务、不碰压缩引擎，产出直接进入既有六节，不建第二套台账。

技能不会因为装了包就自动可用，必须让 `skill-filesystem` 看到它。两种挂法：

```yaml
# 挂法 1（推荐）：把本包的 skills 目录加成自定义技能根，
# 加在 preset 里已有的 skill-filesystem 行上
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - /绝对路径/dsh-academic-research/skills
```

```bash
# 挂法 2：软链进用户技能根（项目根也认 .dsh/skills 与 .agents/skills）
ln -s /绝对路径/dsh-academic-research/skills/research-workflow ~/.dsh/skills/research-workflow
```

> 技能里写的「不要擅自跑昂贵实验」**只是行为指令，不是权限隔离**；运行权限仍走宿主的工具与审批管线。

---

## 它解决什么问题

长会话触发压缩时，官方 `dsh-compaction-basic` 的英文通用模板会把会话压成一段工程摘要。
科研会话被这样压过之后，常见的损失是：**实验计划、进展、设计、结果之间的对应关系没了**，
剩下的是一堆「做了优化、效果更好」的叙述；数值、公式、路径被模型顺手「整理」过。

`dsh-academic-research` 改两件事：

1. **换结构**：输出固定六节，把「用什么算法做了什么工作得到什么效果」保留成**实验台账**，
   并把已有分析、判断边界、未决问题分开写，避免把推断写成结论。
2. **换保真方式**：精确保留区不再是「让模型抄一遍原文」，而是**模型只给来源范围，
   程序按范围从输入里逐字取出原文**。模型没有机会改写被选中的数值。

设计规范见 [`docs/SUMMARY-SCHEMA.md`](docs/SUMMARY-SCHEMA.md)。

---

## 机制：模型选来源，程序复制原文

送入压缩模型前，程序把待压区段渲染成带编号的原文，并保留原文本：

```text
[S7]
L1: E3 使用 test-v2 进行评价。
L2: seed=42
L3: accuracy=81.3%
L4: checkpoint=/project/results/E3.pt
```

`S<n>` / `L<n>` 由程序分配。程序此时**不知道**这些内容是否重要，只知道每一行来自哪里。

模型正常写其余五节，但 `[invariants]` 里**只写引用，不重写数值**：

```markdown
## [invariants] 精确保留区
- S7:L1-L4
```

程序检查来源是否存在、行号是否有效，然后逐字取出原文填入最终摘要：

```markdown
## [invariants] 精确保留区
来源：S7:L1-L4（本次压缩定位）
原文：
E3 使用 test-v2 进行评价。
seed=42
accuracy=81.3%
checkpoint=/project/results/E3.pt
```

选择哪些内容重要，是模型的工作；把选中的原文准确复制出来，是程序的工作。
**不能用「程序侧保真」把前一件事假定为已经解决。**

前次检查点里已经明确保留的原文，作为**独立必保集合**由程序直接继续携带，不依赖模型重新选中它。

### 这套机制能保证什么、不能保证什么

| | |
|---|---|
| **能保证** | 被选中的片段不会在这次搬运中被模型改写；前次检查点已保留的原文会继续携带 |
| **不能保证** | 模型选中了所有重要片段；原记录本身正确；某个范围在语义上真的属于它声称的 E |
| **不声称** | 「所有关键数据均已保留」——没有独立必保清单时，这只是「选中的都复制了」 |

---

## 六节结构

输出恰好六节，顺序固定，`[key]` 恒为 ASCII 不翻译，标题标签与叙述跟随会话语言：

```markdown
## [goal] 当前目标与假设
## [experiments] 实验台账
## [evidence] 记录与来源
## [analysis] 已有分析与判断边界
## [invariants] 精确保留区
## [open] 待决策问题与下一步
```

- `[goal]` 开头两条 ASCII 字段：`mainline:`（项目主线——整体目标、当前处于哪一步、该步的验收标准，
  以 `docs/MAINLINE.md` 这类权威文件为准并保留出处）与 `progress:`（本次推进——从什么状态到什么状态、
  还差什么）。检查点按**汇报视角**写，不是任务清单：没看过会话的人要先看懂项目在做什么、这一步推到哪了。
- `[experiments]` 每条实验固定七个 ASCII 字段键：`purpose` / `design` / `config` /
  `status` / `result` / `artifacts` / `conclusion`；缺值写 `—`，无条目写 `(none)`。
  结果**不强制**写成 `value±err`：有 `±` 才保留 `±`，没有就写「不确定度未记录」，不补成 `±0`。
- `[analysis]` 用 `decision:` / `judgement:` 两个槽位：`decision:` 收纳已提出的方案及其状态
  （`state:` 五词之一 + `basis:`，状态为 `建议` 时还要 `question:` 指向 `[open]` 里的 `Q<n>`）；
  `judgement:` 放解释、分析、推断。**这一节是已有分析的交接区，不是压缩模型的推理区。**
- `[open]` 输出待决策问题时用固定的 `Q<n>` 数据包，不预设正确答案。

压缩模型在整个过程中**不新增科研结论、不替用户选择路线、不编造指标或证据**。

---

## 领域包

`domain` 只切换**保留词汇**，不改六节骨架：

| 值 | 补充的保留重点 |
|---|---|
| `general` | 关键参数、样本/输入、评价方式和产物 |
| `ml` | 模型与权重、数据版本与划分、训练参数、精度、seed、评测定义、资源与 processor 信息 |
| `optics` | 波长、偏振、几何/材料、测量或仿真条件、相机与标定记录、不确定度描述 |

`domainExtra` 只**追加**保留提示，不覆盖基础保真规则。

---

## 四项检查与一次修复

| 检查 | 范围 |
|---|---|
| **V1 结构** | 六个键完整、唯一、顺序正确；实验具有七字段；没有用空白替代 `—`/`(none)`；`[invariants]` 草稿只含来源引用 |
| **V2 原文** | 独立必保集合（前次检查点已保留的原文）逐字出现在最终摘要；本次引用全部可解析且原文逐字出现 |
| **V3 数值绑定** | 被选中的范围必须含实验归属或指标/单位/路径标识；只含裸数字的切片判失败并要求扩大范围 |
| **V4 截断** | 接口报截断、返回空内容或明显不完整时，不当成成功摘要 |

失败后**携缺项修复一次**；修复仍不过就抛错，**不提交失败摘要，不回退普通摘要，不做多轮自我修复**。

按 Schema §4.2，**没有跳过保真校验的生产开关**。

---

## 快速开始

### 部署形态 A（推荐）：在 agent preset 的 compaction realm 内替换后端

如果你现有的部署形态是「agent preset 自己拥有压缩后端」（即 preset 内已经挂着某个压缩后端），
那么接入点是**替换 preset 内那一行**，而不是新增一个 host 级压缩器：

```yaml
# ~/.dsh/.agent-presets/<preset>/agent.cordis.yml ，在 preset 已有的
# `isolate: { compaction: true, ... }` 组内：
    - id: academic-research
      name: 'dsh-academic-research'
      config:
        domain: ml
        summaryLanguage: auto
        recursive: true
        chunkMessages: 40
        thresholdRatio: 0.7
        retainRatio: 0.16
        maxTokens: 32768
        auto: true
```

同时把本 bundle 的 host 级行关掉，否则两个引擎会抢同一次压缩决策：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: academic-research
  disabled: true
```

> 换成别的后端时，那个后端自己的配置键在这里不被识别。schemastery 会**原样透传**未知键
> （实测：未知的布尔键会留在解析结果里，既不报错也不剥离），而本后端只读取自己声明的键、
> 并且只把 10 个基础键交给基类，所以留着它们不会报错、也不起作用。可以顺手删掉以免误读。

### 部署形态 B：host 平面直接挂载

只在没有 preset 级压缩后端时使用。`dsh-basic` 的 `compaction-basic` 必须同时禁用，
因为二者提供**同一个** `ctx.compaction`：

```yaml
- id: compaction-basic
  disabled: true
- id: academic-research
  name: 'dsh-academic-research'
  config:
    domain: general
    thresholdRatio: 0.7
    retainRatio: 0.16
    maxTokens: 32768
```

### 装包

包**尚未发布到 npm**（`registry.npmjs.org/dsh-academic-research` 返回 404，名字空着），
所以 `add dsh-academic-research` 目前跑不通。本地用路径安装：

```bash
dsh plugin --profile <profile> add /绝对路径/dsh-academic-research
```

> 这条命令会写 profile 的依赖与 `node_modules`。**在 macOS + pnpm 11.7 上实测通过**：
> 装完从 profile 目录能加载到本包，`@deepseek-ai/cordis` 解析到 dsh 安装的那一份
> （不是插件自带的副本），没有出现两份 cordis。

`dsh.bundle.patch` 会自动禁用 `compaction-basic` 并在 host 平面插入本后端。
**preset 部署请按形态 A 把 host 行禁用掉。**

> ⚠️ 用**目录路径**安装会建 `link:`，插件会加载自己 `node_modules` 里的 `@deepseek-ai` 副本
> （那是为类型检查拷进去的），于是系统里出现两份 cordis。**先 `npm pack` 再装 tarball**，
> tarball 里 `node_modules` 为 0，插件会解析 profile 里那一份。

### 自带 agent 预设

包里带一个装完即可在设置里选用的预设：`academic-research`，显示名「科研模式」。它等于内置
`standard` 的整份 assembly，只把压缩后端换成 `dsh-academic-research`（领域包 `ml`）。这是
`dsh-agent-presets` 认可的 shipped 变体做法（`cordis`、`code` 也这么做），**代价是它不随
dsh 升级自动更新**——升级 dsh 后要重新生成 `presets/academic-research/agent.cordis.yml`。

预设是**目录**，不是单文件：`agent.cordis.yml` + `preset.yml`。两种装法：

**A. 放进用户预设目录（推荐：不改任何配置，不需要重启）**

```bash
cp -R <包>/presets/academic-research ~/.dsh/.agent-presets/
```

`~/.dsh/.agent-presets` 由 `includeUserRoot` 自动扫描，且发现逻辑每次 `list()` 都重读磁盘，
所以刷新页面就能在设置里看到。代价是它是一份**拷贝**，包更新后要重新拷一次。

**B. 把包内的 presets 目录注册成一个 root（不拷贝，但必须停 dsh 再改）**

```yaml
- id: agent-presets
  config:
    default: <你原来的默认预设>
    roots:
      - path: ~/.dsh/profiles/<profile>/node_modules/dsh-academic-research/presets
        trust: system
```

> ⚠️ **这一条必须在 dsh 未运行时写。** 实测两次：`agent-presets` 的整块 `config` 覆盖会触发
> `patchReload: live` 的组合热重载，而重载会让正在运行的会话**失去整个工具面**——所有工具
> 调用返回 `unknown tool`，撤掉该条目即恢复。`disabled: true` 这类禁用条目没有这个问题，
> 可以热改（已实测带 8 秒等待确认）。
>
> `default` 必须一起写出：这一层是整块 `config` 覆盖，不是字段级合并。

路径指向包内目录，所以包更新后预设自动跟着更新——这是选 B 的唯一理由。

**预设按会话选，且会话一旦产生内容就不能再换预设**（换掉会把模型已调用过的工具抽走）。
选了本预设的会话，压缩后端就是本插件；host 平面那一行仍需保持禁用，否则两个引擎会抢
同一次压缩决策。

---

## 配置

| 配置 | 默认 | 含义 |
|---|---|---|
| `domain` | `general` | `general` / `ml` / `optics` |
| `summaryLanguage` | `auto` | `en` / `zh` / `auto`；`auto` 跟随用户自然语言，避免被英文代码和日志带偏 |
| `recursive` | `true` | 大区段先分块摘要再合并 |
| `chunkMessages` | `40` | 分块时每块的消息数 |
| `domainExtra` | `''` | 追加到领域包的保留提示（只追加） |
| `thresholdRatio` | 继承官方 | 触发压缩的上下文窗口比例 |
| `retainRatio` / `retainTokens` | 继承官方 | 保留窗口（二者互斥） |
| `maxTokens` | **必填**（未设或 <32768 在启动时抛错） | 摘要输出上限。本后端的六节摘要需要 ≥32768，见下 |
| `summarizationProvider` / `summarizationModel` | `''` | 留空则复用会话路由模型 |
| `compactionRetries` / `maxOverflowRetries` | 继承官方 | 压力与溢出重试 |
| `modelPolicies` | — | 逐 provider/model 覆盖 |
| `auto` | `true` | 自动压缩 |

压力阈值必须落在真实输入上限内：`thresholdRatio × contextWindow < provider 上限 − maxTokens`。

> ⚠️ **`maxTokens` 不要留默认的 8192。** 六节摘要比官方模板长得多；实测 8192 下压缩
> **9/9 全部失败**，错误是 `summarization truncated at the token cap (incomplete checkpoint)`——
> 被 V4 正确拦下，但那段时间里会话**完全没有压缩**。本仓所有部署片段都写 32768。
>
> 这一项**在构造时强制**：`maxTokens` 未设置、或顶层与 `modelPolicies` 里的值低于 32768，
> 插件会直接抛错而不启动。理由同上——继承基础引擎的 8192 是一个已知必坏的默认值，
> 与其让它在运行时把每次压缩都打掉，不如在装配阶段就暴露出来。

---

## 递归分块

区段超过 `chunkMessages` 时，先按块产出分段摘要，每块**各自给出自己那些来源的引用**；
程序按本次编号逐块解析成原文，再把「已解析的原文」交给合并阶段，而不是只传一层模型转述。
合并阶段的精确保留区同样由程序写入。

---

## 已知边界

以下边界分四类：**保真机制的范围**（机制本身不承诺什么）、**有意接受的取舍**、
**与宿主组件的交互**、**与宿主契约的耦合**。它们都不是待修缺陷；每条的「处置」说明遇到时的
正确做法，做法是按现有设计应对，**不是新增淘汰机制、兼容层或框架**（另见
[`docs/ROADMAP.md`](docs/ROADMAP.md)）。

### 保真机制的范围

- **程序保证被选中片段的复制准确性，不保证选择完整性。** 选哪些内容由模型决定，程序只按引用
  从原文逐字取出。因此「引用有效」既不等于「所选范围在语义上确实属于它标注的实验」，也不等于
  「该选的都选了」。详见上文「这套机制能保证什么、不能保证什么」。
- **V1 通过只说明格式合规**，不说明状态与原始证据一致，更不构成执行授权。
  `basis: 用户已确认` 是模型的记录，不是程序的核实结果。
- **没有独立必保清单时，不得报告「所有关键数据均已保留」。** 只有前次检查点中已明确保留的原文
  构成独立必保集合，程序才有依据检查它是否被继续携带。

### 有意接受的取舍

- **保留区跨压缩单调增长。** 前次检查点的保留片段被无条件继续携带，只增不减。当摘要预算不足以
  容纳时，基础引擎的「摘要必须小于被压区段」检查会**报错并拒绝提交**，不会静默删除已保留的原文。
  **处置**：这是 Schema §3 规定的行为；超长会话最终由人工决定淘汰哪些片段，插件内不自动淘汰。
- **被压区段不复用前缀缓存。** 为保证可引用性，区段以带编号的纯文本送入压缩调用，而非原始消息
  序列，因此这一段不进入前缀缓存；`system` 头与 `tools` 仍按原样传递，那部分前缀照常命中。
  **处置**：压缩调用本身低频，这是为保真付出的代价。真实会话实测摘要调用 `cacheReadTokens=6912`。

### 与宿主组件的交互

- **工具结果裁剪器先于压缩器处理大工具结果。** 默认挂载的
  `dsh-compaction-tool-result-pruner` 把超过 8192 字符的工具结果换成约 4 KB 预览加定位符，
  而压缩器的输入由会话日志派生，因此**大文件正文在压缩之前就已不在压缩器视野内**
  （实测：13507 token 的文件读取被裁成单个预览节点）。
  **处置**：职责划分是——裁剪器负责大工具结果，压缩器负责对话历史。需要正文时回读源文件，
  不要指望它出现在检查点里。

### 与宿主契约的耦合（宿主升级后需复核）

- **必须满足 `maxTokens ≥ 32768`，且在构造时强制。** 六节摘要显著长于官方模板；实测 8192 下
  压缩 9/9 全部失败（`summarization truncated at the token cap`）。**处置**：未设置或低于下限时
  插件抛错、不启动，而不是让一个已知必坏的默认值进入运行时。见上文「配置」。
- **契约类型是镜像的。** 已装的 `@deepseek-ai/dsh-compaction-basic` 既不从根导出
  `SummarizationInput` / `SummaryResult`，其 `"./src/*"` 子路径也指向未发布的文件，因此本包镜像了
  这两个类型，只依赖 `dsh-llm` 的根导出。**处置**：宿主升级后重新核对镜像。
- **存在 API 漂移。** 已装的 `0.1.5-rc.2` 契约中 `SummarizationInput` **没有** `system` 字段
  （system 头是 `messages[0]`）；按 `0.1.0-rc.6` 旧契约写的镜像带 `system`，对当前运行时不成立。
- **自带预设是内置 `standard` 的整份拷贝。** 这是 `dsh-agent-presets` 认可的 shipped 变体做法，
  代价是**不随 dsh 升级自动更新**。**处置**：升级 dsh 后重新生成
  `presets/academic-research/agent.cordis.yml`。

---

## 开发

编码规则见 [`AGENTS.md`](AGENTS.md)。改动前先读
[`docs/SUMMARY-SCHEMA.md`](docs/SUMMARY-SCHEMA.md)：产品目标已升级为科研推进工作流（§0.1，分阶段），
但**压缩引擎只负责压缩**，工作流模板不进入本包（§6.1）。

```bash
npm install          # 含 .npmrc：legacy-peer-deps，跳过重型 peer 解析
npm run typecheck    # tsc -p tsconfig.test.json（含 src 与 test）
npm test             # vitest run —— 单文件最小测试，18 个用例
npm run build        # 产出 lib/
```

类型检查需要 dsh 运行时的 `@deepseek-ai` 作用域。它们装在 dsh 自己的
`node_modules` 里，把该作用域复制进本包的 `node_modules/@deepseek-ai` 即可解析：

```bash
cp -R "$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/." node_modules/@deepseek-ai/
```

> ⚠️ **拷完之后不要再跑 `npm install`。** 这个作用域不在 `package.json` 里，`npm install`
> 会把它当多余包**清掉**（240 个包只剩 2 个），typecheck 随即全红。要装依赖就先装、再拷。

源码用 `.ts` 相对导入，靠 TS 5.7+ 的 `rewriteRelativeImportExtensions` 在构建时重写成 `.js`。

> 若 `npm install` 报 `EPERM ... ~/.npm/_cacache`（全局 npm 缓存里有 root 所有的文件），
> 换一个工作区内的缓存目录即可：`npm install --cache ./.npm-cache --logs-dir ./.npm-logs`。

测试集中在一个文件，覆盖 Schema §6.1 要求的几类：另一种语言的同一用例、
漏字段、改写数值、引用不存在、裸数字、截断、编号渲染、前次保留片段的继续携带、
空节 `(none)` 与内部编号不外溢、§2.7 决定条目的标签/状态枚举/依据/Q 引用（表驱动 12 例）、
提示词与校验共用同一份字段定义。**这些用例只证明选中片段的复制准确性，不证明选择完整或科研语义正确。**

---

## 兼容性

- 针对 `dsh` 的 `@deepseek-ai/dsh-compaction-basic@0.1.5-rc.2`
  （`SummarizationInput` = `{ tools?, messages }`，`publish/` 无 `src/`）开发与类型检查。
- 继承官方全部压力 / 保留 / token 计量 / 事务逻辑，只重写 `summarize()` 钩子。
- License: MIT
