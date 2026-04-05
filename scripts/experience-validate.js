#!/usr/bin/env node

const {
  DEFAULTS,
  VALIDATION_STATUSES,
  createPaths,
  loadProjectExperiences,
  normalizeValidation,
  resolveProjectId,
  writeProjectExperiences
} = require('./lib/context-anchor');
const { field, section, status } = require('./lib/terminal-format');
const { runCliMain } = require('./lib/cli-runtime');

function runExperienceValidate(workspaceArg, experienceId, statusArg, projectIdArg, noteArg) {
  if (!experienceId || !statusArg) {
    throw new Error(
      'Usage: node experience-validate.js <workspace> <experience-id> <status> [project-id] [note]'
    );
  }

  if (!VALIDATION_STATUSES.includes(statusArg)) {
    throw new Error(`Validation status must be one of: ${VALIDATION_STATUSES.join(', ')}`);
  }

  const paths = createPaths(workspaceArg);
  const projectId = resolveProjectId(paths.workspace, projectIdArg);
  const experiences = loadProjectExperiences(paths, projectId);
  const idx = experiences.findIndex((entry) => entry.id === experienceId);

  if (idx < 0) {
    throw new Error(`Experience ${experienceId} not found`);
  }

  const validation = normalizeValidation(experiences[idx].validation);
  validation.status = statusArg;
  validation.count += 1;
  validation.last_reviewed_at = new Date().toISOString();
  validation.notes.push({
    source: 'manual',
    at: validation.last_reviewed_at,
    note: noteArg || `Status changed to ${statusArg}`
  });
  if (statusArg !== 'validated') {
    validation.auto_validated = false;
  }

  experiences[idx] = {
    ...experiences[idx],
    validation
  };
  writeProjectExperiences(paths, projectId, experiences);

  return {
    status: 'updated',
    experience_id: experienceId,
    project_id: projectId,
    validation_status: validation.status,
    validation_count: validation.count
  };
}

function parseArgs(argv) {
  return {
    workspace: argv[0],
    experienceId: argv[1],
    statusValue: argv[2],
    projectId: argv[3],
    note: argv[4],
    json: argv.includes('--json')
  };
}

function renderExperienceValidateReport(result) {
  const lines = [];
  const validationKind = result.validation_status === 'validated' ? 'success' : 'warning';
  lines.push(section('Context-Anchor Experience Validate', { kind: validationKind }));
  lines.push(field('Status', status(String(result.status || 'updated').toUpperCase(), 'success'), { kind: 'success' }));
  lines.push(field('Experience', result.experience_id, { kind: 'info' }));
  lines.push(field('Project', result.project_id, { kind: 'muted' }));
  lines.push(field('Validation', status(String(result.validation_status || 'unknown').toUpperCase(), validationKind), { kind: validationKind }));
  lines.push(field('Review count', Number(result.validation_count || 0), { kind: 'info' }));
  return lines.join('\n');
}

function main() {
  return runCliMain(process.argv.slice(2), {
    parseArgs,
    run: async (options) =>
      runExperienceValidate(
        options.workspace,
        options.experienceId,
        options.statusValue,
        options.projectId,
        options.note
      ),
    renderText: renderExperienceValidateReport,
    errorTitle: 'Context-Anchor Experience Validate Failed',
    errorNextStep: 'Check the workspace, experience id, and validation status, then rerun experience-validate.'
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  renderExperienceValidateReport,
  runExperienceValidate
};
