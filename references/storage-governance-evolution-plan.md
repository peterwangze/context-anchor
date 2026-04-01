# 长期记忆治理与 SQLite 演进实施方案

## 背景

`context-anchor` 目前已经具备：

- JSON 兼容存储
- SQLite mirror / FTS 检索
- bootstrap 上下文预算控制
- session / project / user 多层记忆
- mirror rebuild 能力

但当前体系还没有真正解决“长期积累导致的无限膨胀”问题：

- active / archive 双层存储、archive-aware 检索和治理观测已经落地
- `runtime_state` 已独立，长期检索与治理运行也已经进入可观测状态
- 当前剩余核心缺口主要在 blob 分离与压缩，而不是检索或治理控制面

这个文档把后续方案落成“可执行的实施计划”，并明确测试设计。  
在本方案全部实现完成之前，暂停引入与该主题无关的新功能。

## 当前进展

截至 2026-04-01，当前已经完成的基础工作如下：

- 已完成 SQLite mirror 基础设施：
  - collection mirror
  - document mirror
  - FTS 检索
  - mirror rebuild
- 已完成 upgrade 链接入：
  - `install-one-click --upgrade-sessions` 会自动触发 mirror migration
  - `upgrade-sessions --rebuild-mirror` 已支持
- 已完成 bootstrap 上下文治理基础：
  - bootstrap 有 10K 预算
  - 采用分档压缩而不是最终硬截断
  - 长期记忆默认只通过检索指针暴露
- 已完成 session continuity 基础修正：
  - 已关闭且无 pending commitments 的旧 session 不再错误续上 stale `active_task`
- 已完成 mirror-aware status / diagnose / report 基础能力：
  - `status-report` 已能优先读取镜像
  - `sessions-status / sessions-diagnose` 已显示 mirror summary
- 本轮（2026-04-01，Phase 1）已完成：
  - 为每个 session 新增独立 `runtime-state.json`
  - 新增 `scripts/runtime-state-update.js`
  - `session-start / session-close / command:new / command:reset / command:stop / session:compact:after` 已刷新 runtime state
  - bootstrap / gateway startup / continuity restore / status-report 已优先读取 runtime state
  - 已补 runtime-state 优先级与 compact 刷新测试，并跑通全量测试
- 本轮（2026-04-01，Phase 2）已完成：
  - 新增 `scripts/storage-governance.js`
  - session / project / user 已落地 active + archive 双文件层
  - SQLite mirror 已识别 archive collection，`mirror-rebuild` 已可回填 archive 集合
  - `heartbeat / session-close / workspace-monitor` 已执行 storage governance
  - 已补 retention score、去重、active/archive 切分、lifecycle 触发和 archive mirror 测试，并跑通全量测试
- 本轮（2026-04-01，Phase 3）已完成：
  - `memory-search` 已实现 active 优先、archive 按需回退
  - 检索结果已显式返回 `tier / from_archive / retrieval_cost`
  - archive mirror FTS 查询路径已可命中 archive 集合
  - 已补 active/archive 优先级、archive-only fallback、bootstrap 不预载 archive、archive FTS 检索测试
- 本轮（2026-04-01，Phase 4）已完成：
  - SQLite 新增 `governance_runs` 统计表
  - `storage-governance` 每次执行都会记录治理 totals 和 per-collection 摘要
  - `status-report` 已新增 active/archive item count、last governance run、bytes before/after、prune count
  - `workspace-monitor` 触发的治理运行已带明确 reason
  - 已补 governance run 持久化、status-report 观测和 monitor reason 测试

当前仍未完成的核心目标：

- blob 分离与压缩尚未落地

因此，本方案当前状态应认定为：

- `Phase 0`：已完成
- `Phase 1`：已完成
- `Phase 2`：已完成
- `Phase 3`：已完成
- `Phase 4`：已完成
- `Phase 5`：未开始

## 文档维护规则

从本次起，后续每一轮与本方案相关的开发完成后，必须同步更新本文件，且更新不能滞后于代码提交。

每次更新至少要修改以下内容：

1. `当前进展`
   - 标明本轮完成了什么
   - 标明哪些阶段状态发生变化
   - 标明尚未完成的阻塞点
2. 对应 `Phase` 小节
   - 更新已落地项
   - 删除已过时的描述
   - 标注新增的实现入口和关键文件
3. `测试设计`
   - 标记本轮新增或已覆盖的测试点
   - 如果发现测试空洞，必须补到文档里
4. 如本轮行为影响使用者或迁移路径
   - 同步更新 README / doctor / upgrade 命令说明

执行约束：

- 任何与本方案有关的代码提交，都必须附带对应测试
- 任何与本方案有关的代码提交，都必须更新本文件中的“当前进展”
- 未补测试、未更新进展的改动，不视为该阶段完成

建议每次更新都在 `当前进展` 中附带：

- 日期
- 本轮目标
- 已完成测试
- 剩余风险

## 总目标

1. 让上下文增长有硬边界，bootstrap 和恢复链路始终只加载高价值、当前相关的状态。
2. 让存储增长有硬边界，长期数据进入 archive / prune 路径，避免 live 集合无限膨胀。
3. 让 SQLite 从“镜像和检索加速层”演进为“运行索引层和治理控制层”。
4. 保持 JSON 兼容性，避免破坏已有用户数据、安装路径和调试方式。
5. 给后续修改建立完整的测试防线，避免再次引入 reset 连续性、迁移遗漏、live 集合失控等问题。

## 非目标

- 当前阶段不引入远程数据库
- 当前阶段不引入在线向量数据库
- 当前阶段不放弃 JSON 兼容格式
- 当前阶段不实现多设备同步
- 当前阶段不做 embedding 检索主路径替换

## 设计原则

- 先治理数据生命周期，再扩展检索能力
- 当前工作状态与长期知识必须分层，不再混用
- SQLite 用于结构化索引、配额治理、检索和观测，不用于替代全部文件兼容层
- archive 默认不进入上下文，只参与按需检索
- 所有迁移必须可重复执行、可回填、可回滚到 JSON 兼容读路径
- 治理必须是可观测的，不能“静默删除”

## 范围冻结

在以下事项全部落地前，不做无关新功能：

1. `runtime_state` 独立
2. active / archive 双层治理
3. archive-aware 检索
4. 定期治理任务
5. 治理统计与测试体系

允许继续做的工作只包括：

- 该方案内的实现
- 该方案相关 bugfix
- 文档、迁移和测试补全

## 目标架构

### 1. 状态平面

把“当前工作状态”从普通记忆集合里剥离，形成独立平面：

- `runtime_state`
  - `active_task`
  - `pending_commitments`
  - `latest_completed_step`
  - `latest_verified_result`
  - `current_goal`
  - `updated_at`

用途：

- `/reset` / `/new` / `/stop` / `/compact` 恢复连续性
- bootstrap 时优先加载
- 不参与长期 memory/archive 配额

### 2. 知识平面

记忆和经验统一进入三层：

- `active`
  - 可直接参与检索
  - 有硬上限
  - 可进入 bootstrap 指针层
- `archive`
  - 默认不进入上下文
  - 仅按需检索
  - 有单独上限
- `pruned`
  - 超低价值或被新版本折叠
  - 只保留统计或直接删除

### 3. 索引平面

SQLite 演进为控制平面和检索平面：

- `runtime_state`
- `memory_items`
- `content_blobs`
- `retrieval_log`
- `governance_runs`
- 已有 `catalog_collections / catalog_items / catalog_documents` 持续保留，逐步过渡

### 4. 兼容平面

JSON 仍然保留，作用变成：

- 用户可读
- 调试回退
- 迁移兼容

SQLite 是主索引层，但不是“只剩 SQLite、删掉 JSON”。

## 数据模型演进

### A. runtime_state

建议新增：

- workspace 级路径：`.context-anchor/sessions/{session-key}/runtime-state.json`
- mirror：`catalog_documents` 中新增 `session_runtime_state`

字段：

- `session_key`
- `project_id`
- `user_id`
- `active_task`
- `pending_commitments`
- `latest_completed_step`
- `latest_verified_result`
- `current_goal`
- `reference_session`
- `updated_at`

### B. active / archive 存储

当前已有 archive 路径雏形，应正式落地为：

- session
  - `sessions/{key}/memory-hot.json`
  - `sessions/{key}/archives/memory-hot.json`
  - `sessions/{key}/experiences.json`
  - `sessions/{key}/archives/experiences.json`
- project
  - `projects/{id}/decisions.json`
  - `projects/{id}/archives/decisions.json`
  - `projects/{id}/experiences.json`
  - `projects/{id}/archives/experiences.json`
  - `projects/{id}/facts.json`
  - `projects/{id}/archives/facts.json`
- user
  - `users/{id}/memories.json`
  - `users/{id}/archives/memories.json`
  - `users/{id}/experiences.json`
  - `users/{id}/archives/experiences.json`

### C. 配额

当前默认建议如下：

- `session_memories`
  - active: 80
  - archive: 320
- `session_experiences`
  - active: 120
  - archive: 480
- `project_decisions`
  - active: 200
  - archive: 800
- `project_experiences`
  - active: 300
  - archive: 1200
- `project_facts`
  - active: 400
  - archive: 1600
- `user_memories`
  - active: 200
  - archive: 800
- `user_experiences`
  - active: 300
  - archive: 1200

后续允许在 `DEFAULTS.storageGovernance` 中调整，但实现阶段先固定默认值。

### D. 保留评分

归档 / 留存评分统一为：

```text
retention_score =
  heat * 0.35 +
  recency * 0.20 +
  access * 0.15 +
  validation * 0.15 +
  cross_session * 0.10 +
  source_priority * 0.05
```

说明：

- `validation` 对经验类更重要
- `cross_session` 对长期可复用知识更重要
- `source_priority` 用于优先保留 decision / validated experience

## 实施阶段

## Phase 0：冻结与准备

目标：

- 停止无关功能开发
- 保持当前 SQLite mirror 和 JSON 兼容路径稳定
- 先补方案相关文档与测试基线

改动：

- 本文档
- README 链接和术语统一
- baseline 性能和数据规模观测

完成标准：

- 本文档合并
- 所有后续变更必须对照本文档的测试设计补测试

## Phase 1：runtime_state 独立

目标：

- 不再依赖普通 memory/summary 来表达当前工作状态

实现：

- 为每个 session 新增 `runtime-state.json`
- 新增 `scripts/runtime-state-update.js`
- 在以下路径更新 runtime state：
  - `session-start`
  - `session-close`
  - `command:new/reset/stop`
  - `session:compact:after`
- 在 bootstrap 中优先读取 runtime state
- `gateway:startup` 和 `status-report` 也优先读取 runtime state

关键文件：

- `scripts/lib/context-anchor.js`
- `scripts/runtime-state-update.js`
- `scripts/session-start.js`
- `scripts/session-close.js`
- `scripts/session-compact.js`
- `scripts/status-report.js`
- `scripts/lib/bootstrap-cache.js`
- `hooks/context-anchor-hook/handler.js`

完成标准：

- reset/new/stop/compact 之后连续状态来自 runtime state
- closed 且无 pending 的 session 不再错误恢复旧任务

当前结果（2026-04-01）：

- 已完成
- runtime state 已成为 continuity / bootstrap / startup resume / status-report 的优先来源
- 兼容保留 `state.json`，但连续性恢复不再依赖 summary / compact packet 作为主状态来源

## Phase 2：active / archive 治理

目标：

- live 集合大小可控
- archive 成为真实的第二层，而不是只靠 `archived` 标志

实现：

- 新增 `scripts/storage-governance.js`
- 对每个治理集合执行：
  - 去重
  - retention_score 排序
  - 保留 active top N
  - 其余迁移到 archive
  - archive 超限时再 prune
- archive 迁移时保留：
  - `archived_at`
  - `archive_reason`
  - 原始 id
  - source linkage

关键文件：

- `scripts/lib/context-anchor.js`
- `scripts/lib/context-anchor-db.js`
- `scripts/storage-governance.js`
- `scripts/heartbeat.js`
- `scripts/session-close.js`
- `scripts/session-maintenance.js`
- `scripts/workspace-monitor.js`
- `scripts/mirror-rebuild.js`

完成标准：

- live 文件不会无限膨胀
- archive 文件有明确边界
- SQLite mirror 同步 active 和 archive 集合

当前结果（2026-04-01）：

- 已完成
- governance 会按 retention score 对 session / project / user 集合做去重、active/archive 切分与 prune
- active 与 archive 已拆到独立 JSON 文件，并保持 mirror 同步
- `heartbeat / session-close / workspace-monitor` 已默认执行治理

## Phase 3：archive-aware 检索

目标：

- archive 不预载，但可按需检索

实现：

- `memory-search` 分两层：
  - 先查 active
  - active 命中不足时，再查 archive
- 返回结果显式标记：
  - `tier`
  - `from_archive`
  - `retrieval_cost`

关键文件：

- `scripts/memory-search.js`
- `scripts/lib/context-anchor-db.js`
- `scripts/lib/bootstrap-cache.js`
- `scripts/session-start.js`

完成标准：

- bootstrap 不读取 archive 正文
- archive 仍可按需找回

当前结果（2026-04-01）：

- 已完成
- `memory-search` 会先返回 active 结果，仅在 active 结果不足时补 archive 结果
- archive 结果会显式标记 `tier=archive`、`from_archive=true`、`retrieval_cost=archive_lookup`
- bootstrap 仍只暴露检索指针，不预载 archive 正文

## Phase 4：治理任务与观测

目标：

- 治理不靠人工触发
- 可观察到数据规模、归档量和 prune 量

实现：

- `heartbeat` / `session-close` / `workspace-monitor` 执行治理
- 新增 `governance_runs` 统计
- `status-report` 增加：
  - active item count
  - archive item count
  - last governance run
  - bytes before / after
  - prune count

关键文件：

- `scripts/heartbeat.js`
- `scripts/session-close.js`
- `scripts/workspace-monitor.js`
- `scripts/status-report.js`
- `scripts/lib/context-anchor-db.js`
- `scripts/storage-governance.js`
- `scripts/session-maintenance.js`

完成标准：

- 用户能看到系统是否在膨胀
- 治理结果可回归验证

当前结果（2026-04-01）：

- 已完成
- `heartbeat / session-close / workspace-monitor` 已执行 storage governance 并记录 `governance_runs`
- `status-report` 已显示 active/archive item count 和最近一次治理运行摘要
- 最近一次治理运行已可观察 `bytes_before / bytes_after / prune_count`

## Phase 5：blob 分离与压缩

目标：

- 大文本不拖慢主索引和 live 集合

实现：

- 主表只留短 summary / metadata
- 正文进入 `content_blobs`
- archive 优先压缩长 details / solution / raw context

说明：

- 这一阶段可以在 Phase 2~4 完成后再做
- 不影响前面阶段的主逻辑

## 迁移策略

### 1. 向后兼容

- JSON 文件继续保留
- 旧脚本仍可读 JSON
- mirror rebuild 持续可重复运行

### 2. 迁移顺序

1. 升级代码
2. 执行 `mirror-rebuild`
3. 执行第一次治理
4. 之后由 heartbeat / maintenance 自动接管

### 3. 灰度策略

- 第一阶段只做 `report-only`
  - 计算保留结果
  - 不真实迁移
- 第二阶段开启 archive 迁移
- 第三阶段开启 archive prune

建议通过环境变量控制：

- `CONTEXT_ANCHOR_GOVERNANCE_MODE=report|enforce`
- `CONTEXT_ANCHOR_ARCHIVE_PRUNE=0|1`

## 实施顺序约束

严格按下面顺序推进：

1. 文档和测试基线
2. runtime_state
3. active / archive 治理
4. archive-aware search
5. 治理任务和统计
6. blob 分离

不允许跳过前置阶段直接做：

- 语义检索主路径
- 新数据库迁移
- 多设备同步

## 测试设计

以下测试必须补齐，且后续修改不能删减。

## A. 单元测试

### A1. retention score

覆盖：

- heat 更高的条目优先
- validated experience 优先于未验证经验
- 多 session 命中的条目优先
- 同分情况下按最近访问排序

断言：

- 排序稳定
- 同输入多次运行结果一致

已覆盖（2026-04-01）：

- `storage governance retention scores prefer validated and cross-session entries in a stable order`

### A2. active/archive 配额切分

覆盖：

- 未超限时不迁移
- 超限时 active 保留 top N
- 迁移到 archive 后 active 数量等于上限
- archive 超限时 prune 最低价值项

断言：

- active / archive 数量符合配额
- 被迁移项带 `archived_at / archive_reason`

已覆盖（2026-04-01）：

- `storage governance dedupes entries and splits active archive budgets with prune`

### A3. 去重与版本折叠

覆盖：

- 相同 `content_hash` 的重复条目
- 相同 summary 但 access metadata 不同
- 同一 source 多版本更新

断言：

- 不会无限累积重复项
- 高价值版本保留

已覆盖（2026-04-01）：

- `storage governance dedupes entries and splits active archive budgets with prune`

### A4. runtime_state

覆盖：

- 有 pending commitments 时恢复
- 已关闭且无 pending 时不恢复 stale task
- compact 后 runtime state 刷新
- reset/new/stop 后 continuity source 正确

已覆盖（2026-04-01）：

- `session-start prefers runtime state over stale session state for the current session`
- `session-compact after refreshes runtime state metadata`
- `session-start does not carry forward stale active task from a closed session without pending commitments`
- `command stop hook runs unified session close lifecycle`
- `real OpenClaw runtime loads managed hooks and closes the prior session on command:new rollover`

## B. 集成测试

### B1. session lifecycle

场景：

- `session-start -> work -> command:reset -> bootstrap`
- `session-start -> work -> command:new -> bootstrap`
- `session-start -> work -> command:stop -> gateway:startup -> bootstrap`

断言：

- runtime state 连续
- 过期 active_task 不错误恢复
- pending commitments 保留

当前覆盖（2026-04-01）：

- `gateway startup hook emits a resume message for the latest active session`
- `managed bootstrap injects recovered continuity for an unfinished prior session`
- `real installed host hook wrapper returns resume guidance on gateway startup`
- `real OpenClaw runtime loads managed hooks and closes a session through the internal command stop hook`

### B2. governance 执行

场景：

- heartbeat 后触发治理
- session-close 后触发治理
- workspace-monitor 批量触发治理

断言：

- active live 集合不超过上限
- archive 增长
- governance report 正确

当前覆盖（2026-04-01）：

- `heartbeat runs storage governance and syncs active and archive mirrors`
- `session-close runs storage governance for project collections`
- `workspace monitor inherits storage governance through maintenance heartbeat`
- `storage governance persists governance runs into the workspace catalog`
- `status report summarizes user project session counts and governance`

### B3. archive-aware search

场景：

- active 有命中
- active 无命中但 archive 有命中
- active 和 archive 同时命中

断言：

- active 结果优先
- archive 结果带 tier 标记
- archive 不自动进入 bootstrap

当前覆盖（2026-04-01）：

- `memory-search retrieves persisted long-term memory on demand`
- `memory-search falls back to archive when active has no matching hits`
- `memory-search prefers active hits over archive hits for the same query`
- `archive content stays out of bootstrap while remaining retrievable on demand`

### B4. mirror 同步

场景：

- active 集合治理后 mirror 更新
- archive 集合治理后 mirror 更新
- mirror rebuild 后可重建 active + archive 索引

断言：

- SQLite 计数正确
- FTS 能命中 archive 项

当前覆盖（2026-04-01）：

- `heartbeat runs storage governance and syncs active and archive mirrors`
- `mirror-rebuild backfills archive collections into sqlite mirrors`
- `archive items are searchable through the sqlite mirror FTS path`

## C. 回归测试

必须长期保留：

1. reset 不续到 stale task
2. closed session 无 pending 不继承 active_task
3. unfinished continuation 仍能恢复
4. bootstrap 预算不破 10K
5. archive 数据不会进入 bootstrap 正文
6. upgrade + mirror rebuild 后旧数据仍可检索
7. status-report 在非 snapshot 模式下保持只读

## D. 迁移测试

### D1. 老数据升级

输入：

- 只有 JSON，无 SQLite
- 已有大量 session/project/user 资产

断言：

- mirror rebuild 完整回填
- 无数据丢失
- 不修改原始 JSON 语义

### D2. 重复迁移

多次运行：

- `mirror-rebuild`
- `upgrade-sessions --rebuild-mirror`

断言：

- 结果幂等
- 不重复插入 mirror 数据

### D3. 半迁移中断

场景：

- rebuild 执行中断
- 下一次重新执行

断言：

- 可恢复
- 不出现索引损坏

## E. 性能与规模测试

最少覆盖：

- 单 workspace 10k active + archive items
- 多 workspace 总计 100k items
- archive 命中检索延迟
- governance 单次执行耗时
- mirror rebuild 耗时

验收目标建议：

- bootstrap 构建耗时不显著上升
- `memory-search` 活跃集检索 < 100ms
- `memory-search` archive fallback 检索 < 300ms
- `mirror-rebuild` 对常规本地规模可在分钟级内完成

## F. 真实链路测试

保留并扩展 `openclaw-real.test.js`：

- one-click install + upgrade-sessions + rebuild mirror
- runtime stop/new/reset
- compact before/after
- workspace-monitor 周期治理
- real profile 下 archive-aware retrieval

## G. 手工验收

每次阶段性完成后，至少手工验证：

1. 连续工作 5~10 轮后 reset，提示状态与最新工作一致
2. 已完成的上一轮任务不会再次被当成未完成任务恢复
3. 长期 archive 数据不会出现在 MEMORY.md 正文里
4. 指定关键词仍能从 archive 里检索到旧经验
5. status-report 能看到 archive / governance 统计

## 验收标准

完成本方案至少要满足：

1. live 集合有硬边界
2. archive 可检索但不预载
3. runtime state 独立
4. SQLite 成为主索引层
5. 所有迁移可重复执行
6. 所有核心链路有测试覆盖

## 当前推荐执行顺序

下一步只做：

1. `runtime_state` 独立
2. `storage-governance.js`
3. archive-aware `memory-search`
4. 治理结果接入 `heartbeat/session-close/workspace-monitor`
5. status-report 加治理统计

完成前不做其他新功能。
