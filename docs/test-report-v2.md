# Evogent v2 — Test Report

**Date:** 2026-03-01 (updated 2026-03-19)
**Status:** ALL TESTS PASSING
**Total unit tests:** ~50

---

## Summary

Unit and API/WebSocket integration tests cover the orchestrator, chat, enrichment, post-detail, skills, and mobile-UX subsystems. Playwright E2E tests were removed (2026-03-19) — dev agents use Browser tool for interactive visual verification instead.

## Test Files

### Unit Tests
| File | Tests | What it covers |
|------|-------|---------------|
| `src/lib/orchestrator.test.ts` | 6 | Enqueue, priorities, status, queue ordering |
| `src/lib/sub-agent.test.ts` | 5 | Spawn, log files, handle shape, defaults |
| `src/lib/agent-manager.test.ts` | 4 | Singleton, empty state, constants |
| `src/lib/db/schema.test.ts` | 7 | All 5 tables, columns, constraints, indexes |
| `src/lib/heartbeat.test.ts` | +5 expanded | No-trigger, peaks, empty history, weights |
| `src/lib/skills.test.ts` | +6 expanded | List, registry, install, parse, config |
| `src/lib/db/feed.test.ts` | +5 expanded | normalizeType, relationship, camelCase, UUID |
| `src/lib/db/chat.test.ts` | +4 expanded | Role/status, empty text, type, suggestions |

### API + WebSocket Integration Tests
| File | Tests | What it covers |
|------|-------|---------------|
| `src/app/api/api.test.ts` | ~30 | All 18+ API endpoints (feed, config, ping, status, chat, agents, activity, skills, heartbeat, interactions, orchestrator, ws-status) |
| `src/lib/websocket.test.ts` | ~6 | All 4 WS channels (/ws/feed, /ws/chat, /ws/orchestrator, /ws/agent-progress), simultaneous connections, client counts |

---

## Architecture Coverage

| Section | Feature | Unit | API | WS |
|---------|---------|------|-----|-----|
| 1 | Brain Orchestrator | x | x | x |
| 2 | Sub-Agent Architecture | x | x | x |
| 3 | Inline Chat | x | x | x |
| 4 | Activity Signals | x | x | - |
| 5 | Post Detail + Enrichment | x | x | - |
| 6 | Skills System | x | x | - |
| 7 | Mobile UX | - | - | - |
| - | DB Schema | x | - | - |
| - | WebSocket Channels | - | - | x |

---

## How to Run Tests

```bash
# Unit tests (fast, no server needed for most)
npm run test
```

Visual verification is handled by dev agents using Browser tool during development.
- 1777399364: Pipeline self-orchestration smoke test (Claude) — verified by automated test run.
- 1777399702: Pipeline self-orchestration smoke test (Codex) — verified by automated test run.

- 1777438525: Stress test 01/07 marker — verifying simultaneous-dispatch handling.
- 1777439201: Stress test 2 01/07 marker — verifying simultaneous-dispatch handling after npm-install flock fix.
- 1777439202: Stress test 2 02/07 marker — verifying simultaneous-dispatch handling after npm-install flock fix.
- 1777439203: Stress test 2 03/07 marker — verifying simultaneous-dispatch handling after npm-install flock fix.

- 1777439206: Stress test 2 06/07 marker — verifying simultaneous-dispatch handling after npm-install flock fix.
- 1777439204: Stress test 2 04/07 marker — verifying simultaneous-dispatch handling after npm-install flock fix.
- 1777439205: Stress test 2 05/07 marker — verifying simultaneous-dispatch handling after npm-install flock fix.
- 1777439207: Stress test 2 07/07 marker — verifying simultaneous-dispatch handling after npm-install flock fix.
- 1777441112: Codex stress test 01/07 marker — verifying simultaneous-dispatch handling under Codex brain.
- 1777441113: Codex stress test 02/07 marker — verifying simultaneous-dispatch handling under Codex brain.
- 1777441114: Codex stress test 03/07 marker — verifying simultaneous-dispatch handling under Codex brain.
- 1777441115: Codex stress test 04/07 marker — verifying simultaneous-dispatch handling under Codex brain.
- 1777441116: Codex stress test 05/07 marker — verifying simultaneous-dispatch handling under Codex brain.
- 1777441117: Codex stress test 06/07 marker — verifying simultaneous-dispatch handling under Codex brain.
- 1777441118: Codex stress test 07/07 marker — verifying simultaneous-dispatch handling under Codex brain.
