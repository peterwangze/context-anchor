#!/usr/bin/env node
/**
 * Context Pressure Handler Script
 * Handles context pressure by saving memories and creating checkpoints
 *
 * Usage: node context-pressure-handle.js <workspace> <session-key> <usage-percent>
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const workspace = process.argv[2] || process.cwd();
const sessionKey = (process.argv[3] || 'default').replace(/[:/]/g, '-');
const usagePercent = parseInt(process.argv[4]) || 0;

const anchorDir = path.join(workspace, '.context-anchor');
const sessionsDir = path.join(anchorDir, 'sessions');
const sessionDir = path.join(sessionsDir, sessionKey);

const THRESHOLD_WARNING = 75;
const THRESHOLD_CRITICAL = 85;
const THRESHOLD_EMERGENCY = 90;

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

function handlePressure() {
  ensureDir(sessionDir);

  const result = {
    status: 'handled',
    usage_percent: usagePercent,
    actions: [],
    messages: []
  };

  // Determine pressure level
  if (usagePercent < THRESHOLD_WARNING) {
    result.status = 'normal';
    result.messages.push('上下文压力正常');
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Create checkpoint
  const scriptsDir = path.join(workspace, '..', 'openclaw_project', 'openclaw', 'context-anchor', 'scripts');
  const checkpointScript = path.join(scriptsDir, 'checkpoint-create.js');

  try {
    const reason = usagePercent >= THRESHOLD_EMERGENCY 
      ? 'emergency' 
      : usagePercent >= THRESHOLD_CRITICAL 
        ? 'critical' 
        : 'warning';

    execSync(`node "${checkpointScript}" "${workspace}" "${sessionKey}" "${reason}"`, {
      encoding: 'utf-8',
      stdio: 'pipe'
    });

    result.actions.push('checkpoint_created');
    result.messages.push(`已创建检查点（原因: ${reason}）`);
  } catch (e) {
    result.actions.push('checkpoint_failed');
    result.messages.push('检查点创建失败');
  }

  // Save hot memories
  const memoryHotFile = path.join(sessionDir, 'memory-hot.json');
  const memoryHot = readJson(memoryHotFile, { entries: [] });

  if (memoryHot.entries.length > 0) {
    result.actions.push('memories_saved');
    result.messages.push(`已保存 ${memoryHot.entries.length} 条工作记忆`);
  }

  // Handle critical pressure
  if (usagePercent >= THRESHOLD_CRITICAL) {
    result.actions.push('compact_suggested');
    result.messages.push('⚠️ 上下文压力较高，建议执行 /compact 或精简对话');
  }

  // Handle emergency pressure
  if (usagePercent >= THRESHOLD_EMERGENCY) {
    result.actions.push('emergency_save');
    result.messages.push('🚨 上下文压力过高，已强制保存关键记忆');
  }

  // Update session state
  const sessionStateFile = path.join(sessionDir, 'state.json');
  const sessionState = readJson(sessionStateFile, {});
  sessionState.last_pressure_check = new Date().toISOString();
  sessionState.last_pressure_usage = usagePercent;
  writeJson(sessionStateFile, sessionState);

  console.log(JSON.stringify(result, null, 2));
}

handlePressure();
