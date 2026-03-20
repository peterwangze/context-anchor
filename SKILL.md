---
name: context-anchor
description: Session memory persistence system with layered architecture
---

# Context Anchor

Session 记忆永续系统。通过分层记忆架构和热度流动机制，确保主 agent 的记忆永续，支持切换模型、退出会话后保持记忆连续性。

## 设计哲学

**类人，但超人。**

- 类人：模拟人类记忆的分层结构（感官 → 工作记忆 → 长期记忆）
- 超人：数据可流动、可检索、可持久化、可恢复

## 核心概念

### 记忆层级

| 层级 | 类比 | 存储 | 热度范围 | 特点 |
|------|------|------|----------|------|
| RAM | 工作记忆 | 当前上下文 | 80-100 | 立即可用，容量有限 |
| Cache | 短期记忆 | `memory/YYYY-MM-DD.md` | 50-79 | 快速访问，自动衰减 |
| Disk | 长期记忆 | `MEMORY.md` | 0-49 | 持久化，需主动检索 |

### 热度机制

- **初始热度**：新记忆 = 100（RAM）
- **时间衰减**：每小时 -1 热度
- **访问增强**：每次访问 +5 热度
- **流动触发**：
  - 热度 > 80 → 晋升提醒
  - 热度 < 50 → 降级到 Cache
  - 热度 < 30 → 降级到 Disk

---

## 触发场景与执行流程

### 1. Session Start（会话开始）

**触发条件：** 新会话开始时，或收到 heartbeat 检测到新日期

**执行流程：**
```
1. 检查 memory/YYYY-MM-DD.md 是否存在（今日记忆）
2. 检查 memory/YYYY-MM-DD.md（昨日记忆）
3. 读取 MEMORY.md 中的高热度条目（heat > 70）
4. 将关键记忆注入上下文：
   - 昨日未完成任务
   - 高热度决策和偏好
   - 用户重要信息
5. 更新 state/session-state.json
```

**注入格式：**
```markdown
## 📌 Session Memory Loaded

**昨日记忆摘要：**
- [决策] xxx
- [待办] xxx

**高热度记忆：**
- [偏好] xxx
- [重要] xxx
```

### 2. Heartbeat（定期检查）

**触发条件：** 收到 heartbeat poll（每 30 分钟）

**执行流程：**
```
1. 评估记忆热度
   - 读取 state/heat-index.json
   - 计算时间衰减：hours_since_last_access × 1
   - 更新热度值

2. 检查上下文压力
   - 使用 session_status 获取上下文使用率
   - > 75%：触发记忆保存
   - > 85%：建议用户执行 /compact

3. 执行记忆流动
   - 热度 > 80 且在 Disk → 晋升提醒
   - 热度 < 50 且在 Cache → 标记待降级
   - 热度 < 30 且在 Cache → 降级到 Disk

4. 检查未完成承诺
   - 读取 state/session-state.json 中的 commitments
   - 超时承诺 → 提醒用户

5. 正常输出：HEARTBEAT_OK
```

### 3. Memory Save（记忆保存）

**触发条件：**
- 上下文压力 > 75%
- 用户请求保存
- 重要决策/发现时

**执行流程：**
```
1. 识别需要保存的内容：
   - 用户偏好
   - 重要决策
   - 任务进度
   - 经验教训

2. 写入 memory/YYYY-MM-DD.md：
   - 追加新条目（不覆盖已有内容）
   - 设置初始热度 = 100
   - 添加时间戳和标签

3. 更新 state/heat-index.json
```

### 4. Memory Flow（记忆流动）

**触发条件：** Heartbeat 检测到热度变化

**执行流程：**
```
Cache → Disk（降级）：
1. 读取 memory/YYYY-MM-DD.md 中的低热度条目
2. 提炼压缩内容
3. 追加到 MEMORY.md
4. 从 memory/YYYY-MM-DD.md 移除或标记为 archived

Disk → Cache（晋升）：
1. 用户检索或访问 MEMORY.md 中的条目
2. 热度 +10
3. 热度 > 50 时复制到 memory/YYYY-MM-DD.md
```

---

## 记忆格式

### Cache 条目 (memory/YYYY-MM-DD.md)

```markdown
## MEM-YYYY-MM-DD-NN
type: fact | decision | preference | todo | lesson | tool-pattern
heat: 85
created: YYYY-MM-DDTHH:MM:SS+08:00
tags: [tag1, tag2]

记忆内容...

**Source:** 触发来源（对话/任务/错误等）
```

### Disk 条目 (MEMORY.md)

```markdown
## MEM-YYYY-MM-DD-NN
type: fact
heat: 25
frozen: true
created: YYYY-MM-DDTHH:MM:SS+08:00
last_accessed: YYYY-MM-DDTHH:MM:SS+08:00

记忆内容（已压缩/提炼）...
```

---

## 状态文件

### state/heat-index.json

```json
{
  "last_updated": "YYYY-MM-DDTHH:MM:SS+08:00",
  "entries": [
    {
      "id": "MEM-2026-03-20-01",
      "heat": 85,
      "last_accessed": "YYYY-MM-DDTHH:MM:SS+08:00",
      "access_count": 3
    }
  ]
}
```

### state/session-state.json

```json
{
  "session_id": "feishu:direct:ou_xxx",
  "started_at": "YYYY-MM-DDTHH:MM:SS+08:00",
  "commitments": [
    {
      "id": "commit-001",
      "what": "承诺内容",
      "when": "YYYY-MM-DDTHH:MM:SS+08:00",
      "status": "pending"
    }
  ],
  "active_task": "当前任务描述"
}
```

---

## Agent Playbook

### 必须执行

1. **Session Start** → 加载昨日记忆和高热度记忆
2. **Heartbeat** → 评估热度、检查承诺、触发流动
3. **重要决策** → 立即写入 memory/YYYY-MM-DD.md
4. **用户偏好** → 写入 MEMORY.md（长期保存）

### 禁止操作

1. **不要覆盖** MEMORY.md - 只能追加
2. **不要删除** 记忆条目 - 只能标记 archived
3. **不要忽略** 低热度记忆 - 定期检索

### 最佳实践

1. **Prefer disk over RAM** - 不要把所有东西都塞进上下文
2. **Write explicitly** - 想记住的事情必须写下来
3. **Search before asking** - 先检索记忆，再问用户
4. **Respect heat decay** - 低热度记忆需要主动检索才能访问
5. **工具优先** - 先找工具，再动手实现

---

## 工具使用原则

**主动发现工具：**
- 接到任务时，先扫描 `<available_skills>` 和已有工具
- 评估是否有现成工具适合当前任务
- 优先使用已有工具，而非手动实现

**沉淀工具经验：**
- 发现高效/创新的工具用法 → 记录到 `memory/YYYY-MM-DD.md`
- 可复用的模式 → 提炼后存入 `MEMORY.md`（标记 `type: tool-pattern`）
- 跨领域通用的经验 → 考虑封装成新技能

---

_This skill is part of the OpenClaw memory system._
