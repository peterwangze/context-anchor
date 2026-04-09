# 记忆接管、收益显性化与任务连续性演进实施方案

## 背景

`context-anchor` 的存储架构主链路已经完成：

- `runtime_state`
- active / archive 双层治理
- archive-aware retrieval
- governance runs 与 status-report 观测
- SQLite `content_blobs`

这些能力解决了“能不能存、能不能管、能不能查”的问题。  
但从用户体感看，当前的主要问题已经不再是底层存储，而是：

1. 不同模型 / profile / 外部记忆机制仍可能绕过 `context-anchor`
2. 用户看不清系统到底恢复了什么、沉淀了什么、帮到了什么
3. 即使记忆存在，也不一定能稳定转化为“继续完成当前任务”的帮助
4. diagnose / repair / doctor / install / upgrade 的反馈还要继续围绕“低感知、低误导、低分裂”优化

因此，后续演进方向必须切换为：

- **统一接管**
- **显性收益**
- **任务闭环**

本文件用于承接存储架构完成之后的下一阶段路线。  
后续与该方向相关的开发，应以本文件为准，而不是继续在已完成的存储分阶段计划上追加新阶段。

## 当前进展

截至 `2026-04-04`，当前整体状态如下：

- 存储架构主链路已经完成：
  - runtime state
  - active / archive
  - archive-aware retrieval
  - governance runs / status-report
  - content blobs
- 记忆接管的基础能力已经具备：
  - managed hook 接管
  - heartbeat / workspace monitor 接管
  - upgrade 时 mirror rebuild + governance
  - `MEMORY.md` / `memory/*.md` 自动归并
  - `enforced / best_effort` 记忆接管模式
- diagnose / repair 主链路已经开始收敛：
  - repair 命令已经按 session 问题 / host 问题分流
  - doctor 已能显示 memory takeover mode

本轮已完成：

- `2026-04-03`
  - 新增本路线文档
  - 已将 README 文档导航接入本路线
  - 已在旧存储演进文档中补充“后续方向”指引
- `2026-04-03`
  - 已完成 `Stage 1：多记忆源漂移观测`
  - `doctor` 已增加 external memory source count、last legacy sync time、drift status
  - `status-report` 已增加 external source summary、memory source health、recommended action
  - `sessions-status / sessions-diagnose` 已增加 drift issue 类型、按 drift 给出更精准 repair / follow-up 命令
  - 已新增 `migrate:memory` CLI 作为外部记忆归并入口
  - 已补充 Stage 1 自动化测试，覆盖 `single_source / best_effort / drift_detected`
- `2026-04-03`
  - 已启动 `Stage 2：接管能力强化`
  - `configure-host / install-one-click / upgrade-sessions` 已增加 `takeover_audit`
  - 强制接管模式下，如外部记忆源在最近同步后仍发生变化，会明确返回 warning
  - install / upgrade 的进度输出已可回显 takeover audit 摘要
  - 已补充 Stage 2 自动化测试，覆盖 enforced drift warning 与 install / upgrade audit 回读
- `2026-04-03`
  - `doctor` 已增加 `host_takeover_audit`
  - `configure-host / install-one-click / upgrade-sessions` 已透传 `host_takeover_audit`
  - 已支持对多 registered workspace 做 host-level drift audit
  - 已补充 Stage 2 自动化测试，覆盖多 workspace drift host audit
- `2026-04-03`
  - `doctor` 已增加 `profile_takeover_audit`
  - `configure-host / install-one-click / upgrade-sessions` 已透传 `profile_takeover_audit`
  - 已支持对同级 OpenClaw profile 做 peer-profile drift audit
  - `workspace-monitor` 在 idle 且检测到外部记忆漂移时，会自动触发一次低噪声 legacy memory sync
  - 已补充 Stage 2 自动化测试，覆盖 sibling profile drift audit 与 idle workspace auto-sync
- `2026-04-04`
  - `configure-host` 已增加显式 `verification`
  - `configure-sessions` 已增加显式 `verification` 与 `verification_report`
  - repair 命令执行后已可自动回读当前状态，并返回 `recheck_command`
  - 已补充自动化测试，覆盖 host repair verification 与 session repair verification
- `2026-04-04`
  - `upgrade-sessions` 已增加显式 `verification` 与 `verification_report`
  - `install-one-click` 已增加顶层 `verification`
  - install / upgrade 执行后已可直接返回 recheck 结论，而不只是返回 audit
  - 已补充自动化测试，覆盖 upgrade verification 与 install top-level verification
- `2026-04-04`
  - 已新增 `external-memory-watch` 核心脚本
  - host install 产物中已增加 `automation/context-anchor/external-memory-watch.js`
  - `doctor` 已输出 watcher 路径与命令
  - 已补充自动化测试，覆盖 watcher debounce / skip-sync / installed wrapper
- `2026-04-04`
  - `upgrade-sessions` 已默认跳过临时 `subagent` session
  - 已新增 `--include-subagents` 作为显式覆盖开关
  - 已补充自动化测试，覆盖 subagent 默认跳过
- `2026-04-04`
  - `sessions-status / sessions-diagnose` 已按 workspace 显式展示 `task continuity`
  - `sessions-status / sessions-diagnose` 已按 workspace 显式展示最近一次 `last benefit`
  - 已补充自动化测试，覆盖 continuity / benefit 在 session status 与 diagnose 输出中的可见性
- `2026-04-04`
  - `configure-host / configure-sessions / upgrade-sessions / install-one-click` 的 `verification` 已增加 `readiness_transition.before / after`
  - repair / upgrade 完成后现在可以直接看到 attention session、drift workspace、host readiness 是否真的改善
  - 已补充自动化测试，覆盖 host / session / upgrade 的 readiness transition
- `2026-04-04`
  - `doctor` 的 `recommended_action` 已增加 `recheck_command` 与 `repair_sequence`
  - `sessions-diagnose` 已显式展示 `Recheck` 与 `Repair path`
  - 已补充自动化测试，覆盖 doctor strict repair path 与 diagnose repair path 可见性
- `2026-04-04`
  - `doctor` 的 `recommended_action` 已增加 `repair_strategy`
  - `sessions-diagnose` 已显式展示 `Strategy`
  - 已补充自动化测试，覆盖 strict repair strategy 可见性
- `2026-04-05`
  - `upgrade-sessions` 的 `verification` 已增加 `repair_strategy`
  - `install-one-click` 已聚合 config/session 的 `repair_strategies`
  - install / upgrade 进度输出现在可直接回显 strategy 标签
  - 已补充自动化测试，覆盖 install / upgrade strategy 聚合
- `2026-04-05`
  - `doctor / sessions-diagnose / upgrade-sessions / install-one-click` 的 strategy 已区分 `automatic` / `manual`
  - strategy 现已显式标记 `requires_manual_confirmation`
  - 已补充自动化测试，覆盖 remediation mode 分类
- `2026-04-05`
  - `manual` remediation 已细分为 `confirm_only` 与 `external_environment`
  - install / upgrade 的 strategy 聚合已暴露 manual subtype 维度
  - 已补充自动化测试，覆盖 manual subtype 分类
- `2026-04-05`
  - `manual/external_environment` 已继续细分具体 external issue type
  - 当前已显式区分 `workspace_registration_missing` 与 `workspace_path_unresolved`
  - 已补充自动化测试，覆盖 external issue type 分类
- `2026-04-05`
  - `doctor / sessions-status / sessions-diagnose / status-report / upgrade-sessions / install-one-click` 已开始返回统一的 `remediation_summary`
  - `remediation_summary` 已统一包含 next step、automatic/manual count 与 recheck commands
  - 已补充自动化测试，覆盖 unified remediation summary
- `2026-04-05`
  - `sessions-status / sessions-diagnose` 已开始直接展示 `remediation_summary.next_step`
  - install / upgrade 进度输出已开始直接展示 remediation next step
  - 已补充自动化测试，覆盖 next step 文本可见性
- `2026-04-05`
  - `doctor` 已新增默认文本摘要视图
  - `doctor --json` 可保留完整 JSON 输出
  - 已补充自动化测试，覆盖 doctor remediation 文本摘要
- `2026-04-05`
  - `doctor` 文本摘要已开始直接显示 `External issues`
  - manual external issue type 现在不只存在于结构化数据，也已进入文本视图
  - 已补充自动化测试，覆盖 external issue text visibility
- `2026-04-05`
  - `doctor` 对 external issue type 已开始给出更具体的 `Guidance` 与 `Example command`
  - external issue 不再只是分类标签，也开始带问题定向修复提示
  - 已补充自动化测试，覆盖 doctor external issue guidance
- `2026-04-05`
  - `sessions-diagnose` 已开始显示 remediation `Guidance` 与 `Example command`
  - `status-report` 的 `recommended_action` 已开始返回 `resolution_hint` 与 `command_examples`
  - 已补充自动化测试，覆盖 diagnose / status-report external guidance
- `2026-04-05`
  - `status-report` 已新增默认文本摘要视图
  - `status-report` 文本视图已开始直接显示 remediation next step / guidance / example command
  - 已补充自动化测试，覆盖 status-report text summary
- `2026-04-05`
  - `sessions-status / sessions-diagnose / upgrade-sessions` 已默认跳过用户无感知的 hidden session
  - 已新增 `--include-hidden-sessions` 作为显式排查开关
  - 已补充自动化测试，覆盖 hidden session 默认隐藏与显式显示
- `2026-04-05`
  - `remediation_summary.next_step` 已统一携带结构化 `command_sequence`
  - `doctor / status-report / configure-host / configure-sessions / upgrade-sessions / install-one-click` 已开始直接展示 strict-mode `Auto fix`
  - `sessions-status / sessions-diagnose` 已开始直接展示 `Auto fix path`
  - 已补充自动化测试，覆盖 doctor / status-report / sessions-diagnose 的 auto-fix 可见性
- `2026-04-05`
  - 已新增统一 `auto-fix.js` CLI，可直接执行 automatic remediation 的 `repair -> follow-up -> recheck`
  - `remediation_summary.next_step` 已统一携带 `auto_fix_command`
  - `doctor / sessions-status / sessions-diagnose / status-report / configure-host / configure-sessions / upgrade-sessions / install-one-click` 已开始直接展示 `Auto fix command`
  - 已补充自动化测试，覆盖 auto-fix 编码与命令可见性
- `2026-04-05`
  - `auto-fix.js` 已增加步骤风险分级，当前显式区分 `low / medium / high`
  - 默认只在高风险步骤前做逐步确认，降低低风险修复路径的打断感
  - 已补充自动化测试，覆盖 host config high-risk 分类与确认策略
- `2026-04-05`
  - `auto-fix.js` 已增加批量策略参数：`--until`、`--skip-recheck`、`--risk-threshold`
  - 用户现在可以按阶段、是否回检、风险上限裁剪 automatic remediation 链路
  - 已补充自动化测试，覆盖批量策略过滤与命令生成
- `2026-04-06`
  - `auto-fix.js` 已开始支持用户级默认策略记忆：`--save-defaults` / `--clear-defaults`
  - 当前默认策略保存在 user state 中，可跨后续 auto-fix 调用继承
  - 已补充自动化测试，覆盖默认策略保存、继承与清理
- `2026-04-06`
  - `doctor / status-report / sessions-status / sessions-diagnose / upgrade-sessions` 生成的 `Auto fix command` 已开始自动透传 `--workspace` / `--user-id`
  - auto-fix 默认策略继承现在更容易落到正确 user/workspace，上下文补参成本进一步降低
  - 已补充自动化测试，覆盖 remediation summary auto-fix 上下文命令生成
- `2026-04-06`
  - `Auto fix command` 已开始按问题类型自动选择更贴合场景的默认策略
  - 当前 drift 归并链路默认倾向 `follow_up + skip recheck`，host 配置修复默认保留 `recheck`
  - 已补充自动化测试，覆盖 drift / host-config 两类默认策略生成
- `2026-04-06`
  - `workspace_needs_configuration` 这类问题现在默认倾向先 `repair` 再由用户按需回检
  - `upgraded_session_not_materialized` 这类问题现在默认保留完整 `recheck` 闭环
  - 已补充自动化测试，覆盖 upgrade recovery 细分策略生成
- `2026-04-06`
  - `workspace_unresolved` / `workspace_registration_missing` 这类 manual external-environment 问题已不再暴露误导性的 `Auto fix command`
  - 文本输出现在会明确显示 `Auto fix unavailable`，提醒用户先修外部环境
  - 已补充自动化测试，覆盖 manual external-environment 的 auto-fix 抑制
- `2026-04-06`
  - `manual/confirm_only` 场景现在会额外显示 `Auto fix resume`
  - 系统会说明补齐哪个确认输入后，自动修复才能继续，例如先显式指定 `--workspace`
  - 已补充自动化测试，覆盖 confirm-only 的 blocked reason 与 resume hint
- `2026-04-06`
  - `confirm_only` 的 resume hint 已开始细分到更具体的缺失输入类型
  - 当前已支持按 `workspace / session-key / project-id / profile` 给出差异化提示
  - 已补充自动化测试，覆盖 session-key 缺失的 confirm-only 提示
- `2026-04-06`
  - `confirm_only` 场景现在还会直接给出 `Resume command` 模板
  - 用户可以直接在模板命令里补齐缺失输入后继续流程，而不需要自己重新拼命令
  - 已补充自动化测试，覆盖 session-key 的 resume command 模板
- `2026-04-06`
  - `Resume command` 已开始按入口上下文优先选择更贴近当前命令语境的模板
  - 当前 upgrade 相关场景会优先偏向 `upgrade:sessions`，session 相关场景会优先偏向 `status:sessions` / `configure:sessions`
  - 已补充自动化测试，覆盖多模板时的上下文优先选择
- `2026-04-06`
  - `Resume command` 已开始预填已知上下文参数，例如 `workspace / session-key / openclaw-home / skills-root`
  - 用户现在更少需要手工替换模板占位符即可继续流程
  - 已补充自动化测试，覆盖 resume command 参数预填充
- `2026-04-06`
  - 同一入口存在多个 `Resume command` 候选模板时，系统会优先选择剩余占位符更少、改动更小的模板
  - resume command 现在更倾向于直接可用，而不是让用户再删改更多参数
  - 已补充自动化测试，覆盖同源模板的最小改动优选
- `2026-04-06`
  - 如果 `Resume command` 仍保留关键占位符，文本输出现在会额外显示 `Resume inputs`
  - 用户可以直接看到还缺哪些输入，而不需要自己扫描命令模板
  - 已补充自动化测试，覆盖 session-key 缺失输入列表
- `2026-04-06`
  - `Resume inputs` 现在还会附带更友好的输入说明与示例值
  - 用户可以更快理解每个缺失参数应该填什么，而不只是看到参数名
  - 已补充自动化测试，覆盖 session-key 的输入说明与示例
- `2026-04-06`
  - 高概率输入现在开始支持候选建议，例如 session-key 可直接展示 1~3 个候选值
  - 用户在补参时不只知道“缺什么”，也开始知道“可能填什么”
  - 已补充自动化测试，覆盖 session-key 的候选建议
- `2026-04-06`
  - `status-report / sessions-status / sessions-diagnose` 对 task-state remediation 已开始按缺口类型细分文案
  - 当前已显式区分缺 `goal`、缺 `next step`、缺 `goal+next step`
  - 缺 `next step` / `goal+next step` 的场景现在会更明确提醒 repair 之后补跑一次 `heartbeat`
  - 已补充自动化测试，覆盖 task-state remediation guidance 与 follow-up 文案
- `2026-04-06`
  - `manual/confirm_only` 场景已开始输出 `Resume checks`
  - 系统现在会显式区分当前 `Resume command` 是已经可运行、仍缺输入，还是预填路径已失效
  - `Resume inputs` 的细项现在会继续带 `check` 校验结果，例如候选已就绪、路径不存在、已命中当前候选值
  - 已补充自动化测试，覆盖 confirm-only 输入校验、失效路径提示与文本视图可见性
- `2026-04-06`
  - `upgrade-sessions` 遇到 unresolved target 且当前 profile 已有候选 workspace 时，已开始优先转成 `confirm_only`
  - 当前会直接给出 `Resume command`、候选 workspace 与 `Resume checks`
  - unresolved upgrade target 不再一律退化成笼统的 external-environment 问题
  - 已补充自动化测试，覆盖 unresolved upgrade target 的 confirm-only 路由与文本输出
- `2026-04-06`
  - `upgrade-sessions` 的顶层 `status` 已开始跟随 verification / audit 真实结果，不再在仍需处理时误报 `ok`
  - 当前如果 unresolved target、verification 未通过，或 takeover/profile audit 仍是 warning，升级结果会直接返回 `warning`
  - 已补充自动化测试，覆盖 upgrade 顶层状态与 verification / audit 的一致性
- `2026-04-08`
  - `doctor` 的顶层 `status` 已开始区分 `ok / notice / warning`
  - 当前如果 profile 已可用但 workspace drift audit 尚未选定，或同级 profile 仍处于 `best_effort`，结果会返回 `notice`
  - `doctor` 文本摘要现在也会直接显示顶层 `Status`
  - 已补充自动化测试，覆盖 doctor 顶层状态分级与文本可见性
- `2026-04-08`
  - `configure-host / configure-sessions / install-one-click` 已开始统一返回 `health_status = ok|notice|warning`
  - 当前顶层动作状态与整体健康状态已开始显式拆开，避免 `configured / installed` 与真实验证结果混淆
  - `Stage 5` 主线中的 strict remediation / verify / recheck / auto-fix / resume / health visibility 已基本收口
  - 已补充自动化测试，覆盖 configure/install health status 分级
- `2026-04-08`
  - `task continuity health` 已开始显式区分 `COMPLETE`
  - 当前如果只剩最新完成结果 / 最近用户可见进展，而没有活动 goal / next step / blocked state，会按参考连续性处理
  - 已完成任务不再被误判为需要 repair 的不完整任务态
  - 已补充自动化测试，覆盖 reference-only continuity 与 completed task-state classification
- `2026-04-09`
  - `host_takeover_audit / profile_takeover_audit` 已开始聚合多 workspace / 多 profile 的 strict repair sequence
  - 当前如果同时有多个 drift workspace 或多个 sibling profile 需要处理，会直接给出批量 repair -> recheck 闭环
  - strict-mode 下的 takeover / drift repair 不再只停在“先修第一个问题”
  - 已补充自动化测试，覆盖多 workspace / 多 profile 的聚合 repair sequence
- `2026-04-09`
  - 聚合 takeover / drift repair 现在已开始显式输出 `Affected targets`
  - 当前用户在执行批量 repair / auto-fix 前，可以直接看到将影响哪些 workspace 或 sibling profile
  - 已补充自动化测试，覆盖聚合 repair 的 affected target 可见性
- `2026-04-09`
  - 聚合 drift repair 的 `Auto fix command` 现在已开始复用 drift 流程默认策略
  - 当前会优先停在 `repair`，默认跳过立即 `recheck`，进一步降低批量修复时的打断感
  - 已补充自动化测试，覆盖 aggregated drift auto-fix strategy

当前仍未完成的重点：

- 路线主线阶段已基本闭环完成，后续主要进入增强与质量收口

下一步建议：

1. 后续优先推进整体增强与质量收口，而不再是主线闭环
2. `Stage 2` 后续如继续增强，重点放在 takeover / drift 自愈能力与更低感知自动化
3. `Stage 4` 后续如继续增强，重点放在任务态摘要质量与参考连续性的可解释性
4. `Stage 5` 后续继续扩展 manual/confirm 场景映射、候选建议和偏好演化

后续每一轮开发完成后，都应更新本节，至少补：

- 日期
- 本轮目标
- 已完成
- 新增测试
- 剩余问题

## 当前判断

截至 `2026-04-06`，当前已具备的铺垫如下：

- 已有 host-level managed hook 接管：
  - `agent:bootstrap`
  - `command:new`
  - `command:reset`
  - `command:stop`
  - `session:compact:before`
  - `session:compact:after`
- 已有后台接管：
  - `heartbeat`
  - `workspace-monitor`
- 已有外部记忆聚合能力：
  - `MEMORY.md`
  - `memory/*.md`
- 已有记忆接管模式：
  - `best_effort`
  - `enforced`
- 已有升级路径治理接入、进度提示与 repair 路由修正
- 已有 strict-mode repair UX 主链路：
  - `Auto fix`
  - `Auto fix command`
  - `Auto fix unavailable`
  - `Auto fix resume`
  - `Resume command`
  - `Resume inputs`

当前仍未完成的关键问题：

- 主线阶段已闭环完成，但后续增强仍需继续降低用户感知成本
- 任务态摘要、takeover 自愈、manual/confirm 体验仍可继续优化
- 计划文档后续应从“主线闭环”转向“增强与质量治理”

## 总目标

1. 把 `context-anchor` 从“可选 skill”提升为“默认记忆管理层”。
2. 尽量减少模型、profile、外部文件对记忆的绕过和分裂。
3. 让用户能明确看到系统恢复了什么、推荐了什么、沉淀了什么。
4. 让记忆系统优先服务“当前任务连续性”，而不是只做材料存取。
5. 让 diagnose / repair / install / upgrade 的用户体验保持低感知、低误导、可自助修复。

## 非目标

- 当前阶段不引入新的远程数据库
- 当前阶段不做多设备同步
- 当前阶段不替换 OpenClaw 的全部内部记忆机制
- 当前阶段不做 embedding 主路径改造
- 当前阶段不做 UI 大改版

## 设计原则

### 1. 宿主接管优先于技能自觉

凡是可以通过 host config、managed hooks、workspace monitor、upgrade/install 流程接管的能力，不依赖 agent 自觉调用 skill。

### 2. 单一真源优先

`context-anchor` 应逐步成为 canonical memory plane。  
如果做不到完全单一，也必须做到：

- 可观测
- 可告警
- 可解释
- 可修复

### 3. 任务态优先于材料态

恢复顺序应该优先保证：

- 当前目标
- 最近完成结果
- 下一步动作
- 当前阻塞项

而不是先堆积大量历史材料。

### 4. 低感知、低打断

默认路径尽量自动完成；只有涉及强制接管、潜在冲突、可能影响用户现有习惯的动作时才交互确认。

### 5. 告警必须可执行

任何告警都要直接给出：

- 原因
- 影响
- 推荐修复
- 精确命令

不能只告诉用户“有问题”。

## 成功信号

如果本路线推进有效，用户应该能明显感受到：

1. 使用越久，越少出现“明明做过却没记住”的情况
2. `/new` / `/reset` / `/compact` / 重启后，更容易接着做当前任务
3. 状态检查时，用户能立刻知道问题在 session 侧、host 侧还是多记忆源漂移
4. 升级后不需要自己猜还要不要手工迁移、手工治理、手工修复
5. 用户能明确看到 `context-anchor` 这次具体帮他恢复了哪些上下文

## 实施阶段

## Stage 0：基线固化

目标：

- 明确本路线与已完成存储演进的边界
- 把后续工作统一收敛到本文件

实现：

- 本文档
- README 导航补充
- 已完成旧方案与新方案的衔接说明

状态：

- `已完成`

## Stage 1：多记忆源漂移观测

目标：

- 用户能看到自己是否处于“多套记忆源并存”的不稳定状态

实现：

- `doctor` 增加：
  - external memory source count
  - last legacy sync time
  - drift status
- `status-report` 增加：
  - external source summary
  - memory source health
  - recommended action
- `sessions-status / sessions-diagnose` 增加：
  - drift issue 类型
  - 更精准 repair 命令

关键文件：

- `scripts/doctor.js`
- `scripts/status-report.js`
- `scripts/lib/openclaw-session-status.js`
- `scripts/legacy-memory-sync.js`

完成标准：

- 用户能明确知道当前是单一真源、最佳努力模式，还是已发生漂移
- diagnose / repair 提示与真实修复动作一致

状态：

- `已完成`
- 已完成内容：
  - `doctor` 已输出 external memory source count、last legacy sync time、drift status
  - `status-report` 已输出 external source summary、memory source health、recommended action
  - `sessions-status / sessions-diagnose` 已把 drift 纳入 issue 和 repair 路由
  - 已补 `migrate:memory` 命令统一归并外部 `MEMORY.md` / `memory/*.md`
  - 已补测试覆盖 `single_source / best_effort / drift_detected`

## Stage 2：接管能力强化

目标：

- 进一步减少绕过 `context-anchor` 的入口

实现：

- 严格接管模式下：
  - 明确告警外部记忆源持续变化
  - install / configure / upgrade 对 profile 级配置做一致性校验
- 研究并落地可选 watcher：
  - 文件变化触发 legacy memory sync
- 为多 profile / 多 workspace 增加 host audit

关键文件：

- `scripts/configure-host.js`
- `scripts/install-one-click.js`
- `scripts/upgrade-sessions.js`
- `scripts/legacy-memory-sync.js`
- `scripts/doctor.js`

完成标准：

- `enforced` 模式下，用户能明显减少多记忆源分裂
- 非 `enforced` 模式下，用户也能清楚看到限制

状态：

- `已完成`
- 已完成部分：
  - `configure-host / install-one-click / upgrade-sessions` 已执行接管一致性回读审计
  - enforced 模式下的 external drift 已提升为明确 warning
  - install / upgrade 已可回显 `takeover_audit` 摘要
  - `doctor` 已可输出多 workspace `host_takeover_audit`
  - `configure-host / install-one-click / upgrade-sessions` 已可回传 `host_takeover_audit`
  - `doctor` 已可输出 `profile_takeover_audit`
  - `configure-host / install-one-click / upgrade-sessions` 已可回传 `profile_takeover_audit`
  - `workspace-monitor` 已能在 idle 时自动归并外部记忆变化
  - `configure-host / configure-sessions` 已形成 repair -> verify 闭环
  - `upgrade-sessions / install-one-click` 已形成 upgrade/install -> verify 闭环
  - 已有可选 watcher 运行时，可在文件变化时更快触发 legacy memory sync
  - `host_takeover_audit / profile_takeover_audit` 现在也已支持多 workspace / 多 profile 聚合 repair sequence
- 后续增强：
  - 继续增强 takeover / drift 自愈能力与更低感知自动化

## Stage 3：收益显性化

目标：

- 让用户明确看到系统这次恢复了什么、命中了什么、沉淀了什么

实现：

- bootstrap 增加：
  - restored goal/result/next step 摘要
  - recovered continuity summary
- `memory-search` 增加：
  - why matched
  - why from archive
- `heartbeat` / `session-close` 增加：
  - newly captured lessons
  - promoted skills / archived skills summary

关键文件：

- `scripts/session-start.js`
- `scripts/lib/bootstrap-cache.js`
- `scripts/memory-search.js`
- `scripts/heartbeat.js`
- `scripts/session-close.js`

完成标准：

- 用户不需要猜系统“有没有工作”
- 用户能在关键节点看到实际收益摘要

状态：

- `已完成`
- 已完成部分：
  - bootstrap 已增加 `Recovered Continuity` 摘要
  - `session-start` 已输出结构化 `continuity_summary`
  - bootstrap 现已显式展示恢复来源、restored goal、latest result、next step
  - `memory-search` 已输出 `why_matched`
  - `memory-search` 已输出 `why_from_archive`
  - `heartbeat / session-close` 已输出 `captured_summary`
  - `session-close` 已把 `benefit_summary` 写入 session summary
  - `sessions-status / sessions-diagnose` 已按 workspace 显示最近一次 `last benefit`
  - 已补充自动化测试，覆盖 session-start continuity summary、bootstrap 注入摘要与 last benefit 可见性

## Stage 4：任务连续性模型

目标：

- 恢复的是“当前工作状态”，不是只恢复“参考资料”

实现：

- 扩展 runtime state：
  - `current_goal`
  - `latest_verified_result`
  - `next_step`
  - `blocked_by`
  - `last_user_visible_progress`
- 在以下链路更新：
  - `heartbeat`
  - `session-close`
  - `command:new/reset/stop`
  - `session:compact:after`
- bootstrap 优先展示任务态

关键文件：

- `scripts/lib/context-anchor.js`
- `scripts/runtime-state-update.js`
- `scripts/session-start.js`
- `scripts/session-close.js`
- `scripts/heartbeat.js`
- `scripts/session-compact.js`

完成标准：

- reset/new/compact/重启后，优先恢复目标、结果、下一步
- “任务已经做完却还被当成待办恢复”的情况进一步减少

状态：

- `已完成`
- 已完成部分：
  - runtime state 已增加 `current_goal`
  - runtime state 已增加 `latest_verified_result`
  - runtime state 已增加 `next_step`
  - runtime state 已增加 `blocked_by`
  - runtime state 已增加 `last_user_visible_progress`
  - `heartbeat / session-close / runtime-state-update` 已开始写入任务态字段
  - `session-start` 已优先读取任务态字段恢复 continuity summary
  - `session:compact:after` 已显式返回 `task_state_summary`
  - `status-report` 已显式输出 `task_state_summary`
  - `command:new / command:reset / command:stop` 已形成统一任务态语义
  - bootstrap / startup resume 已进一步优先展示任务态摘要
  - `sessions-status / sessions-diagnose` 已按 workspace 显示 `task continuity`
  - `sessions-status / sessions-diagnose / status-report` 已开始显式区分 `task continuity health`
  - 当前已显式区分 `READY / COMPLETE / PARTIAL / MISSING`
  - `status-report / sessions-diagnose` 已开始把 `task continuity health` 缺口纳入 repair 路由
  - 当前已开始显式给出 `repair task state -> recheck`
  - `task continuity health` 现在已开始继续细分到 `missing goal / missing next step / missing goal+next step`
  - repair strategy 现在会随 task-state 缺口类型输出更细粒度标签
  - 当缺的是 `next step` 或 `goal+next step` 时，repair 路由现在会继续带出一次 `heartbeat` follow-up
  - `status-report / sessions-status / sessions-diagnose` 现在会按 task-state 缺口类型输出更具体的 remediation guidance
  - 参考连续性的已完成任务现在会返回 `COMPLETE`，不再被误判为需要 repair 的不完整任务态
  - 已补充自动化测试，覆盖 next-step 缺口的 follow-up heartbeat
  - 已补充自动化测试，覆盖 task-state 缺口分类
  - 已补充自动化测试，覆盖 task-state remediation 可见性
  - 已补充自动化测试，覆盖 task continuity health 可见性
  - 已补充自动化测试，覆盖 runtime task-state update 与 continuity restore
- 后续增强：
  - 继续优化任务态摘要质量与 reference-only continuity 的可解释性

## Stage 5：严格模式与自动修复闭环

目标：

- 用户发现问题后，不需要猜下一步修什么

实现：

- `doctor` / `sessions-status` / `sessions-diagnose` 给出更细 repair 路径
- 在严格模式下提供：
  - host config drift 修复建议
  - external memory drift 修复建议
  - install / upgrade 中的自动修复入口
- 对 repair 结果做回读验证

关键文件：

- `scripts/doctor.js`
- `scripts/sessions-status.js`
- `scripts/sessions-diagnose.js`
- `scripts/configure-sessions.js`
- `scripts/configure-host.js`

完成标准：

- diagnose -> repair -> recheck 是闭环
- 用户执行提示命令后，状态检查结果应该发生预期变化

状态：

- `进行中`
- 已完成部分：
  - repair 命令分流已开始按问题类型区分
  - `configure-host / configure-sessions / upgrade-sessions` 已形成 repair -> verify -> recheck 主链路
  - `verification` 已增加 `readiness_transition.before / after`
  - repair / upgrade 结果现在可以显式判断“是否真的修好”还是“只是执行过命令”
  - `doctor / sessions-diagnose` 已开始显式串联 repair -> follow-up -> recheck 路径
  - `doctor / sessions-diagnose` 已开始显式区分 strict repair strategy，减少手工判断先后顺序
  - `install-one-click / upgrade-sessions` 已开始把 strict repair strategy 汇总到长流程输出
  - strict repair strategy 已开始区分可自动执行与需要人工确认的步骤
  - 多入口 remediation 输出已开始收敛到统一结构
  - remediation 的 next step 已开始直接进入文本输出
  - manual remediation 已开始区分“只需确认”和“需要修外部环境”
  - `doctor` 已不再只依赖 JSON 才能看懂 remediation 结果
  - external environment 类手工修复已经开始区分更具体的问题来源
  - `doctor` 文本摘要已开始直接暴露 external issue type
  - `doctor` 文本摘要已开始根据 external issue type 给出定向修复提示
  - `sessions-diagnose / status-report` 也开始给出更具体的外部问题修复提示
  - `status-report` 已不再只依赖 JSON 才能快速阅读 remediation 信息
  - session 观测与 upgrade 默认口径已开始优先贴近用户真实感知
  - strict-mode 自动修复路径已开始在 doctor / session diagnose / status-report / install / upgrade / configure 输出中显式化
  - task-state remediation 的文本 guidance 已开始和 strict repair 路径对齐，不再只给笼统 repair 提示
  - confirm-only 场景已开始对 resume command 做基础输入校验，不再只显示缺失输入名
  - upgrade unresolved target 现在也开始复用 confirm-only resume 闭环，而不是只停在外部环境提示
  - upgrade 顶层状态现在也开始避免误导，不再在 verification / audit 仍异常时返回 `ok`
  - doctor 顶层状态现在也开始避免误导，不再把可继续但仍需补齐的 notice 场景误报成 `ok`
  - `configure-host / configure-sessions / install-one-click` 已开始补齐统一 `health_status = ok|notice|warning`
- 后续增强：
  - strict-mode auto-fix 仍可继续补更多 manual/confirm 场景来源映射
  - 仍可继续增强参数预填充、交互补参、更丰富的参数候选建议与可学习偏好演化

## 测试设计

以下测试必须长期保留并持续扩展。

## A. 单元测试

### A1. drift detection

覆盖：

- 只有 `context-anchor`
- `context-anchor + MEMORY.md`
- `context-anchor + memory/*.md`
- `best_effort` 与 `enforced` 模式差异

断言：

- drift 状态正确
- 推荐动作正确

### A2. task-state extraction

覆盖：

- heartbeat 更新 goal/result/next_step
- compact 后任务态保留
- stop/new/reset 不恢复已完成任务

断言：

- runtime state 字段正确
- 恢复链路优先读任务态

### A3. remediation resume validation

覆盖：

- confirm-only 缺失输入但已有候选
- confirm-only 预填路径已失效
- upgrade unresolved target 转 confirm-only
- 文本视图展示 `Resume checks`

断言：

- `Resume command` 校验状态正确
- `Resume inputs` 细项带校验说明
- 文本输出能直接说明“还缺什么 / 哪个路径失效”

## B. 集成测试

### B1. install / configure / upgrade UX

覆盖：

- 交互式选择强制接管
- 显式关闭强制接管
- 升级时切到强制接管

断言：

- host config 落盘正确
- `doctor` 显示正确
- README 命令与实际行为一致

### B2. legacy memory sync

覆盖：

- `MEMORY.md`
- `memory/*.md`
- 重复同步
- 文件变化后二次同步

断言：

- 幂等
- 不重复导入
- 变更后能再次吸收

### B3. visible benefit

覆盖：

- bootstrap 显示恢复摘要
- `memory-search` 显示命中原因
- close / heartbeat 显示沉淀摘要

断言：

- 用户可见输出包含高价值信息
- 不引入刷屏

## C. 真实链路测试

保留并扩展 `openclaw-real.test.js`：

- one-click install 后的强制接管交互结果
- real profile 下 external memory drift
- upgrade 后的严格接管模式
- bootstrap 文件不与宿主 `MEMORY.md` 冲突

## D. 手工验收

每次阶段性完成后，至少手工验证：

1. 一个启用 `enforced` 的 profile 连续工作后，不再出现明显的多记忆源分裂
2. 一个保持 `best_effort` 的 profile 能清楚看到限制提示
3. reset/new/compact 后能直接看到恢复目标、结果和下一步
4. diagnose -> repair -> recheck 真的能形成闭环

## 文档维护规则

从本次起，后续与该路线相关的开发完成后，必须同步更新本文件。

每次更新至少修改：

1. `当前判断`
   - 标明本轮完成了什么
   - 标明哪些阶段状态变化
   - 标明尚未完成的阻塞点
2. 对应 `Stage` 小节
   - 更新已落地项
   - 标记新增入口和关键文件
3. `测试设计`
   - 标记新增或补齐的测试点
4. 如本轮影响使用者
   - 同步更新 README / doctor / diagnose / install / upgrade 文案

执行约束：

- 任何与该路线相关的代码提交，都必须附带对应测试
- 任何与该路线相关的代码提交，都必须更新本文件中的当前状态
- 未补测试、未更新文档的改动，不视为该阶段完成

## 验收标准

完成本路线至少要满足：

1. 用户能判断当前是否存在多记忆源漂移
2. 用户能明确看到这次恢复了什么、这次新增沉淀了什么
3. 任务连续性恢复优先于材料恢复
4. `enforced` / `best_effort` 模式差异清晰、可诊断、可解释
5. diagnose -> repair -> recheck 是稳定闭环
