# Context Anchor

`context-anchor` 是一个给 OpenClaw 使用的记忆持久化 skill。它把 skill、本地运行时、hook 和宿主侧辅助配置组合起来，让 OpenClaw 具备：

- 用户级 / 项目级 / Session级 三层记忆加载
- Session 状态持久化
- 项目级经验沉淀
- 上下文压力下的 checkpoint、`compact-packet` 和记忆同步
- bootstrap 注入硬限制在 10K UTF-8 bytes 内，优先加载短期热记忆
- 长期记忆默认持久化保存，通过按需检索而不是预加载进入上下文
- 在不改变 JSON 兼容格式的前提下，用内嵌 SQLite 镜像加速热读和长期记忆检索
- Session 结束前的自动总结、经验提炼和技能草稿沉淀
- 满足条件的项目级 / 用户级经验自动晋升为 active skill
- 经验校验与技能化候选
- gateway 重启后的恢复提示
- 同名技能的作用域优先级和停用治理

如果你是第一次接入，先看这份 `README`。  
`SKILL.md` 更偏运行规范和行为定义。

## 文档导航

这份文档按两类角色组织：

- 使用者：只关心安装、配置、检查、诊断和更新，希望尽量少打断地把 `context-anchor` 用起来
- 贡献者：要做高级配置、手工接入、机制理解或代码贡献

建议按入口阅读：

- 使用者：从「使用者」开始，先看 5 分钟上手和易用性命令
- 贡献者：从「贡献者」开始，重点看高级配置、运行时结构和开发者指南
- 想查运行规范：继续看 `SKILL.md`
- 想查长期记忆治理与 SQLite 演进：看 `references/storage-governance-evolution-plan.md`
- 想查下一阶段的接管能力、收益显性化与任务连续性路线：看 `references/takeover-continuity-evolution-plan.md`

## 使用者

### 适用场景

- 你希望 OpenClaw 在长任务中跨压缩、跨重启保留上下文连续性
- 你希望把会话中的经验沉淀到项目级记忆，而不是只留在当前窗口
- 你希望宿主通过 hook 或定时调用，把 checkpoint、heartbeat、恢复提示接起来

### 你会得到什么

装好以后，`context-anchor` 会尽量自动完成这些事：

- 记住当前 session 的上下文，不容易因为压缩或重启丢状态
- 把有价值的经验沉淀到项目级和用户级
- 在后续 session 里自动复用之前的经验和技能
- 只把短期热记忆直接注入 bootstrap，长期记忆继续留在持久化存储里按需查找
- bootstrap 现在会更明确地显示恢复来源、restored goal、latest result 和 next step
- runtime state 现在会持续跟踪 current goal、latest result、next step、blocked by 和 last visible progress
- 关键集合会同步到内嵌 SQLite 镜像，减少热读和检索时反复扫描大 JSON 的成本
- 如果 workspace 里还有外部 `MEMORY.md` / `memory/*.md`，会自动归并进 `context-anchor`，减少多套记忆源分裂
- 第一次见到新 workspace 时，默认自动登记归属，尽量不打断你
- 在合适的时候自动做 checkpoint、总结、经验提炼和技能治理
- 运行中的 heartbeat / workspace monitor 也会持续把 session memory 增量提炼成 session experiences
- 即使当前没有 recent session，workspace monitor 也会在发现外部 `MEMORY.md` / `memory/*.md` 漂移时自动做一次低噪声归并
- 同一用户在多个已登记 workspace 里重复验证过的项目经验，会自动汇总成 user experiences 并驱动 user skill 晋升

### 哪些场景会自动接上

- `/compact` 前会先落 checkpoint 和记忆同步，完成后刷新 `compact-packet`、session experiences 和 session draft
- `/stop`、`/new`、`/reset` 会自动收口当前 session，避免旧 session 悬空
- OpenClaw 或 gateway 重启后，`gateway:startup` 先给恢复提示，进入对话时再由 `agent:bootstrap` 注入记忆
- `agent:bootstrap` 注入的文件名现在是 `CONTEXT-ANCHOR.md`，不再和宿主或模型自己的 `MEMORY.md` 约定撞名
- bootstrap 注入内容现在会单独给出 `Recovered Continuity`，减少“到底恢复了什么”的猜测成本
- `Recovered Continuity` 现在也会优先带出 blocked by 和最近一次用户可见进展
- heartbeat 和后台 workspace monitor 会持续做增量经验提炼，不必等到 session close 才开始沉淀
- heartbeat / workspace monitor 也会跨同一用户的已登记 workspace 汇总 project experiences，自动累积 user 级 cross-project evidence
- 如果宿主的压力 snapshot 里带有结构化失败信息，context-pressure monitor 会自动把这些失败沉淀成 project lessons
- 对已经存在的存量 session，执行一次 `upgrade-sessions.js` 后，后续 `/compact`、重启恢复和 bootstrap 都会直接走最新生命周期

### 前置条件

- 已安装 Node.js
- 已有 OpenClaw 运行环境
- 允许在本地 OpenClaw 目录写入配置、hook 和 automation 文件

### 路径说明

本文后面会反复使用几个占位符：

- `<openclaw-home>`：OpenClaw 数据目录
- `<skills-root>`：OpenClaw 扫描 skill 的目录
- `<installed-skill-dir>`：安装后的 `context-anchor` 快照目录，也就是 `<skills-root>/context-anchor`

默认情况下：

- Windows：`C:/Users/<你自己的用户名>/.openclaw`
- macOS：`/Users/<你自己的用户名>/.openclaw`
- Linux：`/home/<你自己的用户名>/.openclaw`

建议：

- 手工执行命令时总是给路径加双引号
- 配置文件里不要写 `~/.openclaw`，要写真实绝对路径
- 安装后先运行一次 `doctor`，直接复制它输出的真实路径

### 5 分钟上手

如果你完全不懂 OpenClaw 的 hook、skills、调度器和配置文件，按下面做就够了。

1. 在项目根目录运行：

```bash
node scripts/install-one-click.js
```

或：

```bash
npm run install:host
```

2. 跟着提示回答问题。

推荐你直接接受默认建议，尤其是：

- 允许写入推荐的 OpenClaw 配置
- 设置一个默认用户名
- 如果你有常用工作目录，填一个默认 workspace

3. 安装完成后执行一次：

```bash
node scripts/doctor.js
```

只要这两个字段是 `true`，就说明基本可用了：

- `installation.ready`
- `configuration.ready`

默认情况下：

- 安装器会把需要的 skill、hook 和 automation 文件放到 OpenClaw 目录
- 新 workspace 第一次进入时会自动登记，不需要你先手工配置
- 后续 heartbeat / workspace monitor / stop / bootstrap 会自动接上记忆、恢复和沉淀链路
- 如果你没有关闭自动登记，绝大多数情况下不会先看到 `needs_configuration`

只有下面几类情况，才建议继续往下读更详细的内容：

- `doctor` 显示 `installation.ready` 或 `configuration.ready` 不是 `true`
- 你想把 skill 安装到自定义目录
- 你明确不想要自动登记 workspace
- 你想手工调试 hook、heartbeat、checkpoint 或技能治理

### 安装与重装

推荐入口：

```bash
node scripts/install-one-click.js
```

```bash
npm run install:host
```

安装器会按顺序询问：

- 是否保留旧记忆并重装
- 是否强制启用 `context-anchor` 接管当前 OpenClaw profile 的记忆管理
- 是否把推荐的 OpenClaw 配置写入当前 `<openclaw-home>/openclaw.json`
- 默认用户名是什么
- 默认 workspace 是什么
- 是否继续添加新的用户或 workspace
- 是否为某个 workspace 启用后台巡检任务
- 如果启用巡检，选择 `Windows` / `macOS` / `Linux`

常用重装方式：

```bash
node scripts/install-one-click.js --yes --keep-memory --apply-config
```

```bash
node scripts/install-one-click.js --yes --drop-memory --apply-config
```

```bash
node scripts/install-one-click.js --yes --keep-memory --apply-config --upgrade-sessions
```

这里的安装目录名始终是 `context-anchor`，不受你本地源码目录名影响。

如果你本机上已经有正在使用的 OpenClaw session，推荐直接使用带 `--upgrade-sessions` 的方式重装。现在这个命令除了会刷新存量 session 到最新 runtime 行为，也会顺手执行 SQLite mirror 回填，并默认跑一轮 storage governance，让升级后的 active/archive 状态尽量马上与新版本一致。

安装/配置时会重点提示你是否要“强制启用 `context-anchor` 接管记忆”。  
如果你接受，安装器会尽量确保：

- OpenClaw internal hooks 持续启用
- `context-anchor` 始终处于可加载状态
- 后续记忆、恢复和治理尽量进入统一的 `context-anchor` 平面

如果你拒绝强制接管，限制是：

- 某些模型或 profile 仍可能继续维护自己的 `MEMORY.md` 或私有记忆文件
- 记忆可能继续分散在多套来源里
- 连续性恢复、经验沉淀和后续检索复用可能不完整

相关显式参数：

- `--enforce-memory-takeover`
- `--no-enforce-memory-takeover`

升级链路执行时会把阶段性进度输出到 `stderr`，例如：

- 已选中多少个 session
- 当前升级到第几个 session
- mirror rebuild 是否开始/完成
- governance 是否开始/完成

最终结果仍然保持 `stdout` 输出 JSON，不影响脚本调用方继续解析结果。

如果你只想升级但暂时不跑治理，可以显式关闭：

```bash
node scripts/install-one-click.js --yes --keep-memory --apply-config --upgrade-sessions --skip-governance
```

### 重新配置与 session 接管

如果你已经安装过，只想重新跑配置，不想重装：

```bash
npm run configure:host
```

```bash
node scripts/configure-host.js
```

如果你只想单独调整是否强制接管记忆：

```bash
node scripts/configure-host.js --enforce-memory-takeover
```

```bash
node scripts/configure-host.js --no-enforce-memory-takeover
```

如果你要批量接管 OpenClaw 已存在的 session：

```bash
node scripts/configure-sessions.js
```

`configure-sessions.js` 会扫描 `~/.openclaw/agents/*/sessions/sessions.json`，按 session 逐个询问是否跳过、配置或重新配置；`--yes` 可自动批量接管全部可解析的 session。默认自动接管模式下，它会优先做轻量级 workspace 自动登记，只在你明确要求重新配置时才重跑整套 host 配置。

### 检查、诊断与更新

检查安装和配置状态：

```bash
node scripts/doctor.js
```

```bash
node scripts/doctor.js --openclaw-home "D:/openclaw-home" --skills-root "D:/openclaw-home/skills"
```

`doctor.js` 现在除了安装和 host 配置状态，还会显示：

- `memory_sources.external_source_count`
- `memory_sources.last_legacy_sync_at`
- `memory_sources.health.status`
- `host_takeover_audit`
- `paths.external_memory_watch_script`
- `commands.external_memory_watch`

如果你想明确检查某个 workspace 是否存在外部 `MEMORY.md` / `memory/*.md` 漂移，建议显式带上：

```bash
node scripts/doctor.js --workspace "<workspace>"
```

查看 session 状态：

```bash
node scripts/sessions-status.js
```

诊断 session 问题：

```bash
node scripts/sessions-diagnose.js
```

`sessions-status.js` 和 `sessions-diagnose.js` 现在会按 workspace 显示：

- `SINGLE_SOURCE`
- `BEST_EFFORT`
- `DRIFT`
- 最新可恢复的 `task continuity`，直接告诉你当前 goal / result / next step / blocked by
- 最近一次 `last benefit`，直接告诉你这轮 session 最近沉淀了什么可见收益

默认会尽量只显示用户真正可感知的 session。  
像没有 transcript、没有 workspace、系统残留但用户无感知的 hidden session，会默认从状态和升级口径里排除，避免 session 数量明显失真。  
如果你确实要排查这类隐藏候选，可以显式加：

```bash
node scripts/sessions-status.js --include-hidden-sessions
```

```bash
node scripts/sessions-diagnose.js --include-hidden-sessions
```

如果检测到外部记忆源已经变化或还没归并，输出里会直接给出对应的 repair 命令。你也可以手工执行：

```bash
npm run migrate:memory -- --workspace "<workspace>"
```

升级存量 session：

```bash
node scripts/upgrade-sessions.js
```

```bash
node scripts/upgrade-sessions.js --workspace "<workspace>"
```

```bash
node scripts/upgrade-sessions.js --session-key "<session-key>"
```

```bash
node scripts/upgrade-sessions.js --rebuild-mirror
```

```bash
node scripts/upgrade-sessions.js --rebuild-mirror --run-governance
```

如果状态查询提示异常，先跑 `sessions-diagnose.js`，再按输出里的诊断命令和修复命令处理。`sessions-status.js` 支持 `--json`，`configure-sessions.js` 和 `upgrade-sessions.js` 也支持 `--workspace` / `--session-key` 只处理一个 workspace 或 session。
现在 `sessions-diagnose.js` 还会额外给出 `Recheck` 和 `Repair path`，把 repair -> follow-up -> recheck 明确串起来，减少 strict-mode 下的误操作和漏检查。
本轮还会额外给出 `Strategy`，直接告诉你这是 `migrate -> enforce -> recheck`、`configure host -> recheck` 还是别的闭环路径。

`configure-host.js`、`install-one-click.js` 和 `upgrade-sessions.js` 的 JSON 结果里现在也会带 `takeover_audit` 和 `host_takeover_audit`。  
如果你已经开启强制接管，但外部记忆文件还在最近一次归并后继续变化，audit 会直接返回 warning 和推荐修复命令。  
如果问题不在当前 workspace，而是在另一个已登记 workspace，`host_takeover_audit` 也会把它显示出来。

现在 `doctor.js` 还会输出 `profile_takeover_audit`，用来提示同级 OpenClaw profile 是否仍处于 `best_effort`、未完成配置，或者仍存在外部记忆漂移。
`doctor.js` 的 `recommended_action` 现在也会带 `recheck_command` 和 `repair_sequence`，可以直接把 strict-mode 下的修复步骤串起来执行。
同时 `recommended_action.repair_strategy` 会给出更明确的修复策略标签，减少用户自己判断先后顺序。
现在 `repair_strategy` 还会区分 `execution_mode = automatic|manual`，并标记 `requires_manual_confirmation`，帮助用户快速判断哪些步骤可以直接执行，哪些需要先人工确认。
`manual` 现在还会继续细分：
- `manual/confirm`：主要是需要用户确认或补一个明确输入
- `manual/external-env`：主要是需要先修 workspace 路径、外部环境或宿主侧问题
其中 `manual/external-env` 现在又会继续细分成更具体的类型，例如：
- `workspace-registration-missing`
- `workspace-path-unresolved`

`configure-host.js` 和 `configure-sessions.js` 现在还会返回 `verification`。  
如果这次 repair 没有真正把目标状态修到位，结果里会直接显示 `verification.status = needs_attention`，并附带 `recheck_command`，避免用户执行完修复后还要自己猜有没有生效。
现在 `verification` 里还会带 `readiness_transition.before / after`，直接告诉你这次 repair 前后到底有没有把 attention session、drift workspace 或 host readiness 改善掉。

`upgrade-sessions.js` 现在也会返回 `verification` 和 `verification_report`，`install-one-click.js` 会在顶层聚合成自己的 `verification`。  
这样升级或一键安装结束后，你可以直接看“这轮是否已经验证通过”，而不是只看到 audit 告警再自己手工补检查。
现在 `upgrade-sessions.js` 的 `verification` 也会带 `repair_strategy`，`install-one-click.js` 会把 config/session 两段的 strategy 聚合到 `verification.repair_strategies`，长流程里也能直接看到下一步应该怎么收口。
`install-one-click.js` 聚合后的 `verification.repair_strategies` 现在也会按 `automatic` / `manual` 分类，方便在长流程结束后直接判断自助修复边界。
同时聚合结果里也会继续拆出 `manual_confirm_only` 和 `manual_external_environment`，便于后续自动化或 UI 侧直接按风险类型分类展示。
本轮开始，`doctor.js`、`sessions-status.js` / `sessions-diagnose.js`、`status-report.js`、`upgrade-sessions.js`、`install-one-click.js` 都会返回统一的 `remediation_summary` 结构，便于用一套逻辑读取 next step、automatic/manual count 和 recheck commands。
现在 `sessions-status.js` / `sessions-diagnose.js` 以及 install/upgrade 的进度输出，也会直接把 `remediation_summary.next_step` 渲染出来，用户不用再自己从多条 strategy 里猜下一步。
对于可自动执行的修复路径，文本输出现在还会直接给出 `Auto fix command`；执行这条命令后，会按 `repair -> follow-up -> recheck` 顺序自动跑完整条闭环。
`auto-fix` 现在还会做风险分级：默认只在高风险步骤（例如 host 配置或 scheduler 变更）前做逐步确认，低风险和中风险步骤尽量减少打断；如果你已经确认环境，也可以显式加 `--yes` 跳过这些确认。
如果你只想执行部分自动修复链路，现在还支持批量策略参数：
- `--until repair|follow_up|recheck`：只执行到指定阶段
- `--skip-recheck`：跳过最后的只读回检
- `--risk-threshold low|medium|high`：只执行不高于该风险级别的步骤
如果你希望这些策略长期生效，`auto-fix` 现在还支持用户级默认策略：
- `--save-defaults`：把当前策略记到当前用户状态里
- `--clear-defaults`：清空已保存的默认策略
- `--workspace` / `--user-id`：显式指定默认策略写入哪个 workspace / user
现在多数 `Auto fix command` 还会自动带上当前问题对应的 `--workspace` / `--user-id` 上下文，尽量减少你手工补参数的成本，并确保默认策略继承落到正确用户。
同时 `Auto fix command` 已开始按问题类型选择更贴合场景的默认策略：例如 drift 归并链路会优先停在 `follow_up` 并默认跳过立即 `recheck`，而 host 配置修复仍会默认保留 `recheck`。
更细一层，workspace 还未配置完成这类问题现在会优先给出“先 repair、不急着立刻 recheck”的默认链路；而“升级后 session 仍未 materialize”这类问题则默认保留完整 `recheck` 闭环。
对于 `workspace_unresolved`、`workspace_registration_missing` 这类 manual / external-environment 问题，现在不会再误给 `Auto fix command`，而会明确显示 `Auto fix unavailable`，提醒用户先修外部环境再继续。
对于 `manual/confirm_only` 这类问题，现在除了 `Auto fix unavailable` 之外，还会额外提示 `Auto fix resume`，说明补齐哪个确认输入后，自动修复才能继续，例如先显式传入 `--workspace`。
这类 `Auto fix resume` 现在也会尽量指向更具体的缺失输入，例如 `--workspace`、`--session-key` 或目标 profile。
同时系统现在还会直接给出 `Resume command` 模板，方便你在原命令基础上把缺失输入补上再继续。
`Resume command` 现在也会尽量优先贴近当前入口语境，例如升级诊断更优先给 `upgrade:sessions` 路径，而 session 诊断更优先给 `status:sessions` / `configure:sessions` 路径。
如果当前上下文里已经知道 `workspace`、`session-key`、`openclaw-home`、`skills-root` 等参数，`Resume command` 现在还会尽量直接预填进去，减少你手工替换占位符的成本。
当同一入口存在多个候选模板时，系统现在还会优先选择“剩余占位符更少、改动更小”的那个命令，进一步降低恢复门槛。
如果 `Resume command` 里仍然保留了必须由用户决定的占位符，系统现在还会额外列出 `Resume inputs`，明确告诉你还差哪些输入。
同时还会补充每个缺失输入的简短说明和示例值，帮助你更快判断应该填什么。
`sessions-diagnose.js` 现在也会把 remediation 的 `Guidance` 和 `Example command` 直接显示出来；`status-report.js` 的 `recommended_action` 也会带这两类字段，方便上层直接展示。
`status-report.js` 现在默认也会输出轻量文本视图；如果你需要完整 JSON 或 snapshot，再显式用 JSON/snapshot 模式。
`doctor.js` 现在默认也会直接输出一份更友好的文本摘要视图；如果你仍然需要完整 JSON，再显式加 `--json`。  
如果当前存在手工外部问题，文本摘要里还会直接显示 `External issues:`，例如 `workspace_registration_missing` 或 `workspace_path_unresolved`，减少用户自己猜是哪类外部问题。
对于这类外部问题，`doctor` 文本摘要现在还会直接给出 `Guidance` 和 `Example command`，方便用户按具体问题类型落地处理。

如果你希望比定时 workspace monitor 更快地收敛外部 `MEMORY.md` / `memory/*.md` 变化，现在还可以直接运行：

```bash
npm run watch:memory -- --workspace "<workspace>" --project-id "<project-id>"
```

安装后的托管路径也会包含：

- `<openclaw-home>/automation/context-anchor/external-memory-watch.js`

这个 watcher 会在文件变化后做 debounce，再触发一次低噪声 legacy memory sync；如果变化已经归并过，不会重复刷同步。

`upgrade-sessions.js` 会一次性刷新已发现或已登记的存量 session，重新生成 bootstrap cache，并让这些 session 在下一次 hook / bootstrap 时直接使用最新 runtime 行为；默认跳过已关闭 session，传 `--include-closed` 才会连已关闭 session 一起刷新。传 `--rebuild-mirror` 时，还会顺手把已有 JSON 资产回填到 SQLite mirror。传 `--run-governance` 时，还会在 mirror 回填之后立刻对升级到的 session 运行一次 storage governance。

现在升级还会默认跳过临时 `subagent` session，避免在短生命周期会话上浪费大量升级时间。  
如果你确实需要把这类 session 也纳入升级，可以显式加：

```bash
node scripts/upgrade-sessions.js --include-subagents
```

同样地，默认升级也会跳过用户无感知的 hidden session，避免把系统残留或无 workspace 的候选算进升级数量。  
如果你确实需要排查这些隐藏候选，可以显式加：

```bash
node scripts/upgrade-sessions.js --include-hidden-sessions
```

执行过程中会持续把简明进度打印到 `stderr`，方便区分“仍在处理”还是“真的卡住了”。

如果你想在升级前顺手把当前 OpenClaw profile 切到 `context-anchor` 强制接管模式，可以加：

```bash
node scripts/upgrade-sessions.js --rebuild-mirror --run-governance --enforce-memory-takeover
```

如果你明确不想强制接管，也可以显式声明：

```bash
node scripts/upgrade-sessions.js --rebuild-mirror --no-enforce-memory-takeover
```

治理相关选项：

- `--run-governance`
- `--governance-mode report|enforce`
- `--governance-prune 0|1`

对存量用户来说，这个升级不需要你手工重建 session。刷新完成后，后续的 `/compact`、`/stop`、`/new`、`/reset` 和重启后的恢复链路都会按最新行为执行。

如果你不是走上面的 `install-one-click.js --upgrade-sessions` 升级链，而是单独执行某个脚本，才需要手工补一次 mirror 回填：

```bash
node scripts/mirror-rebuild.js
```

也可以只回填单个 workspace：

```bash
node scripts/mirror-rebuild.js --workspace "<workspace>"
```

### 安装后你应该看到什么

至少检查这几个路径：

- `<openclaw-home>/openclaw.json`
- `<installed-skill-dir>/README.md`
- `<installed-skill-dir>/SKILL.md`
- `<installed-skill-dir>/scripts/heartbeat.js`
- `<openclaw-home>/hooks/context-anchor-hook/handler.js`
- `<openclaw-home>/automation/context-anchor/context-pressure-monitor.js`
- `<openclaw-home>/automation/context-anchor/workspace-monitor.js`

如果这些文件不存在，说明安装没有完成。

### 安装后先做什么

安装后立刻执行一次自检：

```bash
node scripts/doctor.js
```

如果你使用了自定义目录：

```bash
node scripts/doctor.js --openclaw-home "D:/openclaw-home" --skills-root "D:/openclaw-home/skills"
```

重点看两个字段：

- `installation.ready`：安装文件是否齐全
- `configuration.ready`：推荐配置是否已经写入

`doctor` 还会输出真实路径，以及可直接复制的命令。

另外，`<openclaw-home>/context-anchor-host-config.json` 会保存：

- 默认用户
- 默认 workspace
- 已登记的用户
- 已登记的 workspace 及其默认 owner
- 每个 session 的 workspace / project / user 归属

### 最小验证流程

安装完成后，建议按下面顺序做一次人工验证。

#### 1. 验证 skill / hook 已安装

检查：

- `<installed-skill-dir>/` 是否存在
- `node scripts/doctor.js` 输出中的 `installation.ready` 是否为 `true`
- `openclaw hooks info context-anchor-hook` 是否显示 `Events: agent:bootstrap, command:new, command:reset, command:stop, session:compact:before, session:compact:after`
- `openclaw skills list` 是否能看到 `context-anchor`
- 如果你选择了自动写配置，再确认 `configuration.ready` 是否为 `true`

#### 2. 验证 startup / 恢复预览

先准备一个测试工作区，并写一个最小 payload 文件：

```json
{
  "workspace": "D:/workspace/project"
}
```

然后触发：

```bash
node "<openclaw-home>/hooks/context-anchor-hook/handler.js" gateway:startup "./context-anchor-payload.json"
```

预期：

- 如果 workspace 已登记但没有最近 session，返回 `idle`
- 如果有最近活跃 session，返回 `resume_available` 和 `resume_message`
- 真正注入到 OpenClaw 的 bootstrap 文件名会是 `CONTEXT-ANCHOR.md`，避免和外部 `MEMORY.md` 冲突
- 默认自动登记开启时，未登记 workspace 会先被自动登记，然后继续返回 `idle` 或 `resume_available`
- 如果你关闭了自动登记，workspace 未登记时才会返回 `needs_configuration`

#### 3. 验证 heartbeat

```json
{
  "workspace": "D:/workspace/project",
  "session_key": "chat-session-001",
  "project_id": "default",
  "usage_percent": 82
}
```

然后执行：

```bash
node "<openclaw-home>/hooks/context-anchor-hook/handler.js" heartbeat "./context-anchor-payload.json"
```

预期：

- 返回 `handled`
- 内部结果为 `heartbeat_ok`
- 工作区下出现 `.context-anchor/`

#### 4. 验证 compact 生命周期

```json
{
  "workspace": "D:/workspace/project",
  "session_key": "chat-session-001",
  "project_id": "default"
}
```

先执行 compact 前置处理：

```bash
node "<openclaw-home>/hooks/context-anchor-hook/handler.js" session:compact:before "./context-anchor-payload.json"
```

再执行 compact 后置处理：

```bash
node "<openclaw-home>/hooks/context-anchor-hook/handler.js" session:compact:after "./context-anchor-payload.json"
```

预期：

- 两次调用都返回 `handled`
- `sessions/<session-key>/checkpoint.md` 被创建或更新
- `sessions/<session-key>/experiences.json` 被创建或更新
- `sessions/<session-key>/compact-packet.json` 被创建或更新
- `sessions/<session-key>/skills/index.json` 里会创建或刷新当前 session draft
- 下一次 `agent:bootstrap` 会直接使用新的压缩恢复资产

#### 5. 验证 stop / session end

```json
{
  "workspace": "D:/workspace/project",
  "session_key": "chat-session-001",
  "project_id": "default"
}
```

然后执行：

```bash
node "<openclaw-home>/hooks/context-anchor-hook/handler.js" command:stop "./context-anchor-payload.json"
```

预期：

- `sessions/<session-key>/checkpoint.md` 被创建
- 热记忆会尝试同步到项目级
- 如果 payload 缺失 `workspace` 或 `session_key`，CLI 会直接返回明确错误，而不是写到默认目录

### 故障排查

#### OpenClaw 没有发现 skill

检查：

- 默认托管目录安装时，不需要额外检查 `extraDirs`
- 如果你使用了自定义 `skills-root`，再检查 `<openclaw-home>/openclaw.json.skills.load.extraDirs`
- `<installed-skill-dir>/SKILL.md`
- `node scripts/doctor.js` 的 `installation` 字段

#### hook 调用失败

检查：

- `<openclaw-home>/hooks/context-anchor-hook/handler.js` 是否存在
- payload 是否包含 `workspace`
- 如果手工传 JSON 字符串失败，先改成 payload 文件方式

#### heartbeat 没有触发 checkpoint

检查：

- `usage_percent` 是否达到阈值
- 传入的 `session_key` 是否和当前 session 一致
- 工作区下是否有 `.context-anchor/sessions/<session-key>/`

#### `/compact` 后没有拿到最新恢复状态

检查：

- `openclaw hooks info context-anchor-hook` 是否已经包含 `session:compact:before` 和 `session:compact:after`
- `sessions/<session-key>/compact-packet.json` 是否存在且时间戳有更新
- 如果这个 session 是历史存量 session，是否已经执行过 `node scripts/upgrade-sessions.js`
- 如果 payload 没带 `workspace`，至少要保证 `session_key` 能在宿主登记里被解析回 workspace

#### 经验没有进入技能化候选

检查：

- `validation.status` 是否为 `validated`
- 是否满足最少 7 天
- `access_count` 是否足够
- `access_sessions.length` 是否足够

## 贡献者

### 贡献者入口

如果你想参与这个项目，先建立一个正确心智模型：

- 这不是单纯一份 `SKILL.md`
- 这是一个“skill + runtime scripts + hook wrapper + host config + tests”的组合项目
- README 面向使用者，`SKILL.md` 面向运行规范，`tests/` 用来锁定行为

建议开发顺序：

1. 先看这份 `README`，理解对使用者承诺了什么
2. 再看 `SKILL.md`，理解运行时行为边界
3. 看 `scripts/lib/context-anchor.js` 和 `scripts/lib/host-config.js`，建立数据模型理解
4. 看 `hooks/context-anchor-hook/handler.js`、`scripts/session-start.js`、`scripts/session-close.js`、`scripts/heartbeat.js`
5. 跑 `npm test`，确认本地环境稳定

如果你准备直接贡献代码，后面重点看：

- 「高级配置命令」
- 「工作区中的运行时数据」
- 「自动生命周期」
- 「高级观测与诊断」
- 「开发者指南」

### 交付形态

这个项目不是只有一个 `SKILL.md`。

实际交付是：

- skill：`SKILL.md`
- 运行时脚本：`scripts/`
- hook 处理器：`hooks/context-anchor-hook/`
- 宿主安装脚本：`scripts/install-host-assets.js`

安装后会在 `<openclaw-home>` 下落一份自包含快照，供 OpenClaw 加载和调用。

### 分层模型

第一阶段已经落地的作用域：

- `session`：当前会话的工作记忆、会话经验、技能草稿
- `project`：当前 workspace 的长期决策、项目经验、项目技能索引
- `user`：跨项目偏好、用户级记忆、用户级经验、用户级技能索引

默认：

- `user_id` 默认值是 `default-user`
- `project_id = workspace basename`，如果显式传入则优先显式值

### 高级配置命令

如果你要覆盖默认安装位置：

```bash
node scripts/install-one-click.js --openclaw-home "<openclaw-home>" --skills-root "<skills-root>"
```

如果你要一次性写入默认用户、默认 workspace 和推荐配置：

```bash
node scripts/install-one-click.js --yes --apply-config --default-user "alice" --default-workspace "D:/workspace/main"
```

如果你要在安装时顺手启用后台巡检：

```bash
node scripts/install-one-click.js --yes --apply-config --enable-scheduler --target-platform windows --workspace "D:/workspace/project" --interval-minutes 5
```

如果你已经安装完成，只想精细化调整配置：

```bash
node scripts/configure-host.js --apply-config --default-user "alice" --default-workspace "D:/workspace/main"
```

```bash
node scripts/configure-host.js --enable-scheduler --target-platform macos --workspace "/Users/me/workspace/project"
```

```bash
node scripts/configure-host.js --enable-scheduler --target-platform linux --workspace "/home/me/workspace/project"
```

```bash
node scripts/configure-host.js --yes --default-user "alice" --add-user "bob" --add-workspace "D:/workspace/client-b|bob|client-b"
```

```bash
node scripts/configure-host.js --default-user "alice" --no-auto-register-workspaces
```

### 高级手动接入

如果你明确不想让安装器改配置，仍然可以手工接入。最小原则是：

- skill 安装到默认托管目录 `<openclaw-home>/skills/context-anchor/` 时，不需要额外配置 `skills.load.extraDirs`
- 只有你把 skill 安装到自定义目录时，才需要在 `<openclaw-home>/openclaw.json.skills.load.extraDirs` 追加该目录
- managed hook 文件放在 `<openclaw-home>/hooks/context-anchor-hook/` 后，OpenClaw 会自动发现；真正需要保证的是 `openclaw.json.hooks.internal.enabled = true`

推荐最小配置如下：

```json
{
  "hooks": {
    "internal": {
      "enabled": true
    }
  }
}
```

如果使用自定义 `skills-root`，再额外补：

```json
{
  "skills": {
    "load": {
      "extraDirs": ["<skills-root>"]
    }
  }
}
```

手动调试入口保留如下：

- hook wrapper：`node "<openclaw-home>/hooks/context-anchor-hook/handler.js" <event-name> <payload-file-or-json>`
- workspace 巡检：`node "<openclaw-home>/automation/context-anchor/workspace-monitor.js" "<workspace>"`
- 压力快照 monitor：`node "<openclaw-home>/automation/context-anchor/context-pressure-monitor.js" "<workspace>" "<snapshot-file>"`

如果你是第一次接这类 OpenClaw managed hook，推荐继续使用安装器自动写配置，不要手抄这些命令。

### 工作区中的运行时数据

`context-anchor` 把状态保存在当前任务工作区下：

```text
.context-anchor/
├── catalog.sqlite
├── projects/{project-id}/
│   ├── state.json
│   ├── decisions.json
│   ├── experiences.json
│   ├── facts.json
│   ├── heat-index.json
│   └── skills/index.json
├── sessions/{session-key}/
│   ├── state.json
│   ├── memory-hot.json
│   ├── experiences.json
│   ├── skills/index.json
│   ├── checkpoint.md
│   ├── compact-packet.json
│   └── session-summary.json
└── index.json
```

这意味着：

- 记忆数据按 workspace 隔离
- 同一个 workspace 里的不同 session 会共享项目级记忆
- 换 workspace 不会自动继承旧项目记忆

用户级数据保存在：

```text
<openclaw-home>/context-anchor/users/default-user/
├── state.json
├── memories.json
├── experiences.json
├── skills/index.json
└── heat-index.json

<openclaw-home>/context-anchor/users/catalog.sqlite
```

### 自动生命周期

#### Session Start

`session-start` 现在会自动加载三层资产：

- `session`
- `project`
- `user`

并返回：

- 记忆注入摘要
- 激活技能列表
- 冲突处理后的 `effective_skills`
- 被高优先级同名技能遮蔽的 `shadowed_skills`
- `boot_packet`

技能优先级固定为：

- `session`
- `project`
- `user`

也就是同名技能冲突时，`session > project > user`。

#### 上下文压力

达到压力阈值时，会自动：

- 创建 checkpoint
- 生成 `compact-packet.json`
- 同步高热记忆到项目级
- 如果 snapshot 里带了 `errors` 数组，还会把失败同步成 project lessons

#### Session End / Command Stop

退出前会统一执行：

- checkpoint
- `compact-packet.json`
- session memory 保存
- `session-summary.json`
- session experience 提炼
- `session skill draft` 生成
- project heat / skillification 刷新
- 满足条件的 `project/user active skill` 晋升

#### 技能治理

当前已经落地的治理规则：

- 同名 skill 使用 `conflict_key` 去重
- `scope-promote` 遇到同名 active skill 时会复用现有 skill，而不是重复创建
- `session-start` 只激活冲突处理后的有效技能集合
- `inactive` / `archived` skill 不会进入自动激活集合
- `skill-reconcile` 会在 source experience 失效时自动把相关 skill 降级为 `inactive`
- skill 会保留 `promotion_history` 和 `status_history`
- `skill-supersede` 可以显式声明 winner/loser 关系
- 激活集合受预算约束，超出预算的 skill 会进入 `budgeted_out`
- 长期低价值且 inactive 的 skill 会被自动归档

可以手动更新 skill 状态：

```bash
node "<installed-skill-dir>/scripts/skill-status-update.js" "<workspace>" <scope> <skill-id> <status> [session-key|project-id|user-id] [note]
```

也可以手动执行 reconcile：

```bash
node "<installed-skill-dir>/scripts/skill-reconcile.js" "<workspace>" [project-id] [user-id]
```

也可以手动声明 supersede：

```bash
node "<installed-skill-dir>/scripts/skill-supersede.js" "<workspace>" <scope> <winner-skill-id> <loser-skill-id> [project-id|user-id]
```

### 高级观测与诊断

#### 统一状态报告

可以直接查看当前 workspace 下 user/project/session 三层的统计和治理状态：

```bash
node "<installed-skill-dir>/scripts/status-report.js" "<workspace>" [session-key] [project-id] [user-id]
```

默认只读，不会创建或触碰 runtime 状态文件；只有 `snapshot` 模式会额外写出报告快照。

如果你要把当前状态直接落盘成快照：

```bash
node "<installed-skill-dir>/scripts/status-report.js" "<workspace>" [session-key] [project-id] [user-id] snapshot
```

报告会输出：

- user/project/session 的 memory/experience/skill 计数
- session 的 `task_state_summary`，直接显示 current goal / latest result / next step / blocked by
- governance 统计：`active / shadowed / superseded / budgeted_out`
- `storage_governance` 摘要：
  - active item count
  - archive item count
  - last governance run
  - bytes before / after
  - prune count
- session 最近一次 summary 摘要
- health warnings
- 当前激活预算影响下的治理结果
- 可选的 `snapshot_file`

#### 单条 skill 诊断

可以解释某条 skill 为什么生效、被遮蔽、被 supersede 或被预算裁掉：

```bash
node "<installed-skill-dir>/scripts/skill-diagnose.js" "<workspace>" <skill-id|name|conflict-key> [session-key] [project-id] [user-id]
```

诊断输出会说明：

- 当前匹配到哪些 skill
- 哪一个是 `effective_match`
- 每条 skill 的 `diagnosis`
- 是否被 `shadowed`、`superseded` 或 `budgeted_out`
- 可据此判断是否需要：
  - 提高优先级
  - 调整 budget
  - 声明 supersede
  - 手动 inactive / archive
- `recommendations` 字段会直接给出下一步建议

### 常见高级操作

#### 手动创建 checkpoint

```bash
node "<installed-skill-dir>/scripts/checkpoint-create.js" "<workspace>" "<session-key>" manual
```

#### 手动跑一次 heartbeat

```bash
node "<installed-skill-dir>/scripts/heartbeat.js" "<workspace>" "<session-key>" "<project-id>" 80
```

这条命令除了会推进热度、技能化和压力处理，也会顺手把当前 session memory 增量提炼到 `sessions/<session-key>/experiences.json`。

#### 手动增量提炼 session experiences

```bash
node "<installed-skill-dir>/scripts/session-experience-sync.js" "<workspace>" "<session-key>" "<project-id>"
```

#### 手动捕获一条失败/错误 lesson

```bash
node "<installed-skill-dir>/scripts/error-capture.js" "<workspace>" "<session-key>" command_failed "npm test failed" "exit code 1" "rerun in band"
```

#### 手动汇总 user experiences

```bash
node "<installed-skill-dir>/scripts/user-experience-sync.js" "<workspace>" [user-id]
```

#### 手动生成 compact packet

```bash
node "<installed-skill-dir>/scripts/compact-packet-create.js" "<workspace>" "<session-key>" manual 80
```

#### 按需检索长期记忆

```bash
node "<installed-skill-dir>/scripts/memory-search.js" "<workspace>" "<session-key>" "checkout retry budget"
```

默认会优先走 SQLite 镜像检索；原始 JSON 仍然保留为兼容格式。

当前检索行为是两层的：

- 先查 active
- active 命中不足时再补 archive
- 返回结果会显式带：
  - `tier`
  - `from_archive`
  - `retrieval_cost`
  - `why_matched`
  - `why_from_archive`

现在返回结果会更明确解释：

- 为什么这条被命中，比如命中了 `summary/details/tags` 哪些字段
- 为什么这条来自 archive，比如是因为 active 没有足够结果，还是 active 候选不够强

如果你需要临时关闭数据库镜像，可以设置 `CONTEXT_ANCHOR_DISABLE_DB=1`。

#### 运行存储性能基准

```bash
npm run benchmark:storage -- --workspace-count 1 --active-items 5000 --archive-items 5000
```

这个 benchmark 会生成临时数据集，并输出：

- active 检索耗时
- archive fallback 检索耗时
- governance 单次执行耗时
- mirror rebuild 耗时

默认会在结束后清理临时数据。需要保留数据集排查时，追加 `--keep-data`。

#### 手动执行 session close

```bash
node "<installed-skill-dir>/scripts/session-close.js" "<workspace>" "<session-key>" session-end 80 "<project-id>"
```

#### 手动记录一条项目经验

```bash
node "<installed-skill-dir>/scripts/memory-save.js" "<workspace>" "<session-key>" project best_practice "use smaller diffs"
```

#### 手动记录一条用户级记忆/经验

```bash
node "<installed-skill-dir>/scripts/memory-save.js" "<workspace>" "<session-key>" user best_practice "keep responses concise"
```

#### 从旧 `_global` 迁移到 user

```bash
node "<installed-skill-dir>/scripts/migrate-global-to-user.js" "<workspace>" default-user
```

#### 手动校验经验

```bash
node "<installed-skill-dir>/scripts/experience-validate.js" "<workspace>" <experience-id> validated "<project-id>" "reviewed manually"
```

#### 从经验生成 skill

```bash
node "<installed-skill-dir>/scripts/skill-create.js" "<workspace>" <experience-id> <skill-name> "<project-id>"
```

`skill-name` 会直接作为目录名使用。

- 必须是单个目录名
- 不能包含 `/`、`\` 或 `..`
- 建议只使用便于跨平台落盘的名称

### 重要边界

- Windows / macOS / Linux 都可以通过配置向导生成对应调度配置；如果自动注册失败，脚本会保留生成好的文件供你手工接管
- `usage_percent` 需要宿主提供，`context-anchor` 不负责计算
- 未配置时默认用户仍是 `default-user`；现在可以通过一键配置额外登记多个用户和 workspace 归属
- 旧 `projects/_global` 仍兼容读取，但新的长期用户数据应写入 `user` 层
- `session skill draft` 已实现
- `project/user active skill` 已支持自动晋升、自动回收/回流、归档与 evidence 追踪
- user 级技能晋升现在会自动复用同一用户跨 workspace 的 project evidence，不再要求你先手工写 user experiences

### 开发者指南

这一节给准备参与项目维护或提交 PR 的贡献者。

#### 本地开发环境

最低要求：

- Node.js
- 一个可写的本地工作目录
- 理解这个项目会在测试期间创建临时 workspace 和临时 `openclaw-home`

安装依赖：

```bash
npm install
```

运行自动化验证：

```bash
npm test
```

#### 建议先理解的代码入口

如果你要改行为，建议先按这个顺序读代码：

- `scripts/lib/context-anchor.js`：核心数据结构、路径、读写和技能治理基础能力
- `scripts/lib/host-config.js`：宿主配置、workspace 归属、session 归属和自动接管策略
- `scripts/session-start.js`：进入 session 时如何恢复记忆和激活技能
- `scripts/heartbeat.js`：运行中如何推进记忆同步、热度、技能化与压力处理
- `scripts/session-experience-sync.js`：运行中如何把 session memory 增量提炼为 session experiences
- `scripts/user-experience-sync.js`：如何把同一用户跨 workspace 的 project experiences 汇总为 user experiences
- `scripts/runtime-error-sync.js` / `scripts/error-capture.js`：如何把宿主结构化失败和手工错误记录沉淀成 project lessons
- `scripts/session-compact.js`：`/compact` 前后如何刷新 checkpoint、压缩恢复资产和 bootstrap cache
- `scripts/session-close.js`：退出时如何做总结、经验沉淀和技能草稿生成
- `hooks/context-anchor-hook/handler.js`：OpenClaw managed hook 接入点
- `scripts/install-one-click.js` / `scripts/configure-host.js`：使用者第一次接入会经过的入口

#### 改动时要守住的产品目标

从使用者视角，这个项目最重要的不是“功能更多”，而是“越少打断越好”。提交改动时建议自查：

- 会不会让首次接入更复杂
- 会不会让同一个 session 更容易断裂
- 会不会让已经沉淀的经验更难复用
- 会不会把本来自动完成的事情重新变成手工操作
- 会不会让诊断结果更难理解

#### 当前测试覆盖

现有测试重点覆盖这些承诺：

- user/project/session 三层加载
- session 恢复
- checkpoint 与压力处理
- heartbeat / workspace monitor 驱动的 session experience 增量提炼
- 同一用户跨 workspace 的 user evidence 自动汇总与 user skill 自动晋升/降级
- pressure snapshot 中结构化失败自动沉淀为 project lessons
- compact packet 与 compact 前后 lifecycle hook
- session close
- session skill draft
- `_global -> user` 迁移
- validated experience -> `project/user active skill`
- same-name skill dedupe and precedence governance
- unified status report
- single skill diagnosis
- session 记忆二次同步的 upsert
- 自动校验与技能化候选
- skill 创建
- startup hook 恢复消息
- host 自包含安装
- workspace 自动接管与手动关闭回退

#### 提交贡献前的建议检查

在提交前，至少确认：

- `README.md` 中对使用者的描述仍然成立
- `SKILL.md` 中的行为规范没有被悄悄破坏
- `npm test` 全通过
- 如果改了安装、hook、session 生命周期或技能治理，测试里有新增或更新覆盖

#### 适合继续扩展的方向

如果你想继续演进项目，优先考虑这些方向：

- 更稳定的 session 连续性
- 更少打断的自动接管和恢复
- 更可靠的经验提炼质量
- 更可解释的技能晋升、降级和复用策略
- 更容易让使用者看懂的诊断输出

### 文档分工

- `README.md`：给使用者和贡献者的项目入口说明
- `SKILL.md`：skill 的运行行为规范
- `hooks/context-anchor-hook/HOOK.md`：hook 协议说明
- `references/`：状态模型和机制参考
