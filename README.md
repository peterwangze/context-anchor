# Context Anchor

`context-anchor` 是一个给 OpenClaw 使用的记忆持久化 skill。它把 skill、本地运行时、hook 和宿主侧辅助配置组合起来，让 OpenClaw 具备：

- 用户级 / 项目级 / Session级 三层记忆加载
- Session 状态持久化
- 项目级经验沉淀
- 上下文压力下的 checkpoint、`compact-packet` 和记忆同步
- Session 结束前的自动总结、经验提炼和技能草稿沉淀
- 满足条件的项目级 / 用户级经验自动晋升为 active skill
- 经验校验与技能化候选
- gateway 重启后的恢复提示
- 同名技能的作用域优先级和停用治理

如果你是第一次接入，先看这份 `README`。  
`SKILL.md` 更偏运行规范和行为定义。

## 适用场景

- 你希望 OpenClaw 在长任务中跨压缩、跨重启保留上下文连续性。
- 你希望把会话中的经验沉淀到项目级记忆，而不是只留在当前窗口。
- 你希望宿主通过 hook 或定时调用，把 checkpoint、heartbeat、恢复提示接起来。

## 交付形态

这个项目不是只有一个 `SKILL.md`。

实际交付是：

- skill：`SKILL.md`
- 运行时脚本：`scripts/`
- hook 处理器：`hooks/context-anchor-hook/`
- 宿主安装脚本：`scripts/install-host-assets.js`

安装后会在 `<openclaw-home>` 下落一份自包含快照，供 OpenClaw 加载和调用。

## 分层模型

第一阶段已经落地的作用域：

- `session`：当前会话的工作记忆、会话经验、技能草稿
- `project`：当前 workspace 的长期决策、项目经验、项目技能索引
- `user`：跨项目偏好、用户级记忆、用户级经验、用户级技能索引

默认：

- `user_id` 默认值是 `default-user`
- `project_id = workspace basename`，如果显式传入则优先显式值

## 前置条件

- 已安装 Node.js
- 已有 OpenClaw 运行环境
- 允许在本地 OpenClaw 目录写入配置、hook 和 automation 文件

可选：

- 如果你要在独立目录生成由经验沉淀出的新 skill，可提前规划 `CONTEXT_ANCHOR_SKILLS_ROOT`

## 路径说明

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

## 快速安装

在当前仓根目录执行：

```bash
node scripts/install-one-click.js
```

或：

```bash
npm run install:host
```

这是推荐入口，适合零基础用户。你只需要按提示回答 `Y/N`，不需要自己理解 hook 命令、`config.json` 结构或定时任务参数。

安装器会按顺序询问：

- 是否保留旧记忆并重装
- 是否把推荐的 `hooks` 和 `automation` 写入当前 `<openclaw-home>/config.json`
- 默认用户名是什么
- 默认 workspace 是什么
- 是否继续添加新的用户或 workspace
- 是否为某个 workspace 启用后台巡检任务
- 如果启用巡检，选择 `Windows` / `macOS` / `Linux`

默认结果：

- 把当前 skill 的自包含快照安装到固定目录 `<installed-skill-dir>`
- 更新 `<openclaw-home>/config.json.extraDirs`
- 写入 hook wrapper 到 `<openclaw-home>/hooks/context-anchor-hook/`
- 写入 monitor wrapper 到 `<openclaw-home>/automation/context-anchor/`
- 如果你同意修改配置，再自动补上推荐的 `hooks` 和 `automation.context-anchor-workspace-monitor`
- 写入 `<openclaw-home>/context-anchor-host-config.json`，登记默认用户、默认 workspace、附加用户、附加 workspace
- 后续 session 会按 `workspace -> user/project` 默认归属自动落到登记表里
- 如果你同意启用后台巡检，再为指定 workspace 生成对应平台的调度配置
- Windows：生成 launcher 并注册 Task Scheduler
- macOS：生成 launcher 和 `launchd plist`，并在本机尝试加载
- Linux：生成 launcher、`systemd --user service/timer`，并在本机尝试启用

这里的安装目录名始终是 `context-anchor`，不受你本地源码目录名影响。

## 一键配置

如果你已经安装过，只想重新跑配置，不想重装：

```bash
npm run configure:host
```

或：

```bash
node scripts/configure-host.js
```

这个配置向导会继续使用同样的交互方式：

- 是否覆盖写入推荐配置
- 默认用户名
- 默认 workspace
- 是否继续添加新的用户或 workspace
- 是否启用后台巡检
- 如果启用巡检，选择目标平台
- 如果启用巡检，要监控哪个 workspace

## 常用无交互命令

仅安装并自动写入推荐配置：

```bash
node scripts/install-one-click.js --yes --apply-config --default-user "alice" --default-workspace "D:/workspace/main"
```

安装并同时为某个 workspace 启用后台巡检：

```bash
node scripts/install-one-click.js --yes --apply-config --enable-scheduler --target-platform windows --workspace "D:/workspace/project" --interval-minutes 5
```

安装后单独重跑配置：

```bash
node scripts/configure-host.js --apply-config --default-user "alice" --default-workspace "D:/workspace/main"
```

仅补启一个后台巡检任务：

```bash
node scripts/configure-host.js --enable-scheduler --target-platform macos --workspace "/Users/me/workspace/project"
```

Linux 示例：

```bash
node scripts/configure-host.js --enable-scheduler --target-platform linux --workspace "/home/me/workspace/project"
```

如果你要直接补登记一个新用户和一个新 workspace：

```bash
node scripts/configure-host.js --yes --default-user "alice" --add-user "bob" --add-workspace "D:/workspace/client-b|bob|client-b"
```

如果你要覆盖默认位置：

```bash
node scripts/install-one-click.js --openclaw-home "<openclaw-home>" --skills-root "<skills-root>"
```

如果你明确知道要自动保留旧记忆并直接重装：

```bash
node scripts/install-one-click.js --yes --keep-memory --apply-config
```

如果你明确知道要清空旧记忆再重装：

```bash
node scripts/install-one-click.js --yes --drop-memory --apply-config
```

## 安装后你应该看到什么

至少检查这几个路径：

- `<openclaw-home>/config.json`
- `<installed-skill-dir>/README.md`
- `<installed-skill-dir>/SKILL.md`
- `<installed-skill-dir>/scripts/heartbeat.js`
- `<openclaw-home>/hooks/context-anchor-hook/handler.js`
- `<openclaw-home>/automation/context-anchor/context-pressure-monitor.js`
- `<openclaw-home>/automation/context-anchor/workspace-monitor.js`

如果这些文件不存在，说明安装没有完成。

## 安装后先做什么

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

## 高级手动接入

如果你明确不想让安装器改配置，仍然可以手工接入。推荐最小配置如下：

```json
{
  "extraDirs": [
    "<skills-root>"
  ],
  "hooks": {
    "gateway:startup": "\"<node-exec>\" \"<openclaw-home>/hooks/context-anchor-hook/handler.js\" gateway:startup <payload-file-or-json>",
    "command:stop": "\"<node-exec>\" \"<openclaw-home>/hooks/context-anchor-hook/handler.js\" command:stop <payload-file-or-json>",
    "session:end": "\"<node-exec>\" \"<openclaw-home>/hooks/context-anchor-hook/handler.js\" session:end <payload-file-or-json>",
    "heartbeat": "\"<node-exec>\" \"<openclaw-home>/hooks/context-anchor-hook/handler.js\" heartbeat <payload-file-or-json>"
  },
  "automation": {
    "context-anchor-workspace-monitor": "\"<node-exec>\" \"<openclaw-home>/automation/context-anchor/workspace-monitor.js\" <workspace>"
  }
}
```

高级手动入口保留如下：

- hook wrapper：`node "<openclaw-home>/hooks/context-anchor-hook/handler.js" <event-name> <payload-file-or-json>`
- workspace 巡检：`node "<openclaw-home>/automation/context-anchor/workspace-monitor.js" "<workspace>"`
- 压力快照 monitor：`node "<openclaw-home>/automation/context-anchor/context-pressure-monitor.js" "<workspace>" "<snapshot-file>"`

如果你是第一次接这类 hook 或 JSON payload，推荐继续使用安装器自动写配置，不要手抄这些命令。

## 最小验证流程

安装完成后，建议按下面顺序做一次人工验证。

### 1. 验证 skill 已安装

检查：

- `<installed-skill-dir>/` 是否存在
- `<openclaw-home>/config.json` 的 `extraDirs` 是否包含 `<skills-root>`
- `node scripts/doctor.js` 输出中的 `installation.ready` 是否为 `true`
- 如果你选择了自动写配置，再确认 `configuration.ready` 是否为 `true`

### 2. 验证 startup 恢复

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

- 如果最近没有活跃 session，返回 `idle`
- 如果有最近活跃 session，返回 `resume_available` 和 `resume_message`

### 3. 验证 heartbeat

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

### 4. 验证 stop / session end

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

## 工作区中的运行时数据

`context-anchor` 把状态保存在当前任务工作区下：

```text
.context-anchor/
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
```

## 自动生命周期

### Session Start

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

### 上下文压力

达到压力阈值时，会自动：

- 创建 checkpoint
- 生成 `compact-packet.json`
- 同步高热记忆到项目级

### Session End / Command Stop

退出前会统一执行：

- checkpoint
- `compact-packet.json`
- session memory 保存
- `session-summary.json`
- session experience 提炼
- `session skill draft` 生成
- project heat / skillification 刷新
- 满足条件的 `project/user active skill` 晋升

### 技能治理

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

## 观测与诊断

### 统一状态报告

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
- governance 统计：`active / shadowed / superseded / budgeted_out`
- session 最近一次 summary 摘要
- health warnings
- 当前激活预算影响下的治理结果
- 可选的 `snapshot_file`

### 单条 skill 诊断

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

## 常见操作

### 手动创建 checkpoint

```bash
node "<installed-skill-dir>/scripts/checkpoint-create.js" "<workspace>" "<session-key>" manual
```

### 手动跑一次 heartbeat

```bash
node "<installed-skill-dir>/scripts/heartbeat.js" "<workspace>" "<session-key>" "<project-id>" 80
```

### 手动生成 compact packet

```bash
node "<installed-skill-dir>/scripts/compact-packet-create.js" "<workspace>" "<session-key>" manual 80
```

### 手动执行 session close

```bash
node "<installed-skill-dir>/scripts/session-close.js" "<workspace>" "<session-key>" session-end 80 "<project-id>"
```

### 手动记录一条项目经验

```bash
node "<installed-skill-dir>/scripts/memory-save.js" "<workspace>" "<session-key>" project best_practice "use smaller diffs"
```

### 手动记录一条用户级记忆/经验

```bash
node "<installed-skill-dir>/scripts/memory-save.js" "<workspace>" "<session-key>" user best_practice "keep responses concise"
```

### 从旧 `_global` 迁移到 user

```bash
node "<installed-skill-dir>/scripts/migrate-global-to-user.js" "<workspace>" default-user
```

### 手动校验经验

```bash
node "<installed-skill-dir>/scripts/experience-validate.js" "<workspace>" <experience-id> validated "<project-id>" "reviewed manually"
```

### 从经验生成 skill

```bash
node "<installed-skill-dir>/scripts/skill-create.js" "<workspace>" <experience-id> <skill-name> "<project-id>"
```

`skill-name` 会直接作为目录名使用。

- 必须是单个目录名
- 不能包含 `/`、`\` 或 `..`
- 建议只使用便于跨平台落盘的名称

## 重要边界

- Windows / macOS / Linux 都可以通过配置向导生成对应调度配置；如果自动注册失败，脚本会保留生成好的文件供你手工接管
- `usage_percent` 需要宿主提供，`context-anchor` 不负责计算
- 未配置时默认用户仍是 `default-user`；现在可以通过一键配置额外登记多个用户和 workspace 归属
- 旧 `projects/_global` 仍兼容读取，但新的长期用户数据应写入 `user` 层
- `session skill draft` 已实现
- `project/user active skill` 已支持自动晋升、自动回收/回流、归档与 evidence 追踪

## 故障排查

### OpenClaw 没有发现 skill

检查：

- `<openclaw-home>/config.json.extraDirs`
- `<installed-skill-dir>/SKILL.md`
- `node scripts/doctor.js` 的 `installation` 字段

### hook 调用失败

检查：

- `<openclaw-home>/hooks/context-anchor-hook/handler.js` 是否存在
- payload 是否包含 `workspace`
- 如果手工传 JSON 字符串失败，先改成 payload 文件方式

### heartbeat 没有触发 checkpoint

检查：

- `usage_percent` 是否达到阈值
- 传入的 `session_key` 是否和当前 session 一致
- 工作区下是否有 `.context-anchor/sessions/<session-key>/`

### 经验没有进入技能化候选

检查：

- `validation.status` 是否为 `validated`
- 是否满足最少 7 天
- `access_count` 是否足够
- `access_sessions.length` 是否足够

## 开发验证

仓内自动化验证：

```bash
npm test
```

当前测试覆盖：

- user/project/session 三层加载
- session 恢复
- checkpoint 与压力处理
- compact packet
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

## 文档分工

- `README.md`：给 OpenClaw 使用者的安装和接入说明
- `SKILL.md`：skill 的运行行为规范
- `hooks/context-anchor-hook/HOOK.md`：hook 协议说明
- `references/`：状态模型和机制参考
