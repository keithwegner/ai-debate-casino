# AI Debate Casino

A fake-chip, AI-powered debate casino for hackathons.

The host creates a room, chooses a ridiculous debate proposition, lets the app post fake-chip odds, allows players to bet and buy audience heckle cards, runs a structured AI debate, and then lets an AI judge score the match and settle the board.

## Included in this MVP

- Zero-build Node server using native `http` and native `fetch`
- Static browser UI; no npm dependencies
- In-memory room state
- Server-Sent Events for live room updates
- Host and audience views
- Join-by-room-code flow
- Topic generation and custom-topic normalization
- Persona assignment
- Fake-chip betting markets
- Demo audience and demo bot bets
- Audience heckle cards that influence the next debater turn
- Structured AI judge verdict
- Deterministic settlement math
- Leaderboard
- Mock AI mode for no-token local testing

## Quick start

```bash
cd ai-debate-casino
cp .env.example .env
# Edit .env and replace sk-your-api-key-here with an OpenAI API key.
npm run check
node server.mjs
```

Open:

```text
http://localhost:8787
```

Confirm whether you are really using OpenAI or the mock fallback:

```bash
curl http://localhost:8787/api/health
curl -X POST http://localhost:8787/api/openai-smoke
```

`/api/openai-smoke` makes a tiny GPT-5.5 structured-output request when an API key is configured. If the key is missing or still set to the placeholder, the app stays in mock mode so the demo still runs.

## Run without token usage

```bash
MOCK_AI=true node server.mjs
```

## Recommended hackathon demo flow

1. Create a room.
2. Choose **Classic** or **Kids** under **Audience**.
3. Click **One-click demo round**.
4. Watch the app auto-select a topic, assign personas, post odds, add demo players, place bot bets, run the debate, judge it, settle the bets, and update the leaderboard.

For a more interactive demo, have audience members join by room code, place fake-chip bets, and buy heckle cards while the debate is running.

## Model routing

The app supports task-specific model settings:

```text
OPENAI_MODEL_SETUP=gpt-5.5
OPENAI_MODEL_DEBATE=gpt-5.5
OPENAI_MODEL_JUDGE=gpt-5.5
DEBATE_SCRIPT=fast
```

For a stronger but slower judge:

```text
OPENAI_MODEL_JUDGE=gpt-5.5-pro
OPENAI_REASONING_JUDGE=high
OPENAI_TIMEOUT_MS=240000
```

For a live hackathon, keep the debate model fast. The judge can be upgraded later if the venue has time and budget.

Set `DEBATE_SCRIPT=full` for the full 10-turn debate. Keep `DEBATE_SCRIPT=fast` for a shorter six-turn round with fewer sequential model calls.

## Smoke test

With the server running, verify the API configuration:

```bash
curl -X POST http://localhost:8787/api/openai-smoke
```

Run a full local game-loop smoke test:

```bash
MOCK_AI=true node server.mjs
# In another terminal:
node tests/smoke.mjs
```

In mock mode, the OpenAI smoke endpoint will not call OpenAI. With an API key, it performs a tiny structured-output request.

## Important limitations

- In-memory state disappears when the Node process restarts.
- Host token is stored in browser local storage; this is not production authentication.
- Fake chips only. No real-money betting, no prizes, no cash value.
- AI moderation is demo-grade, not production-grade.
- There is no persistence, database, or deployment hardening yet.

## Good next upgrades

- Persist rooms in SQLite, Redis, or Supabase.
- Add voice playback for debaters and judge.
- Add generated match posters.
- Add tournament brackets.
- Add a real admin moderation queue for custom topics and heckles.
