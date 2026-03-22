# 经验技能化机制

## 闭环

```text
session 行为
  -> 经验记录
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
