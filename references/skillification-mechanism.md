# 经验技能化机制

## 闭环

```text
session 行为
  -> 经验记录
  -> session skill draft
  -> validation
  -> skillification score
  -> skill create
```

## 经验进入技能化候选的条件

1. `validation.status === validated`
2. 创建时间至少 7 天
3. 综合评分 `>= 0.7`

综合评分：

```text
score =
  time(0.3) +
  frequency(0.3) +
  cross-session(0.2) +
  heat(0.2)
```

## 自动校验

满足以下行为证据时，经验会从 `pending` 自动转为 `validated`：

- `access_count >= 3`
- `access_sessions.length >= 2`
- 创建时间至少 7 天

## 手动校验

```bash
node scripts/experience-validate.js <workspace> <experience-id> <status> [project-id] [note]
```

状态：

- `validated`
- `rejected`
- `pending`

## 技能创建

```bash
node scripts/skill-create.js <workspace> <experience-id> <skill-name> [project-id]
```

默认行为：

- 只接受已校验经验
- 在当前 skill 仓上级目录创建新 skill
- 更新 `_skill-index.json`

可选行为：

- `CONTEXT_ANCHOR_GIT_INIT=1`：初始化 skill 自己的 git 仓库
- `CONTEXT_ANCHOR_FORCE_SKILL_CREATE=1`：跳过校验门槛强制创建

## Session Skill Draft

第一阶段新增：

- `session-close.js` 会根据当前 session memory / experience 自动生成 `session skill draft`
- draft 只写入 `sessions/{session-key}/skills/`
- draft 仍然是独立对象，不会直接替代 active skill
- 满足门槛的 validated experience 现在会自动晋升为 `project/user active skill`
- `skill-reconcile` 会基于 supporting evidence 自动降级、回流与归档 skill，并保留 evidence 轨迹

## Governance

当前治理规则：

- 同名 active skill 通过 `conflict_key` 判定冲突
- `session-start` 激活时，优先级为 `session > project > user`
- `scope-promote` 遇到同名 active skill 时复用已有 skill，并追加 `related_experiences`
- `inactive` 和 `archived` skill 不参与自动激活
- `skill-reconcile` 会在 source experience 不再有效时把 skill 自动降级为 `inactive`
- skill 保留 `promotion_history` 和 `status_history`
- `skill-supersede` 可显式声明 winner/loser 关系
- skill 激活集合受预算治理约束，超出预算的 skill 会进入 `budgeted_out`
- 低优先级、低使用度且 inactive 的 skill 会被自动 archive
