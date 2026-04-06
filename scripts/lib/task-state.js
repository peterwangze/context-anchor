function hasOwnValue(target, key) {
  return Object.prototype.hasOwnProperty.call(target || {}, key);
}

function stringifyStructuredTaskState(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((entry) => normalizeTaskStateText(entry)).filter(Boolean);
    return items.length > 0 ? items.join('; ') : null;
  }

  if (typeof value === 'object') {
    const preferredKeys = ['summary', 'text', 'title', 'goal', 'what', 'current_goal', 'label', 'name'];
    for (const key of preferredKeys) {
      if (hasOwnValue(value, key)) {
        const normalized = normalizeTaskStateText(value[key]);
        if (normalized) {
          return normalized;
        }
      }
    }

    const structuredEntries = Object.entries(value)
      .map(([key, entryValue]) => {
        const normalized = normalizeTaskStateText(entryValue);
        return normalized ? `${key}=${normalized}` : null;
      })
      .filter(Boolean);
    return structuredEntries.length > 0 ? structuredEntries.join('; ') : null;
  }

  return null;
}

function normalizeTaskStateText(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = stringifyStructuredTaskState(value);
  if (!text) {
    return null;
  }

  const normalized = String(text).trim();
  if (!normalized || normalized === '[object Object]') {
    return null;
  }
  return normalized ? normalized : null;
}

function buildTaskStateSummaryLine(parts) {
  const text = parts.filter(Boolean).join(' ; ');
  return text || 'No task-state continuity summary available.';
}

function buildTaskStateSummary(state = {}) {
  const currentGoal = normalizeTaskStateText(state.current_goal);
  const latestVerifiedResult = normalizeTaskStateText(state.latest_verified_result);
  const nextStep = normalizeTaskStateText(state.next_step);
  const blockedBy = normalizeTaskStateText(state.blocked_by);
  const lastUserVisibleProgress = normalizeTaskStateText(state.last_user_visible_progress);
  const visible =
    Boolean(currentGoal) ||
    Boolean(latestVerifiedResult) ||
    Boolean(nextStep) ||
    Boolean(blockedBy) ||
    Boolean(lastUserVisibleProgress);

  return {
    visible,
    current_goal: currentGoal,
    latest_verified_result: latestVerifiedResult,
    next_step: nextStep,
    blocked_by: blockedBy,
    last_user_visible_progress: lastUserVisibleProgress,
    summary: visible
      ? buildTaskStateSummaryLine([
          currentGoal ? `goal=${currentGoal}` : null,
          latestVerifiedResult ? `result=${latestVerifiedResult}` : null,
          nextStep ? `next=${nextStep}` : null,
          blockedBy ? `blocked_by=${blockedBy}` : null,
          !currentGoal && !latestVerifiedResult && !nextStep && !blockedBy && lastUserVisibleProgress
            ? `progress=${lastUserVisibleProgress}`
            : null
        ])
      : 'No task-state continuity summary available.'
  };
}

function assessTaskStateHealth(summary = {}) {
  const visible = summary?.visible === true;
  const currentGoal = normalizeTaskStateText(summary?.current_goal);
  const latestVerifiedResult = normalizeTaskStateText(summary?.latest_verified_result);
  const nextStep = normalizeTaskStateText(summary?.next_step);
  const blockedBy = normalizeTaskStateText(summary?.blocked_by);
  const lastUserVisibleProgress = normalizeTaskStateText(summary?.last_user_visible_progress);

  if (!visible) {
    return {
      status: 'missing',
      issues: ['task_state_missing'],
      summary: 'No visible task-state continuity is available yet.'
    };
  }

  if (!currentGoal && !nextStep && !blockedBy) {
    return {
      status: 'partial',
      issues: ['task_state_missing_goal_and_next_step'],
      summary: 'Task continuity is visible, but current goal and next step are still missing.',
      remediation_focus: 'restore_goal_and_next_step'
    };
  }

  if (currentGoal && !nextStep && !blockedBy) {
    return {
      status: 'partial',
      issues: ['task_state_missing_next_step'],
      summary: 'Current goal is visible, but next step is still missing.',
      remediation_focus: 'restore_next_step'
    };
  }

  if (!currentGoal && nextStep) {
    return {
      status: 'partial',
      issues: ['task_state_missing_goal'],
      summary: 'Next step is visible, but current goal is still missing.',
      remediation_focus: 'restore_goal'
    };
  }

  return {
    status: 'ready',
    issues: [],
    remediation_focus: 'none',
    summary:
      latestVerifiedResult || blockedBy || lastUserVisibleProgress
        ? 'Task continuity is ready for restore and repair flows.'
        : 'Task continuity is visible and ready.'
  };
}

function extractNextStepFromSessionState(sessionState = {}) {
  const commitments = Array.isArray(sessionState.commitments) ? sessionState.commitments : [];
  const pending = commitments.find((entry) => entry && entry.status === 'pending' && normalizeTaskStateText(entry.what));
  return pending ? normalizeTaskStateText(pending.what) : null;
}

function buildTaskStateFields(sessionState = {}, existing = {}, options = {}) {
  const currentGoal = hasOwnValue(options, 'currentGoal')
    ? options.currentGoal
    : hasOwnValue(sessionState, 'active_task')
      ? sessionState.active_task
      : existing.current_goal;
  const latestVerifiedResult = hasOwnValue(options, 'latestVerifiedResult')
    ? options.latestVerifiedResult
    : hasOwnValue(sessionState?.metadata || {}, 'latest_verified_result')
      ? sessionState.metadata.latest_verified_result
      : existing.latest_verified_result;
  const nextStep = hasOwnValue(options, 'nextStep')
    ? options.nextStep
    : extractNextStepFromSessionState(sessionState) || existing.next_step;
  const blockedBy = hasOwnValue(options, 'blockedBy')
    ? options.blockedBy
    : hasOwnValue(sessionState?.metadata || {}, 'blocked_by')
      ? sessionState.metadata.blocked_by
      : existing.blocked_by;
  const lastUserVisibleProgress = hasOwnValue(options, 'lastUserVisibleProgress')
    ? options.lastUserVisibleProgress
    : latestVerifiedResult || existing.last_user_visible_progress;

  return {
    current_goal: normalizeTaskStateText(currentGoal),
    latest_verified_result: normalizeTaskStateText(latestVerifiedResult),
    next_step: normalizeTaskStateText(nextStep),
    blocked_by: normalizeTaskStateText(blockedBy),
    last_user_visible_progress: normalizeTaskStateText(lastUserVisibleProgress)
  };
}

function shouldClearTaskStateForReason(reason) {
  const normalized = String(reason || '').trim().toLowerCase();
  return normalized === 'command-stop';
}

function buildTaskStateTransition(reason, sessionState = {}) {
  const normalizedReason = String(reason || 'session-close').trim().toLowerCase();
  const pendingCount = Array.isArray(sessionState.commitments)
    ? sessionState.commitments.filter((entry) => entry.status === 'pending').length
    : 0;
  const cleared = shouldClearTaskStateForReason(normalizedReason);

  return {
    reason: normalizedReason,
    mode: cleared ? 'cleared' : 'retained',
    current_goal_before: normalizeTaskStateText(sessionState.active_task),
    pending_commitments_before: pendingCount,
    summary: cleared
      ? 'This lifecycle event clears the current task state so the next session starts fresh.'
      : 'This lifecycle event preserves unfinished task state so the next session can continue.',
    visible: Boolean(sessionState.active_task) || pendingCount > 0
  };
}

module.exports = {
  assessTaskStateHealth,
  buildTaskStateFields,
  buildTaskStateSummary,
  buildTaskStateTransition,
  extractNextStepFromSessionState,
  normalizeTaskStateText,
  shouldClearTaskStateForReason
};
