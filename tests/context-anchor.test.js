const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadCompactPacket,
  loadUserMemories,
  readJson,
  writeJson
} = require('../scripts/lib/context-anchor');
const { runCheckpointCreate } = require('../scripts/checkpoint-create');
const { runContextPressureHandle } = require('../scripts/context-pressure-handle');
const { handleHookEvent } = require('../hooks/context-anchor-hook/handler');
const { runExperienceValidate } = require('../scripts/experience-validate');
const { runInstallHostAssets } = require('../scripts/install-host-assets');
const { runMigrateGlobalToUser } = require('../scripts/migrate-global-to-user');
const { runMemoryFlow } = require('../scripts/memory-flow');
const { runMemorySave } = require('../scripts/memory-save');
const { runHeartbeat } = require('../scripts/heartbeat');
const { runSkillDiagnose } = require('../scripts/skill-diagnose');
const { runScopePromote } = require('../scripts/scope-promote');
const { runSkillReconcile } = require('../scripts/skill-reconcile');
const { runStatusReport } = require('../scripts/status-report');
const { runSkillSupersede } = require('../scripts/skill-supersede');
const { runSessionClose } = require('../scripts/session-close');
const { runSessionStart } = require('../scripts/session-start');
const { runSkillStatusUpdate } = require('../scripts/skill-status-update');
const { runSkillCreate } = require('../scripts/skill-create');
const { runSkillificationScore } = require('../scripts/skillification-score');

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'context-anchor-'));
}

function cleanupWorkspace(workspace) {
  fs.rmSync(workspace, { recursive: true, force: true });
}

function withOpenClawHome(workspace, fn) {
  const previous = process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_HOME = path.join(workspace, 'openclaw-home');

  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previous;
    }
  }
}

test('session-start preserves existing session state', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'session-a', 'demo');
    const sessionFile = path.join(
      workspace,
      '.context-anchor',
      'sessions',
      'session-a',
      'state.json'
    );
    const state = readJson(sessionFile, {});
    state.active_task = 'keep-me';
    state.commitments = [
      {
        id: 'c1',
        what: 'do x',
        when: '2026-03-22T00:00:00Z',
        status: 'pending'
      }
    ];
    writeJson(sessionFile, state);

    const result = runSessionStart(workspace, 'session-a', 'demo');
    const nextState = readJson(sessionFile, {});

    assert.equal(nextState.active_task, 'keep-me');
    assert.equal(nextState.commitments.length, 1);
    assert.equal(result.session.restored, true);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('context pressure handling creates a checkpoint and syncs hot memories', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
    runSessionStart(workspace, 'session-b', 'demo');
    runMemorySave(
      workspace,
      'session-b',
      'session',
      'decision',
      'Use JSON storage',
      JSON.stringify({ heat: 95, tags: ['architecture'] })
    );

    const result = runContextPressureHandle(workspace, 'session-b', 80);
    const checkpointFile = path.join(
      workspace,
      '.context-anchor',
      'sessions',
      'session-b',
      'checkpoint.md'
    );
    const decisionsFile = path.join(
      workspace,
      '.context-anchor',
      'projects',
      'demo',
      'decisions.json'
    );
    const decisions = readJson(decisionsFile, { decisions: [] }).decisions;

    assert.ok(result.actions.includes('checkpoint_created'));
    assert.ok(fs.existsSync(checkpointFile));
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decision, 'Use JSON storage');
    assert.ok(fs.existsSync(path.join(workspace, '.context-anchor', 'sessions', 'session-b', 'compact-packet.json')));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('memory-flow upserts a previously synced session memory when it changes', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
    runSessionStart(workspace, 'session-upsert', 'demo');
    runMemorySave(
      workspace,
      'session-upsert',
      'session',
      'best_practice',
      'first version',
      JSON.stringify({ heat: 95, details: 'v1' })
    );

    runMemoryFlow(workspace, 'session-upsert', { minimumHeat: 80 });

    const memoryFile = path.join(
      workspace,
      '.context-anchor',
      'sessions',
      'session-upsert',
      'memory-hot.json'
    );
    const memory = readJson(memoryFile, { entries: [] });
    memory.entries[0].content = 'second version';
    memory.entries[0].summary = 'second version';
    memory.entries[0].details = 'v2';
    memory.entries[0].heat = 95;
    writeJson(memoryFile, memory);

    const result = runMemoryFlow(workspace, 'session-upsert', { minimumHeat: 80 });
    const experiencesFile = path.join(
      workspace,
      '.context-anchor',
      'projects',
      'demo',
      'experiences.json'
    );
    const experiences = readJson(experiencesFile, { experiences: [] }).experiences;

    assert.equal(result.synced_entries, 1);
    assert.equal(experiences.length, 1);
    assert.equal(experiences[0].summary, 'second version');
    assert.equal(experiences[0].details, 'v2');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('skillification auto-validates reused experiences before suggesting a skill', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
    runSessionStart(workspace, 'session-c', 'demo');
    const saved = runMemorySave(
      workspace,
      'session-c',
      'project',
      'best_practice',
      'Reusable deployment checklist',
      JSON.stringify({
        heat: 95,
        access_count: 8,
        access_sessions: ['session-d', 'session-e'],
        tags: ['deployment'],
        validation_status: 'pending'
      })
    );

    const experiencesFile = path.join(
      workspace,
      '.context-anchor',
      'projects',
      'demo',
      'experiences.json'
    );
    const experiences = readJson(experiencesFile, { experiences: [] });
    experiences.experiences[0].created_at = '2026-03-01T00:00:00Z';
    writeJson(experiencesFile, experiences);

    const result = runSkillificationScore(workspace, 'demo');

    assert.equal(result.candidates, 1);
    assert.equal(result.candidates_list[0].id, saved.id);
    assert.equal(result.candidates_list[0].validation_status, 'validated');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('skill-create materializes a validated experience into a sibling skill directory', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
    runSessionStart(workspace, 'session-d', 'demo');
    const saved = runMemorySave(
      workspace,
      'session-d',
      'project',
      'best_practice',
      'Reusable deployment checklist',
      JSON.stringify({
        heat: 95,
        access_count: 4,
        access_sessions: ['session-e'],
        tags: ['deployment'],
        validation_status: 'validated'
      })
    );

    const experiencesFile = path.join(
      workspace,
      '.context-anchor',
      'projects',
      'demo',
      'experiences.json'
    );
    const experiences = readJson(experiencesFile, { experiences: [] });
    experiences.experiences[0].created_at = '2026-03-01T00:00:00Z';
    writeJson(experiencesFile, experiences);

    const skillsRoot = path.join(workspace, 'skills-root');
    const created = runSkillCreate(workspace, saved.id, 'deploy-guide', 'demo', {
      skillsRoot
    });

    assert.equal(created.status, 'created');
    assert.ok(fs.existsSync(path.join(skillsRoot, 'deploy-guide', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(skillsRoot, '_skill-index.json')));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('experience-validate rejects unsupported validation statuses', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
    runSessionStart(workspace, 'session-validate', 'demo');
    const saved = runMemorySave(
      workspace,
      'session-validate',
      'project',
      'best_practice',
      'validation candidate'
    );

    assert.throws(
      () => runExperienceValidate(workspace, saved.id, 'typo_status', 'demo'),
      /Validation status must be one of/
    );
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('gateway startup hook emits a resume message for the latest active session', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
    runSessionStart(workspace, 'resume-session', 'demo');
    const sessionFile = path.join(
      workspace,
      '.context-anchor',
      'sessions',
      'resume-session',
      'state.json'
    );
    const state = readJson(sessionFile, {});
    state.active_task = 'finish repair';
    state.commitments = [
      {
        id: 'c2',
        what: 'ship fix',
        when: '2026-03-22T00:00:00Z',
        status: 'pending'
      }
    ];
    writeJson(sessionFile, state);
    runCheckpointCreate(workspace, 'resume-session', 'manual');

    const result = handleHookEvent('gateway:startup', {
      workspace
    });

    assert.equal(result.status, 'resume_available');
    assert.match(result.resume_message, /finish repair/);
    assert.match(result.resume_message, /ship fix/);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('install-host-assets deploys a self-contained skill snapshot and registers extraDirs', () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');

  try {
    withOpenClawHome(workspace, () => {
    const result = runInstallHostAssets(openClawHome);
    const config = readJson(path.join(openClawHome, 'config.json'), {});
    const installedSkillDir = path.join(openClawHome, 'skills', 'context-anchor');
    const hookWrapper = fs.readFileSync(
      path.join(openClawHome, 'hooks', 'context-anchor-hook', 'handler.js'),
      'utf8'
    );
    const normalizedWrapper = hookWrapper.replaceAll('\\\\', '\\');

    assert.equal(result.status, 'installed');
    assert.ok(config.extraDirs.includes(path.join(openClawHome, 'skills')));
    assert.equal(result.installed_skill_dir, installedSkillDir);
    assert.equal(path.basename(result.installed_skill_dir), 'context-anchor');
    assert.ok(fs.existsSync(path.join(installedSkillDir, 'README.md')));
    assert.ok(fs.existsSync(path.join(installedSkillDir, 'scripts', 'memory-flow.js')));
    assert.ok(fs.existsSync(path.join(openClawHome, 'hooks', 'context-anchor-hook', 'handler.js')));
    assert.ok(
      fs.existsSync(
        path.join(openClawHome, 'automation', 'context-anchor', 'context-pressure-monitor.js')
      )
    );
    assert.ok(normalizedWrapper.includes(installedSkillDir));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('session-start loads user scope memories and skills', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runMemorySave(
        workspace,
        'bootstrap-session',
        'user',
        'preference',
        'language:zh-CN',
        JSON.stringify({ user_id: 'default-user' })
      );
      runMemorySave(
        workspace,
        'bootstrap-session',
        'user',
        'best_practice',
        'Prefer concise summaries',
        JSON.stringify({
          user_id: 'default-user',
          heat: 90,
          access_sessions: ['other-session']
        })
      );
      const openClawHome = path.join(workspace, 'openclaw-home');
      const userSkillDir = path.join(openClawHome, 'context-anchor', 'users', 'default-user', 'skills');
      fs.mkdirSync(userSkillDir, { recursive: true });
      writeJson(path.join(userSkillDir, 'index.json'), {
        skills: [
          {
            id: 'user-skill-1',
            name: 'default-user-skill',
            scope: 'user',
            status: 'active',
            summary: 'Loaded at session start'
          }
        ]
      });

      const result = runSessionStart(workspace, 'session-user-load');
      assert.equal(result.user.id, 'default-user');
      assert.ok(result.memories_to_inject.some((entry) => entry.source === 'user_preferences'));
      assert.ok(result.memories_to_inject.some((entry) => entry.source === 'user_experiences'));
      assert.equal(result.skills_to_activate.user.length, 1);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('session-close writes summary, compact packet, and session skill draft', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'session-close', 'demo');
      runMemorySave(
        workspace,
        'session-close',
        'session',
        'best_practice',
        'Always checkpoint before compaction',
        JSON.stringify({ heat: 95, details: 'session lesson' })
      );

      const result = runSessionClose(workspace, 'session-close', {
        reason: 'session-end',
        usagePercent: 88
      });

      assert.equal(result.status, 'closed');
      assert.ok(fs.existsSync(path.join(workspace, '.context-anchor', 'sessions', 'session-close', 'session-summary.json')));
      assert.ok(fs.existsSync(path.join(workspace, '.context-anchor', 'sessions', 'session-close', 'compact-packet.json')));
      assert.ok(fs.existsSync(path.join(workspace, '.context-anchor', 'sessions', 'session-close', 'skills', 'index.json')));
      const skills = readJson(path.join(workspace, '.context-anchor', 'sessions', 'session-close', 'skills', 'index.json'), { skills: [] }).skills;
      assert.equal(skills.length, 1);
      const compactPacket = loadCompactPacket(
        { ...require('../scripts/lib/context-anchor').createPaths(workspace) },
        'session-close'
      );
      assert.equal(compactPacket.session_key, 'session-close');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('migrate-global-to-user imports legacy global state into user scope', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      const globalFile = path.join(workspace, '.context-anchor', 'projects', '_global', 'state.json');
      fs.mkdirSync(path.dirname(globalFile), { recursive: true });
      writeJson(globalFile, {
        user_preferences: {
          timezone: 'Asia/Shanghai'
        },
        important_facts: [
          {
            id: 'glob-1',
            content: 'User prefers Chinese'
          }
        ],
        global_experiences: [
          {
            id: 'glob-exp-1',
            type: 'best_practice',
            summary: 'Reuse stable prompts'
          }
        ]
      });

      const result = runMigrateGlobalToUser(workspace);
      const userMemories = loadUserMemories(require('../scripts/lib/context-anchor').createPaths(workspace), 'default-user');

      assert.equal(result.status, 'migrated');
      assert.equal(result.imported_memories, 1);
      assert.equal(userMemories.length, 1);
      assert.equal(userMemories[0].scope, 'user');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('command stop hook runs unified session close lifecycle', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'hook-close', 'demo');
      runMemorySave(
        workspace,
        'hook-close',
        'session',
        'best_practice',
        'Close through unified lifecycle',
        JSON.stringify({ heat: 95 })
      );

      const result = handleHookEvent('command:stop', {
        workspace,
        session_key: 'hook-close',
        project_id: 'demo',
        usage_percent: 91
      });

      assert.equal(result.status, 'handled');
      assert.equal(result.result.status, 'closed');
      assert.ok(fs.existsSync(path.join(workspace, '.context-anchor', 'sessions', 'hook-close', 'session-summary.json')));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('heartbeat promotes validated project experiences into active project skills', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'promote-project', 'demo');
      const saved = runMemorySave(
        workspace,
        'promote-project',
        'project',
        'best_practice',
        'Use scoped checkpoints',
        JSON.stringify({
          heat: 95,
          access_count: 8,
          access_sessions: ['session-b', 'session-c'],
          tags: ['checkpoint'],
          validation_status: 'validated'
        })
      );

      const experiencesFile = path.join(
        workspace,
        '.context-anchor',
        'projects',
        'demo',
        'experiences.json'
      );
      const experiences = readJson(experiencesFile, { experiences: [] });
      experiences.experiences[0].created_at = '2026-03-01T00:00:00Z';
      writeJson(experiencesFile, experiences);

      const result = runHeartbeat(workspace, 'promote-project', 'demo', 50);
      const projectSkills = readJson(
        path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills', 'index.json'),
        { skills: [] }
      ).skills;

      assert.equal(result.promotions.project_promotions, 1);
      assert.equal(projectSkills.length, 1);
      assert.equal(projectSkills[0].scope, 'project');
      assert.equal(projectSkills[0].source_experience, saved.id);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('scope promote creates active user skills from validated user experiences with cross-project evidence', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runMemorySave(
        workspace,
        'promote-user',
        'user',
        'best_practice',
        'Keep user-facing summaries concise',
        JSON.stringify({
          user_id: 'default-user',
          heat: 95,
          access_count: 8,
          access_sessions: ['session-a', 'session-b'],
          validation: {
            status: 'validated',
            count: 2,
            evidence_count: 4,
            cross_project_count: 2,
            auto_validated: false,
            last_reviewed_at: '2026-03-22T00:00:00Z',
            notes: []
          }
        })
      );

      const userExperiencesFile = path.join(
        workspace,
        'openclaw-home',
        'context-anchor',
        'users',
        'default-user',
        'experiences.json'
      );
      const experiences = readJson(userExperiencesFile, { experiences: [] });
      experiences.experiences[0].created_at = '2026-03-01T00:00:00Z';
      writeJson(userExperiencesFile, experiences);

      const result = runScopePromote(workspace, {
        sessionKey: 'promote-user',
        projectId: 'demo',
        userId: 'default-user'
      });
      const userSkills = readJson(
        path.join(
          workspace,
          'openclaw-home',
          'context-anchor',
          'users',
          'default-user',
          'skills',
          'index.json'
        ),
        { skills: [] }
      ).skills;

      assert.equal(result.user_promotions, 1);
      assert.equal(userSkills.length, 1);
      assert.equal(userSkills[0].scope, 'user');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('scope promote reuses an existing active project skill for same-name experiences', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'promote-reuse', 'demo');
      const first = runMemorySave(
        workspace,
        'promote-reuse',
        'project',
        'best_practice',
        'Use scoped checkpoints',
        JSON.stringify({
          heat: 95,
          access_count: 8,
          access_sessions: ['session-b', 'session-c'],
          tags: ['checkpoint'],
          validation_status: 'validated'
        })
      );
      const second = runMemorySave(
        workspace,
        'promote-reuse',
        'project',
        'best_practice',
        'Use scoped checkpoints',
        JSON.stringify({
          heat: 95,
          access_count: 8,
          access_sessions: ['session-d', 'session-e'],
          tags: ['checkpoint'],
          validation_status: 'validated'
        })
      );

      const experiencesFile = path.join(workspace, '.context-anchor', 'projects', 'demo', 'experiences.json');
      const experiences = readJson(experiencesFile, { experiences: [] });
      experiences.experiences.forEach((entry) => {
        entry.created_at = '2026-03-01T00:00:00Z';
      });
      writeJson(experiencesFile, experiences);

      runScopePromote(workspace, {
        sessionKey: 'promote-reuse',
        projectId: 'demo',
        userId: 'default-user'
      });
      const result = runScopePromote(workspace, {
        sessionKey: 'promote-reuse',
        projectId: 'demo',
        userId: 'default-user'
      });
      const projectSkills = readJson(
        path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills', 'index.json'),
        { skills: [] }
      ).skills;
      const updatedExperiences = readJson(experiencesFile, { experiences: [] }).experiences;

      assert.equal(result.project_promotions, 0);
      assert.equal(projectSkills.length, 1);
      assert.ok(projectSkills[0].related_experiences.includes(first.id));
      assert.ok(projectSkills[0].related_experiences.includes(second.id));
      assert.equal(updatedExperiences[0].skill_id, updatedExperiences[1].skill_id);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('session-start prefers session over project over user skills with same conflict key', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'priority-session', 'demo');

      const projectSkillDir = path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills');
      fs.mkdirSync(projectSkillDir, { recursive: true });
      writeJson(path.join(projectSkillDir, 'index.json'), {
        skills: [
          {
            id: 'project-skill-1',
            name: 'shared-skill',
            conflict_key: 'shared-skill',
            scope: 'project',
            status: 'active',
            summary: 'project version'
          }
        ]
      });

      const userSkillDir = path.join(workspace, 'openclaw-home', 'context-anchor', 'users', 'default-user', 'skills');
      fs.mkdirSync(userSkillDir, { recursive: true });
      writeJson(path.join(userSkillDir, 'index.json'), {
        skills: [
          {
            id: 'user-skill-1',
            name: 'shared-skill',
            conflict_key: 'shared-skill',
            scope: 'user',
            status: 'active',
            summary: 'user version'
          }
        ]
      });

      const sessionSkillDir = path.join(workspace, '.context-anchor', 'sessions', 'priority-session', 'skills');
      fs.mkdirSync(sessionSkillDir, { recursive: true });
      writeJson(path.join(sessionSkillDir, 'index.json'), {
        skills: [
          {
            id: 'session-skill-1',
            name: 'shared-skill',
            conflict_key: 'shared-skill',
            scope: 'session',
            status: 'draft',
            summary: 'session version'
          }
        ]
      });

      const result = runSessionStart(workspace, 'priority-session', 'demo');

      assert.equal(result.effective_skills.length, 1);
      assert.equal(result.effective_skills[0].id, 'session-skill-1');
      assert.equal(result.shadowed_skills.length, 2);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('inactive skills are filtered from effective activation', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'inactive-skill', 'demo');
      const projectSkillDir = path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills');
      fs.mkdirSync(projectSkillDir, { recursive: true });
      writeJson(path.join(projectSkillDir, 'index.json'), {
        skills: [
          {
            id: 'project-skill-1',
            name: 'inactive-skill',
            scope: 'project',
            status: 'active',
            summary: 'to be deactivated'
          }
        ]
      });

      runSkillStatusUpdate(workspace, 'project', 'project-skill-1', 'inactive', 'demo', 'disabled in test');
      const result = runSessionStart(workspace, 'inactive-skill', 'demo');

      assert.equal(result.effective_skills.length, 0);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('skill reconcile deactivates project skills whose supporting experience is rejected', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'reconcile-project', 'demo');
      const saved = runMemorySave(
        workspace,
        'reconcile-project',
        'project',
        'best_practice',
        'Keep promotion evidence fresh',
        JSON.stringify({
          heat: 95,
          access_count: 8,
          access_sessions: ['session-b', 'session-c'],
          validation_status: 'validated'
        })
      );

      const experiencesFile = path.join(workspace, '.context-anchor', 'projects', 'demo', 'experiences.json');
      const experiences = readJson(experiencesFile, { experiences: [] });
      experiences.experiences[0].created_at = '2026-03-01T00:00:00Z';
      writeJson(experiencesFile, experiences);

      runScopePromote(workspace, {
        sessionKey: 'reconcile-project',
        projectId: 'demo',
        userId: 'default-user'
      });

      const promotedExperiences = readJson(experiencesFile, { experiences: [] });
      promotedExperiences.experiences[0].validation.status = 'rejected';
      writeJson(experiencesFile, promotedExperiences);

      const result = runSkillReconcile(workspace, {
        projectId: 'demo',
        userId: 'default-user'
      });
      const projectSkills = readJson(
        path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills', 'index.json'),
        { skills: [] }
      ).skills;

      assert.equal(result.project_deactivated, 1);
      assert.equal(projectSkills[0].status, 'inactive');
      assert.ok(projectSkills[0].status_history.length >= 2);
      assert.equal(projectSkills[0].source_experience, saved.id);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('project skill records promotion history and manual status history', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'history-project', 'demo');
      runMemorySave(
        workspace,
        'history-project',
        'project',
        'best_practice',
        'Track promotion history',
        JSON.stringify({
          heat: 95,
          access_count: 8,
          access_sessions: ['session-b', 'session-c'],
          validation_status: 'validated'
        })
      );

      const experiencesFile = path.join(workspace, '.context-anchor', 'projects', 'demo', 'experiences.json');
      const experiences = readJson(experiencesFile, { experiences: [] });
      experiences.experiences[0].created_at = '2026-03-01T00:00:00Z';
      writeJson(experiencesFile, experiences);

      runScopePromote(workspace, {
        sessionKey: 'history-project',
        projectId: 'demo',
        userId: 'default-user'
      });

      const projectSkillsFile = path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills', 'index.json');
      const promotedSkills = readJson(projectSkillsFile, { skills: [] }).skills;
      runSkillStatusUpdate(workspace, 'project', promotedSkills[0].id, 'inactive', 'demo', 'manual test deactivate');
      const updatedSkills = readJson(projectSkillsFile, { skills: [] }).skills;

      assert.ok(updatedSkills[0].promotion_history.length >= 1);
      assert.ok(updatedSkills[0].status_history.length >= 2);
      assert.equal(updatedSkills[0].status, 'inactive');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('skill supersede deactivates loser and keeps only winner effective', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'supersede-project', 'demo');
      const projectSkillDir = path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills');
      fs.mkdirSync(projectSkillDir, { recursive: true });
      writeJson(path.join(projectSkillDir, 'index.json'), {
        skills: [
          {
            id: 'project-skill-a',
            name: 'shared-project-skill-a',
            conflict_key: 'shared-project-skill-a',
            scope: 'project',
            status: 'active',
            summary: 'winner',
            load_policy: { priority: 60, budget_weight: 1, auto_load: true }
          },
          {
            id: 'project-skill-b',
            name: 'shared-project-skill-b',
            conflict_key: 'shared-project-skill-b',
            scope: 'project',
            status: 'active',
            summary: 'loser',
            load_policy: { priority: 50, budget_weight: 1, auto_load: true }
          }
        ]
      });

      runSkillSupersede(workspace, 'project', 'project-skill-a', 'project-skill-b', 'demo');
      const skills = readJson(path.join(projectSkillDir, 'index.json'), { skills: [] }).skills;
      const result = runSessionStart(workspace, 'supersede-project', 'demo');

      assert.ok((skills[0].evidence || []).some((event) => event.type === 'skill_supersede_winner'));
      assert.ok((skills[1].evidence || []).some((event) => event.type === 'skill_superseded'));
      assert.ok(result.effective_skills.some((skill) => skill.id === 'project-skill-a'));
      assert.ok(!result.effective_skills.some((skill) => skill.id === 'project-skill-b'));
      assert.ok(result.shadowed_skills.length === 0);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('skill activation budget limits effective skills and reports budgeted out skills', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'budget-session', 'demo');
      const sessionSkillDir = path.join(workspace, '.context-anchor', 'sessions', 'budget-session', 'skills');
      fs.mkdirSync(sessionSkillDir, { recursive: true });
      writeJson(path.join(sessionSkillDir, 'index.json'), {
        skills: [
          {
            id: 's1',
            name: 'skill-1',
            conflict_key: 'skill-1',
            scope: 'session',
            status: 'draft',
            load_policy: { priority: 90, budget_weight: 1, auto_load: true }
          },
          {
            id: 's2',
            name: 'skill-2',
            conflict_key: 'skill-2',
            scope: 'session',
            status: 'draft',
            load_policy: { priority: 80, budget_weight: 1, auto_load: true }
          },
          {
            id: 's3',
            name: 'skill-3',
            conflict_key: 'skill-3',
            scope: 'session',
            status: 'draft',
            load_policy: { priority: 70, budget_weight: 1, auto_load: true }
          }
        ]
      });
      const projectSkillDir = path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills');
      fs.mkdirSync(projectSkillDir, { recursive: true });
      writeJson(path.join(projectSkillDir, 'index.json'), {
        skills: [
          {
            id: 'p1',
            name: 'project-skill-1',
            conflict_key: 'project-skill-1',
            scope: 'project',
            status: 'active',
            load_policy: { priority: 60, budget_weight: 1, auto_load: true }
          },
          {
            id: 'p2',
            name: 'project-skill-2',
            conflict_key: 'project-skill-2',
            scope: 'project',
            status: 'active',
            load_policy: { priority: 50, budget_weight: 1, auto_load: true }
          },
          {
            id: 'p3',
            name: 'project-skill-3',
            conflict_key: 'project-skill-3',
            scope: 'project',
            status: 'active',
            load_policy: { priority: 40, budget_weight: 1, auto_load: true }
          }
        ]
      });
      const userSkillDir = path.join(workspace, 'openclaw-home', 'context-anchor', 'users', 'default-user', 'skills');
      fs.mkdirSync(userSkillDir, { recursive: true });
      writeJson(path.join(userSkillDir, 'index.json'), {
        skills: [
          {
            id: 'u1',
            name: 'user-skill-1',
            conflict_key: 'user-skill-1',
            scope: 'user',
            status: 'active',
            load_policy: { priority: 30, budget_weight: 1, auto_load: true }
          },
          {
            id: 'u2',
            name: 'user-skill-2',
            conflict_key: 'user-skill-2',
            scope: 'user',
            status: 'active',
            load_policy: { priority: 20, budget_weight: 1, auto_load: true }
          }
        ]
      });

      const result = runSessionStart(workspace, 'budget-session', 'demo');

      assert.equal(result.effective_skills.length, 5);
      assert.ok(result.shadowed_skills.length === 0);
      assert.ok(result.boot_packet.skill_governance.budgeted_out.length >= 1);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('skill reconcile archives low-value inactive skills', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'archive-skill', 'demo');
      const projectSkillDir = path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills');
      fs.mkdirSync(projectSkillDir, { recursive: true });
      writeJson(path.join(projectSkillDir, 'index.json'), {
        skills: [
          {
            id: 'project-skill-archive',
            name: 'archive-me',
            scope: 'project',
            status: 'inactive',
            usage_count: 0,
            load_policy: { priority: 10, budget_weight: 1, auto_load: true },
            status_history: [
              {
                status: 'inactive',
                at: '2026-03-24T00:00:00Z',
                reason: 'manual'
              }
            ]
          }
        ]
      });

      const result = runSkillReconcile(workspace, {
        projectId: 'demo',
        userId: 'default-user'
      });
      const projectSkills = readJson(path.join(projectSkillDir, 'index.json'), { skills: [] }).skills;

      assert.equal(result.project_archived, 1);
      assert.equal(projectSkills[0].status, 'archived');
      assert.equal(projectSkills[0].archived, true);
      assert.ok((projectSkills[0].evidence || []).some((event) => event.type === 'skill_archived'));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('skill reconcile reactivates inactive skills when supporting evidence returns', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'reactivate-skill', 'demo');
      const projectSkillDir = path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills');
      const projectExperiencesFile = path.join(workspace, '.context-anchor', 'projects', 'demo', 'experiences.json');
      fs.mkdirSync(projectSkillDir, { recursive: true });
      writeJson(projectExperiencesFile, {
        experiences: [
          {
            id: 'exp-reactivate',
            type: 'best_practice',
            summary: 'Reusable lesson',
            validation: { status: 'validated' },
            skillification_suggested: true,
            archived: false,
            source_project: 'demo',
            source_user: 'default-user'
          }
        ]
      });
      writeJson(path.join(projectSkillDir, 'index.json'), {
        skills: [
          {
            id: 'project-skill-reactivate',
            name: 'reactivate-me',
            scope: 'project',
            status: 'inactive',
            related_experiences: ['exp-reactivate'],
            source_project: 'demo',
            source_user: 'default-user',
            status_history: [
              {
                status: 'inactive',
                at: '2026-03-24T00:00:00Z',
                reason: 'manual'
              }
            ]
          }
        ]
      });

      const result = runSkillReconcile(workspace, {
        projectId: 'demo',
        userId: 'default-user'
      });
      const projectSkills = readJson(path.join(projectSkillDir, 'index.json'), { skills: [] }).skills;

      assert.equal(result.project_reactivated, 1);
      assert.equal(projectSkills[0].status, 'active');
      assert.ok((projectSkills[0].evidence || []).some((event) => event.type === 'skill_reactivated'));
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('status report summarizes user project session counts and governance', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'report-session', 'demo');
      runMemorySave(
        workspace,
        'report-session',
        'user',
        'best_practice',
        'User level guidance'
      );
      runMemorySave(
        workspace,
        'report-session',
        'project',
        'best_practice',
        'Project level guidance'
      );
      runMemorySave(
        workspace,
        'report-session',
        'session',
        'best_practice',
        'Session level guidance'
      );
      runSessionClose(workspace, 'report-session', {
        reason: 'session-end',
        usagePercent: 88
      });

      const report = runStatusReport(workspace, 'report-session', 'demo', 'default-user');

      assert.equal(report.status, 'ok');
      assert.equal(report.user.id, 'default-user');
      assert.equal(report.project.id, 'demo');
      assert.equal(report.session.key, 'report-session');
      assert.ok(report.session.last_summary_snapshot);
      assert.ok(typeof report.governance.active === 'number');
      assert.ok(report.evidence.project_skills);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('status report can write a snapshot file and return adaptive budget guidance', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'snapshot-session', 'demo');
      const sessionSkillDir = path.join(workspace, '.context-anchor', 'sessions', 'snapshot-session', 'skills');
      fs.mkdirSync(sessionSkillDir, { recursive: true });
      writeJson(path.join(sessionSkillDir, 'index.json'), {
        skills: [
          {
            id: 'snap-s1',
            name: 'snap-s1',
            conflict_key: 'snap-s1',
            scope: 'session',
            status: 'draft',
            load_policy: { priority: 90, budget_weight: 1, auto_load: true }
          },
          {
            id: 'snap-s2',
            name: 'snap-s2',
            conflict_key: 'snap-s2',
            scope: 'session',
            status: 'draft',
            load_policy: { priority: 80, budget_weight: 1, auto_load: true }
          },
          {
            id: 'snap-s3',
            name: 'snap-s3',
            conflict_key: 'snap-s3',
            scope: 'session',
            status: 'draft',
            load_policy: { priority: 70, budget_weight: 1, auto_load: true }
          }
        ]
      });

      const report = runStatusReport(workspace, 'snapshot-session', 'demo', 'default-user', {
        writeSnapshot: true
      });

      assert.ok(fs.existsSync(report.snapshot_file));
      assert.ok(report.adaptive_budget);
      assert.ok(report.adaptive_budget.recommended.total >= report.adaptive_budget.current.total);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('skill diagnose explains active shadowed superseded and budgeted skills', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'diagnose-session', 'demo');
      const sessionSkillDir = path.join(workspace, '.context-anchor', 'sessions', 'diagnose-session', 'skills');
      fs.mkdirSync(sessionSkillDir, { recursive: true });
      writeJson(path.join(sessionSkillDir, 'index.json'), {
        skills: [
          {
            id: 'diag-session',
            name: 'shared-diag',
            conflict_key: 'shared-diag',
            scope: 'session',
            status: 'draft',
            load_policy: { priority: 90, budget_weight: 1, auto_load: true }
          },
          {
            id: 'diag-budget-1',
            name: 'budget-a',
            conflict_key: 'budget-a',
            scope: 'session',
            status: 'draft',
            load_policy: { priority: 85, budget_weight: 1, auto_load: true }
          },
          {
            id: 'diag-budget-2',
            name: 'budget-b',
            conflict_key: 'budget-b',
            scope: 'session',
            status: 'draft',
            load_policy: { priority: 80, budget_weight: 1, auto_load: true }
          }
        ]
      });
      const projectSkillDir = path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills');
      fs.mkdirSync(projectSkillDir, { recursive: true });
      writeJson(path.join(projectSkillDir, 'index.json'), {
        skills: [
          {
            id: 'diag-project',
            name: 'shared-diag',
            conflict_key: 'shared-diag',
            scope: 'project',
            status: 'active',
            load_policy: { priority: 60, budget_weight: 1, auto_load: true }
          },
          {
            id: 'diag-supersede-winner',
            name: 'winner-skill',
            conflict_key: 'winner-skill',
            scope: 'project',
            status: 'active',
            supersedes: ['loser-skill'],
            load_policy: { priority: 70, budget_weight: 1, auto_load: true }
          },
          {
            id: 'diag-supersede-loser',
            name: 'loser-skill',
            conflict_key: 'loser-skill',
            scope: 'project',
            status: 'active',
            load_policy: { priority: 65, budget_weight: 1, auto_load: true }
          }
        ]
      });

      const diagActive = runSkillDiagnose(workspace, 'diag-session', 'diagnose-session', 'demo', 'default-user');
      const diagShadowed = runSkillDiagnose(workspace, 'diag-project', 'diagnose-session', 'demo', 'default-user');
      const diagSuperseded = runSkillDiagnose(workspace, 'diag-supersede-loser', 'diagnose-session', 'demo', 'default-user');
      const diagBudget = runSkillDiagnose(workspace, 'diag-budget-2', 'diagnose-session', 'demo', 'default-user');

      assert.equal(diagActive.effective_match.id, 'diag-session');
      assert.equal(diagShadowed.reasons[0].diagnosis, 'shadowed');
      assert.equal(diagSuperseded.reasons[0].diagnosis, 'superseded');
      assert.equal(diagBudget.reasons[0].diagnosis, 'budgeted_out');
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('skill diagnose returns recommended actions for non-active diagnoses', () => {
  const workspace = makeWorkspace();

  try {
    withOpenClawHome(workspace, () => {
      runSessionStart(workspace, 'diag-actions', 'demo');
      const projectSkillDir = path.join(workspace, '.context-anchor', 'projects', 'demo', 'skills');
      fs.mkdirSync(projectSkillDir, { recursive: true });
      writeJson(path.join(projectSkillDir, 'index.json'), {
        skills: [
          {
            id: 'diag-archived',
            name: 'diag-archived',
            conflict_key: 'diag-archived',
            scope: 'project',
            status: 'archived',
            archived: true
          }
        ]
      });

      const result = runSkillDiagnose(workspace, 'diag-archived', 'diag-actions', 'demo', 'default-user');

      assert.equal(result.reasons[0].diagnosis, 'archived');
      assert.ok(result.recommendations.length >= 1);
      assert.ok(result.reasons[0].evidence_summary);
    });
  } finally {
    cleanupWorkspace(workspace);
  }
});
