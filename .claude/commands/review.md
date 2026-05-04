Get a second opinion from another AI model on code or a plan.

Parse $ARGUMENTS to extract:
- TARGET: the code, file, or plan to review
- MODEL: which model to use (codex or gemini, default: codex)

Start every review with a runtime-first boundary check:
- Ask whether the requested change builds product code for something an agent could reason through at runtime with existing tools, browser access, file access, or a short reusable skill/instruction.
- If the answer is yes, lead with pushback and recommend refactoring toward instructions, skills, or diagnostics instead of more product code.
- Treat large single-file additions, such as 100+ new lines in one file, as a smell. Confirm they are true infrastructure such as queues, storage, APIs, UI, WebSocket broadcast, dedup, or similarly durable plumbing, not encoded agent logic.
- Use the large CDP cookie-injection client in `src/lib/shared-browser.ts` as the kind of wrong-layer fix to call out, but keep the policy general rather than source-specific.

Read the target file/code, then send it to the specified model with a review prompt that includes the boundary check above before ordinary code review.

If MODEL is codex: codex exec "Review this code or plan. First perform the runtime-first boundary check above, then suggest improvements: [code]"
If MODEL is gemini: echo "Review this code or plan. First perform the runtime-first boundary check above, then suggest improvements: [code]" | gemini -p

Present the review with your own commentary on whether you agree.
