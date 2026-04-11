const { command, field } = require('./terminal-format');

function renderHiddenSessionSummaryLines(hiddenSessionSummary, {
  count = 0,
  countLabel = 'Hidden sessions',
  indent = 0
} = {}) {
  if (!hiddenSessionSummary || Number(count || 0) <= 0) {
    return [];
  }

  const lines = [field(countLabel, Number(count || 0), { indent, kind: 'muted' })];
  if (hiddenSessionSummary.summary) {
    lines.push(field('Hidden filter', hiddenSessionSummary.summary, { indent, kind: 'muted' }));
  }
  if (hiddenSessionSummary.next_step_hint) {
    lines.push(field('Hidden next step', hiddenSessionSummary.next_step_hint, { indent, kind: 'muted' }));
  }
  if (hiddenSessionSummary.inspect_command) {
    lines.push(field('Hidden inspect', command(hiddenSessionSummary.inspect_command), { indent, kind: 'command' }));
  }
  if (hiddenSessionSummary.cleanup_command) {
    lines.push(field('Hidden cleanup', command(hiddenSessionSummary.cleanup_command), { indent, kind: 'command' }));
  }
  return lines;
}

function renderRemediationNextStepLines(remediationSummary, {
  indent = 0,
  autoFixLabel = 'Auto fix',
  nextStepFormatter = null
} = {}) {
  const nextStep = remediationSummary?.next_step;
  if (!nextStep) {
    return [];
  }

  const lines = [];
  const nextStepText = nextStepFormatter
    ? nextStepFormatter(nextStep)
    : `${nextStep.label}${nextStep.summary ? ` - ${nextStep.summary}` : ''}`;

  if (nextStepText) {
    lines.push(field('Next step', nextStepText, {
      indent,
      kind: nextStep.execution_mode === 'manual' ? 'warning' : 'info'
    }));
  }
  if (nextStep.affected_targets_summary) {
    lines.push(field('Affected targets', nextStep.affected_targets_summary, { indent, kind: 'muted' }));
  }
  if (
    nextStep.execution_mode !== 'manual' &&
    Array.isArray(nextStep.command_sequence) &&
    nextStep.command_sequence.length > 0
  ) {
    lines.push(
      field(
        autoFixLabel,
        nextStep.command_sequence
          .map((entry, index) => `${index + 1}) ${entry.step}: ${command(entry.command)}`)
          .join(' | '),
        { indent, kind: 'command' }
      )
    );
  }
  if (nextStep.auto_fix_command) {
    lines.push(field('Auto fix command', command(nextStep.auto_fix_command), { indent, kind: 'command' }));
    return lines;
  }
  if (!nextStep.auto_fix_blocked_reason) {
    return lines;
  }

  lines.push(field('Auto fix unavailable', nextStep.auto_fix_blocked_reason, { indent, kind: 'warning' }));
  if (nextStep.auto_fix_resume_hint) {
    lines.push(field('Auto fix resume', nextStep.auto_fix_resume_hint, { indent, kind: 'muted' }));
  }
  if (nextStep.auto_fix_resume_command) {
    lines.push(field('Resume command', command(nextStep.auto_fix_resume_command), { indent, kind: 'command' }));
  }
  if (nextStep.auto_fix_resume_suggested_command) {
    lines.push(field('Suggested resume', command(nextStep.auto_fix_resume_suggested_command), { indent, kind: 'command' }));
  }
  if (nextStep.auto_fix_resume_suggested_inputs_summary) {
    lines.push(field('Suggested inputs', nextStep.auto_fix_resume_suggested_inputs_summary, { indent, kind: 'muted' }));
  }
  if (nextStep.auto_fix_resume_validation_summary) {
    lines.push(field('Resume checks', nextStep.auto_fix_resume_validation_summary, {
      indent,
      kind: nextStep.auto_fix_resume_validation_status === 'ready' ? 'success' : 'warning'
    }));
  }
  if (nextStep.auto_fix_resume_suggested_validation_summary) {
    lines.push(field('Suggested checks', nextStep.auto_fix_resume_suggested_validation_summary, {
      indent,
      kind: nextStep.auto_fix_resume_suggested_validation_status === 'ready' ? 'success' : 'warning'
    }));
  }
  if (Array.isArray(nextStep.auto_fix_resume_missing_inputs) && nextStep.auto_fix_resume_missing_inputs.length > 0) {
    lines.push(field('Resume inputs', nextStep.auto_fix_resume_missing_inputs.join(', '), { indent, kind: 'warning' }));
  }
  if (Array.isArray(nextStep.auto_fix_resume_input_details) && nextStep.auto_fix_resume_input_details.length > 0) {
    nextStep.auto_fix_resume_input_details.forEach((entry) => {
      lines.push(field(
        `Input ${entry.label}`,
        `${entry.description}${entry.validation_summary ? ` | check=${entry.validation_summary}` : ''}${entry.example ? ` | example=${entry.example}` : ''}`,
        { indent, kind: 'muted' }
      ));
      if (Array.isArray(entry.candidates) && entry.candidates.length > 0) {
        lines.push(field(`Input ${entry.label} options`, entry.candidates.join(' | '), { indent, kind: 'muted' }));
      }
    });
  }

  return lines;
}

module.exports = {
  renderHiddenSessionSummaryLines,
  renderRemediationNextStepLines
};
