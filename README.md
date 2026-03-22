# Context Anchor

`context-anchor` 是一个给 OpenClaw 使用的记忆持久化 skill。它把 skill、本地运行时、hook 和宿主侧辅助配置组合起来，让 OpenClaw 具备：

- Session 状态持久化
- 项目级经验沉淀
- 上下文压力下的 checkpoint 和记忆同步
- 经验校验与技能化候选
- gateway 重启后的恢复提示

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

安装后会在 `~/.openclaw` 下落一份自包含快照，供 OpenClaw 加载和调用。

## 前置条件

- 已安装 Node.js
- 已有 OpenClaw 运行环境
- 允许在本地 `~/.openclaw` 目录写入配置、hook 和 automation 文件

可选：

- 如果你要在独立目录生成由经验沉淀出的新 skill，可提前规划 `CONTEXT_ANCHOR_SKILLS_ROOT`

## 快速安装

在当前仓根目录执行：

```bash
node scripts/install-host-assets.js
```

默认结果：

- 把当前 skill 的自包含快照安装到 `~/.openclaw/skills/context-anchor/`
- 更新 `~/.openclaw/config.json`
- 确保 `config.json.extraDirs` 包含 `~/.openclaw/skills`
- 写入 hook wrapper 到 `~/.openclaw/hooks/context-anchor-hook/`
- 写入 monitor wrapper 到 `~/.openclaw/automation/context-anchor/`

如果你要覆盖默认位置：

```bash
node scripts/install-host-assets.js <openclaw-home> <skills-root>
```

例如：

```bash
node scripts/install-host-assets.js "D:/openclaw-home" "D:/openclaw-home/skills"
```

## 安装后你应该看到什么

至少检查这几个路径：

- `~/.openclaw/config.json`
- `~/.openclaw/skills/context-anchor/SKILL.md`
- `~/.openclaw/skills/context-anchor/scripts/heartbeat.js`
- `~/.openclaw/hooks/context-anchor-hook/handler.js`
- `~/.openclaw/automation/context-anchor/context-pressure-monitor.js`

如果这些文件不存在，说明安装没有完成。

## OpenClaw 最小接入方式

### 1. skill 加载

安装脚本会把 `~/.openclaw/skills` 写进 `config.json.extraDirs`。  
这意味着 OpenClaw 之后应从该目录发现 `context-anchor`。

### 2. hook 接入

宿主应把以下事件接到安装后的 hook wrapper：

- `gateway:startup`
- `command:stop`
- `session:end`
- `heartbeat`

安装后可调用的入口是：

```bash
node ~/.openclaw/hooks/context-anchor-hook/handler.js <event-name> '<json-payload>'
```

如果你在 Windows PowerShell 下调用，推荐把 payload 先写到文件，再把文件路径传给 handler，避免 JSON 转义问题。

例如：

```powershell
$payload = @{
  workspace = 'D:/workspace/project'
  session_key = 'chat-session-001'
  project_id = 'default'
  usage_percent = 82
} | ConvertTo-Json

$payload | Set-Content .\context-anchor-payload.json
node $HOME\.openclaw\hooks\context-anchor-hook\handler.js heartbeat .\context-anchor-payload.json
```

payload 至少应包含：

```json
{
  "workspace": "D:/workspace/project",
  "session_key": "chat-session-001",
  "project_id": "default"
}
```

如果是 `heartbeat`，再补：

```json
{
  "usage_percent": 82
}
```

### 3. heartbeat / monitor 接入

本仓不自动注册操作系统定时任务。  
你需要让宿主或调度器定期调用：

```bash
node ~/.openclaw/automation/context-anchor/context-pressure-monitor.js <workspace> <snapshot-file>
```

或单 session 简化调用：

```bash
node ~/.openclaw/automation/context-anchor/context-pressure-monitor.js <workspace> <session-key> <usage-percent>
```

`snapshot-file` 格式示例：

```json
{
  "sessions": [
    {
      "session_key": "chat-session-001",
      "usage_percent": 78
    },
    {
      "session_key": "chat-session-002",
      "usage_percent": 91
    }
  ]
}
```

## 最小验证流程

安装完成后，建议按下面顺序做一次人工验证。

### 1. 验证 skill 已安装

检查：

- `~/.openclaw/skills/context-anchor/` 是否存在
- `~/.openclaw/config.json` 的 `extraDirs` 是否包含 `~/.openclaw/skills`

### 2. 验证 startup 恢复

先准备一个测试工作区，然后触发：

```bash
node ~/.openclaw/hooks/context-anchor-hook/handler.js gateway:startup "{\"workspace\":\"D:/workspace/project\"}"
```

预期：

- 如果最近没有活跃 session，返回 `idle`
- 如果有最近活跃 session，返回 `resume_available` 和 `resume_message`

### 3. 验证 heartbeat

```bash
node ~/.openclaw/hooks/context-anchor-hook/handler.js heartbeat "{\"workspace\":\"D:/workspace/project\",\"session_key\":\"chat-session-001\",\"project_id\":\"default\",\"usage_percent\":82}"
```

预期：

- 返回 `handled`
- 内部结果为 `heartbeat_ok`
- 工作区下出现 `.context-anchor/`

### 4. 验证 stop / session end

```bash
node ~/.openclaw/hooks/context-anchor-hook/handler.js command:stop "{\"workspace\":\"D:/workspace/project\",\"session_key\":\"chat-session-001\",\"project_id\":\"default\"}"
```

预期：

- `sessions/<session-key>/checkpoint.md` 被创建
- 热记忆会尝试同步到项目级

## 工作区中的运行时数据

`context-anchor` 把状态保存在当前任务工作区下：

```text
.context-anchor/
├── projects/
├── sessions/
└── index.json
```

这意味着：

- 记忆数据按 workspace 隔离
- 同一个 workspace 里的不同 session 会共享项目级记忆
- 换 workspace 不会自动继承旧项目记忆

## 常见操作

### 手动创建 checkpoint

```bash
node ~/.openclaw/skills/context-anchor/scripts/checkpoint-create.js <workspace> <session-key> manual
```

### 手动跑一次 heartbeat

```bash
node ~/.openclaw/skills/context-anchor/scripts/heartbeat.js <workspace> <session-key> <project-id> 80
```

### 手动记录一条项目经验

```bash
node ~/.openclaw/skills/context-anchor/scripts/memory-save.js <workspace> <session-key> project best_practice "use smaller diffs"
```

### 手动校验经验

```bash
node ~/.openclaw/skills/context-anchor/scripts/experience-validate.js <workspace> <experience-id> validated <project-id> "reviewed manually"
```

### 从经验生成 skill

```bash
node ~/.openclaw/skills/context-anchor/scripts/skill-create.js <workspace> <experience-id> <skill-name> <project-id>
```

## 重要边界

- 操作系统层面的 cron / Task Scheduler 需要你自己注册
- `usage_percent` 需要宿主提供，`context-anchor` 不负责计算
- global scope 当前只存 `user_preferences` 和 `important_facts`
- global 条目当前不参与 heat、validation、skillification

## 故障排查

### OpenClaw 没有发现 skill

检查：

- `~/.openclaw/config.json.extraDirs`
- `~/.openclaw/skills/context-anchor/SKILL.md`

### hook 调用失败

检查：

- `~/.openclaw/hooks/context-anchor-hook/handler.js` 是否存在
- payload 是否包含 `workspace`
- JSON 字符串是否是合法 JSON

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

- session 恢复
- checkpoint 与压力处理
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
