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

async function waitForResults(roomId) {
  for (let i = 0; i < 40; i++) {
    const { room } = await api(`/api/rooms/${roomId}`);
    if (room.status === 'RESULTS') return room;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Room ${roomId} did not reach RESULTS in time.`);
}

async function configureRound(roomId, hostToken) {
  await api(`/api/rooms/${roomId}/topic`, {
    method: 'POST',
    headers: { 'X-Host-Token': hostToken },
    body: { customTopic: 'Resolved: The office microwave should get its own office.' },
  });
  await api(`/api/rooms/${roomId}/personas`, {
    method: 'POST',
    headers: { 'X-Host-Token': hostToken },
    body: { personaAId: 'formal_logician', personaBId: 'product_manager' },
  });
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
const created = await api('/api/rooms', { method: 'POST', body: { displayName: 'Smoke Host' } });
const roomId = created.room.id;
const hostToken = created.hostToken;
if (created.room.readabilityMode !== 'classic') throw new Error('New room did not default to classic readability.');
console.log(`Created room ${roomId}`);

await expectApiError(`/api/rooms/${roomId}/readability`, { method: 'POST', body: { mode: 'kids' } }, 403);
await expectApiError(`/api/rooms/${roomId}/readability`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: { mode: 'graduate-school' } }, 400);
const readable = await api(`/api/rooms/${roomId}/readability`, { method: 'POST', headers: { 'X-Host-Token': hostToken }, body: { mode: 'kids' } });
if (readable.room.readabilityMode !== 'kids') throw new Error('Host could not set kids readability.');

await configureRound(roomId, hostToken);
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
