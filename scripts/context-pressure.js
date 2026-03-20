#!/usr/bin/env node
/**
 * Context Pressure Detection Script
 * Checks context usage and recommends actions
 *
 * Usage: node context-pressure.js
 *
 * Returns JSON with pressure level and recommended actions
 */

const PRESSURE_WARNING = 75;
const PRESSURE_CRITICAL = 85;

function checkPressure() {
  // This script is meant to be called by the agent
  // The agent should use session_status tool to get actual context usage
  // This script provides the logic for interpreting the results

  console.log(JSON.stringify({
    status: 'ready',
    thresholds: {
      warning: PRESSURE_WARNING,
      critical: PRESSURE_CRITICAL
    },
    instructions: {
      warning: 'Auto-save short-term memories to memory/YYYY-MM-DD.md',
      critical: 'Recommend user to execute /compact, then save memories'
    },
    actions: {
      check: 'Use session_status tool to get current context usage',
      warning_action: 'Execute memory save for entries with heat > 70',
      critical_action: 'Alert user and request /compact, then save all memories'
    }
  }, null, 2));
}

checkPressure();
