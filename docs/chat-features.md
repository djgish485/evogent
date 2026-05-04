# Chat Features

Evogent chat is grounded in the local app context: the current post, thread, replies, selected text, source evidence, and user preferences.

## On-Demand Research

Ask the agent in chat to research a topic or URL. It spawns a background task and the analysis appears in your feed. Example: share a news article URL and say "give me a full report on this". The agent replies immediately and the analysis post appears in your feed when ready.

The report is not a dead-end chat blob. It becomes an **Agent's analysis** post, and opening it can trigger the same enrichment pipeline as tweets and articles: related context, curated replies, and additional analysis.

## Ask Agent Tooltip

Select text in any post to see an Ask Agent tooltip. Tap it to start a chat about the selected content.

This works across tweets, articles, analysis posts, and reply comments inside the enrichment view. It makes precise questions easier because the selected text travels with the chat request.

## Setup Wizard

The setup card's **Finish Setup** button starts `/setup-wizard` in chat. The wizard checks required configuration and asks for the next missing setup choice inside the normal chat flow.
