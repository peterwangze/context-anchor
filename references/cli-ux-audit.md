# CLI UX Audit

## Purpose

This document audits the current command-line user experience of context-anchor and defines the next-step UX standard for all user-facing commands.

The guiding principle is:

- User attention and context are scarce resources.
- A command should help the user answer three questions in the first screen:
  - What just happened?
  - Do I need to act?
  - What should I run next?

## UX Goals

### Primary goals

- Make high-frequency commands readable at a glance.
- Highlight state, risk, and next actions without creating noisy output.
- Keep interactive-terminal output user-friendly while preserving JSON for automation.
- Use consistent wording for shared concepts such as readiness, diagnosis, repair, and recheck.

### Non-goals

- Turning every internal maintenance script into a rich interactive UI.
- Breaking existing automation that depends on JSON output.
- Exposing internal implementation detail when a simpler user-facing explanation is enough.

## Output Model

### Dual-mode rule

Commands should follow this default behavior unless there is a strong reason not to:

- TTY / interactive terminal: readable text view
- non-TTY / automation: JSON view
- explicit `--json`: JSON view regardless of TTY

### Output layers

A user-facing command should present information in this order:

1. Title
2. Primary status
3. Key scope or selection summary
4. Risk / attention summary
5. Next step / repair / recheck
6. Optional details

### Text emphasis model

Current shared formatter lives in `scripts/lib/terminal-format.js`.

Standard semantic mapping:

- `success`
  - meaning: healthy, complete, verified, safe to continue
  - examples: `READY`, `VERIFIED`, `INSTALLED`, `RUNNING`
- `warning`
  - meaning: attention required, degraded, drift, manual follow-up
  - examples: `DRIFT DETECTED`, `BEST EFFORT`, `NEEDS ATTENTION`
- `info`
  - meaning: neutral state, summary, next step, scoped context
- `muted`
  - meaning: supporting details, paths, counts, exclusions, legend
- `command`
  - meaning: user should be able to identify copyable commands immediately
- `danger`
  - meaning: command failed or a hard-stop error occurred

## Canonical wording

### Preferred status words

Use these labels consistently:

- installation
  - `READY`
  - `NOT READY`
- verification
  - `VERIFIED`
  - `NEEDS ATTENTION`
  - `WARNING`
- takeover / memory health
  - `SINGLE SOURCE`
  - `BEST EFFORT`
  - `DRIFT DETECTED`
- scheduler / monitor
  - `RUNNING`
  - `CONFIGURED`
  - `OFF`
  - `LEGACY`
- remediation
  - `Diagnose`
  - `Repair`
  - `Recheck`
  - `Next step`

### Wording rules

- Prefer human-readable labels over raw enum shapes.
  - good: `DRIFT DETECTED`
  - bad: `DRIFT_DETECTED`
- Prefer state descriptions over implementation terms.
  - good: `monitor assets exist but the scheduler is idle/queued`
  - bad: `runtime=ready`
- Avoid leaking raw objects or internal serialization into summaries.
  - `[object Object]` is always a bug.

## Current coverage

### High-frequency commands already aligned

These commands now have readable text-mode output and styled error handling:

- `doctor`
- `status-report`
- `status:sessions`
- `diagnose:sessions`
- `configure:host`
- `configure:sessions`
- `upgrade:sessions`
- `install:host`
- `install-host-assets`
- `rebuild:mirror`
- `migrate:memory`
- `memory-search`

### Shared capabilities already in place

- shared formatter: `scripts/lib/terminal-format.js`
- shared error view: `renderCliError()`
- long-running progress styling for install/upgrade
- humanized health and monitor wording
- task continuity summaries protected against structured-object leakage

## Stage review

### Current direction is correct

The current CLI UX evolution path is working and should be preserved:

- high-frequency user-facing commands were prioritized first
- a shared formatter was introduced before broad rollout
- automation compatibility was preserved through TTY text / non-TTY JSON behavior
- wording and summary quality were improved incrementally based on real command output

This has already produced visible gains in:

- status comprehension
- long-running command trust
- error readability
- terminology consistency

### New risk discovered during rollout

As more commands adopt the UX model, a new maintenance risk appears:

- command entrypoints are still wiring TTY detection, JSON fallback, error handling, and summary rendering manually
- status wording logic can still drift if each command keeps its own small formatting rules
- repeated CLI boilerplate will make future slices slower and more fragile

This is not yet an architecture problem, but it will become one if the rollout continues command-by-command without a small platforming step.

## Platforming checkpoint

Before scaling the UX rollout much further, the project should insert a small platforming checkpoint.

### Goal

Reduce repeated CLI UX boilerplate so future command improvements do not corrode maintainability.

### Why now

- enough commands have already adopted the new UX model to expose repetition patterns
- future slices will otherwise copy the same TTY / JSON / error-handling logic repeatedly
- a small shared helper layer now will make Slice B and later slices faster and more consistent

### Scope

This platforming step should stay intentionally lightweight. It does not need a large framework.

Candidate shared helpers:

- a shared command entry wrapper such as:
  - `runCliMain({ run, renderText, allowJson, renderError })`
- a shared output-mode decision helper such as:
  - `shouldRenderJson({ args, stdout })`
- shared human-readable status label helpers for:
  - verification states
  - memory health states
  - monitor / scheduler states
  - remediation state labels
- optional shared success-summary helpers for:
  - counts
  - scope lines
  - next-step lines

### Definition of done for the platforming step

- at least one or two representative commands migrate to the new wrapper successfully
- repeated entrypoint logic is reduced
- canonical wording helpers move closer to one shared place
- later command slices can reuse the pattern instead of copying it

## Remaining command inventory

### P0 - keep stable, continue polishing only when regression appears

These are already in the user-critical path and should stay stable:

- `doctor`
- `status-report`
- `status:sessions`
- `diagnose:sessions`
- `configure:host`
- `configure:sessions`
- `upgrade:sessions`
- `install:host`

### P1 - next commands worth human-friendly text mode

These commands are either user-visible or likely to be run manually during maintenance and debugging:

- `skill-diagnose.js`
- `skill-create.js`
- `skill-status-update.js`
- `skill-supersede.js`
- `experience-validate.js`

Why P1:

- users or maintainers may run them directly
- current output is still mostly JSON-first
- some failures still surface as raw machine payloads

### P2 - internal / low-frequency maintenance scripts

These can remain JSON-first until there is a user need:

- `checkpoint-create.js`
- `compact-packet-create.js`
- `context-pressure.js`
- `context-pressure-handle.js`
- `error-capture.js`
- `heartbeat.js`
- `heat-eval.js`
- `memory-flow.js`
- `memory-save.js`
- `migrate-global-to-user.js`
- `perf-benchmark.js`
- `runtime-error-sync.js`
- `runtime-state-update.js`
- `scope-promote.js`
- `session-close.js`
- `session-compact.js`
- `session-experience-sync.js`
- `session-maintenance.js`
- `session-start.js`
- `skill-draft-create.js`
- `skill-reconcile.js`
- `skillification-score.js`
- `user-experience-sync.js`

Why P2:

- mostly internal lifecycle or data-pipeline tools
- often consumed by wrappers, hooks, or tests
- changing defaults too aggressively can create compatibility risk

## Known UX risks

### Risk 1: TTY detection can hide the nicer text view in captured environments

Impact:

- some verification environments show JSON even though the user-facing terminal experience is better

Guidance:

- keep non-TTY JSON for safety
- if needed later, add explicit `--text` for forced human-readable mode

### Risk 2: wording drift across commands

Impact:

- the same state can appear with slightly different labels across commands

Guidance:

- keep canonical wording in one helper layer where possible
- avoid ad hoc `toUpperCase()` display logic in command files

### Risk 3: summary corruption from structured runtime payloads

Impact:

- object leakage into user-facing summaries destroys trust quickly

Guidance:

- all summary builders must normalize structured values before rendering
- user-facing summaries should prefer semantic fields over raw serialization

## Audit findings by dimension

### 1. Output hierarchy

Current state:

- strong improvement on high-frequency commands
- first-screen readability is now acceptable on status, doctor, install, upgrade, and configuration paths

Remaining gap:

- some maintenance scripts still begin with raw JSON instead of a one-line state summary

### 2. Wording consistency

Current state:

- much better than before
- memory-health wording and monitor wording were recently normalized

Remaining gap:

- some scripts still use raw status payloads directly instead of canonical display labels

### 3. Error UX

Current state:

- major status/config/install commands now show better failed-command output in TTY mode

Remaining gap:

- several lower-priority tools still emit raw JSON errors only

### 4. Automation compatibility

Current state:

- good direction: key commands preserve JSON for non-TTY or explicit `--json`

Remaining gap:

- this rule is not yet consistently implemented across the full script inventory

### 5. Long-running task feedback

Current state:

- install/upgrade progress is much better and no longer feels silently hung

Remaining gap:

- watch / monitor / governance oriented commands can still use better progress or completion summaries when run manually

## Recommended next implementation slices

### Slice A - P1 maintenance command text mode

Target commands:

- `external-memory-watch.js`
- `legacy-memory-sync.js`
- `workspace-monitor.js`
- `context-pressure-monitor.js`
- `storage-governance.js`

Expected result:

- clearer manual-debug experience without changing their data model

Current state:

- completed
- command coverage delivered for:
  - `external-memory-watch.js`
  - `legacy-memory-sync.js`
  - `workspace-monitor.js`
  - `context-pressure-monitor.js`
  - `storage-governance.js`

### Slice A.5 - CLI Platforming

Target:

- reduce repeated CLI entrypoint boilerplate before broadening the rollout further

Expected result:

- better maintainability
- less wording drift
- faster implementation of later slices
- lower regression risk during future CLI UX work

### Slice B - skill workflow command UX

Target commands:

- `skill-diagnose.js`
- `skill-create.js`
- `skill-status-update.js`
- `skill-supersede.js`
- `experience-validate.js`

Expected result:

- better readability for users maintaining the skill/experience lifecycle directly

### Slice C - explicit output-mode controls

Target:

- add optional `--text` where useful for commands often inspected in captured environments

Expected result:

- easier visual verification in CI-like or wrapped shells without losing JSON safety

## Definition of done for future CLI UX work

A command is considered UX-aligned when all of the following are true:

- TTY output shows a readable summary view
- non-TTY or `--json` preserves machine-readable output
- failure output is styled and actionable in TTY mode
- wording uses canonical labels instead of raw enums
- first screen answers status, urgency, and next step
- tests or smoke checks cover at least one representative success path

## Suggested execution order

1. complete Slice A validation and stabilize it
2. implement Slice A.5 CLI Platforming
3. skill workflow commands
4. optional `--text` support
5. opportunistic cleanup of residual raw enum rendering

## Progress tracking

### Completed

- shared terminal formatting layer created
- high-frequency install / upgrade / doctor / status / configure paths upgraded
- Slice A maintenance commands upgraded
- task continuity summary object leakage fixed
- memory-health wording humanized
- monitor wording normalized
- status-report runtime regression fixed

### In progress

- CLI UX audit documented here
- deciding exact scope of the CLI platforming checkpoint

### Next checkpoints

- define and implement Slice A.5 CLI Platforming
- complete Slice B
- decide whether explicit `--text` should become a standard affordance
