const fs = require('fs');
const path = require('path');
const { getOpenClawHome, sanitizeKey } = require('./context-anchor');

function readTextFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function readFirstJsonLine(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const content = readTextFile(filePath);
  const firstLine = content.split(/\r?\n/, 1)[0].trim();
  if (!firstLine) {
    return null;
  }

  try {
    return JSON.parse(firstLine);
  } catch {
    return null;
  }
}

function resolveSessionFilePath(sessionsDir, sessionKey, entry = {}) {
  if (entry.sessionFile) {
    return path.isAbsolute(entry.sessionFile)
      ? entry.sessionFile
      : path.resolve(sessionsDir, entry.sessionFile);
  }

  const sessionId = entry.sessionId || sessionKey;
  return path.join(sessionsDir, `${sessionId}.jsonl`);
}

function loadSessionWorkspace(sessionFile) {
  const header = readFirstJsonLine(sessionFile);
  if (!header || typeof header !== 'object') {
    return {
      workspace: null,
      workspace_source: null
    };
  }

  const workspace =
    header.cwd ||
    header.workspaceDir ||
    header.workspace ||
    header.context?.workspaceDir ||
    null;

  if (!workspace) {
    return {
      workspace: null,
      workspace_source: null
    };
  }

  return {
    workspace: path.resolve(workspace),
    workspace_source: header.cwd ? 'cwd' : 'workspaceDir'
  };
}

function discoverOpenClawSessions(openClawHomeArg) {
  const openClawHome = getOpenClawHome(openClawHomeArg);
  const agentsDir = path.join(openClawHome, 'agents');
  if (!fs.existsSync(agentsDir)) {
    return [];
  }

  const discovered = [];
  for (const agentEntry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!agentEntry.isDirectory()) {
      continue;
    }

    const agentName = agentEntry.name;
    const sessionsDir = path.join(agentsDir, agentName, 'sessions');
    const indexFile = path.join(sessionsDir, 'sessions.json');
    if (!fs.existsSync(indexFile)) {
      continue;
    }

    let indexData;
    try {
      indexData = JSON.parse(readTextFile(indexFile));
    } catch {
      continue;
    }

    if (!indexData || typeof indexData !== 'object' || Array.isArray(indexData)) {
      continue;
    }

    for (const [sessionKey, entry] of Object.entries(indexData)) {
      const sessionFile = resolveSessionFilePath(sessionsDir, sessionKey, entry || {});
      const sessionFileExists = fs.existsSync(sessionFile);
      const workspaceInfo = sessionFileExists
        ? loadSessionWorkspace(sessionFile)
        : {
            workspace: null,
            workspace_source: null
          };

      discovered.push({
        agent: agentName,
        agent_session_index_file: indexFile,
        session_key: sessionKey,
        sanitized_session_key: sanitizeKey(sessionKey),
        session_id: entry?.sessionId || null,
        session_file: sessionFileExists ? sessionFile : null,
        session_index_session_file: entry?.sessionFile || null,
        updated_at: entry?.updatedAt || null,
        chat_type: entry?.chatType || null,
        delivery_context: entry?.deliveryContext || null,
        system_sent: Boolean(entry?.systemSent),
        aborted_last_run: Boolean(entry?.abortedLastRun),
        workspace: workspaceInfo.workspace,
        workspace_source: workspaceInfo.workspace_source,
        transcript_exists: sessionFileExists
      });
    }
  }

  return discovered.sort((left, right) => {
    return Number(right.updated_at || 0) - Number(left.updated_at || 0);
  });
}

module.exports = {
  discoverOpenClawSessions,
  loadSessionWorkspace,
  readFirstJsonLine,
  resolveSessionFilePath
};
