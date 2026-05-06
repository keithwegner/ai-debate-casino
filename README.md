# AI Debate Casino

A fake-chip, AI-powered debate casino for hackathons.

The host creates a room, chooses a ridiculous debate proposition, lets the app post fake-chip odds, allows players to bet and buy audience heckle cards, runs a structured AI debate, and then lets an AI judge score the match and settle the board.

## Included in this MVP

- Zero-build Node server using native `http` and native `fetch`
- Static browser UI with a minimal Node server dependency footprint
- In-memory room state locally, with optional Redis/Valkey room snapshots for hosted deployments
- Optional shared invite-code gate for hosted deployments
- Server-Sent Events for live room updates
- Host and audience views
- Join-by-room-code flow
- Topic generation and custom-topic normalization
- Player topic suggestions and topic voting
- Persona assignment
- Fake-chip betting markets
- Audience heckle cards that influence the next debater turn
- Audience Jury Mode with live reaction tokens, momentum, and judge comparison
- Room chat for human players
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

`/api/openai-smoke` makes a tiny GPT-5.5 structured-output request when an API key is configured. If the key is missing or still set to the placeholder, the app stays in mock mode so local testing can run without token usage.

## Run without token usage

```bash
MOCK_AI=true node server.mjs
```

## Recommended first-round flow

1. Host creates a room and shares the room code or invite link.
2. Players join, suggest topics, and vote while the host picks the resolution.
3. Host assigns debaters, posts odds, and gives players a short betting window.
4. Host starts the debate; players watch, chat, buy heckle cards, and react as the audience jury.
5. Results post automatically; host clicks **Play another round** to replay with the same room.

The visible round loop is always: Topic → Debaters → Bets → Debate → Results → Replay.

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

`BETTING_WINDOW_MS` defaults to `90000`, giving players 90 seconds after odds are posted. The host can start earlier once every eligible non-host audience player has placed a bet.

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

## Render deployment

This app must be hosted as a Node web service, not a static site. It uses API routes, Server-Sent Events, and server-side OpenAI calls.

Recommended first launch on Render:

- Web Service: `ai-debate-casino`, Node, Starter plan
- Key Value: `ai-debate-casino-rooms`, Starter plan, same region as the web service
- Build command: `npm ci && npm run check`
- Start command: `npm start`
- Health check path: `/api/health`

Set these Render environment variables:

```text
OPENAI_API_KEY=<server-side OpenAI API key>
REDIS_URL=<Render internal Key Value URL>
REQUIRE_PERSISTENCE=true
SITE_ACCESS_CODE=<shared invite code>
SESSION_SECRET=<long random secret>
NODE_VERSION=22
DEBATE_SCRIPT=fast
```

Do not set a fixed `PORT` on Render. Render provides it, and the server binds to `0.0.0.0`.

Room persistence stores lobby snapshots in Redis/Valkey after room mutations. Finished rooms, players, bankrolls, chat messages, topic voting, custom debaters, bets, transcripts, verdicts, and results survive restarts. If the server restarts during an active debate or while a human turn timer is waiting, the room is marked interrupted/resettable instead of resuming the in-flight model call.

When `SITE_ACCESS_CODE` is set, the browser shows an invite-code screen before any room APIs can be used. The OpenAI key remains server-side only.

## Important limitations

- Without `REDIS_URL`, in-memory state disappears when the Node process restarts.
- Active debate generation and human-turn timers do not resume across restarts; interrupted rooms must be reset.
- Host token is stored in browser local storage; this is not production authentication.
- Fake chips only. No real-money betting, no prizes, no cash value.
- AI moderation is lightweight and not a production-grade trust-and-safety system.
- The invite code is a simple shared gate, not user accounts or role-based authentication.

## Good next upgrades

- Add full user accounts and per-host room ownership.
- Add voice playback for debaters and judge.
- Add generated match posters.
- Add tournament brackets.
- Add a real admin moderation queue for custom topics and heckles.
