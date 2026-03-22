# 可靠性说明

## 保证项

- `session-start` 不覆盖已有 session 状态
- `context-pressure-handle` 一定先创建 checkpoint，再同步记忆
- `session:end` hook 会串联 checkpoint / flow / heat / skillification
- host 安装脚本写入的是 wrapper，不依赖复制后的相对路径

## 建议使用顺序

1. `session-start`
2. 工作过程中调用 `memory-save`
3. 定时调用 `heartbeat` 或 `context-pressure-monitor`
4. 会话结束时触发 `command:stop` 或 `session:end`

## 校验方式

```bash
npm test
```

当前测试覆盖：

- session 恢复
- checkpoint 与压力处理
- 自动校验与技能化候选
- skill 创建
- startup hook 恢复消息
- host wrapper 安装
