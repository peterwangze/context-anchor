function hasOwnValue(target, key) {
  return Object.prototype.hasOwnProperty.call(target || {}, key);
}

function normalizeTaskStateText(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();
  return text ? text : null;
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
      ? [
          currentGoal ? `goal=${currentGoal}` : null,
          latestVerifiedResult ? `result=${latestVerifiedResult}` : null,
          nextStep ? `next=${nextStep}` : null,
          blockedBy ? `blocked_by=${blockedBy}` : null
        ].filter(Boolean).join(' ; ')
      : 'No task-state continuity summary available.'
  };
}

module.exports = {
  buildTaskStateFields,
  buildTaskStateSummary,
  extractNextStepFromSessionState,
  normalizeTaskStateText
};
