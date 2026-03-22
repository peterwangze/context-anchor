# context-anchor-hook

用于把 `context-anchor` 的会话记忆、恢复和结束同步接到宿主事件。

## 支持事件

- `gateway:startup`
- `command:stop`
- `session:end`
- `heartbeat`

## 调用方式

```bash
node handler.js <event-name> '<json-payload>'
```

payload 示例：

```json
{
  "workspace": "D:/workspace/project",
  "session_key": "feishu-direct-user",
  "project_id": "default",
  "usage_percent": 82
}
```

## 返回

标准 JSON：

- `status`
- `event`
- `actions`
- `resume_message` 或 `message`
