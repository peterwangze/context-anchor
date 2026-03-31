#!/usr/bin/env node

const path = require('path');
const {
  buildCheckpointContent,
  createPaths,
  getRepoRoot,
  loadRankedCollection,
  loadSessionState,
  projectDecisionsFile,
  readText,
  sanitizeKey,
  sessionCheckpointFile,
  sessionMemoryFile,
  writeSessionState,
  writeText
} = require('./lib/context-anchor');

function runCheckpointCreate(workspaceArg, sessionKeyArg, reasonArg, options = {}) {
  const paths = createPaths(workspaceArg);
  const sessionKey = sanitizeKey(sessionKeyArg);
  const reason = reasonArg || 'manual';
  const sessionState = loadSessionState(paths, sessionKey, undefined, {
    createIfMissing: true,
    touch: true
  });
  const memoryEntries = loadRankedCollection(sessionMemoryFile(paths, sessionKey), 'entries', {
    minHeat: 0,
    limit: 5
  });
  const decisions = loadRankedCollection(projectDecisionsFile(paths, sessionState.project_id), 'decisions', {
    minHeat: 0,
    limit: 5
  });
  const templateFile = path.join(getRepoRoot(), 'templates', 'checkpoint.md');
  const template = readText(templateFile);
  const timestamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  const content = buildCheckpointContent(template, {
    timestamp,
    activeTask: sessionState.active_task || '无',
    hotMemories:
      memoryEntries
        .map((entry) => `- [${entry.type}] ${entry.summary || entry.content}`)
        .join('\n') || '无',
    keyDecisions:
      decisions
        .map((entry) => `- ${entry.decision}`)
        .join('\n') || '无',
    pendingCommitments:
      (sessionState.commitments || [])
        .filter((entry) => entry.status === 'pending')
        .map((entry) => `- ${entry.what}`)
        .join('\n') || '无',
    nextSteps: options.nextSteps || sessionState.metadata?.next_steps || '继续当前任务'
  });

  const appendix = [
    '',
    '---',
    `- 创建时间: ${new Date().toISOString()}`,
    `- 保存原因: ${reason}`,
    `- Session: ${sessionState.session_key}`
  ];

  if (options.usagePercent !== undefined) {
    appendix.push(`- 上下文使用率: ${options.usagePercent}%`);
  }

  const checkpointFile = sessionCheckpointFile(paths, sessionKey);
  writeText(checkpointFile, `${content.trimEnd()}\n${appendix.join('\n')}\n`);

  sessionState.last_checkpoint = new Date().toISOString();
  sessionState.checkpoint_reason = reason;
  writeSessionState(paths, sessionKey, sessionState);

  return {
    status: 'created',
    checkpoint_file: checkpointFile,
    timestamp: sessionState.last_checkpoint,
    reason,
    active_task: sessionState.active_task,
    pending_commitments: (sessionState.commitments || []).filter(
      (entry) => entry.status === 'pending'
    ).length
  };
}

function main() {
  const usagePercent = process.argv[5] ? Number(process.argv[5]) : undefined;
  const result = runCheckpointCreate(process.argv[2], process.argv[3], process.argv[4], {
    usagePercent
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runCheckpointCreate
};
