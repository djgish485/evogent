# Evogent - Curation & Cloud Coding Agent

<p align="center">
  <img src="docs/images/hero-feed.jpeg" alt="Evogent curated feed thread with the rationale visible" width="320">
</p>

Evogent is an AI curation agent that browses your social media for you and shows you what *you* want to see, not what the algorithm wants you to see.

## Live demo

[evo.dangish.net](https://evo.dangish.net) curates an x.com account's For You & Following feeds, HN news, etc. Coding agents are read only in this demo.

## Use your subscriptions

Evo runs through the Claude Code or Codex CLI, so your Claude Pro or ChatGPT Plus subscription powers everything. API keys also work if you prefer.

## Install With A Coding Agent

Paste this into your favorite coding agent:

```text
Install Evogent for me from the latest repo at https://github.com/djgish485/evogent.

Before running commands, explain in plain language what Evogent is and that setup covers install -> sources -> launch -> optional skills and archive import.

Clone the repo, then follow `docs/setup-for-coding-agents.md` end-to-end (Phase 1 system setup, Phase 2 three required + one optional etc, Phase 3 launch and verify). Run `npm run setup:agent` after dependency/build setup and again before declaring setup done.

Respect platform boundaries: `scripts/setup.sh` is Linux/systemd-only; macOS and Windows should use the manual local setup path in `docs/setup-for-coding-agents.md`.

When finished, report the final app URL. If setup is not complete, report the remaining REQUIRED lines from `npm run setup:agent`.
```

## Install on a Cloud VM

If you want a public URL gated by login that you can hit from any browser, including mobile, paste this into a coding agent:

```text
Install Evogent on a small Hetzner VM behind Cloudflare Access. I want to reach the URL from any device, but only my email should pass the auth gate.

I have ready: a Hetzner Cloud API token, a domain managed by Cloudflare with Zero Trust enabled, the hostname I want for Evogent (ask me), and the email I want allowed through Access (ask me). If a prerequisite is missing, tell me exactly where to create it before starting.

Provision a small Ubuntu VM, set up a Cloudflare tunnel that routes my chosen hostname to the app running on the VM at localhost:3001, and create a Cloudflare Access self-hosted application restricting the hostname to my email. Lock the VM down so its only public reachable surface is the tunnel.

Before configuring browser-backed sources, install the required desktop layer on the VM: XFCE + LightDM + gnome-keyring auto-unlocked via PAM. Use `scripts/setup-desktop-browser.sh`, then reboot. This is required for Twitter, YouTube, and Substack logins to survive Chrome restarts; --headless Chrome or a no-desktop install will break source auth on restart. See `docs/reference/browser-setup-guide.md` for the full explanation.

On the VM, install Evogent from https://github.com/djgish485/evogent following docs/setup-for-coding-agents.md end to end. Report the final hostname and any remaining setup items when done.
```

## Cloud Coding Agent

Claude Code remote control not stable? SSH apps feeling janky? Evo works beautifully as a cloud coding agent. It's like Twitter for your repo.

Stand-alone coding agent instructions:

```text
Install Evogent in coding-agent-only mode (minimum-install mode: just PORT in .env.local and one of `claude` or `codex` on PATH and authenticated). Skip the Twitter/social-source setup, skill installs, preferences embedding, and curation cron entirely.

Follow docs/setup-for-coding-agents.md from https://github.com/djgish485/evogent, but stop after the minimum install runs. Then run `node scripts/create-default-sessions.mjs --coding-agent-only` so the General Agent session exists (no Curator Agent needed in coding-agent-only installs).

When done, report the URL where Evogent is running.
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

Evo ships with skills for the places most people read:

- **Twitter / X**
- **YouTube**
- **Substack**
- **Hacker News**

Each source is a markdown skill: a short file that tells the agent how to fetch the source and what its content looks like. To add a new one (an RSS feed, a niche forum, a company dashboard, anything web-readable), describe it to a coding agent and let it write the skill. Drop it in `skills-library/` and Evo's curator will pick it up on the next cycle. No code changes required.

## Development Philosophy

This app is powered by extremely flexible and strong coding agents, so use their full capabilities. Coding agent instructions are preferred over brittle deterministic code whenever possible. This keeps the system flexible and able to correct any errors and problems that arise. Regular audits are performed by the agents to *evolve* and improve the app over time.

## Secure by default

Direct access to Evo's agents is disabled for remote users by default. To use the app remotely, put it behind an authenticated login layer (Cloudflare Access works great) and then set `MEDIA_AGENT_TRUST_NETWORK=1` to let those authenticated requests through. The cloud-VM install prompt above does this for you. See [Security](docs/security.md) for the full model.

## Links

- [Setup for coding agents](docs/setup-for-coding-agents.md)
- [Public-feed demo VM setup](docs/demo-vm-setup.md)
- [Config reference](docs/config-reference.md)
- [Skills](docs/skills.md)
- [Chat features](docs/chat-features.md)
- [Twitter/X access](docs/sources/twitter.md)
- [Security](docs/security.md)
- [Development](docs/development.md)
- [License](LICENSE)
