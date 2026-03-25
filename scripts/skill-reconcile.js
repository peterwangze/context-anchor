#!/usr/bin/env node

const {
  DEFAULTS,
  appendEvidence,
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
  let reactivated = 0;
  let archived = 0;
  const nextSkills = skills.map((rawSkill) => {
    const skill = normalizeSkillRecord(rawSkill, scope);
    const related = (skill.related_experiences || []).map((id) => experienceMap.get(id)).filter(Boolean);
    const supportingExperiences = related.filter(isExperienceSupportingSkill);

    if (skill.status === 'inactive' && !skill.archived && supportingExperiences.length > 0) {
      reactivated += 1;
      const statusUpdatedAt = new Date().toISOString();
      return appendEvidence(
        {
          ...skill,
          status: 'active',
          archived: false,
          superseded_by: null,
          status_updated_at: statusUpdatedAt,
          status_note: 'auto-reconcile: validated supporting experiences restored',
          status_history: [
            ...(skill.status_history || []),
            {
              status: 'active',
              at: statusUpdatedAt,
              reason: 'auto-reconcile: validated supporting experiences restored'
            }
          ]
        },
        {
          type: 'skill_reactivated',
          at: statusUpdatedAt,
          scope,
          source_session: null,
          source_project: skill.source_project || supportingExperiences[0]?.source_project || null,
          source_user: skill.source_user || supportingExperiences[0]?.source_user || null,
          actor: 'skill-reconcile',
          reason: 'validated_support_restored',
          details: {
            supporting_experiences: supportingExperiences.map((experience) => experience.id)
          }
        }
      );
    }

    if (
      skill.status === 'inactive' &&
      !skill.archived &&
      Number(skill.load_policy?.priority || 0) <= DEFAULTS.skillArchivePriorityThreshold &&
      Number(skill.usage_count || 0) <= DEFAULTS.skillArchiveUsageThreshold
    ) {
      archived += 1;
      const statusUpdatedAt = new Date().toISOString();
      return appendEvidence(
        {
          ...skill,
          status: 'archived',
          archived: true,
          status_updated_at: statusUpdatedAt,
          status_note: 'auto-reconcile: archived low-value inactive skill',
          status_history: [
            ...(skill.status_history || []),
            {
              status: 'archived',
              at: statusUpdatedAt,
              reason: 'auto-reconcile: archived low-value inactive skill'
            }
          ]
        },
        {
          type: 'skill_archived',
          at: statusUpdatedAt,
          scope,
          source_session: null,
          source_project: skill.source_project || null,
          source_user: skill.source_user || null,
          actor: 'skill-reconcile',
          reason: 'low_value_inactive_skill',
          details: {
            usage_count: Number(skill.usage_count || 0),
            priority: Number(skill.load_policy?.priority || 0)
          }
        }
      );
    }

    if (skill.status !== 'active' || skill.archived) {
      return skill;
    }

    if (supportingExperiences.length > 0) {
      return skill;
    }

    deactivated += 1;
    const statusUpdatedAt = new Date().toISOString();
    return appendEvidence(
      {
        ...skill,
        status: 'inactive',
        status_updated_at: statusUpdatedAt,
        status_note: 'auto-reconcile: no validated supporting experiences',
        status_history: [
          ...(skill.status_history || []),
          {
            status: 'inactive',
            at: statusUpdatedAt,
            reason: 'auto-reconcile: no validated supporting experiences'
          }
        ]
      },
      {
        type: 'skill_deactivated',
        at: statusUpdatedAt,
        scope,
        source_session: null,
        source_project: skill.source_project || null,
        source_user: skill.source_user || null,
        actor: 'skill-reconcile',
        reason: 'no_validated_supporting_experiences',
        details: {
          related_experiences: (skill.related_experiences || []).slice(0, 20)
        }
      }
    );
  });

  return {
    skills: nextSkills,
    deactivated,
    reactivated,
    archived
  };
}

function runSkillReconcile(workspaceArg, options = {}) {
  const paths = createPaths(workspaceArg);
  const projectId = resolveProjectId(paths.workspace, options.projectId);
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
    project_reactivated: nextProject.reactivated,
    user_deactivated: nextUser.deactivated,
    user_reactivated: nextUser.reactivated,
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
