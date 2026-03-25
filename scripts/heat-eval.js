#!/usr/bin/env node

const {
  DEFAULTS,
  clamp,
  createPaths,
  loadProjectDecisions,
  loadProjectExperiences,
  nowIso,
  recordHeatEntry,
  resolveProjectId,
  syncProjectStateMetadata,
  writeProjectDecisions,
  writeProjectExperiences
} = require('./lib/context-anchor');

function calculateDecay(lastAccessed) {
  const now = Date.now();
  const last = new Date(lastAccessed).getTime();
  const hoursSinceAccess = (now - last) / (1000 * 60 * 60);
  return Math.max(0, Math.floor(hoursSinceAccess));
}

function evaluateEntry(entry, type, defaultHeat) {
  const decay = calculateDecay(entry.last_accessed || entry.created_at || nowIso());
  const currentHeat = Number(entry.heat || defaultHeat);
  let nextHeat = clamp(currentHeat - decay, 0, 100);
  const sessionCount = (entry.access_sessions || []).length;

  if (sessionCount >= 2) {
    nextHeat = Math.max(nextHeat, Math.min(100, 40 + sessionCount * 10));
  }

  return {
    ...entry,
    type,
    heat: nextHeat,
    archived: nextHeat < DEFAULTS.archiveHeat && sessionCount < 2,
    last_evaluated: nowIso()
  };
}

function runHeatEvaluation(workspaceArg, projectIdArg) {
  const paths = createPaths(workspaceArg);
  const projectId = resolveProjectId(paths.workspace, projectIdArg);
  const decisions = loadProjectDecisions(paths, projectId).map((entry) =>
    evaluateEntry(entry, 'decision', 80)
  );
  const experiences = loadProjectExperiences(paths, projectId).map((entry) =>
    evaluateEntry(entry, entry.type || 'experience', 60)
  );

  writeProjectDecisions(paths, projectId, decisions);
  writeProjectExperiences(paths, projectId, experiences);

  const entries = [...decisions, ...experiences];
  entries.forEach((entry) => recordHeatEntry(paths, projectId, entry));
  syncProjectStateMetadata(paths, projectId);

  const needsPromotion = entries.filter((entry) => entry.heat >= DEFAULTS.hotMemoryHeat && !entry.archived);
  const needsDemotion = entries.filter((entry) => entry.archived);

  return {
    project_id: projectId,
    evaluated: entries.length,
    needs_promotion: needsPromotion.length,
    needs_demotion: needsDemotion.length,
    promotion_candidates: needsPromotion.map((entry) => ({
      id: entry.id,
      type: entry.type,
      heat: entry.heat
    })),
    demotion_candidates: needsDemotion.map((entry) => ({
      id: entry.id,
      type: entry.type,
      heat: entry.heat
    }))
  };
}

function main() {
  const result = runHeatEvaluation(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runHeatEvaluation
};
