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

The live source schedule is private `data/source-cadence.json`. The daily
overseer may tune each source independently from recent yield, health,
attention, battery, provider cost, and notification urgency, then writes the
file atomically with mode `0600`. Public
`data/source-cadence.default.json` is bootstrap-only and contains no person's
routine. Scheduler mechanics read the private values; they do not invent
source priorities.

## Codex Reasoning Effort

Only write this section when Brain Provider is Codex CLI.

```markdown
## Codex Reasoning Effort
low|medium|high
```

Do not ask for this separately during install. Derive it from Usage Level: Low -> `low`, Medium -> `medium`, High -> `high`.

## Phone task routing

The canonical phone profile may split either provider route by workload without
changing the model used by ordinary chat:

```markdown
## Codex Model
<ordinary Codex chat model>

## Curator Model
<phone curation baseline>

## Curator Reasoning
low|medium|high|xhigh

## Claude Curator Model
<Claude curation baseline>

## Claude Curator Reasoning
low|medium|high|xhigh|max

## Source Discovery Model
<one-time source-recipe authoring baseline>

## Source Discovery Reasoning
low|medium|high|xhigh

## Claude Source Discovery Model
<Claude one-time source-recipe authoring baseline>

## Claude Source Discovery Reasoning
low|medium|high|xhigh|max

## Browse Model
<computer-use baseline>

## Browse Reasoning
low|medium|high|xhigh

## Claude Browse Model
<Claude computer-use baseline>

## Claude Browse Reasoning
low|medium|high|xhigh|max

## Claude YouTube Browse Model
<optional Claude YouTube override>

## Claude YouTube Browse Reasoning
low|medium|high|xhigh|max

## Overseer Model
<daily review model>

## Overseer Reasoning
high|xhigh|max|ultra
```

These values remain private deployment choices. Use the lowest route that
passes the representative workload. Before provider work, a phone with no
config receives the complete generic config baseline, followed by
Codex curator and source-discovery/Sol-high, Codex browse/Terra-medium,
Claude curator and source-discovery/Opus-high, Claude browse/Sonnet-high, and
overseer/Sol-high task headings.

An existing config is migrated differently: missing curator, source-discovery,
and browse model headings inherit its effective `Codex Model`. Curator
reasoning inherits its effective Codex reasoning (including the Usage Level
fallback), while the previously medium-effort browse and source-discovery lanes
remain medium and overseer remains Sol/high. Missing Claude lane headings use
the provider-compatible Opus/high curator and source-discovery plus Sonnet/high browse baselines;
they never inherit a Codex model name. Existing headings—including
intentionally blank ones—are never rewritten. A version-only mode-`0600`
`.phone-config-bootstrap.json` beside the private config makes this migration
explicit and repeatable through the production `runtime/data` symlink without
recording private choices.

`Brain Provider` selects the provider before task routing. For Codex,
`Curator Model` is authoritative and `Codex Model` remains its compatibility
fallback; `Browse Model` similarly wins over `Codex Model`, with Terra/medium
as the public fallback. For Claude, the corresponding `Claude Curator Model`
`Claude Source Discovery Model`, and `Claude Browse Model` headings are
authoritative, with Opus/high for curator and source discovery and Sonnet/high
for browse as their respective
provider-compatible public fallbacks. Optional `Claude YouTube
Browse Model` and reasoning headings override only that lane. A model name
from the other provider or an unsupported effort is rejected and reported as
a fallback instead of being sent to a paid CLI invocation.

Automatic diagnosis is independently pinned to Sol/high. It does not inherit
`Codex Model`, `Overseer Model`, or `Overseer Reasoning`, and no private
persistent route can change it. A one-run explicit diagnosis environment
override remains available for supervised diagnosis.

Persistent overrides for global browse, YouTube browse, curation, source
discovery, and automatic diagnosis are currently disabled: the available
computer-use receipts do not bind a frozen, blinded private-relevance review,
and the curator harness cannot yet isolate every production side effect.
One-run environment overrides remain available for supervised screening; see
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
