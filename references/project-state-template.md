# 记忆文件模板

## 短期记忆（sessions/{session-key}/state.json）

```json
{
  "session_key": "feishu:direct:ou_xxx",
  "project": "project-name",
  "created_at": "2026-03-19T22:00:00+08:00",
  "last_updated": "2026-03-19T23:44:00+08:00",
  
  "active_task": {
    "description": "当前任务描述",
    "started_at": "2026-03-19T23:40:00+08:00",
    "progress": "进行中/已完成/暂停"
  },
  
  "working_memory": [
    {
      "id": "mem-001",
      "type": "decision|fact|task|preference",
      "content": "记忆内容",
      "heat": 85,
      "created_at": "2026-03-19T23:42:00+08:00",
      "last_accessed": "2026-03-19T23:44:00+08:00",
      "access_count": 3,
      "tags": ["tag1", "tag2"]
    }
  ],
  
  "commitments": [
    {
      "id": "commit-001",
      "what": "承诺内容",
      "when": "2026-03-19T23:45:00+08:00",
      "status": "pending|done|delayed|cancelled",
      "delay_reason": "延误原因（如有）"
    }
  ],
  
  "recent_files": [
    "path/to/file1",
    "path/to/file2"
  ],
  
  "pending_tasks": [
    "待完成任务1",
    "待完成任务2"
  ]
}
```

## 长期记忆索引（projects/{project}/state.json）

```json
{
  "project": "project-name",
  "created_at": "2026-03-19T00:00:00+08:00",
  "last_updated": "2026-03-19T23:44:00+08:00",
  
  "knowledge_domains": [
    "领域1",
    "领域2"
  ],
  
  "key_decisions": [
    "dec-001: 决策摘要",
    "dec-002: 决策摘要"
  ],
  
  "user_preferences": {
    "preference_key": "preference_value"
  },
  
  "session_history_count": 5
}
```

## 决策库（projects/{project}/decisions.json）

```json
{
  "decisions": [
    {
      "id": "dec-001",
      "decision": "决策内容",
      "rationale": "决策理由",
      "alternatives": ["备选方案1", "备选方案2"],
      "session_key": "feishu:direct:ou_xxx",
      "created_at": "2026-03-19T23:42:00+08:00",
      "heat": 60,
      "tags": ["architecture", "important"],
      "impact": "high|medium|low"
    }
  ]
}
```

## 经验库（projects/{project}/experiences.json）

```json
{
  "experiences": [
    {
      "id": "exp-001",
      "type": "lesson|best_practice|gotcha",
      "summary": "经验摘要",
      "details": "详细说明",
      "solution": "解决方案（如有）",
      "session_key": "feishu:direct:ou_xxx",
      "created_at": "2026-03-19T23:30:00+08:00",
      "heat": 45,
      "tags": ["bug", "config"]
    }
  ]
}
```

## 工作记忆备份（sessions/{session-key}/memory-hot.json）

模型切换前保存的工作记忆快照：

```json
{
  "session_key": "feishu:direct:ou_xxx",
  "saved_at": "2026-03-19T23:50:00+08:00",
  "reason": "model_switch|compaction|manual",
  
  "hot_memories": [
    {
      "id": "mem-001",
      "type": "decision",
      "content": "高热度记忆内容",
      "heat": 90,
      "context": "相关上下文"
    }
  ],
  
  "active_context": {
    "current_task": "当前任务",
    "recent_messages_summary": "最近对话摘要"
  }
}
```

## Checkpoint（sessions/{session-key}/checkpoint.md）

人类可读的快照：

```markdown
# Context Checkpoint — 2026-03-19 23:44

## 当前任务
重构 context-anchor 为分层记忆架构

## 工作记忆（热度 > 80）
- 采用三层记忆架构：热/温/冷
- 热度机制：访问 +10，衰减 -1

## 关键决策
- 使用 JSON 格式存储记忆：便于跨模型兼容
- 主 Agent 统筹，子 Agent 执行：职责分离

## 未完成承诺
- [ ] 完成 Phase 2：持续服务机制
- [ ] 完成 Phase 3：模型切换支持

## 下一步
1. 实现 heartbeat 集成
2. 测试热度流动机制
```

## 跨 Session 热度索引（projects/{project}/heat-index.json）

记录所有 session 对同一信息的访问热度汇总：

```json
{
  "project": "openclaw",
  "last_updated": "2026-03-19T23:52:00+08:00",
  "heat_records": [
    {
      "content_hash": "sha256:abc123...",
      "content_preview": "采用三层记忆架构",
      "type": "decision",
      "total_heat": 150,
      "access_sessions": ["session-A", "session-B"],
      "created_at": "2026-03-19T23:42:00+08:00",
      "last_accessed": "2026-03-19T23:52:00+08:00"
    }
  ]
}
```

**热度计算规则：**
- 每个 session 访问：+10
- 跨 session 存活：+20
- 应用成功：+20
- 时间衰减：每小时 -1

## 成长追踪（projects/{project}/growth.json）

记录项目级别的成长指标：

```json
{
  "project": "openclaw",
  "last_updated": "2026-03-19T23:59:00+08:00",
  
  "growth_metrics": {
    "experiences_recorded": 25,
    "experiences_solidified": 8,
    "skills_learned": 5,
    "skills_created": 2,
    "errors_reduced_percent": 30,
    "efficiency_improved_percent": 20
  },
  
  "learning_history": [
    {
      "date": "2026-03-19",
      "type": "skill_learned",
      "name": "docker-build-fixes",
      "source": "ClawHub",
      "applied": true,
      "outcome": "成功解决 Docker 构建问题"
    },
    {
      "date": "2026-03-19",
      "type": "skill_created",
      "name": "context-anchor",
      "reason": "需要记忆永续能力",
      "published": false
    }
  ],
  
  "skill_inventory": [
    {
      "name": "context-anchor",
      "category": "core",
      "proficiency": "expert",
      "learned_at": "2026-03-19",
      "last_used": "2026-03-19",
      "use_count": 50
    },
    {
      "name": "docker-build-fixes",
      "category": "tool",
      "proficiency": "intermediate",
      "learned_at": "2026-03-19",
      "last_used": "2026-03-19",
      "use_count": 3
    }
  ],
  
  "improvement_opportunities": [
    {
      "area": "测试覆盖率",
      "current_state": "45%",
      "target_state": "80%",
      "suggested_action": "学习 testing-guide 技能"
    }
  ]
}
```

**成长指标说明：**

| 指标 | 说明 | 目标 |
|------|------|------|
| experiences_recorded | 记录的经验总数 | 持续增长 |
| experiences_solidified | 已固化为技能的经验数 | > 30% |
| skills_learned | 学习的技能数 | 按需增长 |
| skills_created | 创建的技能数 | 有价值时创建 |
| errors_reduced_percent | 错误率降低百分比 | > 20% |
| efficiency_improved_percent | 效率提升百分比 | > 10% |
