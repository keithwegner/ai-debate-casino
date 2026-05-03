const base = process.env.BASE_URL || 'http://localhost:8787';

async function apiRaw(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const response = await fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
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

function normalizePersonaLabelPart(value) {
  return String(value || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function waitForResults(roomId) {
  for (let i = 0; i < 40; i++) {
    const { room } = await api(`/api/rooms/${roomId}`);
    if (room.status === 'RESULTS') return room;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Room ${roomId} did not reach RESULTS in time.`);
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

const health = await api('/api/health');
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
const created = await api('/api/rooms', { method: 'POST', body: { displayName: 'Smoke Host' } });
const roomId = created.room.id;
const hostToken = created.hostToken;
if (created.room.readabilityMode !== 'classic') throw new Error('New room did not default to classic readability.');
console.log(`Created room ${roomId}`);

await expectApiError(`/api/rooms/${roomId}/personas/custom`, { method: 'POST', body: { name: 'Madame Tax Volcano', profile: 'A furious accountant who treats every claim like an audit with fireworks.' } }, 403);
await expectApiError(`/api/rooms/${roomId}/personas/custom`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: { name: '', profile: '' } }, 400);
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
