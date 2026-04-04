# Onboard OTEL Canvas

Telemetry schema for the `onboard-otel-canvas` skill execution.

## Overview

This canvas documents the telemetry events emitted during the onboarding workflow, which guides users through creating their first OTEL canvas and workflow scenarios.

## Events

| Event | Description |
|-------|-------------|
| `onboard.started` | Skill execution initiated |
| `onboard.discovery.complete` | Phase 0: Codebase exploration complete, candidates found |
| `onboard.discovery.error` | Error during codebase exploration |
| `onboard.feature.selected` | Phase 1: User selected a feature to onboard |
| `onboard.canvas.created` | Phase 2: Canvas file created |
| `onboard.canvas.error` | Error creating or validating canvas file |
| `onboard.workflow.created` | Phase 3: Workflow file created |
| `onboard.workflow.error` | Error creating or validating workflow file |
| `onboard.complete` | Phase 4: Onboarding successfully completed |

## Workflow Scenarios

- **Success**: Full onboarding completed with canvas and workflow files
- **Discovery Failed**: Error during codebase exploration (`onboard.discovery.error`)
- **Canvas Creation Failed**: Error creating canvas (`onboard.canvas.error`)
- **Workflow Creation Failed**: Error creating workflow (`onboard.workflow.error`)
