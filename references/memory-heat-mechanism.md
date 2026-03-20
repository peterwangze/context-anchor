# 记忆热度机制详解（多 Session 多 Project 版）

## 热度计算公式

```
热度 = 初始热度 + 访问加成 - 时间衰减 + 跨 Session 加成 + 特殊加成
```

## 初始热度

| 来源 | 初始热度 | 作用域 | 说明 |
|------|----------|--------|------|
| 新决策 | 80 | project | 重要决策，项目级共享 |
| 新经验 | 60 | project | 经验教训，项目级共享 |
| 新偏好 | 70 | project/global | 用户偏好 |
| 新事实 | 50 | project | 一般信息 |
| 错误/教训 | 60 | project | 重要性较高 |
| Session 工作记忆 | 100 | session | 当前会话专用 |

## 热度变化规则

### 访问加成

| 行为 | 热度变化 | 说明 |
|------|----------|------|
| 在对话中引用 | +10 | 每次引用 |
| 用户确认重要 | +30 | 手动标记 |
| 完成相关任务 | +5 | 任务完成 |
| **跨 Session 访问** | **+10** | **其他 Session 访问时** |
| **跨 Session 存活** | **+20** | **被多个 Session 访问** |

### 时间衰减

| 时间 | 热度变化 | 说明 |
|------|----------|------|
| 每小时 | -1 | 持续衰减 |
| 每天未访问 | -5 | 额外衰减 |
| 超过 7 天未访问 | -10 | 快速衰减 |

### 热度上限和下限

- 最大热度：100
- 最小热度：0
- 热度 < 10 且无跨 Session 访问 → 标记可清理

## 热度分级与行为（多 Session 多 Project）

| 热度范围 | 层级 | 存储位置 | 作用域 | 行为 |
|----------|------|----------|--------|------|
| 80 - 100 | 工作记忆（热） | `sessions/{key}/memory-hot.json` | 当前 Session | 保持在上下文 |
| 50 - 79 | 短期记忆（温） | `projects/{id}/decisions.json` | 项目级共享 | 按需加载，跨 Session 可见 |
| 30 - 49 | 长期记忆（冷） | `projects/{id}/experiences.json` | 项目级共享 | 按需检索 |
| 0 - 29 | 归档记忆 | 标记 archived | 项目级共享 | 低优先级检索 |
| - | 全局记忆 | `projects/_global/state.json` | 所有项目 | 用户偏好、通用知识 |

## 记忆流动示例

### Session → Project（共享）

```
1. Session 中创建决策（热度 80）
2. 被 Session A 访问（+10，热度 90）
3. 被 Session B 访问（+10，热度 100，记录 access_sessions: [A, B]）
4. Heartbeat 检测到跨 Session 访问
5. 确认为高价值记忆，保持在项目级
```

### Project → Global（全局）

```
1. 项目级偏好（热度 85）
2. 被多个项目引用
3. 提升到 projects/_global/
4. 所有项目可见
```

### Project → Session（加载）

```
1. 项目级决策（热度 75）
2. Session C 启动，加载项目记忆
3. 热度 > 70 的决策被注入上下文
4. 访问记录更新：access_sessions 增加 C
```

## 热度评估时机

| 时机 | 频率 | 说明 |
|------|------|------|
| heartbeat | 每 30 分钟 | 定期评估项目级热度 |
| Session 启动 | 每次启动 | 加载高热度记忆 |
| 跨 Session 访问 | 实时 | 记录到 access_sessions |
| Session 结束 | 一次 | 同步到项目级 |

## 跨 Session 追踪

### access_sessions 数组

每个项目级记忆条目包含：

```json
{
  "id": "dec-001",
  "heat": 85,
  "access_sessions": ["session-A", "session-B", "session-C"],
  "access_count": 5,
  "last_accessed": "YYYY-MM-DDTHH:MM:SS+08:00"
}
```

### 跨 Session 加成计算

```
跨 Session 加成 = access_sessions.length × 5
```

- 1 个 Session 访问：+5
- 2 个 Session 访问：+10
- 3+ 个 Session 访问：+15（上限）

## 特殊处理

### 强制保留

用户明确标记"记住这个"的信息：
- 热度设为 80（工作记忆下限）
- 跳过自动降级
- 只能手动删除

### 快速遗忘

用户明确标记"忘了这个"的信息：
- 热度设为 0
- 标记为可清理
- 下次清理时删除

### 错误信息

记录为错误/教训的信息：
- 初始热度 60
- 类型为 `lesson`
- 存储在 `projects/{id}/experiences.json`
- 跨 Session 可检索，避免重复错误

### 自我提升闭环

```
错误发生 → 记录到 experiences.json (type: lesson)
    ↓
Heartbeat 检测 → 分析错误模式
    ↓
提炼经验 → 更新 heat-index.json
    ↓
下次遇到类似情况 → 检索经验 → 避免重复错误
    ↓
成功避免 → access_count++ → heat += 5
```
