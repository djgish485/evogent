---
name: pipeline-audit
description: Manual entrypoint into the shared audit core used by every curation and reflection cycle
user-invocable: true
metadata:
  evogent:
    heartbeat-task: false
    chat-routing: background
    requires:
      env: []
---
# Pipeline Audit

This skill is a manual/user-invocable entrypoint into `.claude/shared/audit-core.md`.

## Purpose

- It uses the same audit core that already runs on every curation and every reflection cycle.
- It is not a heartbeat task.
- It is not a separate third audit path.
- It must not define its own output rules, lifecycle rules, or audit-summary conventions.

Use it when the user explicitly asks to audit the pipeline or when you need to manually apply the shared audit core outside the normal curation/reflection cadence.

## How to run it

1. Read `.claude/shared/audit-core.md`.
2. Execute that file in `manual` mode.
3. Keep the main target as the external-content pipeline unless the user explicitly asks for another pipeline.
4. Use the same evidence bundle and routing rules as curation/reflection.

## Manual-mode expectations

- Prefer read-only investigation unless the shared audit core says a feed item should be emitted.
- If a current incident should be surfaced now, route it the same way curation would.
- If a durable policy/config issue is supported by multi-cycle evidence, route it the same way reflection would.
- If there are no actionable findings, produce no feed items.
- Do not create a special audit summary notification just because this skill was invoked.

## Adaptable target

The default target is the main external-content pipeline. You may adapt the target if the user explicitly asks for a different pipeline, but the shared audit core still governs evidence gathering and output routing.
