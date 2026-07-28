# Config Reference

Evogent stores personal runtime choices in `data/config.md`. That file is gitignored and should be changed through setup, chat, or direct local editing.

## Brain Provider

Controls which local brain runner powers curation, chat, research, and enrichment tasks.

```markdown
## Brain Provider
Claude Code|Codex CLI
```

Claude Code uses the user's Claude account. Codex CLI uses the user's ChatGPT/Codex account. Normal use does not require separate API billing, though direct Anthropic or OpenAI API keys can be used if preferred.

## Usage Level

Provides a broad model-quality/usage preference. Local and VM profiles may also
use it as a cadence default.

```markdown
## Usage Level
Low|Medium|High
```

- **Low**: minimal usage and faster/lower-cost models.
- **Medium**: balanced usage and model quality.
- **High**: maximum model quality and higher allowed usage.

Treat these as relative controls, not plan-name or price mappings. Provider plans
change; explain the current allowance tradeoff during setup and persist only the
chosen level.

On the canonical phone profile, the private personal model owns source-specific
cadence. The sole Termux scheduler combines predicted app opens, source yield,
notification signals, and this broad usage preference. Do not treat the example
intervals from VM-era docs as phone product laws.

The live source schedule is private `data/source-cadence.json`. Reflection may
tune each source independently from recent yield, health, attention, battery,
provider cost, and notification urgency, then writes the file atomically with
mode `0600`. Public `data/source-cadence.default.json` is bootstrap-only and
contains no person's routine. Scheduler mechanics read the private values; they
do not invent source priorities.

## Codex Reasoning Effort

Only write this section when Brain Provider is Codex CLI.

```markdown
## Codex Reasoning Effort
low|medium|high
```

Do not ask for this separately during install. Derive it from Usage Level: Low -> `low`, Medium -> `medium`, High -> `high`.

## Phone task routing

The canonical phone profile may split the Codex route by workload without
changing the model used by ordinary chat:

```markdown
## Codex Model
<curator baseline>

## Curator Reasoning
low|medium|high|xhigh

## Browse Model
<computer-use baseline>

## Browse Reasoning
low|medium|high|xhigh

## Overseer Model
<daily review model>

## Overseer Reasoning
high|xhigh|max|ultra
```

These are private deployment choices, not setup-time public defaults. Use the
lowest route that passes the representative workload. Persistent cheaper
overrides live in mode-`0600` `data/model-routing.json` and are accepted only
with recent paired benchmark proof; see
[`phone-efficiency-and-model-routing.md`](phone-efficiency-and-model-routing.md).
The daily overseer defaults to one bounded Sol/high run. Max or Ultra is an
explicit operator setting only and belongs on a measured, quality-first review
that benefits from it; the overseer cannot escalate its own route.
Re-check the
[current OpenAI model-selection guidance](https://developers.openai.com/api/docs/guides/latest-model.md)
when release defaults change; benchmark results from the actual phone remain
the authority for this workload.

## Agent Name

Every completed setup should leave an agent name in config.

```markdown
## Agent Name
[chosen or default name]
```

If the user skips naming, pick a sensible default such as Atlas, Nova, Echo, Sage, Scout, Pixel, Ember, or Orion.

## Time Zone

Controls user-facing local-time decisions, schedule labels, and OpenClaw daily timer sync. Use an IANA time zone name.

```markdown
## Time Zone
Etc/UTC
```

If the section is absent or blank, Evogent uses the host time zone when available and falls back to UTC. Invalid values are ignored with a warning.

## Private Maintenance Window

The phone scheduler recognizes these optional `data/config.md` headings. Values
are local whole hours from `0` through `23`; the repository never carries one
deployment's chosen hours.

| Heading | Meaning | Environment override |
|---|---|---|
| `## Maintenance Hour` | Hour when the scheduler makes the daily durable private review due. An absent or invalid value uses the neutral product fallback. | `EVOGENT_MAINTENANCE_HOUR` |
| `## Quiet Start Hour` | Inclusive start of an optional lower-activity window. | `EVOGENT_QUIET_START` |
| `## Quiet End Hour` | Exclusive end of the optional lower-activity window. | `EVOGENT_QUIET_END` |

The quiet window is active only when both endpoints are valid and distinct. It
may wrap across midnight. During that window the scheduler uses its longest
normal interval; urgent notification and durable maintenance semantics remain
separate. Leaving either heading unset disables the quiet window rather than
guessing a sleep routine.

## Background Source Browsing

Background Source Browsing is the global pause switch for scheduled browser-backed source refreshes.

```markdown
## Background Source Browsing
On|Off
```

During browser-backed source login, turn it off before credentials are entered. Turn it back on after the selected source's setup-smoke evidence is verified unless the user explicitly wants automatic source refresh disabled.

## Curation Steering

Custom user steering belongs in `data/curation-prompt.md`, not in a product source file. Useful sections include:

```markdown
## Interests and Topics
## Content to Avoid
## Tweet Selection Criteria
## Analysis Style Preferences
```

Manual Interests text is optional backup context. Content sources, imported archives, thumbs up/down feedback, preference evidence, and curation evidence are the primary learning signals.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port, default `3001` |
| `HOST` | No | Bind address, default `0.0.0.0` |
| `AUTH_TOKEN` | No | Twitter `auth_token` cookie for Bird CLI |
| `CT0` | No | Twitter `ct0` cookie for Bird CLI |
| `EVOGENT_MAINTENANCE_HOUR` | No | Private local whole-hour override for the daily durable maintenance task |
| `EVOGENT_QUIET_START` | No | Private local whole-hour quiet-window start |
| `EVOGENT_QUIET_END` | No | Private local whole-hour quiet-window end |

Authentication for network-exposed deployments is the deployer's responsibility; use Cloudflare Access, proxy-level basic auth, IP allowlists, a VPN, or an equivalent deployment-layer control.
