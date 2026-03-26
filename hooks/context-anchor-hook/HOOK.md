---
name: context-anchor-hook
description: "Inject context-anchor session memory into agent bootstrap and close sessions on OpenClaw command lifecycle events"
homepage: https://docs.openclaw.ai/automation/hooks
metadata:
  {
    "openclaw":
      {
        "emoji": "🔗",
        "events": ["agent:bootstrap", "command:new", "command:reset", "command:stop"],
        "requires": { "bins": ["node"], "config": ["workspace.dir"] },
      },
  }
---

# Context Anchor Hook

Connects `context-anchor` to OpenClaw's real managed-hook lifecycle:

- `agent:bootstrap`: injects persisted session context into the current run
- `command:new`: closes the current context-anchor session before OpenClaw resets
- `command:reset`: closes the current context-anchor session before OpenClaw resets
- `command:stop`: closes the current context-anchor session when `/stop` is issued

## Notes

- Background heartbeat / maintenance is handled by the external workspace monitor, not by a managed hook event.
- If a workspace is not registered in `context-anchor-host-config.json`, the hook injects setup guidance instead of auto-assigning ownership.
- Manual CLI debugging is still supported through `handler.js`, but OpenClaw itself loads this hook via the default export and managed event objects.
