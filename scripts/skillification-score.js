#!/usr/bin/env node

const {
  DEFAULTS,
  calculateDaysSince,
  createPaths,
  ensureExperienceValidation,
  loadProjectExperiences,
  normalizeValidation,
  resolveProjectId,
  writeProjectExperiences
} = require('./lib/context-anchor');

const WEIGHTS = {
  time: 0.3,
  frequency: 0.3,
  crossSession: 0.2,
  heat: 0.2
};

const THRESHOLDS = {
  minDays: DEFAULTS.autoValidation.minDays,
  minScore: 0.7,
  maxDaysForFullWeight: 30,
  maxCountForFullWeight: 10,
  maxSessionsForFullWeight: 5
};

function calculateSkillificationScore(experience) {
  const daysSinceCreated = calculateDaysSince(experience.created_at);
  const accessCount = Number(experience.access_count || experience.applied_count || 0);
  const sessionCount = (experience.access_sessions || []).length;
  const timeWeight = Math.min(daysSinceCreated / THRESHOLDS.maxDaysForFullWeight, 1);
  const frequencyWeight = Math.min(accessCount / THRESHOLDS.maxCountForFullWeight, 1);
  const crossSessionWeight = Math.min(sessionCount / THRESHOLDS.maxSessionsForFullWeight, 1);
  const heatWeight = Number(experience.heat || 0) / 100;
  const score =
    timeWeight * WEIGHTS.time +
    frequencyWeight * WEIGHTS.frequency +
    crossSessionWeight * WEIGHTS.crossSession +
    heatWeight * WEIGHTS.heat;

  return {
    score: Math.round(score * 100) / 100,
    breakdown: {
      time: Math.round(timeWeight * 100) / 100,
      frequency: Math.round(frequencyWeight * 100) / 100,
      crossSession: Math.round(crossSessionWeight * 100) / 100,
      heat: Math.round(heatWeight * 100) / 100
    },
    daysSinceCreated: Math.round(daysSinceCreated * 10) / 10,
    meetsMinDays: daysSinceCreated >= THRESHOLDS.minDays
  };
}

function suggestSkillName(experience) {
  const typePrefixes = {
    lesson: 'safe',
    best_practice: 'guide',
    'tool-pattern': 'tool',
    gotcha: 'avoid',
    feature_request: 'feature'
  };
  const prefix = typePrefixes[experience.type] || 'skill';
  const tags = experience.tags || [];

  if (tags.length > 0) {
    return `${prefix}-${String(tags[0]).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  }

  const words = String(experience.summary || 'general')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .join('-');

  return `${prefix}-${words || experience.type || 'general'}`;
}

function runSkillificationScore(workspaceArg, projectIdArg) {
  const paths = createPaths(workspaceArg);
  const projectId = resolveProjectId(paths.workspace, projectIdArg);
  const experiences = loadProjectExperiences(paths, projectId);
  const candidates = [];
  const blockedByValidation = [];

  const updatedExperiences = experiences.map((experience) => {
    if (experience.skill_name) {
      return experience;
    }

    const scoreResult = calculateSkillificationScore(experience);
    const validation = ensureExperienceValidation(experience, 'skillification-score');
    const suggestedName = suggestSkillName(experience);
    const validationReady = normalizeValidation(validation).status === 'validated';
    const skillificationSuggested =
      validationReady && scoreResult.meetsMinDays && scoreResult.score >= THRESHOLDS.minScore;

    const updated = {
      ...experience,
      validation,
      skillification_score: scoreResult.score,
      skillification_breakdown: scoreResult.breakdown,
      skillification_suggested: skillificationSuggested,
      skillification_suggested_name: suggestedName
    };

    if (skillificationSuggested) {
      candidates.push({
        id: updated.id,
        type: updated.type,
        summary: updated.summary,
        score: scoreResult.score,
        breakdown: scoreResult.breakdown,
        suggested_name: suggestedName,
        validation_status: updated.validation.status,
        days_since_created: scoreResult.daysSinceCreated,
        access_count: updated.access_count || updated.applied_count || 0,
        access_sessions: (updated.access_sessions || []).length
      });
    } else if (scoreResult.meetsMinDays && scoreResult.score >= THRESHOLDS.minScore && !validationReady) {
      blockedByValidation.push({
        id: updated.id,
        summary: updated.summary,
        score: scoreResult.score,
        validation_status: updated.validation.status
      });
    }

    return updated;
  });

  writeProjectExperiences(paths, projectId, updatedExperiences);

  return {
    project_id: projectId,
    evaluated: experiences.length,
    candidates: candidates.length,
    blocked_by_validation: blockedByValidation.length,
    threshold: THRESHOLDS.minScore,
    min_days: THRESHOLDS.minDays,
    candidates_list: candidates.sort((left, right) => right.score - left.score),
    blocked_candidates: blockedByValidation.sort((left, right) => right.score - left.score)
  };
}

function main() {
  const result = runSkillificationScore(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  calculateSkillificationScore,
  suggestSkillName,
  runSkillificationScore
};
