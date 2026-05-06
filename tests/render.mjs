import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appSource = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8'))
  .replace('initAmbientMotion();\ninit();', '')
  .concat('\nglobalThis.__app = { state, roomHtml, roundLoopState, bettingWindowState };');

const root = { innerHTML: '' };
const context = {
  console,
  document: {
    documentElement: { dataset: {}, style: { setProperty() {} } },
    getElementById(id) {
      return id === 'root' ? root : null;
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
  },
  location: { search: '', origin: 'http://localhost:8787' },
  localStorage: {
    getItem() { return null; },
    setItem() {},
    removeItem() {},
  },
  window: {
    matchMedia() { return { matches: true, addEventListener() {} }; },
    addEventListener() {},
    innerHeight: 900,
    innerWidth: 1200,
    scrollY: 0,
  },
  EventSource: class {},
  FormData: class {},
  URLSearchParams,
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
  requestAnimationFrame(fn) { return setTimeout(fn, 0); },
  cancelAnimationFrame(id) { clearTimeout(id); },
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(appSource, context, { filename: 'public/app.js' });

const { state, roomHtml, roundLoopState, bettingWindowState } = context.__app;

function makeRoom(overrides = {}) {
  const openedAt = Date.now() - 10_000;
  const closesAt = Date.now() + 80_000;
  return {
    id: 'ROOM42',
    status: 'BETTING_OPEN',
    currentPhase: 'Betting open',
    phaseStartedAt: new Date(openedAt).toISOString(),
    createdAt: new Date(openedAt).toISOString(),
    updatedAt: new Date(openedAt).toISOString(),
    version: 1,
    ai: { mode: 'mock', mockReason: 'test', setupModel: 'mock', debateModel: 'mock', judgeModel: 'mock', debateScript: 'fast', transcriptStreamCps: 500, botPauseMs: 0 },
    players: [
      { id: 'host', displayName: 'Host', bankroll: 1000, isHost: true, isBot: false },
      { id: 'bettor', displayName: 'Bettor', bankroll: 1000, isHost: false, isBot: false },
      { id: 'bettor2', displayName: 'Bettor Two', bankroll: 1000, isHost: false, isBot: false },
    ],
    topics: [],
    topicVote: { open: false, submissions: [], votes: [], counts: [], totalVotes: 0 },
    topic: { id: 'topic', resolution: 'Resolved: UI tests should be readable.', sideA: 'For', sideB: 'Against', category: 'testing', comedyPotential: 7, safetyRating: 'safe' },
    debaters: [
      { id: 'debater_a', kind: 'ai', personaId: 'formal_logician', displayName: 'Professor Steelman', archetype: 'Formal Logician', tagline: 'Precise.', sideLabel: 'For', stance: 'For' },
      { id: 'debater_b', kind: 'ai', personaId: 'product_manager', displayName: 'Roadmap Rhonda', archetype: 'Product Manager', tagline: 'Aligned.', sideLabel: 'Against', stance: 'Against' },
    ],
    customPersonas: [],
    pendingCustomPersona: null,
    markets: [
      { id: 'winner_a', label: 'Professor Steelman wins', type: 'winner', targetDebaterId: 'debater_a', odds: 1.8, rationale: 'Cleaner logic.', settleRule: 'Wins if judge picks Professor Steelman.' },
      { id: 'winner_b', label: 'Roadmap Rhonda wins', type: 'winner', targetDebaterId: 'debater_b', odds: 2.1, rationale: 'More punch.', settleRule: 'Wins if judge picks Roadmap Rhonda.' },
    ],
    bets: [],
    bettingWindow: { openedAt: new Date(openedAt).toISOString(), closesAt: new Date(closesAt).toISOString(), durationMs: 90_000, remainingMs: 80_000, done: false, doneReason: '', eligibleCount: 2, bettedCount: 1 },
    heckles: [],
    heckleCards: [{ id: 'pirate_analogy', label: 'Pirate Analogy', cost: 25, instruction: 'Use a pirate analogy.' }],
    chatMessages: [],
    juryReactions: [],
    jury: { options: [], reactionsTotal: 0, totals: {} },
    turns: [],
    streamingTurn: null,
    pendingHumanTurn: null,
    verdict: null,
    settlements: null,
    running: false,
    error: null,
    ...overrides,
  };
}

function renderAsPlayer(room) {
  state.session = { roomId: room.id, playerId: 'bettor', hostToken: '', displayName: 'Bettor' };
  return roomHtml(room);
}

function renderAsHost(room) {
  state.session = { roomId: room.id, playerId: 'host', hostToken: 'host_token', displayName: 'Host' };
  return roomHtml(room);
}

const activeRoom = makeRoom();
const activeHtml = renderAsPlayer(activeRoom);
assert.equal(bettingWindowState(activeRoom).active, true);
assert.match(activeHtml, /Bet amount/);
assert.match(activeHtml, /Place bet/);
assert.match(activeHtml, /Betting window/);
assert.doesNotMatch(activeHtml, /Heckle Codes/);

const doneRoom = makeRoom({
  bettingWindow: { ...activeRoom.bettingWindow, done: true, doneReason: 'all_bettors_ready', bettedCount: 2 },
  bets: [{ id: 'bet', userId: 'bettor', marketLabel: 'Professor Steelman wins', amount: 50, status: 'pending', net: null }],
});
const doneHtml = renderAsPlayer(doneRoom);
assert.equal(roundLoopState(doneRoom, doneRoom.players[1], false).current.id, 'debate');
assert.doesNotMatch(doneHtml, /Bet amount/);
assert.doesNotMatch(doneHtml, /Place bet/);
assert.doesNotMatch(doneHtml, /My bets/);
assert.match(doneHtml, /Heckle Codes/);
assert.match(doneHtml, />Heckles</);

const hostDoneHtml = renderAsHost(doneRoom);
assert.match(hostDoneHtml, /Start debate/);
assert.doesNotMatch(hostDoneHtml, /Start unlocks in/);

const judgingRoom = makeRoom({
  status: 'JUDGING',
  currentPhase: 'Judge deliberation',
  bettingWindow: null,
  running: true,
});
const judgingHtml = renderAsPlayer(judgingRoom);
assert.doesNotMatch(judgingHtml, /Bet amount/);
assert.doesNotMatch(judgingHtml, /Place bet/);
assert.doesNotMatch(judgingHtml, /Heckle Codes/);
assert.match(judgingHtml, /Closed for judging/);

console.log('Renderer checks passed.');
