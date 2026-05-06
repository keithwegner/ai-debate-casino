import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appSource = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8'))
  .replace('initAmbientMotion();\ninit();', '')
  .concat('\nglobalThis.__app = { state, roomHtml, roundLoopState, bettingWindowState, afterStartDebateUi };');

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

const { state, roomHtml, roundLoopState, bettingWindowState, afterStartDebateUi } = context.__app;

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
assert.match(activeHtml, /Topic/);
assert.doesNotMatch(activeHtml, /Resolution/);
assert.doesNotMatch(activeHtml, /Resolved:/);
assert.match(activeHtml, /Bet amount/);
assert.match(activeHtml, /Place bet/);
assert.match(activeHtml, /Betting window/);
assert.doesNotMatch(activeHtml, /Heckle Cards/);

const hostActiveHtml = renderAsHost(activeRoom);
assert.match(hostActiveHtml, /Hosts guide the round/);
assert.doesNotMatch(hostActiveHtml, /Bet amount/);
assert.doesNotMatch(hostActiveHtml, /data-action="placeBet"/);

const doneRoom = makeRoom({
  bettingWindow: { ...activeRoom.bettingWindow, done: true, doneReason: 'all_bettors_ready', bettedCount: 2 },
  bets: [{ id: 'bet', userId: 'bettor', marketLabel: 'Professor Steelman wins', amount: 50, status: 'pending', net: null }],
});
const doneHtml = renderAsPlayer(doneRoom);
assert.equal(roundLoopState(doneRoom, doneRoom.players[1], false).current.id, 'debate');
assert.doesNotMatch(doneHtml, /Bet amount/);
assert.doesNotMatch(doneHtml, /Place bet/);
assert.doesNotMatch(doneHtml, /My bets/);
assert.match(doneHtml, /aria-label="Heckle Cards"/);
assert.match(doneHtml, />Heckle Cards</);
assert.doesNotMatch(doneHtml, /Bets and heckles/);
assert.doesNotMatch(doneHtml, /<h3>Bets<\/h3>/);

const hostDoneHtml = renderAsHost(doneRoom);
assert.match(hostDoneHtml, /Start debate/);
assert.match(hostDoneHtml, /data-action="startDebate"/);
assert.doesNotMatch(hostDoneHtml, /Start unlocks in/);
assert.doesNotMatch(hostDoneHtml, /Watch live debate/);
assert.doesNotMatch(hostDoneHtml, /Debate is queued/);

const hostDoneWithHeckleHtml = renderAsHost(makeRoom({
  bettingWindow: { ...activeRoom.bettingWindow, done: true, doneReason: 'no_eligible_bettors', eligibleCount: 0, bettedCount: 0 },
  heckles: [{ id: 'heckle', playerId: 'host', displayName: 'Host', cardId: 'pirate_analogy', label: 'Pirate Analogy', cost: 25, status: 'pending' }],
}));
assert.match(hostDoneWithHeckleHtml, /Queued now/);
assert.match(hostDoneWithHeckleHtml, /Pirate Analogy by Host/);
assert.match(hostDoneWithHeckleHtml, /1 queued/);

const lockedRoom = makeRoom({
  status: 'BETTING_LOCKED',
  currentPhase: 'Starting debate',
  bettingWindow: null,
  running: true,
});
const hostLockedHtml = renderAsHost(lockedRoom);
const playerLockedHtml = renderAsPlayer(lockedRoom);
assert.match(hostLockedHtml, /Debate is queued/);
assert.match(hostLockedHtml, /Watch live debate/);
assert.match(playerLockedHtml, /Debate is queued|Debate is starting/);
assert.match(playerLockedHtml, /Go to live|Watch live/);

state.ui.hostConsoleOpen = true;
state.ui.hostConsoleScrollTop = 48;
state.ui.activeSection = 'host';
state.ui.roomTab = 'chat';
state.ui.chatOpen = true;
state.ui.scrollToLiveAfterRender = false;
afterStartDebateUi();
assert.equal(state.ui.hostConsoleOpen, false);
assert.equal(state.ui.hostConsoleScrollTop, 0);
assert.equal(state.ui.activeSection, 'live');
assert.equal(state.ui.roomTab, 'seats');
assert.equal(state.ui.chatOpen, false);
assert.equal(state.ui.scrollToLiveAfterRender, true);

const judgingRoom = makeRoom({
  status: 'JUDGING',
  currentPhase: 'Judge deliberation',
  bettingWindow: null,
  running: true,
});
const judgingHtml = renderAsPlayer(judgingRoom);
assert.doesNotMatch(judgingHtml, /Bet amount/);
assert.doesNotMatch(judgingHtml, /Place bet/);
assert.doesNotMatch(judgingHtml, /Heckle Cards/);
assert.match(judgingHtml, /Closed for judging/);

console.log('Renderer checks passed.');
