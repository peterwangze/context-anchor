#!/usr/bin/env node

const {
  DEFAULTS,
  createPaths,
  loadProjectExperiences,
  loadProjectSkills,
  loadUserExperiences,
  loadUserSkills,
  normalizeSkillRecord,
  resolveProjectId,
  resolveUserId,
  writeProjectSkills,
  writeUserSkills
} = require('./lib/context-anchor');

function isExperienceSupportingSkill(experience) {
  return (
    experience &&
    !experience.archived &&
    experience.validation?.status === 'validated' &&
    experience.skillification_suggested !== false
  );
}

function reconcileSkillCollection(skills, experiences, scope) {
  const experienceMap = new Map(experiences.map((experience) => [experience.id, experience]));
  let deactivated = 0;
  let archived = 0;
  const nextSkills = skills.map((rawSkill) => {
    const skill = normalizeSkillRecord(rawSkill, scope);
    if (
      skill.status === 'inactive' &&
      !skill.archived &&
      Number(skill.load_policy?.priority || 0) <= DEFAULTS.skillArchivePriorityThreshold &&
      Number(skill.usage_count || 0) <= DEFAULTS.skillArchiveUsageThreshold
    ) {
      archived += 1;
      return {
        ...skill,
        status: 'archived',
        archived: true,
        status_updated_at: new Date().toISOString(),
        status_note: 'auto-reconcile: archived low-value inactive skill',
        status_history: [
          ...(skill.status_history || []),
          {
            status: 'archived',
            at: new Date().toISOString(),
            reason: 'auto-reconcile: archived low-value inactive skill'
          }
        ]
      };
    }

    if (skill.status !== 'active' || skill.archived) {
      return skill;
    }

    const related = (skill.related_experiences || []).map((id) => experienceMap.get(id)).filter(Boolean);
    const supportingExperiences = related.filter(isExperienceSupportingSkill);

    if (supportingExperiences.length > 0) {
      return skill;
    }

    deactivated += 1;
    return {
      ...skill,
      status: 'inactive',
      status_updated_at: new Date().toISOString(),
      status_note: 'auto-reconcile: no validated supporting experiences',
      status_history: [
        ...(skill.status_history || []),
        {
          status: 'inactive',
          at: new Date().toISOString(),
          reason: 'auto-reconcile: no validated supporting experiences'
        }
      ]
    };
  });

  return {
    skills: nextSkills,
    deactivated,
    archived
  };
}

function runSkillReconcile(workspaceArg, options = {}) {
  const paths = createPaths(workspaceArg);
  const projectId = resolveProjectId(paths.workspace, options.projectId || DEFAULTS.projectId);
  const userId = resolveUserId(options.userId || DEFAULTS.userId);

  const projectExperiences = loadProjectExperiences(paths, projectId);
  const projectSkills = loadProjectSkills(paths, projectId);
  const nextProject = reconcileSkillCollection(projectSkills, projectExperiences, 'project');
  writeProjectSkills(paths, projectId, nextProject.skills);

  const userExperiences = loadUserExperiences(paths, userId);
  const userSkills = loadUserSkills(paths, userId);
  const nextUser = reconcileSkillCollection(userSkills, userExperiences, 'user');
  writeUserSkills(paths, userId, nextUser.skills);

  return {
    status: 'reconciled',
    project_id: projectId,
    user_id: userId,
    project_deactivated: nextProject.deactivated,
    user_deactivated: nextUser.deactivated,
    project_archived: nextProject.archived,
    user_archived: nextUser.archived
  };
}

function main() {
  const result = runSkillReconcile(process.argv[2], {
    projectId: process.argv[3],
    userId: process.argv[4]
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runSkillReconcile
};
