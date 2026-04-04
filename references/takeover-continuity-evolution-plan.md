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

截至 `2026-04-03`，当前整体状态如下：

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

当前仍未完成的重点：

- 用户仍然不够容易看到“这次恢复了什么 / 新沉淀了什么”
- 任务连续性还没有形成明确的 goal/result/next-step 模型
- 严格模式还没有形成完整的 drift 告警与自动修复闭环

下一步建议：

1. 先做 `Stage 2：接管能力强化`
2. 再做 `Stage 3：收益显性化`
3. 然后推进 `Stage 4：任务连续性模型`

后续每一轮开发完成后，都应更新本节，至少补：

- 日期
- 本轮目标
- 已完成
- 新增测试
- 剩余问题

## 当前判断

截至 `2026-04-03`，当前已具备的铺垫如下：

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

当前仍未完成的关键问题：

- 用户还看不清“这次恢复了什么”和“这次系统新沉淀了什么”
- 任务连续性仍偏“材料恢复”，还不够“状态恢复”
- 严格接管模式还没有形成完整的 drift 告警、强约束和自动修复闭环

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

- `进行中`
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
- 仍待完成：
  - 更强的 strict-mode repair 闭环

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

- `进行中`
- 已完成部分：
  - bootstrap 已增加 `Recovered Continuity` 摘要
  - `session-start` 已输出结构化 `continuity_summary`
  - bootstrap 现已显式展示恢复来源、restored goal、latest result、next step
  - 已补充自动化测试，覆盖 session-start continuity summary 与 bootstrap 注入摘要
- 仍待完成：
  - `memory-search` 的 why matched / why from archive
  - `heartbeat / session-close` 的 newly captured summary

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

- `未开始`
- 已有铺垫：
  - active_task / pending_commitments runtime_state 已独立

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

- `未开始`
- 已有铺垫：
  - repair 命令分流已开始按问题类型区分

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
