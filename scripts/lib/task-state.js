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

module.exports = {
  buildTaskStateFields,
  extractNextStepFromSessionState,
  normalizeTaskStateText
};
