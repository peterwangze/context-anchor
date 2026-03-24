# context-anchor-hook

用于把 `context-anchor` 的会话记忆、恢复和结束同步接到宿主事件。

## 支持事件

- `gateway:startup`
- `command:stop`
- `session:end`
- `heartbeat`

## 调用方式

```bash
node "handler.js" <event-name> <payload-file-or-json>
```

对零基础用户，推荐优先传 JSON 文件路径，不要直接在命令行内联 JSON。

payload 示例：

```json
{
  "workspace": "D:/workspace/project",
  "session_key": "feishu-direct-user",
  "project_id": "default",
  "usage_percent": 82
}
```

如果 payload 解析失败，CLI 会返回明确的 `status: "error"` 和错误信息。

## 返回

标准 JSON：

- `status`
- `event`
- `actions`
- `resume_message` 或 `message`
