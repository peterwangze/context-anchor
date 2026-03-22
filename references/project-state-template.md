# 状态文件模板

## Session State

```json
{
  "session_key": "session-a",
  "project_id": "default",
  "started_at": "2026-03-22T12:00:00.000Z",
  "last_active": "2026-03-22T12:30:00.000Z",
  "commitments": [],
  "active_task": "修复 context-anchor",
  "errors_count": 0,
  "experiences_count": 0,
  "notes_count": 0,
  "last_checkpoint": null,
  "checkpoint_reason": null,
  "last_pressure_check": null,
  "last_pressure_usage": null,
  "metadata": {}
}
```

## Session Memory

```json
{
  "entries": [
    {
      "id": "mem-20260322123000-abcd12",
      "type": "decision",
      "content": "Use JSON storage",
      "summary": "Use JSON storage",
      "heat": 95,
      "created_at": "2026-03-22T12:30:00.000Z",
      "last_accessed": "2026-03-22T12:30:00.000Z",
      "session_key": "session-a",
      "project_id": "default",
      "scope": "session",
      "sync_to_project": true,
      "synced_project_entry_id": "exp-20260322123100-efgh34",
      "last_sync_fingerprint": "{\"type\":\"best_practice\"}",
      "archived": false
    }
  ]
}
```

## Project Decision

```json
{
  "id": "dec-20260322123000-abcd12",
  "type": "decision",
  "decision": "Use JSON storage",
  "rationale": null,
  "session_key": "session-a",
  "created_at": "2026-03-22T12:30:00.000Z",
  "last_accessed": "2026-03-22T12:30:00.000Z",
  "heat": 80,
  "access_count": 1,
  "access_sessions": ["session-a"],
  "tags": ["architecture"],
  "impact": "medium",
  "archived": false
}
```

## Project Experience

```json
{
  "id": "exp-20260322123000-abcd12",
  "type": "best_practice",
  "summary": "Reusable deployment checklist",
  "details": null,
  "solution": null,
  "source": "agent-observation",
  "session_key": "session-a",
  "created_at": "2026-03-22T12:30:00.000Z",
  "last_accessed": "2026-03-22T12:30:00.000Z",
  "heat": 60,
  "applied_count": 0,
  "access_count": 1,
  "access_sessions": ["session-a"],
  "tags": ["deployment"],
  "validation": {
    "status": "pending",
    "count": 0,
    "auto_validated": false,
    "last_reviewed_at": null,
    "notes": []
  },
  "archived": false
}
```

## Heat Index Entry

```json
{
  "id": "exp-20260322123000-abcd12",
  "type": "best_practice",
  "heat": 60,
  "last_accessed": "2026-03-22T12:30:00.000Z",
  "last_evaluated": "2026-03-22T12:30:00.000Z",
  "access_count": 1,
  "access_sessions": ["session-a"],
  "archived": false
}
```
