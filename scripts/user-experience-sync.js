#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  appendEvidence,
  createPaths,
  loadProjectExperiences,
  loadUserExperiences,
  loadUserState,
  normalizeValidation,
  nowIso,
  projectDir,
  recordUserHeatEntry,
  resolveUserId,
  skillConflictKey,
  uniqueList,
  writeUserExperiences,
  writeUserState
} = require('./lib/context-anchor');
const { readHostConfig, resolveOwnership } = require('./lib/host-config');
const { suggestSkillName } = require('./skillification-score');

const USER_ROLLUP_SOURCE = 'project-experience-rollup';
const ROLLUP_TYPES = new Set(['lesson', 'best_practice', 'tool-pattern', 'gotcha', 'feature_request']);

function normalizeWorkspaceKey(workspace) {
  return path.resolve(workspace);
}

function listWorkspaceProjectIds(paths) {
  if (!fs.existsSync(paths.projectsDir)) {
    return [];
  }

  return fs
    .readdirSync(paths.projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '_global')
    .map((entry) => entry.name);
}

function buildAggregationKey(experience) {
  const suggestedName = experience.skillification_suggested_name || suggestSkillName(experience);
  return `${experience.type}:${skillConflictKey(suggestedName)}`;
}

function isRollupCandidate(experience = {}) {
  return (
    !experience.archived &&
    ROLLUP_TYPES.has(experience.type) &&
    normalizeValidation(experience.validation).status === 'validated'
  );
}

function normalizeSourceExperience(workspace, projectId, experience) {
  const validation = normalizeValidation(experience.validation);
  return {
    ...experience,
    workspace: normalizeWorkspaceKey(workspace),
    project_id: projectId,
    validation,
    aggregation_key: buildAggregationKey(experience)
  };
}

function compareSourcePriority(left, right) {
  const heatDiff = Number(right.heat || 0) - Number(left.heat || 0);
  if (heatDiff !== 0) {
    return heatDiff;
  }

  const accessDiff =
    Number(right.access_count || right.applied_count || 0) - Number(left.access_count || left.applied_count || 0);
  if (accessDiff !== 0) {
    return accessDiff;
  }

  return new Date(right.last_accessed || right.created_at || 0).getTime() - new Date(left.last_accessed || left.created_at || 0).getTime();
}

function collectWorkspaceProjects(openClawHome, userId, currentWorkspace) {
  const hostConfig = readHostConfig(openClawHome);
  const workspaces = uniqueList([
    ...(hostConfig.workspaces || [])
      .filter((entry) => entry.user_id === userId)
      .map((entry) => normalizeWorkspaceKey(entry.workspace)),
    ...(currentWorkspace ? [normalizeWorkspaceKey(currentWorkspace)] : [])
  ]);

  return workspaces.flatMap((workspace) => {
    const paths = createPaths(workspace);
    return listWorkspaceProjectIds(paths).map((projectId) => ({
      workspace,
      projectId
    }));
  });
}

function buildRollupRecord(existing, userId, sources = []) {
  const timestamp = nowIso();
  const representative = [...sources].sort(compareSourcePriority)[0];
  const supportingProjects = uniqueList(sources.map((entry) => entry.project_id));
  const supportingWorkspaces = uniqueList(sources.map((entry) => entry.workspace));
  const supportingExperienceIds = uniqueList(sources.map((entry) => entry.id));
  const earliestCreatedAt = [...sources]
    .map((entry) => entry.created_at)
    .filter(Boolean)
    .sort()[0];
  const latestAccessedAt = [...sources]
    .map((entry) => entry.last_accessed || entry.created_at)
    .filter(Boolean)
    .sort()
    .slice(-1)[0];
  const validation = normalizeValidation(existing?.validation);
  validation.cross_project_count = supportingProjects.length;
  validation.evidence_count = supportingExperienceIds.length;

  return {
    ...(existing || {}),
    id: existing?.id || representative.id,
    scope: 'user',
    type: representative.type,
    summary: representative.summary,
    details: representative.details || null,
    solution: representative.solution || null,
    source: USER_ROLLUP_SOURCE,
    source_user: userId,
    source_project: representative.project_id || representative.source_project || null,
    source_workspace: representative.workspace,
    aggregation_key: representative.aggregation_key,
    supporting_projects: supportingProjects,
    supporting_workspaces: supportingWorkspaces,
    supporting_experience_ids: supportingExperienceIds,
    created_at: existing?.created_at || earliestCreatedAt || timestamp,
    last_accessed: latestAccessedAt || timestamp,
    heat: Math.max(...sources.map((entry) => Number(entry.heat || 0)), Number(existing?.heat || 0), 60),
    access_count: sources.reduce(
      (total, entry) => total + Number(entry.access_count || entry.applied_count || 0),
      0
    ),
    access_sessions: uniqueList(sources.flatMap((entry) => entry.access_sessions || [])),
    tags: uniqueList(sources.flatMap((entry) => entry.tags || [])),
    validation,
    archived: false,
    archived_at: null
  };
}

function buildRollupFingerprint(entry = {}) {
  return JSON.stringify({
    type: entry.type || null,
    summary: entry.summary || null,
    details: entry.details || null,
    solution: entry.solution || null,
    aggregation_key: entry.aggregation_key || null,
    supporting_projects: [...(entry.supporting_projects || [])].sort(),
    supporting_experience_ids: [...(entry.supporting_experience_ids || [])].sort(),
    heat: Number(entry.heat || 0),
    access_count: Number(entry.access_count || 0),
    access_sessions: [...(entry.access_sessions || [])].sort(),
    validation_status: entry.validation?.status || null,
    cross_project_count: Number(entry.validation?.cross_project_count || 0),
    evidence_count: Number(entry.validation?.evidence_count || 0),
    archived: Boolean(entry.archived)
  });
}

function archiveRollup(existing) {
  const validation = normalizeValidation(existing.validation);
  validation.cross_project_count = 0;
  validation.evidence_count = 0;
  return {
    ...existing,
    supporting_projects: [],
    supporting_workspaces: [],
    supporting_experience_ids: [],
    validation,
    archived: true,
    archived_at: existing.archived_at || nowIso()
  };
}

function annotateSyncEvent(existing, nextEntry, action) {
  if (action === 'unchanged') {
    return nextEntry;
  }

  return appendEvidence(nextEntry, {
    type: action === 'created' ? 'user_experience_saved' : action === 'updated' ? 'user_experience_updated' : 'user_experience_archived',
    at: nowIso(),
    scope: 'user',
    source_session: null,
    source_project: nextEntry.source_project || null,
    source_user: nextEntry.source_user || null,
    actor: 'user-experience-sync',
    reason: nextEntry.aggregation_key || nextEntry.summary || nextEntry.id,
    details: {
      entry_id: nextEntry.id,
      supporting_projects: nextEntry.supporting_projects || []
    }
  });
}

function runUserExperienceSync(workspaceArg, options = {}) {
  const paths = createPaths(workspaceArg);
  const ownership = resolveOwnership(paths.openClawHome, {
    workspace: paths.workspace,
    projectId: options.projectId,
    userId: options.userId
  });
  const userId = resolveUserId(ownership.userId);
  const projects = collectWorkspaceProjects(paths.openClawHome, userId, paths.workspace);
  const grouped = new Map();

  projects.forEach(({ workspace, projectId }) => {
    const projectPaths = createPaths(workspace);
    const projectEntries = loadProjectExperiences(projectPaths, projectId)
      .filter(isRollupCandidate)
      .map((entry) => normalizeSourceExperience(workspace, projectId, entry));

    projectEntries.forEach((entry) => {
      const existing = grouped.get(entry.aggregation_key) || [];
      existing.push(entry);
      grouped.set(entry.aggregation_key, existing);
    });
  });

  const userExperiences = loadUserExperiences(paths, userId);
  const managedExperiences = userExperiences.filter((entry) => entry.source === USER_ROLLUP_SOURCE);
  const manualExperiences = userExperiences.filter((entry) => entry.source !== USER_ROLLUP_SOURCE);
  const nextManaged = [];
  let created = 0;
  let updated = 0;
  let archived = 0;
  let unchanged = 0;

  managedExperiences.forEach((existing) => {
    const sources = grouped.get(existing.aggregation_key) || [];
    if (sources.length === 0) {
      const archivedEntry = archiveRollup(existing);
      if (buildRollupFingerprint(existing) === buildRollupFingerprint(archivedEntry)) {
        unchanged += 1;
        nextManaged.push(existing);
        return;
      }

      archived += 1;
      nextManaged.push(annotateSyncEvent(existing, archivedEntry, 'archived'));
      return;
    }

    const nextEntry = buildRollupRecord(existing, userId, sources);
    grouped.delete(existing.aggregation_key);
    if (buildRollupFingerprint(existing) === buildRollupFingerprint(nextEntry)) {
      unchanged += 1;
      nextManaged.push(existing);
      return;
    }

    updated += 1;
    nextManaged.push(annotateSyncEvent(existing, nextEntry, 'updated'));
  });

  grouped.forEach((sources) => {
    const nextEntry = annotateSyncEvent(null, buildRollupRecord(null, userId, sources), 'created');
    created += 1;
    nextManaged.push(nextEntry);
  });

  const nextExperiences = [...manualExperiences, ...nextManaged];
  writeUserExperiences(paths, userId, nextExperiences);
  nextManaged.forEach((entry) => recordUserHeatEntry(paths, userId, entry));

  const userState = loadUserState(paths, userId);
  userState.key_experiences = uniqueList([
    ...manualExperiences.map((entry) => entry.id),
    ...nextManaged.filter((entry) => !entry.archived).map((entry) => entry.id)
  ]).slice(0, 20);
  userState.last_updated = nowIso();
  writeUserState(paths, userId, userState);

  return {
    status: 'synced',
    user_id: userId,
    discovered_projects: projects.length,
    managed_experiences: nextManaged.length,
    created,
    updated,
    archived,
    unchanged
  };
}

function main() {
  const result = runUserExperienceSync(process.argv[2], {
    userId: process.argv[3]
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  USER_ROLLUP_SOURCE,
  buildAggregationKey,
  runUserExperienceSync
};
