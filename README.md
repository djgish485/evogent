# Evogent

<p align="center">
  <img src="docs/images/hero-feed.jpeg" alt="Evogent curated feed thread with the rationale visible" width="320">
</p>

Evogent is an AI curation agent that browses your social media for you and shows you what *you* want to see, not what the algorithm wants you to see.

## Works with your subscriptions

Evogent runs through the Claude Code or Codex CLI you already use, so your Claude Pro or ChatGPT Plus subscription powers everything — curation, chat, code fixes, audits. API keys still work if you prefer; you just don't need any to get started.

## Install With A Coding Agent

Paste this into your favorite coding agent:

```text
Install Evogent for me from the latest repo at https://github.com/djgish485/evogent.

Before running commands, explain in plain language what Evogent is and that setup covers install -> sources -> launch -> optional skills and archive import.

Clone the repo, then follow `docs/setup-for-coding-agents.md` end-to-end (Phase 1 system setup, Phase 2 three required + one optional etc, Phase 3 launch and verify). Run `npm run setup:agent` after dependency/build setup and again before declaring setup done.

Respect platform boundaries: `scripts/setup.sh` is Linux/systemd-only; macOS and Windows should use the manual local setup path in `docs/setup-for-coding-agents.md`.

When finished, report the final app URL. If setup is not complete, report the remaining REQUIRED lines from `npm run setup:agent`.
```

## Install on a Cloud VM (Public URL)

If you want a public URL gated by login that you can hit from any browser, including mobile, paste this into a coding agent on your local machine:

```text
Install Evogent on a small Hetzner VM behind Cloudflare Access. I want to reach the URL from any device, but only my email should pass the auth gate.

I have ready: a Hetzner Cloud API token, a domain managed by Cloudflare with Zero Trust enabled, the hostname I want for Evogent (ask me), and the email I want allowed through Access (ask me). If a prerequisite is missing, tell me exactly where to create it before starting.

Provision a small Ubuntu VM, set up a Cloudflare tunnel that routes my chosen hostname to the app running on the VM at localhost:3001, and create a Cloudflare Access self-hosted application restricting the hostname to my email. Lock the VM down so its only public reachable surface is the tunnel.

Before configuring browser-backed sources, install the required desktop layer on the VM: XFCE + LightDM + gnome-keyring auto-unlocked via PAM. Use `scripts/setup-desktop-browser.sh`, then reboot. This is required for Twitter, YouTube, and Substack logins to survive Chrome restarts; --headless Chrome or a no-desktop install will break source auth on restart. See `docs/reference/browser-setup-guide.md` for the full explanation.

On the VM, install Evogent from https://github.com/djgish485/evogent following docs/setup-for-coding-agents.md end to end. Report the final hostname and any remaining setup items when done.
```

## Cloud Coding Agent

Evogent also works as a cloud coding agent — like Twitter for your repo. Install it on a small VM, open it on your phone or any browser, and drive Claude Code or Codex at any repo from anywhere.

```text
Install Evogent in coding-agent-only mode on a small VM I can drive from my phone, gated by my email through Cloudflare Access.

I have ready: a cloud provider account (Hetzner, DigitalOcean, Fly, etc.), a domain managed by Cloudflare with Zero Trust enabled, the hostname I want for Evogent (ask me), the email I want allowed through Access (ask me), and either Claude Code or Codex CLI authenticated on this local machine — install and authenticate the same one on the VM.

Provision a small Ubuntu VM, set up a Cloudflare tunnel routing my chosen hostname to the app at localhost:3001, and create a Cloudflare Access self-hosted application restricting access to my email. Lock the VM down so the only public reachable surface is the tunnel.

On the VM, install Evogent from https://github.com/djgish485/evogent in minimum-install mode — just PORT in .env.local and one of `claude` or `codex` on PATH and authenticated. Skip the Twitter/social-source setup, skill installs, preferences embedding, and curation cron entirely. Follow docs/setup-for-coding-agents.md but stop after the minimum install runs.

When done, open the UI, create a chat session pointed at the repo I want to drive, and report the final hostname.
```

## Manual Install

```bash
git clone https://github.com/djgish485/evogent.git evogent
cd evogent
npm install
npm run build
cp .env.example .env.local
npm run setup:agent
# Edit .env.local with your settings
sudo bash scripts/setup.sh
```

Then open http://localhost:3001 and use the setup card's **Finish Setup** button. It starts `/setup-wizard` in chat to check configuration and guide the next setup step.

For the full setup flow from https://github.com/djgish485/evogent, see [Setup for coding agents](docs/setup-for-coding-agents.md).

## Sources

Evogent ships with skills for the places most people read:

- **Twitter / X** — home timeline, following timeline, topic searches
- **YouTube** — subscriptions and watch signals
- **Substack** — your subscribed publications inbox
- **Hacker News** — front page and Ask HN

Each source is a markdown skill — a short file that tells the agent how to fetch the source and what its content looks like. To add a new one (an RSS feed, a niche forum, a company dashboard, anything web-readable), describe it to a coding agent and let it write the skill. Drop it in `skills-library/` and Evogent's curator will pick it up on the next cycle. No code changes required.

## Development Philosophy

This system runs full Claude Code sessions for every task — curation, chat, reflection, enrichment, dev agents. These are autonomous agents with tool use, file access, web search, browser, and full codebase reasoning. They don't need hand-holding.

**1. Trust the agent runtime.** Before building custom code for any capability, ask: can the agent do this with a general instruction? Build product code for infrastructure (queues, storage, APIs, UI, WebSocket broadcast, dedup) — not for agent decision-making. A 10-line instruction in a skill file beats a 779-line orchestrator that tries to think for the agent.

**2. General direction over prescriptive recipes.** Give agents problems and constraints, not step-by-step solutions. Describe what's broken and why it matters. Let the Claude Code session investigate the codebase and figure out the implementation.

**3. General-purpose mechanisms over one-off fixes.** When something breaks, don't patch the symptom — ask what system should have prevented it. If a subsystem has 3+ narrow fixes, the real problem is a missing general capability. Build the capability, not another patch.

**4. Strengthen diagnosis, not agent-specific patches.** If an agent hits something unexpected and works around it instead of investigating, the fix is not a custom patch for that case — it's better diagnostic instruction. These sessions can read code, query SQLite, inspect payloads, and reason through mismatches. When dispatching a fix for a bug an agent encountered, ask: what general detection capability would have caught this? Build that capability, and the specific bug should fall out as a side effect.

**5. Prefer completion over time-boxing.** If work is still making real progress, prefer a longer-running task to a killed task. Use short deadlines for probes, liveness checks, and other operational safeguards, but raise or remove execution caps that terminate productive agent work without protecting correctness.

**6. Render the same data the same way everywhere — suppress only what's actually duplicated.** When a component's behavior changes based on a context flag ('am I inside X?', 'am I in detail view?', 'was I given permission to render this?'), ask whether the flag is expressing a real duplication you can detect structurally (e.g., `parentId` is in the current render scope) or a blanket assumption that will drop useful content in common cases. Prefer the structural check; delete the flag where possible. A blanket flag-gated suppression is an invisible regression waiting to happen — every new place the component is rendered silently inherits the suppression.

The practical test for any change: Am I writing code that does something only infrastructure can do (persist data, route messages, serve UI), or am I writing code that duplicates what a Claude Code session can already reason through or should be instructed to investigate before falling back? If it's the latter, write an instruction instead.

## Secure by default

Direct access to Evogent's agents is disabled for remote users by default. Agents can run things on your machine, so the safe default is local-only. To use the app remotely, put it behind an authenticated login layer (Cloudflare Access works great) and then set `MEDIA_AGENT_TRUST_NETWORK=1` to let those authenticated requests through. The cloud-VM install prompt above does this for you. See [Security](docs/security.md) for the full model.

## Links

- [Setup for coding agents](docs/setup-for-coding-agents.md)
- [Public-feed demo VM setup](docs/demo-vm-setup.md)
- [Config reference](docs/config-reference.md)
- [Skills](docs/skills.md)
- [Chat features](docs/chat-features.md)
- [Twitter/X access](docs/sources/twitter.md)
- [Security](docs/security.md)
- [Development](docs/development.md)
- [Architecture](docs/architecture-v2.md)
- [License](LICENSE)
