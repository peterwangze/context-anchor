# 经验技能化机制

## 核心理念

```
经验（数据）→ 时间验证 → 提炼 → 技能（能力）→ 持续成长
```

## 技能化触发条件

### 综合评分公式

```
技能化评分 = 时间权重(0.3) + 频率权重(0.3) + 跨Session权重(0.2) + 热度权重(0.2)

其中：
- 时间权重 = min(days_since_created / 30, 1)  // 30天满权重
- 频率权重 = min(access_count / 10, 1)         // 10次满权重
- 跨Session权重 = min(access_sessions.length / 5, 1)  // 5个Session满权重
- 热度权重 = heat / 100

技能化评分 >= 0.7 时，建议技能化
```

### 触发条件表

| 条件 | 阈值 | 说明 |
|------|------|------|
| **时间跨度** | 经验创建 >= 7 天 | 经过时间验证 |
| **访问频率** | access_count >= 5 | 被多次使用 |
| **跨 Session** | access_sessions.length >= 2 | 多个会话都有用 |
| **热度稳定** | 平均热度 >= 60 | 持续保持价值 |
| **综合评分** | >= 0.7 | 建议技能化 |

### 强制技能化

用户可以跳过时间验证，直接请求将经验转化为技能。

---

## 完整流程

### 1. 经验积累阶段

```
错误/最佳实践/工具用法 → experiences.json
记录：created_at, access_count, access_sessions, heat
```

### 2. 时间验证阶段

```
Heartbeat 定期检查（每 30 分钟）
计算技能化评分
评分 >= 0.7 → 加入候选列表
```

### 3. 建议确认阶段

**方式 A：Heartbeat 自动建议**
```
发现可技能化的经验：
- 经验：{summary}
- 评分：{score}
- 建议技能名：{suggested_name}
是否创建技能？
```

**方式 B：用户主动请求**
```
"把 xxx 经验转化成技能"
```

**命名规则：**
- Agent 提供技能名称建议
- 用户决定最终名称

### 4. 技能创建阶段

```
1. 在 openclaw_project/openclaw/{skill-name}/ 创建目录
2. 创建 SKILL.md（从经验提炼指令）
3. 初始化 git 仓库
4. 通过 extraDirs 自动加载
```

### 5. 技能应用阶段

```
自动加载到 available_skills
Agent 遵循技能指令执行
记录技能使用情况，持续优化
```

### 6. 经验关联

```
原经验保留，标记 skill_name 关联
不再参与技能化评分
```

---

## 经验类型与技能映射

| 经验类型 | 技能化方向 | 示例 |
|----------|------------|------|
| `tool-pattern` | 工具使用技能 | web-research, file-operations |
| `best_practice` | 最佳实践技能 | git-workflow, code-review |
| `lesson` | 错误预防技能 | safe-operations, debug-patterns |
| `gotcha` | 陷阱提醒技能 | powershell-gotchas, docker-gotchas |

---

## 主动学习机制

### Heartbeat 检查项

```
1. 扫描 experiences.json，计算技能化评分
2. 识别高评分经验（>= 0.7）
3. 检查是否已有对应技能
4. 如果没有，输出建议
```

### 技能搜索优先

```
遇到问题时：
1. 先搜索 ClawHub 是否有现成技能
2. 检查 openclaw_project/openclaw/ 是否有相关技能
3. 如果有，直接使用
4. 如果没有，考虑从经验创建
```

---

## 技能目录结构

```
openclaw_project/openclaw/
├── context-anchor/              # 记忆管理技能
│   ├── SKILL.md
│   ├── scripts/
│   ├── references/
│   └── .git/
│
├── {skill-name}/                # 新技能（从经验创建）
│   ├── SKILL.md                 # 技能定义
│   ├── scripts/                 # 可选
│   ├── references/              # 可选
│   └── .git/                    # Git 管理
│
└── _skill-index.json            # 技能索引
```

---

## SKILL.md 生成模板

```markdown
---
name: {skill-name}
description: {从经验 summary 提炼}
---

# {skill-name}

{从经验 details 提炼的详细说明}

## 使用场景

{从经验 tags 和使用记录提炼}

## 执行步骤

{从经验 solution 或 pattern 提炼}

## 注意事项

{从经验 gotchas 或相关错误提炼}

---

_此技能从经验 {experience-id} 沉淀而来_
```

---

## 状态文件格式

### experiences.json 更新

```json
{
  "experiences": [
    {
      "id": "exp-001",
      "type": "lesson",
      "summary": "Move-Item 不会移动隐藏目录",
      "skillification_score": 0.85,
      "skillification_suggested": true,
      "skill_name": "safe-file-operations",
      "created_at": "2026-03-13T08:29:00+08:00",
      "access_count": 8,
      "access_sessions": ["session-A", "session-B", "session-C"],
      "heat": 95
    }
  ]
}
```

### _skill-index.json

```json
{
  "skills": [
    {
      "name": "safe-file-operations",
      "source_experience": "exp-001",
      "created_at": "2026-03-20T12:00:00+08:00",
      "usage_count": 0
    }
  ]
}
```

---

## 持续成长闭环

```
经验积累 → 时间验证 → 技能化建议 → 技能创建 → 技能应用 → 新经验 → ...
     ↑                                                        ↓
     └────────────────── 持续优化 ←───────────────────────────┘
```
