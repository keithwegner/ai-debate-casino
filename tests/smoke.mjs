import { createClient } from 'redis';

const base = process.env.BASE_URL || 'http://localhost:8787';
let cookieHeader = '';

async function apiRaw(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(!options.noCookie && cookieHeader ? { Cookie: cookieHeader } : {}),
    ...(options.headers || {}),
  };
  const response = await fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie && !options.noCookie) cookieHeader = setCookie.split(';')[0];
  const data = await response.json();
  return { response, data };
}

async function api(path, options = {}) {
  const { response, data } = await apiRaw(path, options);
  if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
  return data;
}

async function expectApiError(path, options, status) {
  const { response, data } = await apiRaw(path, options);
  if (response.status !== status) throw new Error(`Expected ${status} from ${path}, got ${response.status}: ${data.error || 'no error'}`);
  return data;
}

async function openRoomEventStream(roomId) {
  const headers = cookieHeader ? { Cookie: cookieHeader } : {};
  const response = await fetch(`${base}/api/rooms/${roomId}/events`, { headers });
  if (!response.ok || !response.body) throw new Error(`Failed to open room event stream: ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let closed = false;

  function parseBlock(block) {
    let event = 'message';
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return null;
    return { event, data: data.join('\n') };
  }

  async function nextRoom(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      while (buffer.includes('\n\n')) {
        const index = buffer.indexOf('\n\n');
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const parsed = parseBlock(block);
        if (!parsed || parsed.event !== 'room') continue;
        const room = JSON.parse(parsed.data);
        if (predicate(room)) return room;
      }
      const remaining = deadline - Date.now();
      const timeout = new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), Math.min(remaining, 250)));
      const result = await Promise.race([reader.read(), timeout]);
      if (result?.timeout) continue;
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
    }
    throw new Error(`Timed out waiting for room SSE event for ${roomId}.`);
  }

  async function close() {
    if (closed) return;
    closed = true;
    try { await reader.cancel(); } catch { /* ignore */ }
  }

  return { nextRoom, close };
}

async function assertRedisRoomSnapshot(roomId, namespace, options = {}) {
  if (!process.env.REDIS_URL) throw new Error('Health reported Redis persistence but REDIS_URL is not available to the smoke test.');
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();
  try {
    const key = `${namespace}:room:${roomId}`;
    for (let i = 0; i < 30; i++) {
      const raw = await client.get(key);
      if (raw) {
        const room = JSON.parse(raw);
        if (room.id !== roomId) throw new Error(`Persisted room id mismatch: ${room.id} !== ${roomId}`);
        if (!Array.isArray(room.players) || !room.players.length) throw new Error('Persisted room snapshot did not include players.');
        if (room.streamingTurn) throw new Error('Persisted room snapshot included transient streamingTurn state.');
        if (options.chatText && !room.chatMessages?.some((message) => message.text === options.chatText)) throw new Error('Persisted room snapshot did not include expected chat message.');
        if (options.topicText && !room.topics?.some((topic) => topic.resolution === options.topicText)) throw new Error('Persisted room snapshot did not include expected topic vote candidate.');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Redis room snapshot ${key} was not written.`);
  } finally {
    await client.quit();
  }
}

function normalizePersonaLabelPart(value) {
  return String(value || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function waitForResults(roomId) {
  for (let i = 0; i < 180; i++) {
    const { room } = await api(`/api/rooms/${roomId}`);
    if (room.status === 'RESULTS') return room;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Room ${roomId} did not reach RESULTS in time.`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStreamingTurn(roomId) {
  for (let i = 0; i < 120; i++) {
    const { room } = await api(`/api/rooms/${roomId}`);
    if (room.streamingTurn?.text) return room;
    if (room.status === 'RESULTS') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Room ${roomId} did not expose an active streaming turn.`);
}

async function waitForReactableTurn(roomId) {
  for (let i = 0; i < 160; i++) {
    const { room } = await api(`/api/rooms/${roomId}`);
    const target = room.turns?.at(-1);
    if (target?.id && room.status === 'DEBATE') return { room, target };
    if (['JUDGING', 'SETTLEMENT', 'RESULTS'].includes(room.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Room ${roomId} did not expose a jury-reactable turn.`);
}

async function waitForPendingHumanTurn(roomId) {
  for (let i = 0; i < 1200; i++) {
    const { room } = await api(`/api/rooms/${roomId}`);
    if (room.pendingHumanTurn) return room;
    if (room.status === 'RESULTS') return room;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Room ${roomId} did not expose a pending human turn in time.`);
}

async function submitHumanTurnsUntilResults(roomId, playerId, textFactory = null) {
  const submitted = [];
  for (let i = 0; i < 24; i++) {
    const room = await waitForPendingHumanTurn(roomId);
    if (room.status === 'RESULTS') return { room, submitted };
    const pending = room.pendingHumanTurn;
    if (pending.playerId !== playerId) throw new Error(`Pending turn belonged to ${pending.playerId}, not ${playerId}.`);
    const text = textFactory
      ? textFactory(pending, submitted.length)
      : `Human smoke turn ${submitted.length + 1}: ${pending.phase} says that argument is bullshit, then supports the microwave office with clear reasons, a callback, and a practical example.`;
    await api(`/api/rooms/${roomId}/turns/human`, {
      method: 'POST',
      body: { playerId, pendingTurnId: pending.id, text },
    });
    submitted.push(text);
  }
  throw new Error(`Room ${roomId} did not finish after submitted human turns.`);
}

async function configureRound(roomId, hostToken, personaAId = 'formal_logician', personaBId = 'product_manager') {
  const current = await api(`/api/rooms/${roomId}`);
  if (!current.room.topic) {
    const topicLocked = await api(`/api/rooms/${roomId}/topic`, {
      method: 'POST',
      headers: { 'X-Host-Token': hostToken },
      body: { customTopic: 'Resolved: The office microwave should get its own office.' },
    });
    if (topicLocked.room.debaters.length) throw new Error('Topic lock should not auto-assign debaters.');
  }
  const assigned = await api(`/api/rooms/${roomId}/personas`, {
    method: 'POST',
    headers: { 'X-Host-Token': hostToken },
    body: { personaAId, personaBId },
  });
  if (assigned.room.debaters[0]?.personaId !== personaAId) throw new Error(`Debater A was not assigned to ${personaAId}.`);
  if (assigned.room.debaters[1]?.personaId !== personaBId) throw new Error(`Debater B was not assigned to ${personaBId}.`);
  if (eligibleBettorsFromRoom(assigned.room).length < 3) await joinAudience(roomId);
  const odds = await api(`/api/rooms/${roomId}/odds`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: {} });
  const eligible = eligibleBettorsFromRoom(odds.room);
  if (odds.room.bettingWindow?.durationMs !== health.bettingWindowMs) throw new Error('Betting window duration did not match health payload.');
  if (odds.room.bettingWindow?.done) throw new Error('Betting window closed before eligible bettors acted.');
  if (odds.room.bettingWindow?.eligibleCount !== eligible.length) throw new Error('Betting window eligible count did not match audience.');
  await expectApiError(`/api/rooms/${roomId}/start`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: {} }, 400);
  await expectApiError(`/api/rooms/${roomId}/heckles`, { method: 'POST', body: { playerId: eligible[0].id, cardId: 'pirate_analogy' } }, 400);
  await placeAudienceBets(roomId, odds.room.markets, eligible);
  const afterBets = await api(`/api/rooms/${roomId}`);
  if (!afterBets.room.bettingWindow?.done || afterBets.room.bettingWindow.doneReason !== 'all_bettors_ready') throw new Error('All eligible bettors did not close the betting window.');
  await expectApiError(`/api/rooms/${roomId}/bets`, { method: 'POST', body: { playerId: eligible[0].id, marketId: odds.room.markets[0].id, amount: 10 } }, 400);
  const heckle = await api(`/api/rooms/${roomId}/heckles`, { method: 'POST', body: { playerId: eligible[0].id, cardId: 'pirate_analogy' } });
  if (!heckle.room.heckles.some((item) => item.cardId === 'pirate_analogy')) throw new Error('Heckle Code was not accepted after betting closed.');
}

function eligibleBettorsFromRoom(room) {
  const humanDebaterIds = new Set((room.debaters || []).filter((debater) => debater.kind === 'human').map((debater) => debater.playerId));
  return (room.players || []).filter((player) => !player.isHost && !player.isBot && !player.leftAt && !humanDebaterIds.has(player.id) && Number(player.bankroll || 0) >= 10);
}

async function joinAudience(roomId) {
  const audience = [
    { name: 'Ada Odds', amount: 50 },
    { name: 'Sam Spread', amount: 75 },
    { name: 'Jules Jury', amount: 100 },
  ];
  const joinedAudience = [];
  for (const bettor of audience) {
    const joined = await api(`/api/rooms/${roomId}/join`, { method: 'POST', body: { displayName: bettor.name } });
    joinedAudience.push({ ...bettor, id: joined.playerId });
  }
  return joinedAudience;
}

async function placeAudienceBets(roomId, markets, audience) {
  if (!markets?.length) throw new Error('Cannot seed smoke bets before odds are posted.');
  for (const [index, bettor] of audience.entries()) {
    const market = markets[index % markets.length];
    await api(`/api/rooms/${roomId}/bets`, {
      method: 'POST',
      body: { playerId: bettor.id, marketId: market.id, amount: bettor.amount || 50 },
    });
  }
}

async function runConfiguredRound() {
  const created = await api('/api/rooms', { method: 'POST', body: { displayName: 'Smoke Host' } });
  const roomId = created.room.id;
  const hostToken = created.hostToken;
  await configureRound(roomId, hostToken);
  await api(`/api/rooms/${roomId}/start`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: {} });
  return { roomId, hostToken, playerId: created.playerId };
}

async function createHumanDebateRoom(label = 'Human Smoke Host') {
  const created = await api('/api/rooms', { method: 'POST', body: { displayName: label } });
  const roomId = created.room.id;
  const hostToken = created.hostToken;
  const human = await api(`/api/rooms/${roomId}/join`, { method: 'POST', body: { displayName: 'Human Debater' } });
  const bettor = await api(`/api/rooms/${roomId}/join`, { method: 'POST', body: { displayName: 'Audience Bettor' } });
  await api(`/api/rooms/${roomId}/topic`, {
    method: 'POST',
    headers: { 'X-Host-Token': hostToken },
    body: { customTopic: 'Resolved: The office microwave should get its own office.' },
  });
  return { roomId, hostToken, hostPlayerId: created.playerId, humanPlayerId: human.playerId, bettorPlayerId: bettor.playerId };
}

async function runTimerBettingWindowCheck() {
  const created = await api('/api/rooms', { method: 'POST', body: { displayName: 'Timer Window Host' } });
  const roomId = created.room.id;
  const hostToken = created.hostToken;
  const bettor = await api(`/api/rooms/${roomId}/join`, { method: 'POST', body: { displayName: 'Slow Bettor' } });
  await api(`/api/rooms/${roomId}/topic`, {
    method: 'POST',
    headers: { 'X-Host-Token': hostToken },
    body: { customTopic: 'Resolved: The office microwave deserves a vacation.' },
  });
  await api(`/api/rooms/${roomId}/personas`, {
    method: 'POST',
    headers: { 'X-Host-Token': hostToken },
    body: { personaAId: 'formal_logician', personaBId: 'product_manager' },
  });
  const odds = await api(`/api/rooms/${roomId}/odds`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: {} });
  if (odds.room.bettingWindow?.done) throw new Error('Timer betting window closed immediately despite an eligible bettor.');
  await delay(Number(health.bettingWindowMs) + 150);
  const expired = await api(`/api/rooms/${roomId}`);
  if (!expired.room.bettingWindow?.done || expired.room.bettingWindow.doneReason !== 'timer_elapsed') throw new Error('Betting window did not close by timer.');
  await expectApiError(`/api/rooms/${roomId}/bets`, { method: 'POST', body: { playerId: bettor.playerId, marketId: odds.room.markets[0].id, amount: 50 } }, 400);
  await api(`/api/rooms/${roomId}/heckles`, { method: 'POST', body: { playerId: bettor.playerId, cardId: 'legal_caveat' } });
  await api(`/api/rooms/${roomId}/start`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: {} });
}

const health = await api('/api/health');
if (typeof health.transcriptStreamCps !== 'number') throw new Error('Health payload did not expose transcript streaming speed.');
if (typeof health.debateBotPauseMs !== 'number') throw new Error('Health payload did not expose debate bot pause.');
if (typeof health.bettingWindowMs !== 'number') throw new Error('Health payload did not expose betting window duration.');
if (!health.persistence || typeof health.persistence.redisConfigured !== 'boolean') throw new Error('Health payload did not expose persistence state.');
if (!health.access || typeof health.access.required !== 'boolean') throw new Error('Health payload did not expose access state.');
if (health.access.required) {
  if (!process.env.SMOKE_ACCESS_CODE) throw new Error('Access gate is enabled; set SMOKE_ACCESS_CODE for smoke tests.');
  await expectApiError('/api/personas', { noCookie: true }, 401);
  await expectApiError('/api/access', { method: 'POST', body: { code: 'wrong-code' }, noCookie: true }, 403);
  const access = await api('/api/access', { method: 'POST', body: { code: process.env.SMOKE_ACCESS_CODE } });
  if (!access.authenticated) throw new Error('Access code did not authenticate the smoke client.');
  if (!cookieHeader.startsWith(`${health.access.cookieName || 'adc_access'}=`)) throw new Error('Access response did not set the expected cookie.');
}
const personas = await api('/api/personas');
const expectedNewPersonas = ['spreadsheet_oracle', 'sentient_vending_machine', 'cursed_intern', 'suburban_warlord', 'crypto_court_jester', 'museum_docent_doom', 'weather_app_shaman', 'powerpoint_necromancer', 'elevator_philosopher', 'mall_santa_auditor'];
for (const personaId of expectedNewPersonas) {
  if (!personas.personas.some((p) => p.id === personaId)) throw new Error(`Missing new built-in persona ${personaId}.`);
}
for (const persona of personas.personas) {
  if (normalizePersonaLabelPart(persona.displayName) === normalizePersonaLabelPart(persona.archetype)) {
    throw new Error(`Redundant persona label for ${persona.id}: ${persona.displayName} / ${persona.archetype}`);
  }
}

if (health.mode === 'mock' && Number(health.transcriptStreamCps || 0) <= 120) {
  const streamingRun = await runConfiguredRound();
  const activeRoom = await waitForStreamingTurn(streamingRun.roomId);
  const active = activeRoom.streamingTurn;
  if (!active?.streaming) throw new Error('Active transcript turn was not marked as streaming.');
  if (activeRoom.turns.some((turn) => turn.id === active.id)) throw new Error('Streaming turn was prematurely stored in completed turns.');
  const partialText = active.text;
  const completedRoom = await waitForResults(streamingRun.roomId);
  const completedTurn = completedRoom.turns.find((turn) => turn.id === active.id);
  if (!completedTurn) throw new Error('Streaming turn did not become a completed transcript turn.');
  if (completedRoom.streamingTurn) throw new Error('Streaming turn was not cleared after debate completion.');
  if (!completedTurn.text.startsWith(partialText.slice(0, Math.min(20, partialText.length)))) throw new Error('Completed turn did not preserve streamed text.');
}

const created = await api('/api/rooms', { method: 'POST', body: { displayName: 'Smoke Host' } });
const roomId = created.room.id;
const hostToken = created.hostToken;
if (!Array.isArray(created.room.chatMessages) || created.room.chatMessages.length) throw new Error('New room did not expose empty chatMessages.');
if (!created.room.activity?.some((entry) => entry.type === 'room_created')) throw new Error('New room did not expose room-created activity.');
if (!created.room.topicVote?.open || created.room.topicVote.totalVotes !== 0) throw new Error('New room did not expose open empty topicVote state.');
if (health.persistence?.mode === 'redis') await assertRedisRoomSnapshot(roomId, health.persistence.namespace || 'ai-debate-casino');
console.log(`Created room ${roomId}`);

const chatJoin = await api(`/api/rooms/${roomId}/join`, { method: 'POST', body: { displayName: 'Chat Friend' } });
if (!chatJoin.room.activity?.some((entry) => entry.type === 'join' && entry.playerId === chatJoin.playerId && entry.message.includes('Chat Friend'))) {
  throw new Error('Join activity was not recorded for a new player.');
}
const chatPost = await api(`/api/rooms/${roomId}/chat`, {
  method: 'POST',
  body: { playerId: chatJoin.playerId, text: 'Hello from the chat rail.' },
});
if (chatPost.message.displayName !== 'Chat Friend') throw new Error('Chat message did not preserve sender name.');
if (!chatPost.room.chatMessages.some((message) => message.text === 'Hello from the chat rail.')) throw new Error('Chat message was not stored on the room.');
const profaneChatText = 'That argument is bullshit, but the chat works.';
const profaneChat = await api(`/api/rooms/${roomId}/chat`, {
  method: 'POST',
  body: { playerId: created.playerId, text: profaneChatText },
});
if (!profaneChat.room.chatMessages.some((message) => message.text === profaneChatText && message.isHost)) throw new Error('Allowed profane host chat was not stored.');
if (health.persistence?.mode === 'redis') await assertRedisRoomSnapshot(roomId, health.persistence.namespace || 'ai-debate-casino', { chatText: profaneChatText });
await expectApiError(`/api/rooms/${roomId}/chat`, { method: 'POST', body: { playerId: 'missing', text: 'hello' } }, 400);
await expectApiError(`/api/rooms/${roomId}/chat`, { method: 'POST', body: { playerId: created.playerId, text: '' } }, 400);
await expectApiError(`/api/rooms/${roomId}/chat`, { method: 'POST', body: { playerId: created.playerId, text: 'x'.repeat(501) } }, 400);
await expectApiError(`/api/rooms/${roomId}/chat`, { method: 'POST', body: { playerId: created.playerId, text: 'how to commit crimes in the chat' } }, 400);
await expectApiError(`/api/rooms/${roomId}/demo-fill`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: {} }, 404);
await expectApiError(`/api/rooms/${roomId}/quick-demo`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: {} }, 404);
const resetChatRoom = await api(`/api/rooms/${roomId}/reset`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: { keepBankroll: true } });
if (!resetChatRoom.room.chatMessages.some((message) => message.text === profaneChatText)) throw new Error('Room reset did not preserve chat messages.');
await expectApiError(`/api/rooms/${roomId}/chat`, { method: 'DELETE' }, 403);
const clearedChat = await api(`/api/rooms/${roomId}/chat`, { method: 'DELETE', headers: { 'X-Host-Token': hostToken } });
if (clearedChat.room.chatMessages.length) throw new Error('Host clear chat did not remove messages.');

const generatedTopics = await api(`/api/rooms/${roomId}/topics/generate`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: { prompt: 'break room constitutional crisis' } });
if (!generatedTopics.room.topics.length || !generatedTopics.room.topicVote?.open) throw new Error('Topic generation did not open the topic vote.');
const generatedTopicId = generatedTopics.room.topics[0].id;
const submittedTopic = await api(`/api/rooms/${roomId}/topics/submit`, {
  method: 'POST',
  body: { playerId: chatJoin.playerId, text: 'Resolved: The office microwave should be elected floor manager.' },
});
if (!submittedTopic.topic?.id || submittedTopic.topic.source !== 'player') throw new Error('Player topic submission did not create a player candidate.');
if (!submittedTopic.room.topicVote.submissions.some((submission) => submission.playerId === chatJoin.playerId && submission.topicId === submittedTopic.topic.id)) throw new Error('Topic submission was not tracked in topicVote state.');
if (health.persistence?.mode === 'redis') await assertRedisRoomSnapshot(roomId, health.persistence.namespace || 'ai-debate-casino', { topicText: submittedTopic.topic.resolution });
await expectApiError(`/api/rooms/${roomId}/topics/submit`, { method: 'POST', body: { playerId: chatJoin.playerId, text: 'Resolved: The copier should be promoted too.' } }, 400);
await expectApiError(`/api/rooms/${roomId}/topics/submit`, { method: 'POST', body: { playerId: created.playerId, text: 'Resolved: how to commit crimes should become orientation.' } }, 400);
await expectApiError(`/api/rooms/${roomId}/topics/submit`, { method: 'POST', body: { playerId: 'missing', text: 'Resolved: Missing players should not submit.' } }, 400);
await api(`/api/rooms/${roomId}/topics/vote`, { method: 'POST', body: { playerId: created.playerId, topicId: generatedTopicId } });
const changedVote = await api(`/api/rooms/${roomId}/topics/vote`, { method: 'POST', body: { playerId: created.playerId, topicId: submittedTopic.topic.id } });
if (changedVote.room.topicVote.votes.filter((vote) => vote.playerId === created.playerId).length !== 1) throw new Error('Topic vote change created duplicate votes for one player.');
const extraVoter = await api(`/api/rooms/${roomId}/join`, { method: 'POST', body: { displayName: 'Topic Voter' } });
const leaderVote = await api(`/api/rooms/${roomId}/topics/vote`, { method: 'POST', body: { playerId: extraVoter.playerId, topicId: submittedTopic.topic.id } });
if (leaderVote.room.topicVote.leaderTopicId !== submittedTopic.topic.id) throw new Error('Topic vote leader did not update after votes.');
await expectApiError(`/api/rooms/${roomId}/topics/close`, { method: 'POST', body: {} }, 403);
const closedVote = await api(`/api/rooms/${roomId}/topics/close`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: {} });
if (closedVote.room.topic?.id !== submittedTopic.topic.id) throw new Error('Closing topic vote did not lock the leading topic.');
if (closedVote.room.topic.voteResult?.mode !== 'top_vote' || closedVote.room.topic.voteResult.votes !== 2) throw new Error('Locked topic did not preserve top-vote result metadata.');
if (closedVote.room.debaters.length) throw new Error('Closing topic vote should leave debater assignment to the host.');
await expectApiError(`/api/rooms/${roomId}/topics/vote`, { method: 'POST', body: { playerId: created.playerId, topicId: submittedTopic.topic.id } }, 409);
const resetVoteRoom = await api(`/api/rooms/${roomId}/reset`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: { keepBankroll: true } });
if (resetVoteRoom.room.topic || resetVoteRoom.room.topics.length || resetVoteRoom.room.topicVote.votes.length || resetVoteRoom.room.topicVote.submissions.length) throw new Error('Room reset did not clear topic voting state.');
const leaveRoom = await api(`/api/rooms/${roomId}/leave`, { method: 'POST', body: { playerId: chatJoin.playerId } });
const inactiveChatFriend = leaveRoom.room.players.find((player) => player.id === chatJoin.playerId);
if (!inactiveChatFriend?.leftAt) throw new Error('Leave did not mark the player inactive.');
if (!leaveRoom.room.players.some((player) => player.id === chatJoin.playerId)) throw new Error('Leave removed the player record instead of preserving history.');
if (!leaveRoom.room.activity?.some((entry) => entry.type === 'leave' && entry.playerId === chatJoin.playerId && entry.message.includes('Chat Friend'))) {
  throw new Error('Leave activity was not recorded.');
}
await expectApiError(`/api/rooms/${roomId}/chat`, { method: 'POST', body: { playerId: chatJoin.playerId, text: 'I should be inactive.' } }, 400);

const overrideRoom = await api('/api/rooms', { method: 'POST', body: { displayName: 'Override Host' } });
const overrideGuest = await api(`/api/rooms/${overrideRoom.room.id}/join`, { method: 'POST', body: { displayName: 'Override Voter' } });
const overrideGenerated = await api(`/api/rooms/${overrideRoom.room.id}/topics/generate`, { method: 'POST', headers: { 'X-Host-Token': overrideRoom.hostToken }, body: {} });
const [overrideLeader, overrideTarget] = overrideGenerated.room.topics;
await api(`/api/rooms/${overrideRoom.room.id}/topics/vote`, { method: 'POST', body: { playerId: overrideGuest.playerId, topicId: overrideLeader.id } });
const overrideLocked = await api(`/api/rooms/${overrideRoom.room.id}/topic`, { method: 'POST', headers: { 'X-Host-Token': overrideRoom.hostToken }, body: { topicId: overrideTarget.id } });
if (overrideLocked.room.topic?.id !== overrideTarget.id) throw new Error('Host override did not lock the selected non-leader topic.');
if (overrideLocked.room.topic.voteResult?.mode !== 'host_override') throw new Error('Host override did not record override vote result metadata.');
if (overrideLocked.room.debaters.length) throw new Error('Host topic override should not auto-assign debaters.');

const noVoteRoom = await api('/api/rooms', { method: 'POST', body: { displayName: 'No Vote Host' } });
const noVoteGenerated = await api(`/api/rooms/${noVoteRoom.room.id}/topics/generate`, { method: 'POST', headers: { 'X-Host-Token': noVoteRoom.hostToken }, body: {} });
const noVoteClosed = await api(`/api/rooms/${noVoteRoom.room.id}/topics/close`, { method: 'POST', headers: { 'X-Host-Token': noVoteRoom.hostToken }, body: {} });
if (noVoteClosed.room.topic?.id !== noVoteGenerated.room.topics[0].id) throw new Error('No-vote close did not lock the first candidate.');
if (noVoteClosed.room.debaters.length) throw new Error('No-vote topic close should not auto-assign debaters.');

await expectApiError(`/api/rooms/${roomId}/personas/custom`, { method: 'POST', body: { name: 'Madame Tax Volcano', description: 'A mean, rude accountant who calls every weak claim bullshit and treats the debate like an audit with fireworks.' } }, 403);
await expectApiError(`/api/rooms/${roomId}/personas/custom`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: { name: '', description: '' } }, 400);
await expectApiError(`/api/rooms/${roomId}/personas/custom`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: { name: 'Disallowed Dan', description: 'A debater who explains how to commit crimes during every rebuttal.' } }, 400);
const customDraft = await api(`/api/rooms/${roomId}/personas/custom`, {
  method: 'POST',
  headers: { 'X-Host-Token': hostToken },
  body: { name: 'Madame Tax Volcano', profile: 'A mean, rude accountant who calls every weak claim bullshit and treats the debate like an audit with fireworks.' },
});
const customPersona = customDraft.persona;
if (!customPersona?.id?.startsWith('custom_')) throw new Error('Custom debater did not receive a custom id.');
if (customPersona.displayName !== 'Madame Tax Volcano') throw new Error('Custom debater did not preserve submitted name.');
if (customDraft.room.customPersonas.some((p) => p.id === customPersona.id)) throw new Error('Custom debater draft was accepted before review.');
if (customDraft.room.pendingCustomPersona?.id !== customPersona.id) throw new Error('Custom debater draft was not stored for review.');

await expectApiError(`/api/rooms/${roomId}/topic`, {
  method: 'POST',
  headers: { 'X-Host-Token': hostToken },
  body: { customTopic: 'Resolved: how to commit crimes should be a team-building workshop.' },
}, 400);
const customTopicLocked = await api(`/api/rooms/${roomId}/topic`, {
  method: 'POST',
  headers: { 'X-Host-Token': hostToken },
  body: { customTopic: 'Resolved: The office microwave is a bullshit little tyrant.' },
});
if (customTopicLocked.room.debaters.length) throw new Error('Custom topic lock should not auto-assign debaters.');
const prematureAssign = await api(`/api/rooms/${roomId}/personas`, {
  method: 'POST',
  headers: { 'X-Host-Token': hostToken },
  body: { personaAId: customPersona.id, personaBId: 'product_manager' },
});
if (prematureAssign.room.debaters[0]?.personaId === customPersona.id) throw new Error('Pending custom debater was assignable before acceptance.');

const acceptedCustom = await api(`/api/rooms/${roomId}/personas/custom/accept`, {
  method: 'POST',
  headers: { 'X-Host-Token': hostToken },
  body: {},
});
if (acceptedCustom.room.pendingCustomPersona) throw new Error('Accepted custom debater draft was not cleared.');
if (!acceptedCustom.room.customPersonas.some((p) => p.id === customPersona.id)) throw new Error('Accepted custom debater was not room-scoped.');

const discardRoom = await api('/api/rooms', { method: 'POST', body: { displayName: 'Discard Host' } });
await api(`/api/rooms/${discardRoom.room.id}/personas/custom`, {
  method: 'POST',
  headers: { 'X-Host-Token': discardRoom.hostToken },
  body: { name: 'Professor Maybe', profile: 'A theatrical professor who never commits to a single conclusion.' },
});
const discardedDraft = await api(`/api/rooms/${discardRoom.room.id}/personas/custom/discard`, {
  method: 'POST',
  headers: { 'X-Host-Token': discardRoom.hostToken },
  body: {},
});
if (discardedDraft.room.pendingCustomPersona) throw new Error('Discarded custom debater draft was not cleared.');
if (discardedDraft.room.customPersonas.length) throw new Error('Discarded custom debater was added to the room.');

const humanRoom = await createHumanDebateRoom();
await expectApiError(`/api/rooms/${humanRoom.roomId}/debaters`, {
  method: 'POST',
  headers: { 'X-Host-Token': humanRoom.hostToken },
  body: { debaterA: { kind: 'ai', personaId: 'formal_logician' }, debaterB: { kind: 'ai', personaId: 'product_manager' } },
}, 400);
await expectApiError(`/api/rooms/${humanRoom.roomId}/debaters`, {
  method: 'POST',
  headers: { 'X-Host-Token': humanRoom.hostToken },
  body: { debaterA: { kind: 'human', playerId: humanRoom.hostPlayerId }, debaterB: { kind: 'human', playerId: humanRoom.humanPlayerId } },
}, 400);
const humanAssigned = await api(`/api/rooms/${humanRoom.roomId}/debaters`, {
  method: 'POST',
  headers: { 'X-Host-Token': humanRoom.hostToken },
  body: { debaterA: { kind: 'human', playerId: humanRoom.humanPlayerId }, debaterB: { kind: 'ai', personaId: 'product_manager' } },
});
if (humanAssigned.room.debaters[0]?.kind !== 'human') throw new Error('Debater A was not assigned as a human.');
if (humanAssigned.room.debaters[0]?.playerId !== humanRoom.humanPlayerId) throw new Error('Human debater did not preserve player id.');
if (humanAssigned.room.debaters[1]?.kind !== 'ai') throw new Error('Debater B was not assigned as AI.');
const humanOdds = await api(`/api/rooms/${humanRoom.roomId}/odds`, { method: 'POST', headers: { 'X-Host-Token': humanRoom.hostToken }, body: {} });
const humanMarketId = humanOdds.room.markets[0]?.id;
if (!humanMarketId) throw new Error('Human debate room did not expose a betting market.');
await expectApiError(`/api/rooms/${humanRoom.roomId}/bets`, { method: 'POST', body: { playerId: humanRoom.humanPlayerId, marketId: humanMarketId, amount: 50 } }, 400);
await api(`/api/rooms/${humanRoom.roomId}/bets`, { method: 'POST', body: { playerId: humanRoom.bettorPlayerId, marketId: humanMarketId, amount: 50 } });
await api(`/api/rooms/${humanRoom.roomId}/start`, { method: 'POST', headers: { 'X-Host-Token': humanRoom.hostToken }, body: {} });
const submittedHuman = await submitHumanTurnsUntilResults(humanRoom.roomId, humanRoom.humanPlayerId);
if (!submittedHuman.submitted.length) throw new Error('No human turns were submitted.');
if (!submittedHuman.submitted.some((text) => text.includes('bullshit'))) throw new Error('Human-turn profanity path was not exercised.');
for (const text of submittedHuman.submitted) {
  if (!submittedHuman.room.turns.some((turn) => turn.source === 'human' && turn.text === text)) throw new Error(`Submitted human turn missing from transcript: ${text}`);
}

const weakRoom = await createHumanDebateRoom('Weak Human Smoke Host');
await api(`/api/rooms/${weakRoom.roomId}/debaters`, {
  method: 'POST',
  headers: { 'X-Host-Token': weakRoom.hostToken },
  body: { debaterA: { kind: 'human', playerId: weakRoom.humanPlayerId }, debaterB: { kind: 'ai', personaId: 'corporate_lawyer' } },
});
const weakOdds = await api(`/api/rooms/${weakRoom.roomId}/odds`, { method: 'POST', headers: { 'X-Host-Token': weakRoom.hostToken }, body: {} });
const weakMarketId = weakOdds.room.markets[0]?.id;
if (!weakMarketId) throw new Error('Weak human debate room did not expose a betting market.');
await api(`/api/rooms/${weakRoom.roomId}/bets`, { method: 'POST', body: { playerId: weakRoom.bettorPlayerId, marketId: weakMarketId, amount: 50 } });
await api(`/api/rooms/${weakRoom.roomId}/start`, { method: 'POST', headers: { 'X-Host-Token': weakRoom.hostToken }, body: {} });
const weakFinal = await submitHumanTurnsUntilResults(weakRoom.roomId, weakRoom.humanPlayerId, () => 'what');
if (weakFinal.room.verdict?.winnerDebaterId === 'debater_a') throw new Error('Weak human arguments incorrectly beat the AI debater.');
if ((weakFinal.room.verdict?.scores?.debater_a?.total || 0) >= (weakFinal.room.verdict?.scores?.debater_b?.total || 0)) throw new Error('Weak human arguments were not scored below the AI debater.');
if (!weakFinal.room.verdict?.worstArgument?.summary?.toLowerCase().includes('what')) throw new Error('Judge did not call out the weak human argument.');

if (Number(health.humanTurnTimeoutMs || 90000) <= 1000) {
  const timeoutRoom = await createHumanDebateRoom('Timeout Smoke Host');
  await api(`/api/rooms/${timeoutRoom.roomId}/debaters`, {
    method: 'POST',
    headers: { 'X-Host-Token': timeoutRoom.hostToken },
    body: { debaterA: { kind: 'human', playerId: timeoutRoom.humanPlayerId }, debaterB: { kind: 'ai', personaId: 'product_manager' } },
  });
  const timeoutOdds = await api(`/api/rooms/${timeoutRoom.roomId}/odds`, { method: 'POST', headers: { 'X-Host-Token': timeoutRoom.hostToken }, body: {} });
  const timeoutMarketId = timeoutOdds.room.markets[0]?.id;
  if (!timeoutMarketId) throw new Error('Timeout human debate room did not expose a betting market.');
  await api(`/api/rooms/${timeoutRoom.roomId}/bets`, { method: 'POST', body: { playerId: timeoutRoom.bettorPlayerId, marketId: timeoutMarketId, amount: 50 } });
  await api(`/api/rooms/${timeoutRoom.roomId}/start`, { method: 'POST', headers: { 'X-Host-Token': timeoutRoom.hostToken }, body: {} });
  const timeoutFinal = await waitForResults(timeoutRoom.roomId);
  if (!timeoutFinal.turns.some((turn) => turn.timeoutFilled && turn.source === 'ai_timeout')) throw new Error('Human turn timeout did not produce an AI fill-in transcript entry.');
}

if (Number(health.bettingWindowMs || 90000) <= 1000) {
  await runTimerBettingWindowCheck();
}

await expectApiError(`/api/rooms/${roomId}/readability`, { method: 'POST', body: { mode: 'kids' } }, 404);
await expectApiError(`/api/rooms/${roomId}/readability`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: { mode: 'kids' } }, 404);

await configureRound(roomId, hostToken, customPersona.id, 'product_manager');
await expectApiError(`/api/rooms/${roomId}/jury`, { method: 'POST', body: { playerId: created.playerId, turnId: 'missing', group: 'emoji', reactionId: 'laugh' } }, 400);
await api(`/api/rooms/${roomId}/start`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: {} });
const juryTarget = await waitForReactableTurn(roomId);
const juryVote = await api(`/api/rooms/${roomId}/jury`, { method: 'POST', body: { playerId: created.playerId, turnId: juryTarget.target.id, group: 'thumb', reactionId: 'thumb_up' } });
if (juryVote.room.juryReactions.filter((r) => r.playerId === created.playerId && r.turnId === juryTarget.target.id && r.group === 'thumb').length !== 1) throw new Error('Thumb reaction was not recorded.');
if (!juryVote.room.jury?.turns?.some((turn) => turn.turnId === juryTarget.target.id && turn.counts.thumb_up === 1 && turn.groups.thumb.thumb_up === 1)) throw new Error('Jury summary did not count the thumb reaction.');
const juryUpdate = await api(`/api/rooms/${roomId}/jury`, { method: 'POST', body: { playerId: created.playerId, turnId: juryTarget.target.id, group: 'thumb', reactionId: 'double_thumb' } });
let updatedReactions = juryUpdate.room.juryReactions.filter((r) => r.playerId === created.playerId && r.turnId === juryTarget.target.id && r.group === 'thumb');
if (updatedReactions.length !== 1 || updatedReactions[0].reactionId !== 'double_thumb') throw new Error('Thumb reaction did not update in place.');
const doubleSummary = juryUpdate.room.jury?.turns?.find((turn) => turn.turnId === juryTarget.target.id);
if (!doubleSummary || doubleSummary.counts.double_thumb !== 1 || doubleSummary.positive < 2) throw new Error('Double thumbs up did not count as a stronger positive read.');
const juryThumbOff = await api(`/api/rooms/${roomId}/jury`, { method: 'POST', body: { playerId: created.playerId, turnId: juryTarget.target.id, group: 'thumb', reactionId: 'double_thumb' } });
updatedReactions = juryThumbOff.room.juryReactions.filter((r) => r.playerId === created.playerId && r.turnId === juryTarget.target.id && r.group === 'thumb');
if (updatedReactions.length !== 0) throw new Error('Selecting the same thumb reaction did not remove it.');
await api(`/api/rooms/${roomId}/jury`, { method: 'POST', body: { playerId: created.playerId, turnId: juryTarget.target.id, group: 'thumb', reactionId: 'thumb_down' } });
const reactionStream = await openRoomEventStream(roomId);
const juryLaugh = await api(`/api/rooms/${roomId}/jury`, { method: 'POST', body: { playerId: created.playerId, turnId: juryTarget.target.id, group: 'emoji', reactionId: 'laugh' } });
try {
  await reactionStream.nextRoom((room) => room.jury?.turns?.some((turn) => turn.turnId === juryTarget.target.id && turn.groups?.emoji?.laugh === 1), 6000);
} finally {
  await reactionStream.close();
}
const juryFire = await api(`/api/rooms/${roomId}/jury`, { method: 'POST', body: { playerId: created.playerId, turnId: juryTarget.target.id, group: 'emoji', reactionId: 'fire' } });
if (juryFire.room.juryReactions.filter((r) => r.playerId === created.playerId && r.turnId === juryTarget.target.id && r.group === 'emoji').length !== 2) throw new Error('Independent emoji reactions were not both recorded.');
const juryLaughOff = await api(`/api/rooms/${roomId}/jury`, { method: 'POST', body: { playerId: created.playerId, turnId: juryTarget.target.id, group: 'emoji', reactionId: 'laugh' } });
const remainingEmoji = juryLaughOff.room.juryReactions.filter((r) => r.playerId === created.playerId && r.turnId === juryTarget.target.id && r.group === 'emoji');
if (remainingEmoji.length !== 1 || remainingEmoji[0].reactionId !== 'fire') throw new Error('Emoji reaction did not toggle independently.');
if (!juryLaugh.room.jury?.turns?.some((turn) => turn.turnId === juryTarget.target.id && turn.groups.emoji.laugh === 1)) throw new Error('Jury summary did not count emoji reactions.');
console.log('Started adult roast round. Waiting for results...');

const finalRoom = await waitForResults(roomId);
if (!finalRoom.verdict?.winnerDebaterId) throw new Error('Missing verdict.');
if (!finalRoom.settlements?.leaderboard?.length) throw new Error('Missing settlement leaderboard.');
if (!finalRoom.jury?.reactionsTotal) throw new Error('Missing jury reaction total.');
if (!finalRoom.verdict?.audienceJury?.reactionCount) throw new Error('Judge verdict did not include audience jury context.');
await expectApiError(`/api/rooms/${roomId}/jury`, { method: 'POST', body: { playerId: created.playerId, turnId: finalRoom.turns.at(-1)?.id, group: 'emoji', reactionId: 'clap' } }, 400);

if (health.mode === 'mock') {
  if (finalRoom.turns[0]?.text.includes('I will keep this clear')) throw new Error('Mock debate unexpectedly used removed simplified-audience text.');
}

console.log(`Winner: ${finalRoom.verdict.winnerName}`);
console.log(`Turns: ${finalRoom.turns.length}`);
console.log(`Leaderboard rows: ${finalRoom.settlements.leaderboard.length}`);
