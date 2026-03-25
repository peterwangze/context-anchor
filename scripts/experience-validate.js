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

function main() {
  try {
    const result = runExperienceValidate(
      process.argv[2],
      process.argv[3],
      process.argv[4],
      process.argv[5],
      process.argv[6]
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          status: 'error',
          message: error.message
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  runExperienceValidate
};
