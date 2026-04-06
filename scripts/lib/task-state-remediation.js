function normalizeIssues(issues = []) {
  return Array.isArray(issues) ? issues.filter(Boolean).map((entry) => String(entry)) : [];
}

function detectTaskStateGap(issues = [], status = 'unknown') {
  const normalizedIssues = normalizeIssues(issues);

  if (normalizedIssues.includes('task_state_missing_goal_and_next_step')) {
    return 'missing_goal_and_next_step';
  }
  if (normalizedIssues.includes('task_state_missing_next_step')) {
    return 'missing_next_step';
  }
  if (normalizedIssues.includes('task_state_missing_goal')) {
    return 'missing_goal';
  }
  if (normalizedIssues.includes('task_state_missing')) {
    return 'missing';
  }
  if (normalizedIssues.includes('task_state_incomplete') || String(status).toLowerCase() === 'partial') {
    return 'incomplete';
  }
  return String(status).toLowerCase() === 'missing' ? 'missing' : 'ready';
}

function buildTaskStateRepairProfile(issues = [], options = {}) {
  const normalizedIssues = normalizeIssues(issues);
  const gap = detectTaskStateGap(normalizedIssues, options.status);
  const recheckTarget = options.recheckTarget || 'status report';

  switch (gap) {
    case 'missing_goal_and_next_step':
      return {
        issues: normalizedIssues.length > 0 ? normalizedIssues : ['task_state_missing_goal_and_next_step'],
        strategy_type: 'repair_task_goal_and_next_step_then_recheck',
        strategy_label: 'repair task goal+next step -> recheck',
        summary: `Task continuity is missing both current goal and next step. Refresh the session linkage, capture the next step, then rerun ${recheckTarget}.`,
        strategy_summary: `Refresh task continuity, capture both current goal and next step again, then rerun ${recheckTarget}.`,
        resolution_hint:
          'Neither current goal nor next step is visible yet. Rebuild the session linkage first, then run one heartbeat so later restores stop feeling blank.',
        needs_follow_up_heartbeat: true
      };
    case 'missing_next_step':
      return {
        issues: normalizedIssues.length > 0 ? normalizedIssues : ['task_state_missing_next_step'],
        strategy_type: 'repair_task_next_step_then_recheck',
        strategy_label: 'repair task next step -> recheck',
        summary: `Task continuity is missing the next step. Refresh the session linkage, capture a fresh next step, then rerun ${recheckTarget}.`,
        strategy_summary: `Refresh task continuity, capture the next step again, then rerun ${recheckTarget}.`,
        resolution_hint:
          'Current goal is visible, but the next step is still missing. Rebuild the session linkage first, then run one heartbeat so restores stop feeling stalled.',
        needs_follow_up_heartbeat: true
      };
    case 'missing_goal':
      return {
        issues: normalizedIssues.length > 0 ? normalizedIssues : ['task_state_missing_goal'],
        strategy_type: 'repair_task_goal_then_recheck',
        strategy_label: 'repair task goal -> recheck',
        summary: `Task continuity is missing the current goal. Refresh the session linkage, then rerun ${recheckTarget}.`,
        strategy_summary: `Refresh task continuity and restore the current goal, then rerun ${recheckTarget}.`,
        resolution_hint:
          'Next step is visible, but the current goal is still missing. Rebuild the session linkage so later restores stop feeling contextless.',
        needs_follow_up_heartbeat: false
      };
    case 'missing':
      return {
        issues: normalizedIssues.length > 0 ? normalizedIssues : ['task_state_missing'],
        strategy_type: 'repair_task_state_then_recheck',
        strategy_label: 'repair task state -> recheck',
        summary: `Task continuity is not visible yet. Refresh the session linkage, then rerun ${recheckTarget}.`,
        strategy_summary: `Refresh task continuity first, then rerun ${recheckTarget}.`,
        resolution_hint:
          'Current goal, next step, or blocked state is not visible yet. Rebuild the session linkage before trusting the restored work state.',
        needs_follow_up_heartbeat: false
      };
    case 'incomplete':
      return {
        issues: normalizedIssues.length > 0 ? normalizedIssues : ['task_state_incomplete'],
        strategy_type: 'repair_task_state_then_recheck',
        strategy_label: 'repair task state -> recheck',
        summary: `Task continuity is still incomplete. Refresh the session linkage, then rerun ${recheckTarget}.`,
        strategy_summary: `Refresh task continuity first, then rerun ${recheckTarget}.`,
        resolution_hint:
          'Current goal, next step, or blocked state is still incomplete. Rebuild the session linkage so later restore and repair flows stay consistent.',
        needs_follow_up_heartbeat: false
      };
    default:
      return {
        issues: normalizedIssues,
        strategy_type: 'recheck_only',
        strategy_label: 'recheck',
        summary: `No task-state repair is required; rerun ${recheckTarget} when the environment changes.`,
        strategy_summary: `No task-state repair is required right now; rerun ${recheckTarget} when the environment changes.`,
        resolution_hint: 'No task-state remediation is required right now.',
        needs_follow_up_heartbeat: false
      };
  }
}

module.exports = {
  buildTaskStateRepairProfile,
  detectTaskStateGap
};
