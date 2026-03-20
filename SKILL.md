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

## 触发场景

1. **session_start** - 加载昨日记忆 + 高热度记忆
2. **heartbeat** - 评估热度，触发流动
3. **上下文压力** - 自动保存短期记忆
4. **用户请求** - 主动保存/恢复
5. **session_end** - 持久化所有记忆

## 记忆格式

### Cache 条目 (memory/YYYY-MM-DD.md)

```markdown
## MEM-2026-03-20-01
type: fact | decision | preference | todo | context
heat: 85
created: 2026-03-20T10:30:00+08:00
tags: [project-x, important]

记忆内容...
```

### Disk 条目 (MEMORY.md)

```markdown
## MEM-2026-03-15-01
type: fact
heat: 25
frozen: true
created: 2026-03-15T14:00:00+08:00
last_accessed: 2026-03-20T10:30:00+08:00

记忆内容（已压缩/提炼）...
```

## 工具使用原则

**主动发现工具：**
- 接到任务时，先扫描 `<available_skills>` 和已有工具
- 评估是否有现成工具适合当前任务
- 优先使用已有工具，而非手动实现

**沉淀工具经验：**
- 发现高效/创新的工具用法 → 记录到 `memory/YYYY-MM-DD.md`
- 可复用的模式 → 提炼后存入 `MEMORY.md`（标记 `type: tool-pattern`）
- 跨领域通用的经验 → 考虑封装成新技能

**经验格式示例：**
```markdown
## TOOL-2026-03-20-01
type: tool-pattern
tool: web_search + web_fetch

Pattern: 快速调研某个主题
Steps:
1. web_search 获取相关链接
2. web_fetch 抓取前 2-3 个结果的关键内容
3. 综合整理成摘要

Effect: 5 分钟内完成主题调研，无需浏览器
```

## Agent Playbook

1. **Prefer disk over RAM** - 不要把所有东西都塞进上下文
2. **Write explicitly** - 想记住的事情必须写下来
3. **Search before asking** - 先检索记忆，再问用户
4. **Respect heat decay** - 低热度记忆需要主动检索才能访问
5. **工具优先** - 先找工具，再动手实现

---

_This skill is part of the OpenClaw memory system._
