# Evolving Curation Research

This is a living document for how evogent should evolve its curation and preference-learning systems. It is intentionally practical and decision-focused. The goal is not to mirror the research literature in full, but to record what we learned, what we decided, and what is worth building next.

The complete research output that informed this summary lives at:

`/root/.clawdbot/logs/research/research-evolving-curation/output.txt`

## Research Context

We reviewed Evogent's current architecture against:

- OpenClaw and NanoClaw memory / heartbeat systems
- Jeff Clune's open-ended and self-improving systems work, including AI-GAs, OMNI-EPIC, and Darwin Godel Machine
- Ken Stanley's novelty search, POET, and MAP-Elites work
- Prompt and agent self-improvement systems such as Promptbreeder, OPRO, and DSPy
- Memory-oriented agent architectures such as Generative Agents and MemGPT / Letta

The central question was not "how do we make evogent more academic?" It was "what genuinely improves curation quality for a single-user app running on ephemeral `claude -p` tasks, SQLite, and a Pro-subscription budget?"

## Bottom Line

Evogent already has the right basic shape for evolving curation:

- explicit user feedback
- account-level and semantic preference learning
- a nightly reflection cycle that rewrites synthesized preference knowledge
- user-approved prompt evolution through suggestions
- adaptive cadence driven by real usage

The main gap is not lack of evolutionary ideas. The main gap is lack of richer decision-trace data for reflection. The current reflection cycle is already the evolution mechanism. The highest-leverage improvements are about improving the signal it sees.

## Current Architecture Layers

These are the layers that already make evogent an evolving curation system.

### 1. Setup / bootstrapping

Initial taste and account context comes from:

- Twitter archive import
- `/setup-wizard` chat onboarding
- first-pass curation prompt configuration

This gives the system a starting prior instead of forcing it to learn from zero.

### 2. Configuration

The main persistent configuration surfaces are:

- `data/config.md`
- `data/curation-prompt.md`
- adaptive heartbeat behavior in `server.js`

This layer sets cadence, editorial style, topic emphasis, avoidance rules, and operational behavior.

### 3. Context sent to the curation agent

The curation worker is driven by a stack of context, not a single prompt:

- OpenClaw curator instructions synced from Evogent memory files
- dynamic learned summary in `data/preferences-context.md`
- synthesized long-term patterns in `data/preference-insights.md`
- editorial policy in `data/curation-prompt.md`
- recent feed history
- vector preference matching via `POST /api/preferences/match`

This is already a tiered memory system in practice, even if it is not named that way in the code.

### 4. Feedback signals

The current high-value feedback channels are:

- thumbs up / thumbs down with optional reasons
- chat conversations
- suggestion accept / dismiss decisions
- imported Twitter archive likes, tweets, interests, blocks, and mutes

The strongest signal today is explicit feedback, especially thumbs-down with reasons.

### 5. Reflection / dream cycle

The reflection worker in `.claude/commands/reflect.md` reviews recent evidence and:

- updates `data/preference-insights.md` directly
- proposes `data/curation-prompt.md` or `data/config.md` changes through suggestion items
- writes a reflection summary back to the feed

This is the existing self-improvement loop. It already acts as a lightweight prompt-and-policy evolution system.

### 6. Skills

Skills are modular plugins that can add capabilities, workflows, and domain-specific logic. They are another way the curation system evolves without changing the core architecture.

## Research Findings

### OpenClaw and NanoClaw comparison

OpenClaw is stronger than evogent on formal assistant-OS structure:

- explicit memory tiers
- compaction and session-pruning behavior
- heartbeat as a first-class automation surface
- temporal-decay style memory and recency handling
- cleaner bootstrapping files such as `IDENTITY.md`, `USER.md`, `SOUL.md`, `TOOLS.md`, and `HEARTBEAT.md`

NanoClaw is simpler and closer to file-backed assistant memory with scheduled tasks and code self-modification.

What both systems do not really provide is Evogent's core strength: preference learning for content curation. OpenClaw is a generic assistant OS, not a preference-learning curator.

Evogent already surpasses them on:

- explicit feedback loops
- account-level learning
- semantic preference matching
- user-approved evolution of curation policy

OpenClaw is useful as a reference for memory hygiene and formal context layering, but not as a model for preference learning.

### Academic prompt-evolution approaches are mostly impractical here

The literature around prompt populations, MAP-Elites, replay scoring, and optimizer loops is interesting, but most of it assumes a very different operating environment:

- cheap evaluation
- large API budgets
- many users
- frequent A/B tests
- tasks with clear numeric objective functions

That does not match evogent.

For this system:

- running 10 nightly prompt variants is not viable on a Pro subscription
- the curation agent does not emit a clean numeric score and mostly makes qualitative picks
- the real signal often arrives days later
- the strongest signal is explicit user thumbs up / thumbs down, often after the cycle is long finished
- quality is mostly judged qualitatively, not by immediate click metrics

In other words: most of the literature is useful as a mental model, not as a direct implementation template.

### What is practical

The practical path is to make reflection smarter, not to bolt on heavyweight search infrastructure.

The current reflection cycle already does the core job:

- observe outcomes
- synthesize patterns
- update internal preference knowledge
- suggest changes to curation policy

The next gains come from richer evidence inside that loop.

## Decisions Made

### 1. Enrich preference context with agent reasoning

Decision: include the curation agent's original `reason` for including an item alongside the later user reaction when rebuilding `preferences-context.md`.

Why:

- "Agent included X because Y" plus "user liked/disliked X because Z" is much more informative than either side alone.
- This creates a more useful replay record for reflection.
- It exposes whether the system is failing on retrieval, framing, novelty, or taste prediction.

This is the clearest path toward experience replay without building a full evaluation harness.

### 2. Add candidate rejection logging

Decision: log what the curation agent considered but rejected, and why, in `data/curation-candidates.jsonl`.

Why:

- Reflection currently sees outcomes, not the full decision funnel.
- Without rejected candidates, we cannot tell whether missed opportunities were never retrieved, considered and filtered out, or outcompeted by similar items.
- Candidate-frontier logging is the cheapest form of evaluation infrastructure we can add.

This is the highest-ROI observability improvement for future replay, prompt comparisons, and diversity analysis.

### 3. Add a novelty budget

Decision: add a simple curation rule that reserves some share of each cycle for new sources or topics.

Why:

- this reduces filter-bubble drift
- it does not require new infrastructure
- it operationalizes the best part of novelty-search thinking in one prompt-level rule

The likely first version is a default instruction in the standard curation prompt, not a scoring system.

### 4. Do not implement heavyweight evolution infrastructure right now

Decision: do not build any of the following yet:

- prompt variant populations
- MAP-Elites scoring infrastructure
- formal A/B testing
- implicit engagement collection such as time-on-post and scroll depth

Why:

- these are over-engineered for a single-user app
- they create data and evaluation demands we cannot meet cleanly yet
- they distract from the simpler improvements that directly strengthen reflection

## Why These Decisions Beat the Fancy Alternatives

The main lesson from the research is that quality-diversity and self-improvement systems work best when they have:

- cheap repeated evaluation
- reusable logged trajectories
- metrics that can be compared across variants

Evogent does not have that today. It has sparse, delayed, high-quality explicit feedback instead.

That means the right move is:

1. keep the current single-policy reflection loop
2. improve the evidence it sees
3. add light exploration pressure
4. postpone population search until there is enough logged replay data to justify it

## Future Possibilities

These are worth documenting as directions, but they are not commitments yet.

- Experience replay built from richer pairings of agent reasoning and user reactions. This is being implemented now.
- Candidate frontier logging for reflection and offline review. This is being implemented now.
- Novelty search reserves, likely a `10-20%` exploration budget.
- Meta-reflection, where the system evolves the reflection heuristics themselves while keeping outer guardrails fixed.
- Implicit signals such as time-on-post, scroll depth, expand rate, and revisits. These remain lower priority than explicit feedback.

## Design Principles Going Forward

- Favor explicit feedback over implicit engagement.
- Treat reflection as the core evolution mechanism.
- Prefer better evidence over more search algorithms.
- Keep novelty simple and intentional.
- Only add formal optimization loops once we have enough logged decision data to evaluate them honestly.

## References

These are the main papers and systems that shaped the conclusions above.

- Jeff Clune. [AI-GAs: AI-Generating Algorithms, an Alternate Paradigm for Producing General Artificial Intelligence](https://arxiv.org/abs/1905.10985), 2019.
- Landon Morrison, Michael Dennis, Benjamin Recht, and Jeff Clune. [OMNI-EPIC: Open-Endedness via Models of human Notions of Interestingness with Environments Programmed in Code](https://openreview.net/forum?id=56IuSw535r), ICLR 2025.
- Jenny Zhang, Shengran Hu, Cong Lu, Robert Lange, and Jeff Clune. [Darwin Godel Machine: Open-Ended Evolution of Self-Improving Agents](https://arxiv.org/abs/2505.22954), 2025.
- Joel Lehman and Kenneth O. Stanley. [Novelty Search and the Problem with Objectives](https://www.cs.swarthmore.edu/~meeden/DevelopmentalRobotics/lehman_ecj11.pdf), 2011.
- Rui Wang, Joel Lehman, Jeff Clune, and Kenneth O. Stanley. [Paired Open-Ended Trailblazer (POET): Endlessly Generating Increasingly Complex and Diverse Learning Environments and Their Solutions](https://arxiv.org/abs/1901.01753), 2019.
- Jean-Baptiste Mouret and Jeff Clune. [Illuminating Search Spaces by Mapping Elites](https://arxiv.org/abs/1504.04909), 2015.
- Chrisantha Fernando, Dylan Banarse, Henry Tam, et al. [Promptbreeder: Self-Referential Self-Improvement via Prompt Evolution](https://arxiv.org/abs/2309.16797), 2023.
- Chengrun Yang, Xuezhi Wang, Yizhong Wang, et al. [Large Language Models as Optimizers](https://arxiv.org/abs/2309.03409), 2023.
- Omar Khattab, Keshav Santhanam, Xiang Lisa Li, et al. [DSPy: Compiling Declarative Language Model Calls into Self-Improving Pipelines](https://arxiv.org/abs/2310.03714), 2023.
- Joon Sung Park, Joseph O'Brien, Carrie Cai, et al. [Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/abs/2304.03442), 2023.
- Charles Packer, Vivian Fang, Shishir G. Patil, Kevin Lin, Sarah Wooders, and Joseph E. Gonzalez. [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560), 2023.
- OpenClaw documentation: [openclaw/openclaw](https://github.com/openclaw/openclaw)
- NanoClaw documentation: [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw)

## Status

This document should evolve as the curation system evolves. It is a record of current conclusions, not a frozen design.
