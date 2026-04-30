const base = process.env.BASE_URL || 'http://localhost:8787';

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const response = await fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
  return data;
}

const created = await api('/api/rooms', { method: 'POST', body: { displayName: 'Smoke Host' } });
const roomId = created.room.id;
const hostToken = created.hostToken;
console.log(`Created room ${roomId}`);

await api(`/api/rooms/${roomId}/quick-demo`, {
  method: 'POST',
  headers: { 'X-Host-Token': hostToken },
  body: {},
});
console.log('Started quick demo. Waiting for results...');

let finalRoom = null;
for (let i = 0; i < 40; i++) {
  const { room } = await api(`/api/rooms/${roomId}`);
  if (room.status === 'RESULTS') {
    finalRoom = room;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

if (!finalRoom) throw new Error('Room did not reach RESULTS in time.');
if (!finalRoom.verdict?.winnerDebaterId) throw new Error('Missing verdict.');
if (!finalRoom.settlements?.leaderboard?.length) throw new Error('Missing settlement leaderboard.');
console.log(`Winner: ${finalRoom.verdict.winnerName}`);
console.log(`Turns: ${finalRoom.turns.length}`);
console.log(`Leaderboard rows: ${finalRoom.settlements.leaderboard.length}`);
