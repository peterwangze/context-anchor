---
name: context-anchor
description: Session memory persistence system with layered architecture
---

# Context Anchor

Session 记忆永续系统。通过分层记忆架构和热度流动机制，确保主 agent 的记忆永续，支持**多 Session 多 Project 并行**，支持切换模型、退出会话后保持记忆连续性。

## 设计哲学

**类人，但超人。**

- 类人：模拟人类记忆的分层结构（感官 → 工作记忆 → 长期记忆）
- 超人：数据可流动、可检索、可持久化、可恢复、可跨 Session 共享

---

## 核心架构

### 多 Session 多 Project 支持

```
.context-anchor/
├── projects/
│   ├── {project-id}/
│   │   ├── state.json           # 项目级状态
│   │   ├── decisions.json       # 决策库
│   │   ├── experiences.json     # 经验库
│   │   └── heat-index.json      # 项目级热度索引
│   └── _global/
│       └── state.json           # 全局状态
├── sessions/
│   ├── {session-key}/
│   │   ├── state.json           # 会话状态
│   │   ├── checkpoint.md        # 检查点
│   │   └── memory-hot.json      # 工作记忆快照
│   └── _index.json              # 会话索引
└── index.json                   # 全局索引
```

### 记忆层级

| 层级 | 类比 | 存储 | 热度范围 | 作用域 |
|------|------|------|----------|--------|
| RAM | 工作记忆 | 当前上下文 | 80-100 | 当前 Session |
| Cache | 短期记忆 | `sessions/{session-key}/memory-hot.json` | 50-79 | 当前 Session |
| Disk | 长期记忆 | `projects/{project-id}/` | 0-49 | 项目级共享 |
| Global | 全局记忆 | `projects/_global/` | - | 跨项目共享 |

### 热度机制

- **初始热度**：新记忆 = 100（RAM）
- **时间衰减**：每小时 -1 热度
- **访问增强**：每次访问 +5 热度
- **跨 Session 增强**：被其他 Session 访问 +10 热度
- **流动触发**：
  - 热度 > 80 → 晋升提醒
  - 热度 < 50 → 降级到 Cache
  - 热度 < 30 → 降级到 Disk

---

## 触发场景与执行流程

### 1. Session Start（会话开始）

**触发条件：** 新会话开始时

**执行流程：**
```
1. 识别 Session 和 Project
   - 从 inbound_meta 获取 session_key 和 chat_id
   - 确定 project_id（默认为 "default"）

2. 初始化 Session 状态
   - 创建 .context-anchor/sessions/{session-key}/
   - 初始化 state.json

3. 加载项目级记忆
   - 读取 projects/{project-id}/state.json
   - 加载高热度决策和经验
   - 加载未完成任务

4. 加载全局记忆
   - 读取 projects/_global/state.json
   - 加载用户偏好和重要信息

5. 注入上下文
   - 项目级记忆摘要
   - 全局偏好
   - 相关历史 Session 信息

6. 更新会话索引
   - 记录 session 启动时间
   - 关联 project_id
```

**注入格式：**
```markdown
## 📌 Session Memory Loaded

**Project:** {project-id}
**Session:** {session-key}

**项目记忆：**
- [决策] xxx (heat: 85)
- [经验] xxx (heat: 72)

**全局偏好：**
- 用户偏好 xxx

**相关历史：**
- 上次会话: {session-key} ({date})
```

### 2. Heartbeat（定期检查）

**触发条件：** 收到 heartbeat poll（每 30 分钟）

**执行流程：**
```
1. 识别当前 Session 和 Project

2. 评估项目级记忆热度
   - 读取 projects/{project-id}/heat-index.json
   - 计算时间衰减
   - 检测跨 Session 访问

3. 检查上下文压力
   - 使用 session_status 获取上下文使用率
   - > 75%：触发记忆保存
   - > 85%：建议用户执行 /compact

4. 执行记忆流动
   - 热度 > 80 且在 Disk → 晋升提醒
   - 热度 < 50 且在 Cache → 标记待降级
   - 热度 < 30 且在 Cache → 降级到 Disk

5. 检查未完成承诺
   - 读取 sessions/{session-key}/state.json 中的 commitments
   - 超时承诺 → 提醒用户

6. 同步到项目级
   - 将高价值记忆同步到 projects/{project-id}/
   - 更新项目级热度索引

7. 正常输出：HEARTBEAT_OK
```

### 3. Memory Save（记忆保存）

**触发条件：**
- 上下文压力 > 75%
- 用户请求保存
- 重要决策/发现时
- Session 结束前

**执行流程：**
```
1. 识别记忆作用域
   - session-only: 仅当前会话
   - project-level: 项目级共享
   - global: 跨项目共享

2. 写入对应位置
   - session-only → sessions/{session-key}/memory-hot.json
   - project-level → projects/{project-id}/decisions.json 或 experiences.json
   - global → projects/_global/state.json

3. 更新热度索引
   - 记录访问时间
   - 设置初始热度

4. 触发自我提升检查
   - 是否有错误需要记录？
   - 是否有经验需要沉淀？
   - 是否需要更新 self-improvement？
```

### 4. Memory Flow（记忆流动）

**触发条件：** Heartbeat 检测到热度变化

**执行流程：**
```
Session → Project（共享）：
1. 检测 session 中的高价值记忆（heat > 80, 跨 session 有用）
2. 提炼压缩内容
3. 写入 projects/{project-id}/
4. 更新项目级热度索引
5. 保留 session 引用

Project → Global（全局）：
1. 检测项目中的高价值记忆（heat > 90, 跨项目有用）
2. 提炼压缩内容
3. 写入 projects/_global/
4. 更新全局索引

Project → Session（加载）：
1. 用户检索或访问项目记忆
2. 热度 +10
3. 复制到 session 工作记忆
```

---

## 自我提升闭环

### 错误检测与记录

**触发条件：**
- 命令执行失败
- 用户纠正（"不对"、"错了"）
- API 调用失败

**执行流程：**
```
1. 记录错误到 sessions/{session-key}/errors.json
2. 分析错误原因
3. 如果是可复用教训 → 同步到 projects/{project-id}/experiences.json
4. 如果是系统性问题 → 同步到 projects/_global/
5. 触发 self-improvement 技能（如果可用）
```

### 经验沉淀

**触发条件：**
- 发现更好的方法
- 解决了复杂问题
- 用户表扬

**执行流程：**
```
1. 记录经验到 sessions/{session-key}/experiences.json
2. 提炼可复用模式
3. 如果通用性强 → 同步到 projects/{project-id}/experiences.json
4. 如果跨项目有用 → 同步到 projects/_global/
```

### 持续改进

**每次 Heartbeat 检查：**
```
1. 回顾本次会话的工具使用
2. 发现高效用法 → 记录为 tool-pattern
3. 发现低效操作 → 记录为改进点
4. 更新 self-improvement 技能
```

---

## 状态文件格式

### sessions/{session-key}/state.json

```json
{
  "session_key": "feishu:direct:ou_xxx",
  "project_id": "default",
  "started_at": "YYYY-MM-DDTHH:MM:SS+08:00",
  "last_active": "YYYY-MM-DDTHH:MM:SS+08:00",
  "commitments": [
    {
      "id": "commit-001",
      "what": "承诺内容",
      "when": "YYYY-MM-DDTHH:MM:SS+08:00",
      "status": "pending"
    }
  ],
  "active_task": "当前任务描述",
  "errors_count": 0,
  "experiences_count": 0
}
```

### projects/{project-id}/state.json

```json
{
  "project_id": "default",
  "name": "项目名称",
  "created_at": "YYYY-MM-DDTHH:MM:SS+08:00",
  "last_updated": "YYYY-MM-DDTHH:MM:SS+08:00",
  "sessions_count": 10,
  "key_decisions": ["dec-001", "dec-002"],
  "key_experiences": ["exp-001"],
  "user_preferences": {
    "preference_key": "preference_value"
  }
}
```

### projects/{project-id}/decisions.json

```json
{
  "decisions": [
    {
      "id": "dec-001",
      "decision": "决策内容",
      "rationale": "决策理由",
      "session_key": "feishu:direct:ou_xxx",
      "created_at": "YYYY-MM-DDTHH:MM:SS+08:00",
      "heat": 60,
      "access_sessions": ["session-A", "session-B"],
      "tags": ["architecture", "important"]
    }
  ]
}
```

### projects/{project-id}/experiences.json

```json
{
  "experiences": [
    {
      "id": "exp-001",
      "type": "lesson|best_practice|gotcha|tool-pattern",
      "summary": "经验摘要",
      "details": "详细说明",
      "solution": "解决方案",
      "session_key": "feishu:direct:ou_xxx",
      "created_at": "YYYY-MM-DDTHH:MM:SS+08:00",
      "heat": 45,
      "applied_count": 3,
      "tags": ["bug", "config"]
    }
  ]
}
```

### projects/{project-id}/heat-index.json

```json
{
  "project_id": "default",
  "last_updated": "YYYY-MM-DDTHH:MM:SS+08:00",
  "entries": [
    {
      "id": "dec-001",
      "type": "decision",
      "heat": 85,
      "last_accessed": "YYYY-MM-DDTHH:MM:SS+08:00",
      "access_count": 5,
      "access_sessions": ["session-A", "session-B"]
    }
  ]
}
```

---

## 错误捕获与学习记录（整合 self-improvement）

### 自动触发条件

| 触发条件 | 记录类型 | 初始热度 | 说明 |
|----------|----------|----------|------|
| 命令执行失败（退出码 != 0） | lesson | 60 | 自动捕获 |
| 用户纠正（"不对"、"错了"、"Actually..."） | lesson | 70 | 高优先级 |
| API 调用失败 | lesson | 60 | 自动捕获 |
| 发现更好的方法 | best_practice | 50 | 主动记录 |
| 用户表扬 | best_practice | 60 | 正向反馈 |
| 功能请求 | feature_request | 40 | 用户需求 |

### 错误记录流程

```
1. 检测到错误
2. 记录到 experiences.json：
   {
     "type": "lesson",
     "summary": "错误摘要",
     "details": "详细说明",
     "solution": "解决方案（如有）",
     "error_context": {
       "command": "执行的命令",
       "exit_code": 1,
       "output": "错误输出"
     }
   }
3. 设置初始热度
4. 触发技能化检查（Heartbeat）
```

### 学习记录流程

```
1. 发现最佳实践或用户表扬
2. 记录到 experiences.json：
   {
     "type": "best_practice",
     "summary": "实践摘要",
     "details": "详细说明",
     "applied_count": 0
   }
3. 设置初始热度
```

### 功能请求记录

```
1. 用户请求不存在的功能
2. 记录到 experiences.json：
   {
     "type": "feature_request",
     "summary": "功能描述",
     "status": "pending"
   }
```

---

## 兼容性支持（整合 openclaw-mem）

### 双格式支持

context-anchor 同时支持两种格式：

| 格式 | 位置 | 说明 |
|------|------|------|
| **新格式** | `.context-anchor/` | 推荐，支持多 Session 多 Project |
| **旧格式** | `MEMORY.md`, `memory/` | 兼容 openclaw-mem |

### 迁移检测

Session Start 时检查旧格式文件：

```
1. 检查 MEMORY.md 是否存在
2. 检查 memory/ 目录是否存在
3. 如果存在，输出提示：
   "检测到旧格式记忆文件：
    - MEMORY.md
    - memory/YYYY-MM-DD.md
    建议迁移到 .context-anchor/ 格式以获得更好的多 Session 支持。
    是否执行迁移？"
```

### 迁移脚本

执行 `scripts/migrate-memory.js` 将旧格式迁移到新格式：

```
1. 读取 MEMORY.md 条目 → projects/{project-id}/decisions.json
2. 读取 memory/YYYY-MM-DD.md → projects/{project-id}/experiences.json
3. 保留原文件（不删除）
4. 记录迁移日志
```

---

## 经验技能化机制

### 核心理念

```
经验（数据）→ 时间验证 → 提炼 → 技能（能力）→ 持续成长
```

### 技能化评分

**评分公式：**
```
技能化评分 = 时间权重(0.3) + 频率权重(0.3) + 跨Session权重(0.2) + 热度权重(0.2)

其中：
- 时间权重 = min(days_since_created / 30, 1)
- 频率权重 = min(access_count / 10, 1)
- 跨Session权重 = min(access_sessions.length / 5, 1)
- 热度权重 = heat / 100

评分 >= 0.7 且创建 >= 7天 → 建议技能化
```

### Heartbeat 检查

```
1. 执行 skillification-score.js 计算评分
2. 识别高评分经验
3. 输出建议：
   "发现可技能化的经验：
    - 经验：{summary}
    - 评分：{score}
    - 建议技能名：{suggested_name}
    是否创建技能？"
```

### 技能创建流程

```
用户确认后：
1. 执行 skill-create.js 创建技能
2. 在 openclaw_project/openclaw/{skill-name}/ 创建目录
3. 生成 SKILL.md（从经验提炼）
4. 初始化 git 仓库
5. 通过 extraDirs 自动加载
```

### 强制技能化

用户可以跳过时间验证，直接请求：
```
"把 xxx 经验转化成技能"
```

### 技能创建后

- 原经验保留，标记 `skill_name` 关联
- 不再参与技能化评分
- 技能自动加载到 available_skills

---

## 工具使用原则（核心行为准则）

### 0. 安全检查（最高优先级）

**使用任何外部技能/工具前必须检查：**

```
1. 来源验证
   - 是否来自官方/可信来源？
   - ClawHub 技能是否有社区验证？
   - 本地技能是否经过审查？

2. 权限评估
   - 技能需要什么权限？
   - 是否涉及敏感操作？
   - 是否有权限隔离？

3. 风险评估
   - 操作是否可逆？
   - 是否涉及数据删除/修改？
   - 是否涉及外部网络请求？
   - 是否涉及敏感信息？
```

**危险操作分类：**

| 风险级别 | 操作类型 | 处理方式 |
|----------|----------|----------|
| 🔴 高危 | 删除文件、格式化、系统配置修改 | **必须用户确认** |
| 🟠 中危 | 文件修改、网络请求、进程管理 | 明确告知用户，建议确认 |
| 🟡 低危 | 文件读取、状态查询 | 正常执行，记录日志 |
| 🟢 安全 | 纯计算、文本处理 | 正常执行 |

**危险操作清单：**

```
🔴 高危操作（必须确认）：
- rm / Remove-Item（删除文件/目录）
- 格式化磁盘
- 修改系统配置
- 安装/卸载软件
- 修改防火墙规则
- 执行外部脚本
- 发送邮件/消息到外部
- 上传文件到外部服务器

🟠 中危操作（建议确认）：
- 文件写入/修改
- 创建/删除目录
- 网络请求
- 启动/停止服务
- 修改配置文件
- Git push / 强制操作
```

**安全检查流程：**

```
1. 识别操作类型
2. 评估风险级别
3. 高危操作 → 向用户确认，说明风险
4. 中危操作 → 告知用户，建议确认
5. 执行后 → 记录到 experiences.json
```

### 1. 主动发现工具

**接到任务时的标准流程：**

```
1. 扫描 <available_skills> 列表
2. 搜索 ClawHub 是否有现成技能
3. 检查 openclaw_project/openclaw/ 是否有相关技能
4. 评估每个工具/技能的适用性
5. 选择最合适的工具执行任务
```

**评估标准：**

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | `<available_skills>` | 已加载，立即可用 |
| 2 | ClawHub | 可安装，社区验证 |
| 3 | openclaw_project | 本地开发，可定制 |
| 4 | 手动实现 | 最后选择 |

### 2. 使用工具后必须总结

**每次使用工具后：**

```
1. 记录工具名称和用途
2. 总结使用场景
3. 记录高效用法或发现的问题
4. 写入 experiences.json (type: tool-pattern)
```

**记录格式：**

```json
{
  "type": "tool-pattern",
  "tool": "工具名称",
  "summary": "使用场景摘要",
  "pattern": "使用模式",
  "steps": ["步骤1", "步骤2"],
  "effect": "效果说明",
  "gotchas": ["注意事项"]
}
```

### 3. 沉淀成技能

**工具经验技能化流程：**

```
1. 使用工具 → 记录到 experiences.json
2. 多次使用 → 热度上升
3. 跨 Session 使用 → 评分上升
4. 评分 >= 0.7 → 建议技能化
5. 创建技能 → 自动加载
```

### 4. 工具使用检查清单

**每次任务前检查：**

- [ ] 是否有现成技能可用？
- [ ] ClawHub 是否有相关技能？
- [ ] 技能来源是否可信？
- [ ] 操作是否涉及危险动作？
- [ ] 是否需要用户确认？

**每次任务后记录：**

- [ ] 使用了哪些工具？
- [ ] 有什么高效用法？
- [ ] 有什么坑需要避免？
- [ ] 是否值得技能化？
- [ ] 是否有安全风险需要记录？

---

## Agent Playbook

### 必须执行

1. **Session Start** → 加载项目和全局记忆，检查旧格式迁移
2. **Heartbeat** → 评估热度、检查承诺、触发流动、技能化建议
3. **任务前** → 扫描可用工具，**安全检查**，优先使用现成技能
4. **危险操作** → **必须向用户确认，说明风险**
5. **任务后** → 总结工具使用，记录到 experiences.json
6. **重要决策** → 写入项目级 decisions.json
7. **用户偏好** → 写入项目级 state.json
8. **错误捕获** → 自动记录到 experiences.json (type: lesson)
9. **学习记录** → 发现最佳实践时记录到 experiences.json
9. **功能请求** → 用户请求不存在功能时记录
10. **Session End** → 同步到项目级，更新热度索引

### 自动捕获触发词

| 触发词/场景 | 动作 |
|-------------|------|
| 命令失败（退出码 != 0） | 记录 lesson |
| "不对"、"错了"、"Actually..." | 记录 lesson（高优先级） |
| API 调用失败 | 记录 lesson |
| "记住这个"、"这个很重要" | 记录 best_practice |
| "我想要...功能" | 记录 feature_request |
| 完成任务 | 记录 tool-pattern |

### 禁止操作

1. **不要覆盖** 项目级文件 - 只能追加
2. **不要删除** 记忆条目 - 只能标记 archived
3. **不要忽略** 跨 Session 访问 - 记录到 access_sessions
4. **不要忽略** 错误 - 必须记录到 experiences.json
5. **不要跳过工具扫描** - 接到任务必须先找工具
6. **不要忘记总结** - 使用工具后必须记录经验
7. **不要跳过安全检查** - 使用外部技能/工具前必须评估风险
8. **不要擅自执行高危操作** - 删除、格式化、系统配置修改必须用户确认
9. **不要隐藏风险** - 危险操作必须明确告知用户

### 最佳实践

1. **Safety first** - 安全第一，所有危险操作必须确认
2. **Tool-first mindset** - 先找工具，再动手实现
3. **Prefer project over session** - 有价值的记忆及时同步到项目级
4. **Track cross-session access** - 记录哪些 Session 访问了哪些记忆
5. **Self-improve continuously** - 每次错误都是学习机会
6. **Respect project boundaries** - 不同项目的记忆隔离
7. **Share globally when appropriate** - 用户偏好、通用经验放全局
8. **Skillify valuable experiences** - 高评分经验及时转化为技能
9. **Document tool patterns** - 每次工具使用都要总结沉淀
10. **Record security incidents** - 记录安全相关经验，避免重复风险

---

_This skill is part of the OpenClaw memory system._
