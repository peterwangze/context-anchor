#!/usr/bin/env node

const path = require('path');
const {
  DEFAULTS,
  buildScopedSkillMarkdown,
  createPaths,
  generateId,
  loadProjectExperiences,
  loadProjectSkills,
  loadSessionSkills,
  loadUserExperiences,
  loadUserSkills,
  normalizeValidation,
  projectSkillsDir,
  resolveProjectId,
  resolveUserId,
  sanitizeKey,
  sessionSkillsDir,
  writeProjectExperiences,
  writeProjectSkills,
  writeSessionSkills,
  writeText,
  writeUserExperiences,
  writeUserSkills,
  userSkillsDir
} = require('./lib/context-anchor');
const { calculateSkillificationScore, suggestSkillName } = require('./skillification-score');

function ensurePromotionMeta(experience, scope) {
  const validation = normalizeValidation(experience.validation);
  const scoreResult = calculateSkillificationScore(experience);
  return {
    ...experience,
    validation,
    skillification_score: experience.skillification_score ?? scoreResult.score,
    skillification_breakdown: experience.skillification_breakdown || scoreResult.breakdown,
    skillification_suggested:
      experience.skillification_suggested ??
      (validation.status === 'validated' && scoreResult.meetsMinDays && scoreResult.score >= 0.7),
    skillification_suggested_name:
      experience.skillification_suggested_name || suggestSkillName(experience),
    promotion_history: Array.isArray(experience.promotion_history) ? experience.promotion_history : [],
    skill_scope: experience.skill_scope || null,
    scope: experience.scope || scope
  };
}

function createSkillRecord(scope, targetDir, experience, defaults = {}) {
  const skillId = generateId(scope === 'user' ? 'user-skill' : 'project-skill');
  const skillName = experience.skillification_suggested_name || suggestSkillName(experience);
  const filename = `${skillId}.md`;
  const skillPath = path.join(targetDir, filename);
  const record = {
    id: skillId,
    name: skillName,
    scope,
    status: 'active',
    summary: experience.summary,
    source_experience: experience.id,
    source_scope: experience.scope || defaults.sourceScope || scope,
    source_session: experience.source_session || defaults.sessionKey || null,
    source_project: experience.source_project || defaults.projectId || null,
    source_user: experience.source_user || defaults.userId || null,
    created_at: new Date().toISOString(),
    path: skillPath
  };

  writeText(skillPath, buildScopedSkillMarkdown(record));
  return record;
}

function promoteProjectSkills(paths, projectId, sessionKey) {
  const experiences = loadProjectExperiences(paths, projectId).map((entry) => ensurePromotionMeta(entry, 'project'));
  const skills = loadProjectSkills(paths, projectId);
  const promotions = [];

  const nextExperiences = experiences.map((experience) => {
    if (experience.skill_name || !experience.skillification_suggested || experience.validation.status !== 'validated') {
      return experience;
    }

    const existingSkill =
      skills.find((skill) => skill.source_experience === experience.id) ||
      skills.find((skill) => skill.name === experience.skillification_suggested_name);

    if (existingSkill) {
      return {
        ...experience,
        skill_name: existingSkill.name,
        skill_id: existingSkill.id,
        skill_scope: 'project'
      };
    }

    const skill = createSkillRecord('project', projectSkillsDir(paths, projectId), experience, {
      sessionKey,
      projectId
    });
    skills.push(skill);
    promotions.push(skill);

    return {
      ...experience,
      skill_name: skill.name,
      skill_id: skill.id,
      skill_scope: 'project',
      promotion_history: experience.promotion_history.concat({
        scope: 'project',
        at: skill.created_at,
        skill_id: skill.id
      })
    };
  });

  writeProjectExperiences(paths, projectId, nextExperiences);
  writeProjectSkills(paths, projectId, skills);

  if (sessionKey) {
    const drafts = loadSessionSkills(paths, sessionKey);
    const nextDrafts = drafts.map((draft) => {
      const linked = promotions.find((skill) => skill.summary === draft.summary);
      if (!linked) {
        return draft;
      }

      return {
        ...draft,
        promoted_to_scope: 'project',
        promoted_to_skill_id: linked.id,
        promoted_at: linked.created_at
      };
    });
    writeSessionSkills(paths, sessionKey, nextDrafts);
  }

  return promotions;
}

function promoteUserSkills(paths, userId) {
  const experiences = loadUserExperiences(paths, userId).map((entry) => ensurePromotionMeta(entry, 'user'));
  const skills = loadUserSkills(paths, userId);
  const promotions = [];

  const nextExperiences = experiences.map((experience) => {
    const validation = normalizeValidation(experience.validation);
    const canPromote =
      !experience.skill_name &&
      validation.status === 'validated' &&
      experience.skillification_suggested &&
      Number(validation.cross_project_count || 0) >= 2;

    if (!canPromote) {
      return experience;
    }

    const existingSkill =
      skills.find((skill) => skill.source_experience === experience.id) ||
      skills.find((skill) => skill.name === experience.skillification_suggested_name);

    if (existingSkill) {
      return {
        ...experience,
        skill_name: existingSkill.name,
        skill_id: existingSkill.id,
        skill_scope: 'user'
      };
    }

    const skill = createSkillRecord('user', userSkillsDir(paths, userId), experience, {
      userId
    });
    skills.push(skill);
    promotions.push(skill);

    return {
      ...experience,
      skill_name: skill.name,
      skill_id: skill.id,
      skill_scope: 'user',
      promotion_history: experience.promotion_history.concat({
        scope: 'user',
        at: skill.created_at,
        skill_id: skill.id
      })
    };
  });

  writeUserExperiences(paths, userId, nextExperiences);
  writeUserSkills(paths, userId, skills);

  return promotions;
}

function runScopePromote(workspaceArg, options = {}) {
  const paths = createPaths(workspaceArg);
  const projectId = resolveProjectId(paths.workspace, options.projectId);
  const userId = resolveUserId(options.userId || DEFAULTS.userId);
  const sessionKey = options.sessionKey ? sanitizeKey(options.sessionKey) : null;
  const projectPromotions = promoteProjectSkills(paths, projectId, sessionKey);
  const userPromotions = promoteUserSkills(paths, userId);

  return {
    status: 'promoted',
    project_id: projectId,
    user_id: userId,
    project_promotions: projectPromotions.length,
    user_promotions: userPromotions.length,
    project_skills: projectPromotions.map((skill) => ({
      id: skill.id,
      name: skill.name
    })),
    user_skills: userPromotions.map((skill) => ({
      id: skill.id,
      name: skill.name
    }))
  };
}

function main() {
  const result = runScopePromote(process.argv[2], {
    sessionKey: process.argv[3],
    projectId: process.argv[4],
    userId: process.argv[5]
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  runScopePromote
};
