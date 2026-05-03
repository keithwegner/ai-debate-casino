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

async function assertRedisRoomSnapshot(roomId, namespace) {
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

async function waitForStreamingTurn(roomId) {
  for (let i = 0; i < 120; i++) {
    const { room } = await api(`/api/rooms/${roomId}`);
    if (room.streamingTurn?.text) return room;
    if (room.status === 'RESULTS') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Room ${roomId} did not expose an active streaming turn.`);
}

async function waitForPendingHumanTurn(roomId) {
  for (let i = 0; i < 400; i++) {
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
      : `Human smoke turn ${submitted.length + 1}: ${pending.phase} supports the microwave office with clear reasons, a callback, and a practical example.`;
    await api(`/api/rooms/${roomId}/turns/human`, {
      method: 'POST',
      body: { playerId, pendingTurnId: pending.id, text },
    });
    submitted.push(text);
  }
  throw new Error(`Room ${roomId} did not finish after submitted human turns.`);
}

async function configureRound(roomId, hostToken, personaAId = 'formal_logician', personaBId = 'product_manager') {
  await api(`/api/rooms/${roomId}/topic`, {
    method: 'POST',
    headers: { 'X-Host-Token': hostToken },
    body: { customTopic: 'Resolved: The office microwave should get its own office.' },
  });
  const assigned = await api(`/api/rooms/${roomId}/personas`, {
    method: 'POST',
    headers: { 'X-Host-Token': hostToken },
    body: { personaAId, personaBId },
  });
  if (assigned.room.debaters[0]?.personaId !== personaAId) throw new Error(`Debater A was not assigned to ${personaAId}.`);
  if (assigned.room.debaters[1]?.personaId !== personaBId) throw new Error(`Debater B was not assigned to ${personaBId}.`);
  await api(`/api/rooms/${roomId}/odds`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: {} });
  await api(`/api/rooms/${roomId}/demo-fill`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: {} });
}

async function runConfiguredRound(mode = 'classic') {
  const created = await api('/api/rooms', { method: 'POST', body: { displayName: `Smoke Host ${mode}` } });
  const roomId = created.room.id;
  const hostToken = created.hostToken;
  if (created.room.readabilityMode !== 'classic') throw new Error('New room did not default to classic readability.');
  if (mode !== 'classic') {
    const updated = await api(`/api/rooms/${roomId}/readability`, {
      method: 'POST',
      headers: { 'X-Host-Token': hostToken },
      body: { mode },
    });
    if (updated.room.readabilityMode !== mode) throw new Error(`Readability did not update to ${mode}.`);
  }
  await configureRound(roomId, hostToken);
  await api(`/api/rooms/${roomId}/start`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: {} });
  return { roomId, hostToken };
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

const health = await api('/api/health');
if (typeof health.transcriptStreamCps !== 'number') throw new Error('Health payload did not expose transcript streaming speed.');
if (typeof health.debateBotPauseMs !== 'number') throw new Error('Health payload did not expose debate bot pause.');
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
  const streamingRun = await runConfiguredRound('classic');
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
if (created.room.readabilityMode !== 'classic') throw new Error('New room did not default to classic readability.');
if (health.persistence?.mode === 'redis') await assertRedisRoomSnapshot(roomId, health.persistence.namespace || 'ai-debate-casino');
console.log(`Created room ${roomId}`);

await expectApiError(`/api/rooms/${roomId}/personas/custom`, { method: 'POST', body: { name: 'Madame Tax Volcano', description: 'A furious accountant who treats every claim like an audit with fireworks.' } }, 403);
await expectApiError(`/api/rooms/${roomId}/personas/custom`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: { name: '', description: '' } }, 400);
const customDraft = await api(`/api/rooms/${roomId}/personas/custom`, {
  method: 'POST',
  headers: { 'X-Host-Token': hostToken },
  body: { name: 'Madame Tax Volcano', profile: 'A furious accountant who treats every claim like an audit with fireworks.' },
});
const customPersona = customDraft.persona;
if (!customPersona?.id?.startsWith('custom_')) throw new Error('Custom debater did not receive a custom id.');
if (customPersona.displayName !== 'Madame Tax Volcano') throw new Error('Custom debater did not preserve submitted name.');
if (customDraft.room.customPersonas.some((p) => p.id === customPersona.id)) throw new Error('Custom debater draft was accepted before review.');
if (customDraft.room.pendingCustomPersona?.id !== customPersona.id) throw new Error('Custom debater draft was not stored for review.');

await api(`/api/rooms/${roomId}/topic`, {
  method: 'POST',
  headers: { 'X-Host-Token': hostToken },
  body: { customTopic: 'Resolved: The office microwave should get its own office.' },
});
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
await api(`/api/rooms/${humanRoom.roomId}/odds`, { method: 'POST', headers: { 'X-Host-Token': humanRoom.hostToken }, body: {} });
await expectApiError(`/api/rooms/${humanRoom.roomId}/bets`, { method: 'POST', body: { playerId: humanRoom.humanPlayerId, marketId: 'winner_a', amount: 50 } }, 400);
await api(`/api/rooms/${humanRoom.roomId}/bets`, { method: 'POST', body: { playerId: humanRoom.bettorPlayerId, marketId: 'winner_a', amount: 50 } });
await api(`/api/rooms/${humanRoom.roomId}/start`, { method: 'POST', headers: { 'X-Host-Token': humanRoom.hostToken }, body: {} });
const submittedHuman = await submitHumanTurnsUntilResults(humanRoom.roomId, humanRoom.humanPlayerId);
if (!submittedHuman.submitted.length) throw new Error('No human turns were submitted.');
for (const text of submittedHuman.submitted) {
  if (!submittedHuman.room.turns.some((turn) => turn.source === 'human' && turn.text === text)) throw new Error(`Submitted human turn missing from transcript: ${text}`);
}

const weakRoom = await createHumanDebateRoom('Weak Human Smoke Host');
await api(`/api/rooms/${weakRoom.roomId}/debaters`, {
  method: 'POST',
  headers: { 'X-Host-Token': weakRoom.hostToken },
  body: { debaterA: { kind: 'human', playerId: weakRoom.humanPlayerId }, debaterB: { kind: 'ai', personaId: 'corporate_lawyer' } },
});
await api(`/api/rooms/${weakRoom.roomId}/odds`, { method: 'POST', headers: { 'X-Host-Token': weakRoom.hostToken }, body: {} });
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
  await api(`/api/rooms/${timeoutRoom.roomId}/odds`, { method: 'POST', headers: { 'X-Host-Token': timeoutRoom.hostToken }, body: {} });
  await api(`/api/rooms/${timeoutRoom.roomId}/start`, { method: 'POST', headers: { 'X-Host-Token': timeoutRoom.hostToken }, body: {} });
  const timeoutFinal = await waitForResults(timeoutRoom.roomId);
  if (!timeoutFinal.turns.some((turn) => turn.timeoutFilled && turn.source === 'ai_timeout')) throw new Error('Human turn timeout did not produce an AI fill-in transcript entry.');
}

await expectApiError(`/api/rooms/${roomId}/readability`, { method: 'POST', body: { mode: 'kids' } }, 403);
await expectApiError(`/api/rooms/${roomId}/readability`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: { mode: 'graduate-school' } }, 400);
const readable = await api(`/api/rooms/${roomId}/readability`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: { mode: 'kids' } });
if (readable.room.readabilityMode !== 'kids') throw new Error('Host could not set kids readability.');

await configureRound(roomId, hostToken, customPersona.id, 'product_manager');
await api(`/api/rooms/${roomId}/start`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: {} });
await expectApiError(`/api/rooms/${roomId}/readability`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: { mode: 'classic' } }, 409);
console.log('Started kids readability round. Waiting for results...');

const finalRoom = await waitForResults(roomId);
if (finalRoom.readabilityMode !== 'kids') throw new Error('Final room did not preserve kids readability.');
if (!finalRoom.verdict?.winnerDebaterId) throw new Error('Missing verdict.');
if (!finalRoom.settlements?.leaderboard?.length) throw new Error('Missing settlement leaderboard.');

if (health.mode === 'mock') {
  if (!finalRoom.turns[0]?.text.includes('I will keep this clear')) throw new Error('Kids mock debate did not use simpler readability text.');
  if (!finalRoom.verdict.verdict.includes('easier to follow')) throw new Error('Kids mock judge did not use simpler readability text.');
  const classicRun = await runConfiguredRound('classic');
  const classicRoom = await waitForResults(classicRun.roomId);
  if (classicRoom.turns[0]?.text === finalRoom.turns[0]?.text) throw new Error('Mock debate text did not change between classic and kids readability.');
}

console.log(`Winner: ${finalRoom.verdict.winnerName}`);
console.log(`Turns: ${finalRoom.turns.length}`);
console.log(`Leaderboard rows: ${finalRoom.settlements.leaderboard.length}`);
