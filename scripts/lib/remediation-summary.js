function normalizeRemediationEntry(source, action = {}) {
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
    follow_up_command: action?.follow_up_command || null
  };
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

function buildRemediationSummary(pairs = []) {
  const entries = dedupeEntries(
    (Array.isArray(pairs) ? pairs : [])
      .map((pair) => normalizeRemediationEntry(pair?.source, pair?.action))
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
  dedupeEntries,
  normalizeRemediationEntry
};
