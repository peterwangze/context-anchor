# 记忆文件模板（多 Session 多 Project 版）

## Session 状态（sessions/{session-key}/state.json）

```json
{
  "session_key": "feishu:direct:ou_xxx",
  "project_id": "default",
  "started_at": "2026-03-20T10:00:00+08:00",
  "last_active": "2026-03-20T10:30:00+08:00",
  "commitments": [
    {
      "id": "commit-001",
      "what": "承诺内容",
      "when": "2026-03-20T10:15:00+08:00",
      "status": "pending"
    }
  ],
  "active_task": "当前任务描述",
  "errors_count": 0,
  "experiences_count": 0
}
```

## Session 工作记忆（sessions/{session-key}/memory-hot.json）

```json
{
  "entries": [
    {
      "id": "mem-001",
      "type": "fact|decision|preference|todo|context",
      "content": "记忆内容",
      "heat": 100,
      "created_at": "2026-03-20T10:30:00+08:00",
      "session_key": "feishu:direct:ou_xxx"
    }
  ]
}
```

## Session 检查点（sessions/{session-key}/checkpoint.md）

```markdown
# Context Checkpoint — 2026-03-20 10:30

## 当前任务
重构 context-anchor 为多 Session 多 Project 架构

## 工作记忆（热度 > 80）
- 采用三层记忆架构：热/温/冷
- 支持跨 Session 共享

## 关键决策
- 使用 JSON 格式存储记忆：便于跨模型兼容
- 项目级隔离：每个项目独立记忆空间

## 未完成承诺
- [ ] 完成自我提升闭环
- [ ] 测试跨 Session 访问

## 下一步
1. 实现 heartbeat 集成
2. 测试热度流动机制
```

## 项目状态（projects/{project-id}/state.json）

```json
{
  "project_id": "default",
  "name": "项目名称",
  "created_at": "2026-03-15T00:00:00+08:00",
  "last_updated": "2026-03-20T10:30:00+08:00",
  "sessions_count": 10,
  "key_decisions": ["dec-001", "dec-002"],
  "key_experiences": ["exp-001"],
  "user_preferences": {
    "language": "zh-CN",
    "timezone": "Asia/Shanghai"
  }
}
```

## 项目决策库（projects/{project-id}/decisions.json）

```json
{
  "decisions": [
    {
      "id": "dec-001",
      "decision": "采用多 Session 多 Project 架构",
      "rationale": "支持并行会话，隔离项目记忆",
      "alternatives": ["单 Session 架构", "无项目隔离"],
      "session_key": "feishu:direct:ou_xxx",
      "created_at": "2026-03-20T10:00:00+08:00",
      "heat": 85,
      "access_sessions": ["session-A", "session-B"],
      "access_count": 5,
      "last_accessed": "2026-03-20T10:30:00+08:00",
      "tags": ["architecture", "important"],
      "impact": "high"
    }
  ]
}
```

## 项目经验库（projects/{project-id}/experiences.json）

```json
{
  "experiences": [
    {
      "id": "exp-001",
      "type": "lesson|best_practice|gotcha|tool-pattern",
      "summary": "Move-Item 不会移动隐藏目录",
      "details": "使用 Move-Item 迁移目录时，隐藏目录（如 .git）可能不会被一起移动",
      "solution": "使用 Copy-Item + Remove-Item，或显式指定 -Force 参数",
      "session_key": "feishu:direct:ou_xxx",
      "created_at": "2026-03-20T08:29:00+08:00",
      "heat": 95,
      "applied_count": 0,
      "access_sessions": ["session-A"],
      "tags": ["powershell", "safety", "file-operations"]
    }
  ]
}
```

## 项目热度索引（projects/{project-id}/heat-index.json）

```json
{
  "project_id": "default",
  "last_updated": "2026-03-20T10:30:00+08:00",
  "entries": [
    {
      "id": "dec-001",
      "type": "decision",
      "heat": 85,
      "last_accessed": "2026-03-20T10:30:00+08:00",
      "last_evaluated": "2026-03-20T10:30:00+08:00",
      "access_count": 5,
      "access_sessions": ["session-A", "session-B"]
    },
    {
      "id": "exp-001",
      "type": "experience",
      "heat": 95,
      "last_accessed": "2026-03-20T08:30:00+08:00",
      "last_evaluated": "2026-03-20T10:30:00+08:00",
      "access_count": 1,
      "access_sessions": ["session-A"]
    }
  ]
}
```

## 全局状态（projects/_global/state.json）

```json
{
  "user_preferences": {
    "language": "zh-CN",
    "timezone": "Asia/Shanghai",
    "preferred_model": "astroncodingplan/astron-code-latest"
  },
  "important_facts": [
    {
      "content": "用户主要使用飞书进行沟通",
      "created_at": "2026-03-15T00:00:00+08:00"
    }
  ],
  "global_experiences": [
    {
      "id": "glob-001",
      "type": "best_practice",
      "summary": "危险操作必须先确认",
      "created_at": "2026-03-20T08:29:00+08:00"
    }
  ]
}
```

## 会话索引（sessions/_index.json）

```json
{
  "sessions": [
    {
      "session_key": "feishu:direct:ou_xxx",
      "project_id": "default",
      "started_at": "2026-03-20T06:30:00+08:00",
      "last_active": "2026-03-20T10:30:00+08:00"
    },
    {
      "session_key": "telegram:direct:user123",
      "project_id": "project-x",
      "started_at": "2026-03-20T09:00:00+08:00",
      "last_active": "2026-03-20T09:30:00+08:00"
    }
  ]
}
```

## 全局索引（.context-anchor/index.json）

```json
{
  "version": "1.0.0",
  "created_at": "2026-03-15T00:00:00+08:00",
  "last_updated": "2026-03-20T10:30:00+08:00",
  "projects": ["default", "project-x"],
  "active_sessions": ["feishu:direct:ou_xxx"],
  "stats": {
    "total_sessions": 15,
    "total_decisions": 25,
    "total_experiences": 10
  }
}
```

---

## 记忆作用域说明

| 作用域 | 存储位置 | 热度范围 | 共享范围 | 生命周期 |
|--------|----------|----------|----------|----------|
| session | `sessions/{key}/memory-hot.json` | 80-100 | 当前会话 | 会话结束即失效 |
| project | `projects/{id}/` | 30-79 | 项目内所有会话 | 持久化 |
| global | `projects/_global/` | - | 所有项目 | 持久化 |

---

## 跨 Session 访问追踪

每个项目级记忆条目包含 `access_sessions` 数组：

```json
{
  "access_sessions": ["session-A", "session-B", "session-C"],
  "access_count": 5
}
```

**用途：**
1. 计算跨 Session 加成：`access_sessions.length × 5`
2. 识别高价值记忆（被多个 Session 访问）
3. 追踪记忆来源和使用历史
