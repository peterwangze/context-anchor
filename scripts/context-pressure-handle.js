#!/usr/bin/env node

const { createPaths, loadSessionState, sanitizeKey, writeSessionState } = require('./lib/context-anchor');
const { runCheckpointCreate } = require('./checkpoint-create');
const { runCompactPacketCreate } = require('./compact-packet-create');
const { evaluatePressure } = require('./context-pressure');
const { runMemoryFlow } = require('./memory-flow');

function runContextPressureHandle(workspaceArg, sessionKeyArg, usagePercentArg) {
  const usagePercent = Number(usagePercentArg || 0);
  const evaluation = evaluatePressure(usagePercent);
  const sessionKey = sanitizeKey(sessionKeyArg);
  const paths = createPaths(workspaceArg);
  const sessionState = loadSessionState(paths, sessionKey, undefined, {
    createIfMissing: true,
    touch: true
  });

  const result = {
    status: 'handled',
    usage_percent: usagePercent,
    level: evaluation.level,
    actions: [],
    messages: []
  };

  if (evaluation.level === 'normal') {
    result.status = 'normal';
    result.messages.push('上下文压力正常');
    return result;
  }

  const checkpoint = runCheckpointCreate(paths.workspace, sessionKey, evaluation.level, {
    usagePercent
  });
  result.actions.push('checkpoint_created');
  result.messages.push(`已创建检查点（${checkpoint.reason}）`);

  const compact = runCompactPacketCreate(paths.workspace, sessionKey, {
    reason: evaluation.level,
    usagePercent,
    userId: sessionState.user_id
  });
  result.actions.push('compact_packet_created');
  result.messages.push(`已生成压缩包（${compact.compact_packet_file}）`);

  const flow = runMemoryFlow(paths.workspace, sessionKey, {
    minimumHeat: evaluation.level === 'warning' ? 70 : 60
  });

  if (flow.synced_entries > 0) {
    result.actions.push('memories_synced');
    result.messages.push(`已同步 ${flow.synced_entries} 条可复用记忆`);
  }

  if (usagePercent >= 85) {
    result.actions.push('compact_suggested');
    result.messages.push('⚠️ 上下文压力较高，建议执行 /compact 或开始新会话');
  }

  if (usagePercent >= 90) {
    result.actions.push('emergency_notice');
    result.messages.push('🚨 上下文压力过高，关键记忆已落盘，请立即压缩上下文');
  }

  sessionState.last_pressure_check = new Date().toISOString();
  sessionState.last_pressure_usage = usagePercent;
  writeSessionState(paths, sessionKey, sessionState);

  return result;
}

function main() {
  const result = runContextPressureHandle(process.argv[2], process.argv[3], process.argv[4]);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runContextPressureHandle
};
