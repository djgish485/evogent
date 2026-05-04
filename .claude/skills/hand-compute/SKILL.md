---
name: hand-compute
description: Hand-computes a system's execution with explicit state at each step. Use when debugging races, state machines, async bugs, regressions; stress-testing a fix; scoping features on existing state; or approaching unfamiliar code. Especially useful for bugs involving client/server sequencing, background refreshes, recovery paths, queues, or multiple actors evolving state together. Also triggers on "why is this broken", "walk through the flow", "this used to work", "what happens when", or "stress test this plan".
---

# Hand-Compute

Before electronic computers, "computer" was a job: a person who executed a procedure by hand, step by step, writing each intermediate value down. That's the move this skill asks for. When a system's behavior depends on *state evolving over time across multiple actors*, reasoning abstractly is the wrong tool. Abstract reasoning hand-waves the exact thing you need to pin down: what state each actor holds at what moment, and what transitions fire in what order. The fix is to stop reasoning and become the human computer: execute the system manually, step by step, writing down concrete state at every transition, as if you were running the program in your head.

This is slower than "reviewing the logic" but catches bugs that review never will, because the act of maintaining state across steps forces contradictions to surface. It's the same thing a senior engineer does at a whiteboard to debug a race. You're just doing it in text.

## When to use this

Use it when:

- A bug was fixed once and regressed. The mental model used for the first fix is wrong or incomplete, and more review won't find it. *(Shape 2)*
- You're debugging anything that involves client/server sequencing, async callbacks, background refreshes, recovery paths, queues, retries, or two actors evolving state together. *(Shape 2)*
- The user proposes a fix for a state or race bug and asks you to stress-test it, review it, or "think through the edge cases." *(Shape 2)*
- You're scoping a new feature on top of an existing state model and don't yet know where it will fit. *(Shape 3)*
- You're approaching an unfamiliar task (a new API, a new pipeline, an unexplored codebase behavior) and you're tempted to jump straight to code. *(Shape 1)*

Don't use it for:

- Pure transformations with no state (renames, type fixes, formatting, config edits).
- Tasks where the failure is obvious from a single stack trace or error message.
- Well-understood changes where you already know what to write.

The cost of this skill is your attention and time. Don't spend it on tasks that don't need it.

## The three shapes

Pick one before you begin:

| Situation | Shape |
|---|---|
| No code yet, unfamiliar task | **1. New work** |
| Code exists, bug reproduces | **2. Debugging** |
| Code exists, feature is new | **3. Scoping** |

The core move, hand-compute with concrete state, is the same every time. What changes is *what* you compute and *when*. If you're not sure which shape, default to Shape 2; it's the most common entry point.

### Shape 1: New work (build intuition first)

You have a task but no code and no plan.

1. Execute the task *manually*, as the human computer. If it's a scrape, poke around the site and look at real responses. If it's a pipeline, run each stage by hand and inspect the output. If it's an unfamiliar API, call it live and look at the shape of what comes back.
2. At each step, write down what you actually observed, what surprised you, and what you'd have gotten wrong if you'd guessed.
3. Only after the manual execution succeeds, and you've hit the pitfalls, distill the trace into code.

**Example: scraping an unfamiliar job board.** Don't write the scraper. Open the site in a browser. Run a search. Watch the network tab: are results a server-rendered page, an XHR call, a GraphQL query? Click into one job. Is the description in the initial HTML, or fetched separately? Try page 50, then page 100. Does pagination cap? Hit 30 pages in a row. Does the site start soft-blocking you?

Write down what you actually saw:

- Search is `GET /search?q=...&page=N`
- Results page returns HTML, but each job card embeds JSON in a `<script type="application/ld+json">`
- Detail pages are separate URLs with their own JSON blobs
- Pagination stops at page 100 even when more results exist
- After ~30 requests without a session cookie, you get a soft-block page

*Now* write the scraper. Every observation above becomes a design decision:

- a session cookie plus conservative pacing (soft-block threshold)
- a JSON-LD extractor on listing pages (not an HTML parser)
- a separate detail-page fetcher
- a strategy for the 100-page ceiling (narrow searches, or accept that result sets are truncated and surface that to the caller)

None of that would have been in your first draft.

You're done when **you stop being surprised**. That's the signal the intuition is loaded.

### Shape 2: Debugging an existing system

Code exists, the bug reproduces, and you probably already have a theory; resist it.

1. **Hand-compute the broken flow first.** Walk through the current, broken behavior. At every step, write each actor's state as a named object (`client = {...}`, `worker = {...}`, `parser = {...}`, or whatever your system actually has). Take each actor's perspective in turn. Continue until an invariant breaks. *That* is the bug. Often it's not where you thought.
2. **Draft the change in your head and re-walk the broken trace with it applied.** Watch whether the same `⚠` invariant still breaks. That walk is how you find out what to propose: if the trace still breaks, the change is wrong, so revise it and walk again. You're ready to propose once the trace lands on legal state across every phase, not just the one that failed.
3. **Only then propose the fix and write the code.**

The trap here is skipping step 1 and jumping from "I have a theory" to "let me walk through the fix." That reduces the technique to "validate my theory," which is a much weaker prompt and tends to entrench wrong mental models. The fixed-flow walk is not extra verification after the proposal; it is how you find out whether the proposal is real. If the user points you at a proposed fix and asks you to stress-test it, your first move is still step 1: hand-compute the *current broken* flow before you hand-compute the fix.

**Example: an optimistic save clobbered by a stale refresh.** Bug report: "I add an item and click save, and sometimes it disappears from my list a moment later."

*Narrative form.* What a model tends to produce when "walking through" the bug:

> The user adds item c and clicks Save. The client optimistically updates its UI to show [a, b, c] and fires POST /save. The server receives the request, applies the mutation, and items are now [a, b, c] on both sides. Around the same time, an earlier background refresh resolves and the client applies it. The refresh should be returning the current items, so the UI stays consistent at [a, b, c].

This sounds careful, but it reaches the wrong answer. "The refresh should be returning the current items" glides over the question: *when did the refresh actually capture its snapshot?* If it was in flight before the POST, its snapshot is stale. The narrative voice lets you assume the happy answer without checking.

*Stateful form.* The same bug, hand-computed:

```
t=0  a background refresh GET /items fired on page load is already in flight;
     the server already read { rev: 1, items: [a, b] } for it; response in transit

     user adds item c and clicks Save
     client = { status: idle, items: [a, b], pending: false }
     server = { rev: 1, items: [a, b] }

t=1  client POST /save (optimistic: items already show [a, b, c])
     client = { status: saving, items: [a, b, c], pending: true }
     server applies mutation
     server = { rev: 2, items: [a, b, c] }

t=2  POST response reaches client
     client = { status: idle, items: [a, b, c], pending: false }
     (the save looks successful; user sees their item)

t=3  the in-flight GET response from t=0 finally arrives
     snapshot: { rev: 1, items: [a, b] }   (stale: captured before the POST)
     client applies → client.items = [a, b]
     ⚠ item c just vanished; a stale in-flight refresh clobbered the committed state
```

The explicit version can't skip the question the narrative version glosses: at t=3, what does the refresh's snapshot actually contain? You're forced to write its `rev` and `items`, and the stale-rev race becomes unmissable. Notice what the explicit trace reveals that the narrative version couldn't: the bug requires the stale GET to arrive *after* the POST response. Otherwise the POST's fresh state would overwrite the clobber. That ordering constraint matches the user's "sometimes it disappears a moment later" report. The `⚠` marks the moment the invariant breaks.

Now propose the fix: have the client drop refresh responses whose `rev` is older than its last applied state, *or* abandon in-flight refreshes when it issues an optimistic mutation. Pick one, then re-walk the same trace with the fix applied to confirm t=3 no longer clobbers, and then walk the adjacent phases (what if two optimistic mutations overlap? what if the GET arrives between t=1 and t=2?) before writing any code.

### Shape 3: Scoping a new feature on an existing system

Code exists. The feature is new.

1. Hand-compute the new user flow *end-to-end against the current state machine*. Don't design yet; just walk it.
2. Every time you have to invent new state, bend an existing field, or hand-wave a transition, write it down. Those are your actual design decisions.
3. Draft the architecture *from* that list, not before it.

**Example: adding undo to a form that commits immediately.** The current app has one path: user edits → clicks Save → POST /items → done. You're asked to add undo: "the last save can be reversed for 10 seconds." Walk it:

1. User edits a field. *Current model: no intermediate state.*
2. User clicks Save. *Current model: POST, clear form.* For undo, you need to keep the previous server state somewhere so you can restore it. ← **invented state**.
3. A toast appears with an Undo button. No current state for this. ← **invented state**.
4. User clicks Undo within 10s. POST with the previous values? But what if another user modified the item in the meantime? ← **invented question, no clean answer**.
5. 10 seconds pass with no undo. Delete the stashed previous state. ← **another invented state, with its own timer**.
6. User edits a *different* item before the first undo expires. Does the toast stay? Does it point to the first edit or the second? ← **design question the current model can't answer**.

The "← invented" entries are the design surface. The architecture drops out of them: you need a buffer holding the pre-edit state (likely client-side, so Undo is instant rather than round-tripping), a TTL for how long it stays alive, a rule for concurrent-edit conflicts, and a policy for chained actions. None of that was obvious from reading the current code. The walk surfaced it.

You're done when **you can walk the new flow end-to-end without inventing anything mid-step**.

## How to compute well

The technique only works if the computation is *concrete*. Narrative computation (stringing plausible-sounding steps together without pinning state down) collapses back into abstract reasoning. The principles below keep you honest.

**Keep state explicit at every step.** At every transition, write each actor's state as a named object. The actors are whatever your system actually has: `client` and `server`, `parser` and `lexer`, `training_loop` and `optimizer`, `worker` and `queue`. Write them down, not just in your head. The act of writing forces concreteness. If you find yourself summarizing instead of stepping, slow down.

**Switch perspectives deliberately.** Most race bugs live in the seam between two actors. Walk the flow once as each actor in turn, not all at once. The bug often shows up only when you hold two perspectives at the same moment in time and notice they disagree.

**Stay in one head.** Do not fan the walk out to sub-agents. Hand-computing a state machine is cheap *because* one head holds all the state and notices the contradiction mid-step. Parallel walkers each see a slice and lose the "wait, that can't be true given what I saw three steps ago" moment. Use sub-agents to gather *context* for the walk (read these files, find the call sites, list the state fields), then do the walk itself in one place.

**Pick the right level of abstraction.** A bug in how two React state updates interleave in the same render won't show up if you're tracing HTTP requests. A bug in how two services coordinate won't show up if you're tracing single-function execution. Figure out where the contention likely lives, then compute at the level that makes it visible.

**Ground transitions in actual code.** When in doubt about what a function does at a given step, open the file and re-read it. Don't compute what you *think* the function does; compute what it *actually* does.

## Failure modes

These are the ways this skill fails in practice. Notice them in yourself and correct.

| Failure | What it looks like | Fix |
|---|---|---|
| **Narrative computation** | Prose sequences ("then this happens, then that") without explicit state | Write `state = {...}` at every step, literally |
| **Skipping the broken flow** | Jumping straight to "let me walk through the fix" | Back up, compute the broken behavior first, ignoring the fix |
| **Sub-agent fanout** | Parceling the walk across parallel agents | Context-gather with agents, walk in one head |
| **Stopping at the failing phase** | Walking only the broken phase, declaring the fix without re-walking the broken trace with the change applied | Re-walk the broken trace with the change applied, then walk every phase end-to-end |
| **Wrong abstraction level** | Tracing HTTP when the bug is in React render order (or vice versa) | Locate the bug's likely home, then compute at that level |
| **Wishful code-reading** | Describing what the function "should" do | Re-read the actual source at every transition |

## When you're done

- **New work.** Done when **you stop being surprised**. You can describe the real input/output shape without guessing, and you've hit the pitfalls yourself.
- **Debugging.** Done when **every phase's trace lands on legal state with the fix applied**. You can explain, in concrete terms, why the old flow broke and why the new flow can't break the same way.
- **Scoping.** Done when **you can walk the new flow end-to-end without inventing anything mid-step**.

## Checklist

Before declaring the walk complete, each of these should be true:

- [ ] I wrote each actor's state as a named object at every step, not narrative
- [ ] I took the perspective of each actor at least once
- [ ] I walked in one head (I didn't parcel the walk across sub-agents)
- [ ] (Debugging) I hand-computed the broken flow *before* walking the fix
- [ ] (Debugging) I walked every phase of the system with the fix applied, not just the failing one
- [ ] When I hit a `⚠` moment, I stopped and explained it rather than pushing past
- [ ] I grounded uncertain transitions by re-reading the actual source, not imagining it
- [ ] (New work) I observed real input/output, not imagined shapes
- [ ] (Scoping) Every "invented state" or "open question" is written down
