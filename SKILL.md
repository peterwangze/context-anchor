---
name: context-anchor
description: Session memory persistence, experience validation, and skillification runtime for OpenClaw
triggers:
  - on_session_start
  - on_heartbeat
  - on_memory_save
  - on_context_pressure
---

# Context Anchor

`context-anchor` 用于把 OpenClaw 的用户级、项目级、会话级记忆，连同上下文压力处理、经验校验和技能沉淀接成一条闭环。

OpenClaw 的安装、接入、验证和排错请先看 [README.md](README.md)。  
本文件主要描述 skill 的运行边界、状态模型和行为约束。

## 目标

- 让 `session / project / user` 三层状态都可持续存在并按优先级加载。
- 让项目级和用户级经验在复用时自动升温、计数、校验。
- 让可复用经验在通过校验后进入技能化候选，并在确认后生成新 skill。
- 让宿主侧可以通过 hook 和 monitor wrapper 接入启动恢复、压缩前保存、停止落盘和定时压力检查。

## 当前实现边界

已实现：

- `.context-anchor/` 多 Session / 项目级存储
- `~/.openclaw/context-anchor/users/default-user/` 用户级存储
- `session-start` 的恢复式启动
- checkpoint、compact packet 与上下文压力处理
- session 热记忆向项目记忆的同步
- session close 总结、session experience 提炼与 session skill draft
- validated experience -> `project/user active skill` 基础自动晋升
- heat 评估与 archive 标记
- 经验自动校验与技能化评分
- skill 创建脚本
- hook handler 与 host 安装脚本
- 旧格式 `MEMORY.md` / `memory/` 迁移
- 自动化测试

不在本仓直接完成的事：

- 操作系统层面的 cron / Task Scheduler 注册
- 宿主如何提供 `usage_percent`

本仓提供了 monitor wrapper 和安装脚本，宿主只需要把调度接到这些入口上。

## 目录结构

```text
context-anchor/
├── hooks/context-anchor-hook/        # 仓内 hook handler
├── references/                       # 机制说明和状态模板
├── scripts/                          # 所有运行入口
├── scripts/lib/context-anchor.js     # 共享状态层
├── templates/                        # checkpoint 模板
└── tests/                            # 内建 smoke/integration tests
```

运行时状态目录：

```text
~/.openclaw/context-anchor/
└── users/
    └── default-user/
        ├── state.json
        ├── memories.json
        ├── experiences.json
        ├── skills/index.json
        └── heat-index.json

.context-anchor/
├── projects/
│   ├── {project-id}/
│   │   ├── state.json
│   │   ├── decisions.json
│   │   ├── experiences.json
│   │   ├── facts.json
│   │   ├── heat-index.json
│   │   └── skills/index.json
│   └── _global/
│       └── state.json
├── sessions/
│   ├── {session-key}/
│   │   ├── state.json
│   │   ├── memory-hot.json
│   │   ├── experiences.json
│   │   ├── skills/index.json
│   │   ├── checkpoint.md
│   │   ├── compact-packet.json
│   │   └── session-summary.json
│   └── _index.json
└── index.json
```

## 核心流程

### 1. Session Start

入口：`node scripts/session-start.js <workspace> <session-key> [project-id]`

行为：

1. 初始化 `.context-anchor/` 目录结构。
2. 如果 session 已存在，保留既有 `active_task`、`commitments` 和 checkpoint，不再覆盖。
3. 加载项目级高热度决策、经验和项目技能。
4. 加载用户级偏好、记忆、经验和用户技能。
5. 生成 `boot_packet` 和激活技能摘要。
6. 把本次“读取到项目/用户记忆”的行为写回 `access_count` / `access_sessions` / `heat`。
7. 检查旧格式记忆文件，必要时提示迁移。

### 2. Memory Save / Memory Flow

入口：

- `node scripts/memory-save.js <workspace> <session-key> <scope> <type> <content> [metadata-json]`
- `node scripts/memory-flow.js <workspace> <session-key> [minimum-heat]`

规则：

- session 级内容先进入 `sessions/{key}/memory-hot.json`
- 高热度且可复用的条目会被 `memory-flow` 同步到项目级；已同步条目后续发生内容变化时会 upsert 更新原项目条目
- 经验条目会带上 `validation`、`access_count`、`access_sessions`
- project 保存会同步更新 `heat-index` 和 `project state`
- user 保存写入 `~/.openclaw/context-anchor/users/default-user/`，并维护用户级 `heat-index`

### 3. Heartbeat / 上下文压力

入口：

- `node scripts/heartbeat.js <workspace> <session-key> [project-id] [usage-percent]`
- `node scripts/context-pressure.js [usage-percent]`
- `node scripts/context-pressure-handle.js <workspace> <session-key> <usage-percent>`
- `node scripts/context-pressure-monitor.js <workspace> <snapshot-file|session-key> [usage-percent]`

阈值：

- `>= 75%`：创建 checkpoint、`compact-packet.json`，并同步高热记忆
- `>= 85%`：额外提示 `/compact`
- `>= 90%`：进入 emergency 提醒

`heartbeat.js` 会串联：

1. `memory-flow`
2. `heat-eval`
3. `skillification-score`
4. 可选的 `context-pressure-handle`

### 4. 经验校验与技能化

经验来源：

- `error-capture.js`
- `memory-save.js` 保存的 `lesson / best_practice / tool-pattern / gotcha / feature_request`
- session 热记忆同步到项目级时形成的经验
- session close 从当前 session memory 提炼出的会话经验

校验状态：

- `pending`
- `validated`
- `rejected`

自动校验条件：

- 创建时间至少 7 天
- `access_count >= 3`
- `access_sessions.length >= 2`

技能化评分仍然基于四个维度：

- 时间
- 频率
- 跨 Session
- 热度

但只有 `validation.status === validated` 的经验才会进入技能化候选。

相关脚本：

- `node scripts/experience-validate.js <workspace> <experience-id> <status> [project-id] [note]`
- `node scripts/skillification-score.js <workspace> [project-id]`
- `node scripts/skill-create.js <workspace> <experience-id> <skill-name> [project-id]`

`skill-create.js` 默认要求经验已校验；若明确强制，可通过 `CONTEXT_ANCHOR_FORCE_SKILL_CREATE=1` 放开。

第一阶段新增：

- `session skill draft` 会在 `session-close` 时自动生成
- 满足门槛的 validated experience 会自动晋升为 `project/user active skill`
- 更复杂的晋升治理后续继续演进

生成 skill 的目标目录默认为当前 skill 仓的上级目录，可通过 `CONTEXT_ANCHOR_SKILLS_ROOT` 覆盖。

### 5. Hook 与宿主接入

仓内 hook：

- `hooks/context-anchor-hook/HOOK.md`
- `hooks/context-anchor-hook/handler.js`

支持事件：

- `gateway:startup`
- `command:stop`
- `session:end`
- `heartbeat`

行为：

- `gateway:startup`：找最近活跃 session，返回恢复消息
- `command:stop`：执行统一的 `session-close` 生命周期
- `session:end`：执行统一的 `session-close` 生命周期
- `heartbeat`：执行 heartbeat 总流程

安装脚本：

```bash
node scripts/install-host-assets.js [openclaw-home] [skills-root]
```

作用：

- 默认把当前 skill 的自包含快照部署到 `~/.openclaw/skills/context-anchor/`
- 向 `~/.openclaw/config.json` 追加 `extraDirs`，默认注册 `~/.openclaw/skills`
- 写入 hook wrapper 到 `~/.openclaw/hooks/context-anchor-hook/`
- 写入压力监控 wrapper 到 `~/.openclaw/automation/context-anchor/`

wrapper 会指向安装后的 skill 快照，不再依赖当前源码仓继续存在。

## 环境变量

- `OPENCLAW_HOME`：覆盖默认 `~/.openclaw`
- `CONTEXT_ANCHOR_SKILLS_ROOT`：覆盖 skill 生成根目录
- `CONTEXT_ANCHOR_FORCE_SKILL_CREATE=1`：允许未校验经验强制技能化
- `CONTEXT_ANCHOR_GIT_INIT=1`：创建 skill 后初始化 git 仓库

## User Scope

当前实现里，`global` 已进入兼容层，主模型改为 `user`：

- `user_id` 第一阶段固定为 `default-user`
- 用户级数据写入 `~/.openclaw/context-anchor/users/default-user/`
- 旧 `projects/_global` 仍兼容读取，并可通过迁移脚本导入到 `user`

## 可靠性约束

- 不覆盖已有 session state
- 重要状态变化后写回 heat-index 和 project state
- 经验进入技能化前必须通过校验或显式强制
- session 压力处理只做保存、同步和提示，不隐式删除用户状态
- 高价值记忆默认追加或 archive，不做静默删除
- 已同步的 session 热记忆再次变化时会 upsert 更新原项目条目
- `command:stop` 和 `session:end` 都会走统一的 `session-close` 闭环
- `heartbeat` 和 `session-close` 都会触发 scoped skill promotion

## 验证

```bash
npm test
```

当前测试覆盖：

- session 恢复不丢状态
- 压力处理能创建 checkpoint、compact packet 并同步记忆
- 三层 user/project/session 资产加载
- session close 与 session skill draft
- `_global -> user` 迁移
- validated experience -> `project/user active skill`
- 经验会先校验再技能化
- skill 创建落到目标技能目录
- startup hook 会产出恢复消息
- host 安装脚本会写 wrapper 和 `extraDirs`
