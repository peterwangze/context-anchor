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

## Agent Playbook

### 必须执行

1. **Session Start** → 加载项目和全局记忆
2. **Heartbeat** → 评估热度、检查承诺、触发流动、技能化建议
3. **重要决策** → 写入项目级 decisions.json
4. **用户偏好** → 写入项目级 state.json
5. **错误/经验** → 写入项目级 experiences.json
6. **Session End** → 同步到项目级，更新热度索引

### 禁止操作

1. **不要覆盖** 项目级文件 - 只能追加
2. **不要删除** 记忆条目 - 只能标记 archived
3. **不要忽略** 跨 Session 访问 - 记录到 access_sessions

### 最佳实践

1. **Prefer project over session** - 有价值的记忆及时同步到项目级
2. **Track cross-session access** - 记录哪些 Session 访问了哪些记忆
3. **Self-improve continuously** - 每次错误都是学习机会
4. **Respect project boundaries** - 不同项目的记忆隔离
5. **Share globally when appropriate** - 用户偏好、通用经验放全局
6. **Skillify valuable experiences** - 高评分经验及时转化为技能

---

## 工具使用原则

**主动发现工具：**
- 接到任务时，先扫描 `<available_skills>` 和已有工具
- 评估是否有现成工具适合当前任务
- 优先使用已有工具，而非手动实现

**沉淀工具经验：**
- 发现高效/创新的工具用法 → 记录到 experiences.json (type: tool-pattern)
- 跨领域通用的经验 → 同步到 projects/_global/
- 高评分经验 → 转化为技能

---

_This skill is part of the OpenClaw memory system._
