#!/usr/bin/env node
/**
 * Skillification Score Calculator
 * Calculates skillification score for experiences
 *
 * Usage: node skillification-score.js <workspace> [project-id]
 */

const fs = require('fs');
const path = require('path');

const workspace = process.argv[2] || process.cwd();
const projectId = process.argv[3] || 'default';

const anchorDir = path.join(workspace, '.context-anchor');
const projectsDir = path.join(anchorDir, 'projects');
const projectDir = path.join(projectsDir, projectId);
const experiencesFile = path.join(projectDir, 'experiences.json');

// Weights
const WEIGHTS = {
  time: 0.3,
  frequency: 0.3,
  crossSession: 0.2,
  heat: 0.2
};

// Thresholds
const THRESHOLDS = {
  minDays: 7,
  minScore: 0.7,
  maxDaysForFullWeight: 30,
  maxCountForFullWeight: 10,
  maxSessionsForFullWeight: 5
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJson(file, defaultValue = {}) {
  if (!fs.existsSync(file)) {
    return defaultValue;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return defaultValue;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function calculateDaysSinceCreated(createdAt) {
  const now = Date.now();
  const created = new Date(createdAt).getTime();
  return (now - created) / (1000 * 60 * 60 * 24);
}

function calculateSkillificationScore(experience) {
  const daysSinceCreated = calculateDaysSinceCreated(experience.created_at);
  
  // Time weight: 30 days for full weight
  const timeWeight = Math.min(daysSinceCreated / THRESHOLDS.maxDaysForFullWeight, 1);
  
  // Frequency weight: 10 accesses for full weight
  const frequencyWeight = Math.min((experience.access_count || 0) / THRESHOLDS.maxCountForFullWeight, 1);
  
  // Cross-session weight: 5 sessions for full weight
  const crossSessionWeight = Math.min((experience.access_sessions?.length || 0) / THRESHOLDS.maxSessionsForFullWeight, 1);
  
  // Heat weight: 100 for full weight
  const heatWeight = (experience.heat || 0) / 100;
  
  // Calculate total score
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
  const type = experience.type || 'general';
  const tags = experience.tags || [];
  
  // Generate name based on type and tags
  const typePrefixes = {
    'lesson': 'safe',
    'best_practice': 'guide',
    'tool-pattern': 'tool',
    'gotcha': 'avoid'
  };
  
  const prefix = typePrefixes[type] || 'skill';
  
  // Use first tag if available
  if (tags.length > 0) {
    const tag = tags[0].toLowerCase().replace(/[^a-z0-9]/g, '-');
    return `${prefix}-${tag}`;
  }
  
  // Fallback to type-based name
  return `${prefix}-${type}`;
}

function evaluateSkillification() {
  ensureDir(projectDir);
  
  const experiences = readJson(experiencesFile, { experiences: [] }).experiences;
  const candidates = [];
  const updatedExperiences = [];
  
  experiences.forEach(exp => {
    // Skip already skillified experiences
    if (exp.skill_name) {
      updatedExperiences.push(exp);
      return;
    }
    
    const scoreResult = calculateSkillificationScore(exp);
    
    // Update experience with score
    const updatedExp = {
      ...exp,
      skillification_score: scoreResult.score,
      skillification_breakdown: scoreResult.breakdown,
      skillification_suggested: scoreResult.score >= THRESHOLDS.minScore && scoreResult.meetsMinDays
    };
    
    updatedExperiences.push(updatedExp);
    
    // Add to candidates if meets threshold
    if (updatedExp.skillification_suggested) {
      candidates.push({
        id: exp.id,
        type: exp.type,
        summary: exp.summary,
        score: scoreResult.score,
        breakdown: scoreResult.breakdown,
        suggested_name: suggestSkillName(exp),
        days_since_created: scoreResult.daysSinceCreated,
        access_count: exp.access_count,
        access_sessions: exp.access_sessions?.length || 0
      });
    }
  });
  
  // Save updated experiences
  writeJson(experiencesFile, { experiences: updatedExperiences });
  
  // Output result
  console.log(JSON.stringify({
    project_id: projectId,
    evaluated: experiences.length,
    candidates: candidates.length,
    threshold: THRESHOLDS.minScore,
    min_days: THRESHOLDS.minDays,
    candidates_list: candidates.sort((a, b) => b.score - a.score)
  }, null, 2));
}

evaluateSkillification();
