#!/usr/bin/env node

const { DEFAULTS } = require('./lib/context-anchor');

function evaluatePressure(usagePercent) {
  if (usagePercent === undefined || Number.isNaN(Number(usagePercent))) {
    return {
      status: 'ready',
      thresholds: {
        warning: DEFAULTS.thresholdWarning,
        critical: DEFAULTS.thresholdCritical,
        emergency: DEFAULTS.thresholdEmergency
      },
      instructions: {
        warning: 'Create a checkpoint and sync reusable hot memories to the project store.',
        critical: 'Create a checkpoint, sync memories, and recommend /compact.',
        emergency: 'Force checkpoint creation, sync memories, and require immediate compaction.'
      }
    };
  }

  const usage = Number(usagePercent);
  let level = 'normal';
  const actions = [];

  if (usage >= DEFAULTS.thresholdEmergency) {
    level = 'emergency';
    actions.push('create_checkpoint', 'sync_memories', 'recommend_compact', 'force_attention');
  } else if (usage >= DEFAULTS.thresholdCritical) {
    level = 'critical';
    actions.push('create_checkpoint', 'sync_memories', 'recommend_compact');
  } else if (usage >= DEFAULTS.thresholdWarning) {
    level = 'warning';
    actions.push('create_checkpoint', 'sync_memories');
  }

  return {
    status: 'evaluated',
    usage_percent: usage,
    level,
    actions,
    requires_compact: usage >= DEFAULTS.thresholdCritical
  };
}

function main() {
  const result = evaluatePressure(process.argv[2] ? Number(process.argv[2]) : undefined);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluatePressure
};
