const fs = require('fs');

const { buildAutoFixCommand } = require('./auto-fix');

const RESUME_INPUT_FLAGS = {
  workspace: '--workspace',
  'session-key': '--session-key',
  'project-id': '--project-id',
  'user-id': '--user-id',
  'openclaw-home': '--openclaw-home',
  'skills-root': '--skills-root'
};

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

function listMissingTemplateInputs(command = '') {
  const tokens = (String(command).match(/<([^>]+)>/g) || [])
    .map((entry) => entry.slice(1, -1).trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(tokens)];
}

function describeMissingTemplateInput(input) {
  const key = String(input || '').toLowerCase();
  switch (key) {
    case 'workspace':
      return {
        key,
        label: 'workspace',
        description: '当前需要修复或回检的工作区路径。',
        example: 'D:/workspace/project'
      };
    case 'session-key':
      return {
        key,
        label: 'session-key',
        description: '当前需要继续处理或诊断的 session 标识。',
        example: 'agent:main:checkout-fix'
      };
    case 'project-id':
      return {
        key,
        label: 'project-id',
        description: '当前工作区下对应的项目标识。',
        example: 'checkout-retry'
      };
    case 'user-id':
      return {
        key,
        label: 'user-id',
        description: '当前归属用户标识。',
        example: 'default-user'
      };
    case 'openclaw-home':
      return {
        key,
        label: 'openclaw-home',
        description: '目标 OpenClaw profile 的数据目录。',
        example: 'D:/openclaw-home'
      };
    case 'skills-root':
      return {
        key,
        label: 'skills-root',
        description: 'OpenClaw 扫描技能快照的目录。',
        example: 'D:/openclaw-home/skills'
      };
    default:
      return {
        key,
        label: key,
        description: '继续执行恢复命令前仍需补齐的输入。',
        example: null
      };
  }
}

function uniqueStringList(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map((entry) => String(entry)))];
}

function isPathLikeResumeInput(input) {
  return ['workspace', 'openclaw-home', 'skills-root'].includes(String(input || '').toLowerCase());
}

function sortResumeCandidates(input, values = []) {
  const entries = uniqueStringList(values);
  if (!isPathLikeResumeInput(input)) {
    return entries;
  }

  return entries.sort((left, right) => {
    const leftExists = fs.existsSync(left);
    const rightExists = fs.existsSync(right);
    if (leftExists !== rightExists) {
      return leftExists ? -1 : 1;
    }
    return left.localeCompare(right);
  });
}

function buildResumeInputCandidates(input, context = {}) {
  const key = String(input || '').toLowerCase();
  switch (key) {
    case 'workspace':
      return sortResumeCandidates(key, [
        context.workspace,
        ...(Array.isArray(context.candidateWorkspaces) ? context.candidateWorkspaces : [])
      ]).slice(0, 3);
    case 'session-key':
      return uniqueStringList([
        context.sessionKey,
        ...(Array.isArray(context.candidateSessionKeys) ? context.candidateSessionKeys : [])
      ]).slice(0, 3);
    case 'project-id':
      return uniqueStringList([
        context.projectId,
        ...(Array.isArray(context.candidateProjectIds) ? context.candidateProjectIds : [])
      ]).slice(0, 3);
    case 'user-id':
      return uniqueStringList([
        context.userId,
        ...(Array.isArray(context.candidateUserIds) ? context.candidateUserIds : [])
      ]).slice(0, 3);
    case 'openclaw-home':
      return sortResumeCandidates(key, [
        context.openclawHome,
        ...(Array.isArray(context.candidateOpenClawHomes) ? context.candidateOpenClawHomes : [])
      ]).slice(0, 3);
    case 'skills-root':
      return sortResumeCandidates(key, [
        context.skillsRoot,
        ...(Array.isArray(context.candidateSkillsRoots) ? context.candidateSkillsRoots : [])
      ]).slice(0, 3);
    default:
      return [];
  }
}

function inputToContextKey(input) {
  switch (String(input || '').toLowerCase()) {
    case 'workspace':
      return 'workspace';
    case 'session-key':
      return 'sessionKey';
    case 'project-id':
      return 'projectId';
    case 'user-id':
      return 'userId';
    case 'openclaw-home':
      return 'openclawHome';
    case 'skills-root':
      return 'skillsRoot';
    default:
      return null;
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractResumeInputValue(command = '', input) {
  const flag = RESUME_INPUT_FLAGS[String(input || '').toLowerCase()];
  if (!flag) {
    return null;
  }

  const pattern = new RegExp(`${escapeRegex(flag)}\\s+(?:"([^"]*)"|'([^']*)'|([^\\s]+))`, 'i');
  const match = String(command || '').match(pattern);
  if (!match) {
    return null;
  }

  return match[1] || match[2] || match[3] || null;
}

function isPlaceholderValue(value) {
  return /^<[^>]+>$/.test(String(value || '').trim());
}

function listResumeInputKeys(command = '') {
  const keys = new Set(listMissingTemplateInputs(command));
  Object.entries(RESUME_INPUT_FLAGS).forEach(([input, flag]) => {
    if (new RegExp(`${escapeRegex(flag)}\\b`, 'i').test(String(command || ''))) {
      keys.add(input);
    }
  });
  return [...keys];
}

function buildResumeInputValidationDetail(input, command = '', context = {}) {
  const metadata = describeMissingTemplateInput(input);
  const candidates = buildResumeInputCandidates(input, context);
  const rawValue = extractResumeInputValue(command, input);
  const value = rawValue && !isPlaceholderValue(rawValue) ? rawValue : null;
  const pendingValue = !value;
  let validationStatus = 'ready';
  let validationSummary = '已预填，当前检查通过。';

  if (pendingValue) {
    if (candidates.length > 0) {
      validationStatus = 'candidate_available';
      validationSummary = `仍需补齐，当前已有 ${candidates.length} 个候选值可直接选择。`;
    } else {
      validationStatus = 'needs_value';
      validationSummary = '仍需手工补齐这个输入。';
    }
  } else if (isPathLikeResumeInput(input)) {
    if (fs.existsSync(value)) {
      validationStatus = 'ready';
      validationSummary = '已预填，路径当前存在。';
    } else {
      validationStatus = 'path_missing';
      validationSummary = '已预填，但该路径当前不存在。';
    }
  } else if (candidates.length > 0) {
    if (candidates.includes(value)) {
      validationStatus = 'ready';
      validationSummary = '已预填，且命中了当前候选值。';
    } else {
      validationStatus = 'candidate_mismatch';
      validationSummary = '已预填，但不在当前候选值中。';
    }
  }

  return {
    ...metadata,
    value,
    candidates,
    validation_status: validationStatus,
    validation_summary: validationSummary
  };
}

function summarizeResumeValidation(details = [], resumeCommand = '') {
  if (!resumeCommand) {
    return {
      status: 'needs_attention',
      summary: 'Resume command 还不可用，当前无法继续恢复流程。'
    };
  }

  const attention = details.filter((entry) => ['path_missing', 'candidate_mismatch'].includes(entry.validation_status));
  if (attention.length > 0) {
    const entry = attention[0];
    return {
      status: 'needs_attention',
      summary: `${entry.label}: ${entry.validation_summary}`
    };
  }

  const pending = details.filter((entry) => ['needs_value', 'candidate_available'].includes(entry.validation_status));
  if (pending.length > 0) {
    const entry = pending[0];
    return {
      status: 'needs_input',
      summary: `${entry.label}: ${entry.validation_summary}`
    };
  }

  return {
    status: 'ready',
    summary:
      details.length > 0
        ? 'Resume command 已经补齐，当前已知输入检查通过；重新执行这条命令即可继续流程。'
        : 'Resume command 已可直接重新执行；完成这一步后 auto-fix 就可以继续。'
  };
}

function buildSuggestedResumePlan(command = '', details = [], context = {}) {
  if (!command) {
    return null;
  }

  const suggestionContext = { ...(context || {}) };
  let changed = false;
  let singleCandidateCount = 0;
  let multiCandidateCount = 0;
  const suggestedInputs = [];

  (Array.isArray(details) ? details : []).forEach((entry) => {
    if (entry?.value) {
      return;
    }
    if (!Array.isArray(entry?.candidates) || entry.candidates.length === 0) {
      return;
    }
    const contextKey = inputToContextKey(entry.label);
    if (!contextKey) {
      return;
    }
    suggestionContext[contextKey] = entry.candidates[0];
    changed = true;
    suggestedInputs.push({
      label: entry.label,
      value: entry.candidates[0],
      reason:
        entry.candidates.length === 1
          ? 'only_candidate'
          : isPathLikeResumeInput(entry.label) && fs.existsSync(entry.candidates[0])
          ? 'existing_path'
          : 'top_ranked_candidate'
    });
    if (entry.candidates.length === 1) {
      singleCandidateCount += 1;
    } else {
      multiCandidateCount += 1;
    }
  });

  if (!changed) {
    return null;
  }

  const suggestedCommand = fillTemplateCommand(command, suggestionContext);
  if (!suggestedCommand || suggestedCommand === command) {
    return null;
  }

  const validationDetails = listResumeInputKeys(suggestedCommand).map((entry) =>
    buildResumeInputValidationDetail(entry, suggestedCommand, context || {})
  );
  const validation = summarizeResumeValidation(validationDetails, suggestedCommand);
  const needsReview = multiCandidateCount > 0;
  const suggestedInputsSummary = suggestedInputs
    .map((entry) =>
      entry.reason === 'only_candidate'
        ? `${entry.label}=${entry.value} (only candidate)`
        : entry.reason === 'existing_path'
        ? `${entry.label}=${entry.value} (existing path)`
        : `${entry.label}=${entry.value} (top-ranked candidate)`
    )
    .join(' | ');

  return {
    command: suggestedCommand,
    validation_status: needsReview
      ? 'needs_review'
      : validation.status,
    validation_summary: needsReview
      ? `Suggested resume 已代入排序第一的候选值；其中 ${multiCandidateCount} 个输入仍建议先确认后再重跑。`
      : validation.summary,
    single_candidate_count: singleCandidateCount,
    multi_candidate_count: multiCandidateCount,
    suggested_inputs: suggestedInputs,
    suggested_inputs_summary: suggestedInputsSummary
  };
}

function inferConfirmOnlyRequirement(source, action = {}, strategy = {}) {
  const type = String(strategy.type || action?.type || '').toLowerCase();
  const sourceKey = String(source || 'unknown').toLowerCase();
  const resumeContext = action?.resume_context || {};
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
  const primaryTemplateCommand =
    type === 'select_session_then_recheck'
      ? firstMatchingCommand((entry) => entry.includes('<session-key>') || /--session-key\b/i.test(entry))
      : type === 'select_workspace_then_recheck'
      ? firstMatchingCommand((entry) => entry.includes('<workspace>') || /--workspace\b/i.test(entry))
      : type === 'select_project_then_recheck'
      ? firstMatchingCommand((entry) => entry.includes('<project-id>') || /--project-id\b/i.test(entry))
      : type === 'select_profile_then_recheck'
      ? firstMatchingCommand(
          (entry) =>
            entry.includes('<openclaw-home>') ||
            /--openclaw-home\b/i.test(entry) ||
            entry.includes('<skills-root>') ||
            /--skills-root\b/i.test(entry) ||
            /profile/i.test(entry)
        )
      : firstMatchingCommand(() => true);
  const primaryResumeCommand = fillTemplateCommand(primaryTemplateCommand, resumeContext);
  const pendingInputs = new Set(listMissingTemplateInputs(primaryResumeCommand || primaryTemplateCommand || ''));

  if (pendingInputs.has('session-key')) {
    return {
      key: 'session_key',
      blocked_reason: 'Select the target session first; auto-fix will stay unavailable until the session key is explicit.',
      resume_hint:
        'Re-run the suggested command with an explicit --session-key, then auto-fix can resume on the selected session.',
      resume_command: fillTemplateCommand(
        firstMatchingCommand((entry) => entry.includes('<session-key>')),
        resumeContext
      )
    };
  }

  if (pendingInputs.has('workspace') || (type === 'select_workspace_then_recheck' && !resumeContext.workspace)) {
    return {
      key: 'workspace',
      blocked_reason: 'Select the target workspace first; auto-fix will stay unavailable until the workspace is explicit.',
      resume_hint:
        'Re-run the suggested command with an explicit --workspace, then auto-fix can resume on the resolved workspace.',
      resume_command: fillTemplateCommand(
        firstMatchingCommand((entry) => entry.includes('<workspace>') || /--workspace\b/.test(entry)),
        resumeContext
      )
    };
  }

  if (pendingInputs.has('project-id')) {
    return {
      key: 'project_id',
      blocked_reason: 'Select the target project first; auto-fix will stay unavailable until the project is explicit.',
      resume_hint:
        'Re-run the suggested command with an explicit --project-id, then auto-fix can resume on the selected project.',
      resume_command: fillTemplateCommand(
        firstMatchingCommand((entry) => entry.includes('<project-id>')),
        resumeContext
      )
    };
  }

  if (pendingInputs.has('user-id')) {
    return {
      key: 'user_id',
      blocked_reason: 'Select the target user first; auto-fix will stay unavailable until the user id is explicit.',
      resume_hint:
        'Re-run the suggested command with an explicit --user-id, then auto-fix can resume on the selected user.',
      resume_command: fillTemplateCommand(
        firstMatchingCommand((entry) => entry.includes('<user-id>')),
        resumeContext
      )
    };
  }

  if (pendingInputs.has('skills-root')) {
    return {
      key: 'skills_root',
      blocked_reason: 'Select the target skills root first; auto-fix will stay unavailable until the skills root is explicit.',
      resume_hint:
        'Re-run the suggested command with an explicit --skills-root, then auto-fix can resume on the selected profile assets.',
      resume_command: fillTemplateCommand(
        firstMatchingCommand((entry) => entry.includes('<skills-root>')),
        resumeContext
      )
    };
  }

  if (
    pendingInputs.has('openclaw-home') ||
    (type === 'select_profile_then_recheck' && !resumeContext.openclawHome)
  ) {
    return {
      key: 'profile',
      blocked_reason: 'Select the target OpenClaw profile first; auto-fix will stay unavailable until the profile is explicit.',
      resume_hint:
        'Re-run the suggested command with an explicit --openclaw-home or target profile, then auto-fix can resume on the selected profile.',
      resume_command: fillTemplateCommand(
        firstMatchingCommand(
          (entry) => entry.includes('<openclaw-home>') || /--openclaw-home\b/.test(entry) || /profile/.test(entry)
        ),
        resumeContext
      )
    };
  }

  return {
    key: 'confirmation',
    blocked_reason:
      'This path still needs one manual rerun of the suggested command before automation can continue, so auto-fix is intentionally disabled for now.',
    resume_hint:
      'Rerun the suggested command once with the current confirmed inputs, then auto-fix can continue from the refreshed state.',
    resume_command: primaryResumeCommand
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
  const resumeCommand =
    executionMode === 'manual' && manualSubtype !== 'external_environment'
      ? confirmRequirement.resume_command || null
      : null;
  const resumeInputDetails =
    executionMode === 'manual' && manualSubtype !== 'external_environment'
      ? listResumeInputKeys(resumeCommand).map((entry) =>
          buildResumeInputValidationDetail(entry, resumeCommand, action?.resume_context || {})
        )
      : [];
  const resumeValidation =
    executionMode === 'manual' && manualSubtype !== 'external_environment'
      ? summarizeResumeValidation(resumeInputDetails, resumeCommand)
      : null;
  const suggestedResumePlan =
    executionMode === 'manual' && manualSubtype !== 'external_environment'
      ? buildSuggestedResumePlan(resumeCommand, resumeInputDetails, action?.resume_context || {})
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
  const affectedTargets = [...new Set(
    (Array.isArray(strategy.affected_targets)
      ? strategy.affected_targets
      : Array.isArray(action?.affected_targets)
      ? action.affected_targets
      : []
    )
      .filter(Boolean)
      .map((entry) => String(entry))
  )];
  const affectedTargetsSummary =
    strategy.affected_targets_summary ||
    action?.affected_targets_summary ||
    (affectedTargets.length > 0
      ? affectedTargets.length <= 3
        ? affectedTargets.join(' | ')
        : `${affectedTargets.slice(0, 3).join(' | ')} | +${affectedTargets.length - 3} more`
      : null);

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
        ? resumeCommand
        : null,
    auto_fix_resume_missing_inputs:
      executionMode === 'manual' && manualSubtype !== 'external_environment'
        ? listMissingTemplateInputs(resumeCommand || '')
        : [],
    auto_fix_resume_input_details:
      executionMode === 'manual' && manualSubtype !== 'external_environment'
        ? resumeInputDetails
        : [],
    auto_fix_resume_validation_status:
      executionMode === 'manual' && manualSubtype !== 'external_environment'
        ? resumeValidation?.status || null
        : null,
    auto_fix_resume_validation_summary:
      executionMode === 'manual' && manualSubtype !== 'external_environment'
        ? resumeValidation?.summary || null
        : null,
    auto_fix_resume_suggested_command:
      executionMode === 'manual' && manualSubtype !== 'external_environment'
        ? suggestedResumePlan?.command || null
        : null,
    auto_fix_resume_suggested_validation_status:
      executionMode === 'manual' && manualSubtype !== 'external_environment'
        ? suggestedResumePlan?.validation_status || null
        : null,
    auto_fix_resume_suggested_validation_summary:
      executionMode === 'manual' && manualSubtype !== 'external_environment'
        ? suggestedResumePlan?.validation_summary || null
        : null,
    auto_fix_resume_suggested_inputs:
      executionMode === 'manual' && manualSubtype !== 'external_environment'
        ? suggestedResumePlan?.suggested_inputs || []
        : [],
    auto_fix_resume_suggested_inputs_summary:
      executionMode === 'manual' && manualSubtype !== 'external_environment'
        ? suggestedResumePlan?.suggested_inputs_summary || null
        : null,
    affected_targets: affectedTargets,
    affected_targets_summary: affectedTargetsSummary,
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
  const rankNextStep = (entry) => {
    const isNoop = ['none', 'recheck_only', 'unknown'].includes(String(entry?.type || '').toLowerCase()) ? 1 : 0;
    const manualRank = entry?.execution_mode === 'manual' ? 1 : 0;
    return isNoop * 100 + manualRank * 10;
  };
  const nextStep =
    [...entries].sort((left, right) => {
      const rankDelta = rankNextStep(left) - rankNextStep(right);
      if (rankDelta !== 0) {
        return rankDelta;
      }
      return 0;
    })[0] || null;

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
  buildResumeInputCandidates,
  buildRemediationCommandSequence,
  describeMissingTemplateInput,
  dedupeEntries,
  inferConfirmOnlyRequirement,
  extractResumeInputValue,
  listMissingTemplateInputs,
  listResumeInputKeys,
  normalizeRemediationEntry
};
