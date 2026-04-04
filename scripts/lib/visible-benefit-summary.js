function buildVisibleBenefitSummary(input = {}) {
  const sessionExperiencesCreated = Number(input.session_experiences_created || 0);
  const sessionExperiencesUpdated = Number(input.session_experiences_updated || 0);
  const sessionExperiencesArchived = Number(input.session_experiences_archived || 0);
  const legacySyncedEntries = Number(input.legacy_synced_entries || 0);
  const projectPromotions = Number(input.promoted_project_skills || 0);
  const userPromotions = Number(input.promoted_user_skills || 0);
  const projectArchived = Number(input.archived_project_skills || 0);
  const userArchived = Number(input.archived_user_skills || 0);
  const projectDeactivated = Number(input.deactivated_project_skills || 0);
  const userDeactivated = Number(input.deactivated_user_skills || 0);
  const projectReactivated = Number(input.reactivated_project_skills || 0);
  const userReactivated = Number(input.reactivated_user_skills || 0);
  const skillDraft = input.skill_draft || null;

  const lines = [];

  if (sessionExperiencesCreated > 0) {
    lines.push(`captured ${sessionExperiencesCreated} new lesson(s)`);
  }
  if (sessionExperiencesUpdated > 0) {
    lines.push(`refreshed ${sessionExperiencesUpdated} existing lesson(s)`);
  }
  if (sessionExperiencesArchived > 0) {
    lines.push(`archived ${sessionExperiencesArchived} session lesson(s)`);
  }
  if (legacySyncedEntries > 0) {
    lines.push(`centralized ${legacySyncedEntries} external memory entr${legacySyncedEntries === 1 ? 'y' : 'ies'}`);
  }
  if (projectPromotions > 0 || userPromotions > 0) {
    const promotedParts = [];
    if (projectPromotions > 0) {
      promotedParts.push(`${projectPromotions} project skill(s)`);
    }
    if (userPromotions > 0) {
      promotedParts.push(`${userPromotions} user skill(s)`);
    }
    lines.push(`promoted ${promotedParts.join(' and ')}`);
  }
  if (projectArchived > 0 || userArchived > 0) {
    const archivedParts = [];
    if (projectArchived > 0) {
      archivedParts.push(`${projectArchived} project skill(s)`);
    }
    if (userArchived > 0) {
      archivedParts.push(`${userArchived} user skill(s)`);
    }
    lines.push(`archived ${archivedParts.join(' and ')}`);
  }
  if (projectDeactivated > 0 || userDeactivated > 0) {
    const deactivatedParts = [];
    if (projectDeactivated > 0) {
      deactivatedParts.push(`${projectDeactivated} project skill(s)`);
    }
    if (userDeactivated > 0) {
      deactivatedParts.push(`${userDeactivated} user skill(s)`);
    }
    lines.push(`deactivated ${deactivatedParts.join(' and ')}`);
  }
  if (projectReactivated > 0 || userReactivated > 0) {
    const reactivatedParts = [];
    if (projectReactivated > 0) {
      reactivatedParts.push(`${projectReactivated} project skill(s)`);
    }
    if (userReactivated > 0) {
      reactivatedParts.push(`${userReactivated} user skill(s)`);
    }
    lines.push(`reactivated ${reactivatedParts.join(' and ')}`);
  }
  if (skillDraft?.name) {
    lines.push(`updated draft ${skillDraft.name}`);
  }

  return {
    visible: lines.length > 0,
    newly_captured: {
      session_experiences_created: sessionExperiencesCreated,
      session_experiences_updated: sessionExperiencesUpdated,
      session_experiences_archived: sessionExperiencesArchived,
      legacy_synced_entries: legacySyncedEntries
    },
    skill_changes: {
      promoted_project_skills: projectPromotions,
      promoted_user_skills: userPromotions,
      archived_project_skills: projectArchived,
      archived_user_skills: userArchived,
      deactivated_project_skills: projectDeactivated,
      deactivated_user_skills: userDeactivated,
      reactivated_project_skills: projectReactivated,
      reactivated_user_skills: userReactivated
    },
    skill_draft: skillDraft,
    summary_lines: lines,
    summary: lines.length > 0 ? lines.join('; ') : 'No new visible benefit summary for this run.'
  };
}

module.exports = {
  buildVisibleBenefitSummary
};
