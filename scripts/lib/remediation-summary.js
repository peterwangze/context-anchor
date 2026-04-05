const { buildAutoFixCommand } = require('./auto-fix');

function normalizeRemediationEntry(source, action = {}, options = {}) {
  const strategy = action?.repair_strategy || action || {};
  const label = strategy.label || null;
  const executionMode = strategy.execution_mode === 'manual' ? 'manual' : 'automatic';
  const requiresManualConfirmation = Boolean(strategy.requires_manual_confirmation);
  const recheckCommand = action?.recheck_command || strategy?.recheck_command || null;

  if (!label && !recheckCommand) {
    return null;
  }

  return {
    source: source || 'unknown',
    type: strategy.type || action?.type || 'unknown',
    label,
    summary: strategy.summary || action?.summary || null,
    execution_mode: executionMode,
    manual_subtype: executionMode === 'manual' ? strategy.manual_subtype || 'confirm_only' : null,
    external_issue_type: executionMode === 'manual' ? strategy.external_issue_type || null : null,
    requires_manual_confirmation: requiresManualConfirmation,
    recheck_command: recheckCommand,
    command: action?.command || null,
    follow_up_command: action?.follow_up_command || null,
    command_sequence: buildRemediationCommandSequence(action),
    auto_fix_command: buildAutoFixCommand(buildRemediationCommandSequence(action), options.auto_fix_options || {}),
    resolution_hint: strategy.resolution_hint || action?.resolution_hint || null,
    command_examples: Array.isArray(strategy.command_examples)
      ? strategy.command_examples.filter(Boolean)
      : Array.isArray(action?.command_examples)
      ? action.command_examples.filter(Boolean)
      : []
  };
}

function buildRemediationCommandSequence(action = {}) {
  if (Array.isArray(action?.repair_sequence) && action.repair_sequence.length > 0) {
    return action.repair_sequence
      .map((entry) =>
        entry?.command
          ? {
              step: entry.step || 'repair',
              command: entry.command
            }
          : null
      )
      .filter(Boolean);
  }

  return [
    action?.command ? { step: 'repair', command: action.command } : null,
    action?.follow_up_command ? { step: 'follow_up', command: action.follow_up_command } : null,
    action?.recheck_command ? { step: 'recheck', command: action.recheck_command } : null
  ].filter(Boolean);
}

function dedupeEntries(entries = []) {
  const seen = new Set();
  return entries.filter((entry) => {
    if (!entry) {
      return false;
    }
    const key = [
      entry.source || '',
      entry.type || '',
      entry.label || '',
      entry.execution_mode || '',
      entry.recheck_command || ''
    ].join('::');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildRemediationSummary(pairs = [], options = {}) {
  const entries = dedupeEntries(
    (Array.isArray(pairs) ? pairs : [])
      .map((pair) => normalizeRemediationEntry(pair?.source, pair?.action, options))
      .filter(Boolean)
  );
  const automatic = entries.filter((entry) => entry.execution_mode !== 'manual');
  const manual = entries.filter((entry) => entry.execution_mode === 'manual');
  const manualConfirmOnly = manual.filter((entry) => entry.manual_subtype === 'confirm_only');
  const manualExternalEnvironment = manual.filter((entry) => entry.manual_subtype === 'external_environment');
  const manualExternalIssueTypes = manualExternalEnvironment.reduce((acc, entry) => {
    const key = entry.external_issue_type || 'unknown_external_issue';
    acc[key] = Number(acc[key] || 0) + 1;
    return acc;
  }, {});
  const recheckCommands = [...new Set(entries.map((entry) => entry.recheck_command).filter(Boolean))];
  const nextStep = automatic[0] || manual[0] || null;

  return {
    total: entries.length,
    status:
      manual.length > 0
        ? 'manual_required'
        : automatic.length > 0
        ? 'automatic_available'
        : 'none',
    automatic_count: automatic.length,
    manual_count: manual.length,
    manual_confirm_only_count: manualConfirmOnly.length,
    manual_external_environment_count: manualExternalEnvironment.length,
    manual_external_issue_types: manualExternalIssueTypes,
    next_step: nextStep,
    automatic,
    manual,
    manual_confirm_only: manualConfirmOnly,
    manual_external_environment: manualExternalEnvironment,
    recheck_commands: recheckCommands
  };
}

module.exports = {
  buildRemediationSummary,
  buildRemediationCommandSequence,
  dedupeEntries,
  normalizeRemediationEntry
};
