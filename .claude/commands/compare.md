Ask the same question to all three models and compare their answers.

Question: $ARGUMENTS

1. Run: codex exec "$ARGUMENTS" — save output as CODEX_ANSWER
2. Run: echo "$ARGUMENTS" | gemini -p — save output as GEMINI_ANSWER
3. You (Claude) answer the question too

Present all three answers clearly labeled:
## Claude (Opus 4.6)
[your answer]

## Codex (GPT-5.3)
[codex answer]

## Gemini (3 Pro)
[gemini answer]

## Comparison
[brief note on where they agree/disagree]
