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

Controls curation cadence and model quality.

```markdown
## Usage Level
Low|Medium|High
```

- **Low**: minimal usage, faster/cheaper models, curation every 4-8 hours.
- **Medium**: balanced usage, curation every 90 minutes to 4 hours.
- **High**: maximum quality, curation every 45 minutes to 2 hours.

Low is intended for Pro/Plus tiers. Medium fits Max 5x or ChatGPT Pro at lower volume. High fits Max 20x, ChatGPT Pro, or direct API use.

## Codex Reasoning Effort

Only write this section when Brain Provider is Codex CLI.

```markdown
## Codex Reasoning Effort
low|medium|high
```

Do not ask for this separately during install. Derive it from Usage Level: Low -> `low`, Medium -> `medium`, High -> `high`.

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
America/Denver
```

If the section is absent or blank, Evogent uses the host time zone when available and falls back to UTC. Invalid values are ignored with a warning.

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

Authentication for network-exposed deployments is the deployer's responsibility; use Cloudflare Access, proxy-level basic auth, IP allowlists, a VPN, or an equivalent deployment-layer control.
