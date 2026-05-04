Run a background research task using Gemini (3 Pro). Results are logged and you'll be notified when done.

Usage: /research-gemini <topic or question>

Examples:
  /research-gemini how does the Twitter API v2 rate limiting work
  /research-gemini best practices for Next.js ISR caching

Steps:
1. Parse the research question from: $ARGUMENTS
2. Generate a short descriptive kebab-case ID prefixed with "research-" (e.g., "research-twitter-rate-limits"). Keep under 40 characters. This ID is displayed to the user and used for log paths — make it meaningful.
3. Resolve the repo root first: `REPO_ROOT=$(git rev-parse --show-toplevel)`
4. Run: `bash "$REPO_ROOT/scripts/agents/spawn-research.sh" "<prompt>" "<research-id>" "gemini"`
5. Report the Research ID and log location
6. Tell the user: "Research is running in the background. Check /status for progress, or read the output at the log path when done."

CRITICAL — Script argument order is: "<prompt>" "<research-id>" "<agent-type>"
  - Arg 1: the research prompt (REQUIRED)
  - Arg 2: the research ID you generated in step 2 (REQUIRED — must be a descriptive kebab-case name, NEVER a model name)
  - Arg 3: "gemini" (REQUIRED — always pass this)
  ⚠️  NEVER pass a model name ("claude", "codex", "gemini") as arg 2. Arg 2 is the research ID.
  ⚠️  ALWAYS pass all 3 arguments. Do not omit the research ID or agent type.
