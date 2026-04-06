const { buildAutoFixCommand } = require('./auto-fix');

function quoteTemplateValue(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function fillTemplateCommand(command, context = {}) {
  if (!command) {
    return null;
  }

  let rendered = String(command);
  const replacements = [
    ['<workspace>', context.workspace],
    ['<session-key>', context.sessionKey],
    ['<project-id>', context.projectId],
    ['<user-id>', context.userId],
    ['<openclaw-home>', context.openclawHome],
    ['<skills-root>', context.skillsRoot]
  ];

  replacements.forEach(([token, value]) => {
    if (value) {
      rendered = rendered.split(token).join(String(value));
    }
  });

  const optionReplacements = [
    ['--workspace', context.workspace],
    ['--session-key', context.sessionKey],
    ['--project-id', context.projectId],
    ['--user-id', context.userId],
    ['--openclaw-home', context.openclawHome],
    ['--skills-root', context.skillsRoot]
  ];

  optionReplacements.forEach(([flag, value]) => {
    if (!value) {
      return;
    }
    const pattern = new RegExp(`${flag}\\s+["']?<[^>]+>["']?`, 'gi');
    rendered = rendered.replace(pattern, `${flag} ${quoteTemplateValue(value)}`);
  });

  return rendered;
}

function countPlaceholderTokens(command = '') {
  return (String(command).match(/<[^>]+>/g) || []).length;
}

function countCommandFlags(command = '') {
  return (String(command).match(/--[a-z0-9-]+/gi) || []).length;
}

function inferConfirmOnlyRequirement(source, action = {}, strategy = {}) {
  const type = String(strategy.type || action?.type || '').toLowerCase();
  const sourceKey = String(source || 'unknown').toLowerCase();
  const haystack = [
    strategy.summary,
    action?.summary,
    strategy.resolution_hint,
    ...(Array.isArray(strategy.command_examples) ? strategy.command_examples : []),
    ...(Array.isArray(action?.command_examples) ? action.command_examples : []),
    action?.recheck_command,
    action?.command
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  const templateCommands = [
    ...(Array.isArray(strategy.command_examples) ? strategy.command_examples : []),
    ...(Array.isArray(action?.command_examples) ? action.command_examples : []),
    action?.command,
    action?.recheck_command
  ]
    .filter(Boolean)
    .map((entry) => String(entry));
  const rankForSource = (entry) => {
    if (sourceKey.includes('doctor')) {
      return entry.includes('doctor') ? 0 : entry.includes('configure:host') ? 1 : 2;
    }
    if (sourceKey.includes('status_report') || sourceKey.includes('status-report')) {
      return entry.includes('status-report') ? 0 : entry.includes('status:sessions') ? 1 : 2;
    }
    if (sourceKey.includes('session')) {
      return entry.includes('status:sessions') ? 0 : entry.includes('configure:sessions') ? 1 : 2;
    }
    if (sourceKey.includes('upgrade')) {
      return entry.includes('upgrade:sessions') ? 0 : entry.includes('configure:sessions') ? 1 : entry.includes('status:sessions') ? 2 : 3;
    }
    return 0;
  };
  const rankForEffort = (entry) => {
    const unresolvedPlaceholders = countPlaceholderTokens(entry);
    const flagCount = countCommandFlags(entry);
    return unresolvedPlaceholders * 100 + flagCount;
  };
  const firstMatchingCommand = (predicate) => {
    if (typeof predicate !== 'function') {
      return templateCommands[0] || null;
    }
    const matches = templateCommands.filter((entry) => predicate(entry));
    if (matches.length === 0) {
      return templateCommands[0] || null;
    }
    return (
      matches.sort((left, right) => {
        const sourceDelta = rankForSource(left) - rankForSource(right);
        if (sourceDelta !== 0) {
          return sourceDelta;
        }
        const effortDelta = rankForEffort(left) - rankForEffort(right);
        if (effortDelta !== 0) {
          return effortDelta;
        }
        return String(left).length - String(right).length;
      })[0] || null
    );
  };

  if (haystack.includes('<session-key>') || /--session-key\b/.test(haystack)) {
    return {
      key: 'session_key',
      blocked_reason: 'Select the target session first; auto-fix will stay unavailable until the session key is explicit.',
      resume_hint:
        'Re-run the suggested command with an explicit --session-key, then auto-fix can resume on the selected session.',
      resume_command: fillTemplateCommand(
        firstMatchingCommand((entry) => entry.includes('<session-key>') || /--session-key\b/.test(entry)),
        action?.resume_context || {}
      )
    };
  }

  if (type === 'select_workspace_then_recheck' || haystack.includes('<workspace>') || /--workspace\b/.test(haystack)) {
    return {
      key: 'workspace',
      blocked_reason: 'Select the target workspace first; auto-fix will stay unavailable until the workspace is explicit.',
      resume_hint:
        'Re-run the suggested command with an explicit --workspace, then auto-fix can resume on the resolved workspace.',
      resume_command: fillTemplateCommand(
        firstMatchingCommand((entry) => entry.includes('<workspace>') || /--workspace\b/.test(entry)),
        action?.resume_context || {}
      )
    };
  }

  if (haystack.includes('<project-id>') || /--project-id\b/.test(haystack)) {
    return {
      key: 'project_id',
      blocked_reason: 'Select the target project first; auto-fix will stay unavailable until the project is explicit.',
      resume_hint:
        'Re-run the suggested command with an explicit --project-id, then auto-fix can resume on the selected project.',
      resume_command: fillTemplateCommand(
        firstMatchingCommand((entry) => entry.includes('<project-id>') || /--project-id\b/.test(entry)),
        action?.resume_context || {}
      )
    };
  }

  if (haystack.includes('<openclaw-home>') || /--openclaw-home\b/.test(haystack) || haystack.includes('profile')) {
    return {
      key: 'profile',
      blocked_reason: 'Select the target OpenClaw profile first; auto-fix will stay unavailable until the profile is explicit.',
      resume_hint:
        'Re-run the suggested command with an explicit --openclaw-home or target profile, then auto-fix can resume on the selected profile.',
      resume_command: fillTemplateCommand(
        firstMatchingCommand(
          (entry) => entry.includes('<openclaw-home>') || /--openclaw-home\b/.test(entry) || /profile/.test(entry)
        ),
        action?.resume_context || {}
      )
    };
  }

  return {
    key: 'confirmation',
    blocked_reason:
      'This path still needs one manual confirmation before automation can continue, so auto-fix is intentionally disabled for now.',
    resume_hint:
      'Finish the required confirmation step first, then rerun the suggested command to unlock auto-fix.',
    resume_command: fillTemplateCommand(firstMatchingCommand(() => true), action?.resume_context || {})
  };
}

function normalizeRemediationEntry(source, action = {}, options = {}) {
  const strategy = action?.repair_strategy || action || {};
  const label = strategy.label || null;
  const executionMode = strategy.execution_mode === 'manual' ? 'manual' : 'automatic';
  const requiresManualConfirmation = Boolean(strategy.requires_manual_confirmation);
  const recheckCommand = action?.recheck_command || strategy?.recheck_command || null;
  const manualSubtype = executionMode === 'manual' ? strategy.manual_subtype || 'confirm_only' : null;
  const externalIssueType = executionMode === 'manual' ? strategy.external_issue_type || null : null;
  const confirmRequirement =
    executionMode === 'manual' && manualSubtype !== 'external_environment'
      ? inferConfirmOnlyRequirement(source, action, strategy)
      : null;

  if (!label && !recheckCommand) {
    return null;
  }

  const autoFixBlockedReason =
    executionMode === 'manual'
      ? manualSubtype === 'external_environment'
        ? externalIssueType === 'workspace_registration_missing'
          ? 'Resolve or update the broken workspace registration first; auto-fix is intentionally disabled for this external-environment issue.'
          : externalIssueType === 'workspace_path_unresolved'
          ? 'Provide or recover the correct workspace path first; auto-fix is intentionally disabled for this external-environment issue.'
          : 'Resolve the external environment issue first; auto-fix is intentionally disabled for this path.'
        : confirmRequirement.blocked_reason
      : null;
  const autoFixResumeHint =
    executionMode === 'manual'
      ? manualSubtype === 'external_environment'
        ? null
        : confirmRequirement.resume_hint
      : null;

  return {
    source: source || 'unknown',
    type: strategy.type || action?.type || 'unknown',
    label,
    summary: strategy.summary || action?.summary || null,
    execution_mode: executionMode,
    manual_subtype: manualSubtype,
    external_issue_type: externalIssueType,
    requires_manual_confirmation: requiresManualConfirmation,
    recheck_command: recheckCommand,
    command: action?.command || null,
    follow_up_command: action?.follow_up_command || null,
    command_sequence: buildRemediationCommandSequence(action),
    auto_fix_command:
      executionMode === 'manual'
        ? null
        : buildAutoFixCommand(buildRemediationCommandSequence(action), {
            ...(options.auto_fix_options || {}),
            strategyType: strategy.type || action?.type || null,
            actionType: action?.type || strategy.type || null,
            issues: action?.issues || []
          }),
    auto_fix_blocked_reason: autoFixBlockedReason,
    auto_fix_resume_hint: autoFixResumeHint,
    auto_fix_resume_command:
      executionMode === 'manual' && manualSubtype !== 'external_environment'
        ? confirmRequirement.resume_command || null
        : null,
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
  inferConfirmOnlyRequirement,
  normalizeRemediationEntry
};
