# dsh-academic-research

> DeepSeek Harness 的**科研保真**上下文压缩后端：检查点由**程序**从会话日志生成，**不调用模型**。
> 用户原话与助手文字逐字保留、标明是谁说的；推理与工具输出移出窗口，但每条都留下读回用的 `seq`。

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-compaction-4D6BFE?style=flat-square)](https://github.com/topics/dsh-plugin)

---

## 已实现 / 未实现

包的最终目标是**一个完整的科研 agent**（见 [`docs/ROADMAP.md`](docs/ROADMAP.md)）。目前实现的是压缩后端与工作流技能；
科研工具不在其中。

| | |
|---|---|
| **压缩后端** | `ctx.compaction` 的唯一提供方。检查点由程序生成：用户原话、助手文字逐字并标作者；工具调用一行、指向结果的 `seq`；读写过的文件清单；前次检查点逐字接上。不调用模型，因此不会因模型输出出错而失败 |
| **随包附带的技能** | `research-workflow`（五种场景 + 决策包与实施卡两个模板），由 `academic-research` 预设随包挂载（`presets/academic-research/skills/`）。用户写 `/research-workflow <场景词>` 显式调用——这是宿主 `dsh-tool-skill` 自带的技能手势，**本包不注册斜杠命令、不提供工具**，技能本身仍是提示模板。入口已在 dsh 0.2.2-rc.1 源码上确认；**真实研究流程的验收尚未做**（[`docs/ROADMAP.md`](docs/ROADMAP.md) 阶段 2） |
| **尚未实现** | 研究状态条目的出处核对（条目引用用户原话的 `seq`、由程序逐字核对）；文献检索与引用溯源、附件（PDF 等）解析、实验设计与统计检查、可复现性核对等科研工具。**本包当前不提供任何 `research_*` 之类的科研工具** |

---

## `research-workflow` 技能

五种场景（研究梳理 / 实验设计 / 科研实现 / 实验复盘 / 恢复与交接）与两种交接物（决策包 / 实施卡），
位于 [`presets/academic-research/skills/research-workflow/`](presets/academic-research/skills/research-workflow/SKILL.md)。
**它是提示模板，不是运行时**：不注册命令、不新增服务、不碰压缩引擎；产出写进研究状态记录（六节，见 [`docs/SUMMARY-SCHEMA.md`](docs/SUMMARY-SCHEMA.md) §2），不建第二套台账。

> 这五种**场景**与 [`docs/SUMMARY-SCHEMA.md`](docs/SUMMARY-SCHEMA.md) §0.1 的四种**工作方式**
> （研究整理 / 研究评议 / 实施推进 / 恢复与交接）是两套并存的叫法，不改名、不合并；
> 逐条对应关系见 [`SKILL.md` §零](presets/academic-research/skills/research-workflow/SKILL.md)。

### 调用

在消息里写 `/research-workflow`，后面跟场景词和材料：

```text
/research-workflow 梳理 为什么 E3 在 test-v2 上掉点
/research-workflow 设计 E4 是否要补同学习率的对照
/research-workflow 实现 Q2 已确认的实施卡
/research-workflow 复盘 E4
/research-workflow 恢复 @<上一个会话>
```

- 这是 dsh 0.2.2-rc.1 宿主自带的技能手势（`dsh-tool-skill` 的 pre-step 监听器）：用户消息里以空白为界的
  `/<技能名>` 命中一个用户可调用的技能时，宿主把技能全文作为指令上下文注入当轮，不靠模型自己想起来加载。
  Web 输入框里输入 `/` 也能从建议里选（`dsh-client-ui-skill`）。
- **名字后面要有空格或换行**：`/research-workflow设计` 不触发（手势要求名字两侧是空白），整行会作为普通文字发给模型。
- 场景词：`梳理` / `设计` / `实现` / `复盘` / `恢复`（或 `交接`）。没写、且请求对不上唯一一个场景时，技能要求模型先问一句要哪一段。
- `恢复` 配合 `@` 会话引用使用（`dsh-session-reference`，web profile 已挂载）：被引用会话以有界只读快照进入上下文，
  只含双方文字与压缩检查点、**不含工具输出**，并被标为不可信背景。技能要求先用工具核对工作树、产物和作业状态，
  输出核对表，再接着做。
- 每次调用把技能全文（约 4.8k 字符）注入当轮一次；不调用时只占技能目录里的一行描述。

**技能随预设一起走，装预设就等于装上它。** `academic-research` 预设的 `skill-filesystem` 行用
`baseUrl`（预设自己的目录）挂载同目录下的 `skills/`，所以两种装法都带技能，不需要额外的挂载步骤；
这与 dsh 自带 `cordis` 预设挂自己技能的做法一致：

- **挂法 A（拷贝）**：`cp -R <包>/presets/academic-research ~/.dsh/.agent-presets/` 会把 `skills/` 一起拷过去。
- **挂法 B（注册包内 presets 目录）**：直接从包内读取，`skills/` 本来就在预设目录旁边。

要让**别的预设**（例如 `standard-pro`）也能用到它，再把它软链进用户技能根
（`skill-filesystem` 默认扫描 `<dshHome>/skills`，对所有预设与项目生效；该根被 watch，
**加完当前会话下一轮就能看到，不需要重启**）：

```bash
ln -s <包>/presets/academic-research/skills/research-workflow ~/.dsh/skills/research-workflow
```

> 技能里写的「不要擅自跑昂贵实验」**只是行为指令，不是权限隔离**；运行权限仍走宿主的工具与审批管线。

---

## 它解决什么问题

上一版让压缩模型把会话重写成一份六节科研交接记录。真实会话里这条路有三个问题：

1. **经常压不出来**：一个真实会话 13 次压缩只成功 2 次——引用越界、模型把区段当成待继续的任务去调工具、
   只出 reasoning 不出正文、区段超过模型上下文。失败时会话完全没有压缩，每次白等 30 秒到 10 分钟。
2. **会改写「谁说的」**：整段重写时，助手的推测可以变成「当前假设」，一条判断可以被补成 `state: 已确认`
   （实际发生过）。读的人分不清哪句是用户说的。
3. **选错的留下来**：模型挑中的原文才被保留，一份成功检查点的保留区里有 goal 对象的三个历史版本、模型自己的思考原文、
   孤立的代码行，并逐轮累积。

同类研究的结论一致：丢弃工具输出与模型总结效果相当、成本低得多；逐字保留对话、丢弃工具输出并可按需回查，
多轮压缩后的事实回忆明显好于模型总结。设计依据与出处见 [`docs/SUMMARY-SCHEMA.md`](docs/SUMMARY-SCHEMA.md) §1.1。

---

## 检查点长什么样

```markdown
本检查点由 dsh-academic-research 按固定规则从会话日志生成，没有调用模型改写。
- 「用户」条目是用户原话，逐字保留。「助手」条目是助手当时写的文字，逐字保留；其中的结论、数值和状态没有经过核实，不是用户确认过的前提。
- 推理、工具输出和注入上下文没有保留。需要原文时用 session_event_read 按 seq 读回（本会话 id：…），或重新读取文件、重新运行命令。
- 工作区规则（AGENTS.md 等）由宿主在压缩后重新注入，不在本检查点里。
- 研究状态以项目里的状态文件为准（如 .research/STATE.md）；接着做之前先核对真实代码、产物与作业状态。

## [rounds] 压缩记录
- 第 1 次：seq 9–3633，977 条消息；未保留：推理 777593 字符，工具输出 512259 字符（482 次调用），注入上下文 49 条

## [files] 涉及的文件
- src/index.ts（读）
- .trace/proxy.mjs（读、写、改）

## [record] 逐字记录
[用户 · seq 9]
更新当前插件支持新版的dsh

[注入 · seq 10] agent-instructions · instructions（未保留）

[助手 · seq 19]
- 调用 bash：List workspace root contents → 结果 seq 23（1421 字符，未保留）
- 调用 bash：Show plugin package.json and dsh checkout → 结果 seq 27（1370 字符，未保留）

[助手 · seq 41]
- 调用 read：src/index.ts → 结果 seq 4017（5159 字符，未保留）
```

（以上节选自一次真实区段的输出；`seq 4017` 是一个替换节点，它的 `sourceEventSeqs` 指向原始事件 `seq 43`。）

| 区段里的内容 | 检查点里 |
|---|---|
| 用户原话 | 逐字，标 `[用户 · seq]` |
| 助手文字 | 逐字，标 `[助手 · seq]`，并声明未核实 |
| 推理 | 不保留，计字符数 |
| 工具调用 | 一行：工具名 + 一句说明 + 结果的 `seq`、字符数、是否出错 |
| 工具输出 | 不保留，计字符数，按 `seq` 读回 |
| 注入的上下文 | 一行出处；工作区规则由宿主在压缩后重新注入 |
| 前次检查点 | 本格式：分节接上，不嵌套；其它格式（包括本包上一版的六节检查点）：整段逐字作为一条记录 |

**读回**：预设挂载 `dsh-tool-session-query`，`session_event_read` 不传 `session_id` 就读当前会话，按 `seq` 返回完整事件。
宿主以 `openAt: never` 打开查询服务时只有全文搜索不可用，按 `seq` 读取仍可用。

**研究状态不在检查点里**：六节研究状态（目标、实验台账、证据、分析、保留原文、待决问题）由工作中的 agent
在事情发生时写进项目的状态文件，规则见 [`docs/SUMMARY-SCHEMA.md`](docs/SUMMARY-SCHEMA.md) §2。压缩只搬运原话，不生成也不改写它。

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
        thresholdRatio: 0.7
        retainRatio: 0.16
        auto: true
```

同时把本 bundle 的 host 级行关掉，否则两个引擎会抢同一次压缩决策：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: academic-research
  disabled: true
```

> 配置只有基础引擎的键。别的后端的键、以及本包上一版的 `domain` / `summaryLanguage` / `recursive` /
> `chunkMessages` / `domainExtra`，都会被基础引擎的键校验拒绝（`BasicCompactionConfig: unknown key "…"`），启动失败。
> 换后端或升级本包时要把这些键删掉。

### 部署形态 B：host 平面直接挂载

只在没有 preset 级压缩后端时使用。`dsh-basic` 的 `compaction-basic` 必须同时禁用，
因为二者提供**同一个** `ctx.compaction`：

```yaml
- id: compaction-basic
  disabled: true
- id: academic-research
  name: 'dsh-academic-research'
  config:
    thresholdRatio: 0.7
    retainRatio: 0.16
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
`standard` 的整份 assembly，改动只有四处：压缩后端换成 `dsh-academic-research`、
挂上 `dsh-tool-session-query`（按 `seq` 读回被压掉的事件，见下文）、
`skill-filesystem` 行挂上预设自带的 `skills/`（`research-workflow`，见上文）、`persona` 行写入
**科研硬性要求**（长程 agent 中默认不新增 hash／冻结 contract／baseline／gate；不写兜底分支；
做根因修复；临时产物在对应工作结束后删除等，见 `presets/academic-research/agent.cordis.yml`）。
persona 是本预设恒常生效的一层，所以这些要求不依赖工作区里有没有 `AGENTS.md`、也不依赖技能
是否被加载；项目自己的 `AGENTS.md` 照常生效。这是 `dsh-agent-presets` 认可的 shipped 变体做法
（`cordis`、`code` 也这么做），**代价是它不随 dsh 升级自动更新**——升级 dsh 后要重新生成
`presets/academic-research/agent.cordis.yml`。

预设是**目录**，不是单文件：`agent.cordis.yml` + `preset.yml` + `skills/`。两种装法：

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

只有基础引擎 `dsh-compaction-basic` 的键，含义与默认值都继承官方：

| 配置 | 含义 |
|---|---|
| `thresholdRatio` | 触发压缩的上下文窗口比例 |
| `headroomTokens` | 输出预留之外的额外压力余量（默认 65536） |
| `retainRatio` / `retainTokens` | 保留窗口（二者互斥） |
| `maxTokens` | 基础引擎按它预留输出预算并计入压力；本后端不调用模型，不另设下限 |
| `summarizationProvider` / `summarizationModel` / `compactionRetries` / `maxOverflowRetries` / `modelPolicies` | 基础引擎的键，本后端不调用模型，它们不影响检查点 |
| `auto` | 自动压缩 |

压力阈值必须落在真实输入上限内：`thresholdRatio × contextWindow < provider 上限 − maxTokens − headroomTokens`。

---

## 已知边界

- **检查点线性增长，不设上限。** 原话逐字保留、前次检查点整段携带。按一个真实会话复算：区段 1.72M 字符
  （约 41 万 token）→ 检查点 87k 字符；再叠一轮后 147k 字符。携带部分最终逼近压缩阈值时，基础引擎的
  「摘要必须小于被压区段」检查会报错，不会静默截断。
- **助手文字逐字保留，也就逐字保留了它的错误。** 检查点声明助手文字未核实；它是「说过什么」的记录，不是事实。
- **工具输出不在窗口里。** 需要时按 `seq` 读回或重新读文件；接手的 agent 是否真的去读回，程序管不了。
- **读回依赖 `dsh-tool-session-query`。** 自带预设已挂载；别的预设要自己挂，否则 `seq` 只能靠人去会话日志里找。
- **报错而不是猜**：区段为空、区段消息对不上会话可见面、前次检查点缺少本格式的分节时，直接报错，不生成检查点。

---

## 开发

编码规则见 [`AGENTS.md`](AGENTS.md)。改动前先读 [`docs/SUMMARY-SCHEMA.md`](docs/SUMMARY-SCHEMA.md)：
§1 规定检查点保留什么，§2 规定研究状态怎么记；**压缩引擎只负责压缩**。

```bash
npm install          # 含 .npmrc：legacy-peer-deps，跳过重型 peer 解析
npm run typecheck    # tsc -p tsconfig.test.json（含 src 与 test）
npm test             # vitest run
npm run build        # 产出 lib/
```

类型检查需要 dsh 运行时的 `@deepseek-ai` 作用域。它们装在 dsh 自己的
`node_modules` 里，把该作用域复制进本包的 `node_modules/@deepseek-ai` 即可解析：

```bash
cp -R "$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/." node_modules/@deepseek-ai/
```

> ⚠️ **拷完之后不要再跑 `npm install`。** 这个作用域不在 `package.json` 里，`npm install`
> 会把它当多余包**清掉**，typecheck 随即全红。要装依赖就先装、再拷。

源码用 `.ts` 相对导入，靠 TS 5.7+ 的 `rewriteRelativeImportExtensions` 在构建时重写成 `.js`。

> 若 `npm install` 报 `EPERM ... ~/.npm/_cacache`（全局 npm 缓存里有 root 所有的文件），
> 换一个工作区内的缓存目录即可：`npm install --cache ./.npm-cache --logs-dir ./.npm-logs`。

---

## 兼容性

- 运行环境：Node >= 24.9（DSH 0.2.2 的要求）。
- 针对 `dsh` 的 `@deepseek-ai/dsh-compaction-basic@0.2.2-rc.1`
  （`SummarizationInput` = `{ tools?, messages }`，`publish/` 无 `src/`）开发与类型检查。
- 前次检查点按 `@deepseek-ai/dsh-compaction/checkpoint` 的 `isCompactCheckpointSource` 识别；区段消息按会话可见面
  （`session.surface.nodes` + `deriveEventMessage`）映射回 `seq`。宿主升级后复核这两处。
- 继承官方全部压力 / 保留 / token 计量 / 事务逻辑，只重写 `summarize()` 钩子。
- License: MIT
