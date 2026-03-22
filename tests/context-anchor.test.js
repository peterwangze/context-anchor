const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { readJson, writeJson } = require('../scripts/lib/context-anchor');
const { runCheckpointCreate } = require('../scripts/checkpoint-create');
const { runContextPressureHandle } = require('../scripts/context-pressure-handle');
const { handleHookEvent } = require('../hooks/context-anchor-hook/handler');
const { runExperienceValidate } = require('../scripts/experience-validate');
const { runInstallHostAssets } = require('../scripts/install-host-assets');
const { runMemoryFlow } = require('../scripts/memory-flow');
const { runMemorySave } = require('../scripts/memory-save');
const { runSessionStart } = require('../scripts/session-start');
const { runSkillCreate } = require('../scripts/skill-create');
const { runSkillificationScore } = require('../scripts/skillification-score');

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'context-anchor-'));
}

function cleanupWorkspace(workspace) {
  fs.rmSync(workspace, { recursive: true, force: true });
}

test('session-start preserves existing session state', () => {
  const workspace = makeWorkspace();

  try {
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
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('context pressure handling creates a checkpoint and syncs hot memories', () => {
  const workspace = makeWorkspace();

  try {
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
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('memory-flow upserts a previously synced session memory when it changes', () => {
  const workspace = makeWorkspace();

  try {
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
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('skillification auto-validates reused experiences before suggesting a skill', () => {
  const workspace = makeWorkspace();

  try {
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
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('skill-create materializes a validated experience into a sibling skill directory', () => {
  const workspace = makeWorkspace();

  try {
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
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('experience-validate rejects unsupported validation statuses', () => {
  const workspace = makeWorkspace();

  try {
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
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('gateway startup hook emits a resume message for the latest active session', () => {
  const workspace = makeWorkspace();

  try {
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
  } finally {
    cleanupWorkspace(workspace);
  }
});

test('install-host-assets deploys a self-contained skill snapshot and registers extraDirs', () => {
  const workspace = makeWorkspace();
  const openClawHome = path.join(workspace, 'openclaw-home');

  try {
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
  } finally {
    cleanupWorkspace(workspace);
  }
});
