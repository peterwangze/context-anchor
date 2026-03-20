#!/usr/bin/env node
/**
 * Checkpoint Creation Script
 * Creates a checkpoint file with current session state
 *
 * Usage: node checkpoint-create.js <workspace> <session-key> [reason]
 */

const fs = require('fs');
const path = require('path');

const workspace = process.argv[2] || process.cwd();
const sessionKey = (process.argv[3] || 'default').replace(/[:/]/g, '-');
const reason = process.argv[4] || 'manual';

const anchorDir = path.join(workspace, '.context-anchor');
const sessionsDir = path.join(anchorDir, 'sessions');
const sessionDir = path.join(sessionsDir, sessionKey);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJson(file, defaultValue = {}) {
  if (!fs.existsSync(file)) {
    return defaultValue;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return defaultValue;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function createCheckpoint() {
  ensureDir(sessionDir);

  const sessionStateFile = path.join(sessionDir, 'state.json');
  const memoryHotFile = path.join(sessionDir, 'memory-hot.json');
  const checkpointFile = path.join(sessionDir, 'checkpoint.md');

  const sessionState = readJson(sessionStateFile, {
    session_key: sessionKey,
    active_task: null,
    commitments: []
  });

  const memoryHot = readJson(memoryHotFile, { entries: [] });

  // Get hot memories (heat > 80)
  const hotMemories = memoryHot.entries
    .filter(e => e.heat > 80)
    .slice(0, 5)
    .map(e => `- [${e.type}] ${e.content?.substring(0, 100) || e.summary?.substring(0, 100)}`)
    .join('\n');

  // Get pending commitments
  const pendingCommitments = (sessionState.commitments || [])
    .filter(c => c.status === 'pending')
    .map(c => `- ${c.what}`)
    .join('\n');

  // Build checkpoint content
  const timestamp = new Date().toISOString();
  const dateStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  let checkpoint = `# Context Checkpoint — ${dateStr}

## 当前任务
${sessionState.active_task || '无'}

## 工作记忆（热度 > 80）
${hotMemories || '无'}

## 未完成承诺
${pendingCommitments || '无'}

## 下一步
继续当前任务...

---
- 创建时间: ${timestamp}
- 保存原因: ${reason}
- Session: ${sessionKey}
`;

  // Write checkpoint
  fs.writeFileSync(checkpointFile, checkpoint);

  // Update session state
  sessionState.last_checkpoint = timestamp;
  sessionState.checkpoint_reason = reason;
  writeJson(sessionStateFile, sessionState);

  console.log(JSON.stringify({
    status: 'created',
    checkpoint_file: checkpointFile,
    timestamp,
    reason,
    active_task: sessionState.active_task,
    pending_commitments: (sessionState.commitments || []).filter(c => c.status === 'pending').length
  }, null, 2));
}

createCheckpoint();
