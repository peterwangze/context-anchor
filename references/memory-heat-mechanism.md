# 记忆热度机制

## 热度层级

| 热度 | 含义 | 典型存储 |
|------|------|----------|
| 80-100 | 热 | `sessions/{key}/memory-hot.json` |
| 50-79 | 温 | `projects/{id}/decisions.json` / `experiences.json` |
| 30-49 | 冷 | `projects/{id}/facts.json` / 低频经验 |
| 0-9 | 归档候选 | `archived: true` |

## 热度变化

增加：

- 同一 Session 再次访问：`+5`
- 新 Session 访问：`+10`
- session 热记忆同步到项目级时保留温热值

衰减：

- `heat-eval.js` 按距离 `last_accessed` 的小时数衰减
- 当热度很低且没有跨 Session 复用时，标记 `archived`

## 访问计数

以下行为会写回访问元数据：

- `session-start.js` 把被注入的项目记忆记为一次访问
- 后续脚本对经验做复用、同步或校验时会保留 `access_count` / `access_sessions`

## 相关脚本

- `scripts/session-start.js`
- `scripts/memory-flow.js`
- `scripts/heat-eval.js`
