import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appSource = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8'))
  .replace('initAmbientMotion();\ninit();', '')
  .concat('\nglobalThis.__app = { state, roomHtml, roundLoopState, bettingWindowState, afterStartDebateUi, resultSpotlightKey, syncActiveSectionFromViewport, bindResultReview };');

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

const { state, roomHtml, roundLoopState, bettingWindowState, afterStartDebateUi, resultSpotlightKey, syncActiveSectionFromViewport, bindResultReview } = context.__app;

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

function sectionHtml(html, className) {
  const start = html.indexOf(`<section class="${className}`);
  assert.notEqual(start, -1, `Expected section ${className}`);
  const end = html.indexOf('</section>', start);
  assert.notEqual(end, -1, `Expected section ${className} to close`);
  return html.slice(start, end);
}

const activeRoom = makeRoom();
const activeHtml = renderAsPlayer(activeRoom);
assert.equal(bettingWindowState(activeRoom).active, true);
assert.match(activeHtml, /Topic/);
assert.doesNotMatch(activeHtml, /Resolution/);
assert.doesNotMatch(activeHtml, /Resolved:/);
assert.match(activeHtml, /Bet amount/);
assert.match(activeHtml, /Place bet/);
const playerBetButton = activeHtml.match(/<button type="button" data-action="placeBet"[^>]*>Place bet<\/button>/)?.[0] || '';
assert.match(playerBetButton, /data-market-id="winner_a"/);
assert.doesNotMatch(playerBetButton, /disabled/);
assert.match(activeHtml, /Betting window/);
assert.doesNotMatch(activeHtml, /Heckle Cards/);
assert.match(activeHtml, /round-loop-mobile-progress/);
assert.match(activeHtml, /Step 3 of 6/);
assert.match(activeHtml, /aria-label="Bets"><span>Bets<\/span>/);
assert.match(activeHtml, /class="mobile-exit" data-action="leaveRoom" aria-label="Leave room"><span>Exit<\/span>/);

const hostActiveHtml = renderAsHost(activeRoom);
assert.match(hostActiveHtml, /Hosts guide the round/);
assert.doesNotMatch(hostActiveHtml, /Bet amount/);
assert.doesNotMatch(hostActiveHtml, /data-action="placeBet"/);
assert.match(hostActiveHtml, /class="mobile-exit" data-action="leaveRoom" aria-label="Leave room"><span>Exit<\/span>/);

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
assert.match(doneHtml, /aria-label="Heckle Cards"><span>Cards<\/span>/);
assert.doesNotMatch(doneHtml, /aria-label="Heckle Cards"><span>Heckle Cards<\/span>/);
assert.match(doneHtml, /Step 4 of 6/);
assert.equal((doneHtml.match(/Go to Heckle Cards/g) || []).length, 1);
assert.doesNotMatch(doneHtml, /Bets and heckles/);
assert.doesNotMatch(doneHtml, /<h3>Bets<\/h3>/);

const hostDoneHtml = renderAsHost(doneRoom);
assert.match(hostDoneHtml, /Start debate/);
assert.match(hostDoneHtml, /data-action="startDebate"/);
assert.doesNotMatch(sectionHtml(hostDoneHtml, 'role-guidance host-role'), /data-action="startDebate"/);
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

const completedTurn = {
  id: 'turn_react',
  phase: 'Opening statement',
  speakerDebaterId: 'debater_a',
  speakerName: 'Professor Steelman',
  persona: 'Formal Logician',
  sideLabel: 'For',
  text: 'This opening statement gives the audience a clear claim, a useful warrant, and a concrete example so the pinned reactions have a completed statement to target.',
};
const reactionRoom = makeRoom({
  status: 'DEBATE',
  currentPhase: 'Opening statement',
  turns: [completedTurn],
  juryReactions: [
    { playerId: 'bettor', turnId: 'turn_react', group: 'thumb', reactionId: 'thumb_up' },
    { playerId: 'bettor', turnId: 'turn_react', group: 'emoji', reactionId: 'laugh' },
    { playerId: 'bettor2', turnId: 'turn_react', group: 'emoji', reactionId: 'fire' },
  ],
  jury: {
    reactionsTotal: 3,
    groups: {
      thumb: [
        { id: 'thumb_down', group: 'thumb', emoji: '👎', label: 'Thumbs down', sentiment: 'negative', score: -1 },
        { id: 'thumb_up', group: 'thumb', emoji: '👍', label: 'Thumbs up', sentiment: 'positive', score: 1 },
        { id: 'double_thumb', group: 'thumb', emoji: '👍👍', label: 'Double thumbs up', sentiment: 'positive', score: 2 },
      ],
      emoji: [
        { id: 'laugh', group: 'emoji', emoji: '😂', label: 'Funny', sentiment: 'positive', score: 1 },
        { id: 'fire', group: 'emoji', emoji: '🔥', label: 'Fire', sentiment: 'positive', score: 1 },
        { id: 'thinking', group: 'emoji', emoji: '🤔', label: 'Thinking', sentiment: 'neutral', score: 0 },
        { id: 'clap', group: 'emoji', emoji: '👏', label: 'Applause', sentiment: 'positive', score: 1 },
        { id: 'skull', group: 'emoji', emoji: '💀', label: 'Dead', sentiment: 'positive', score: 1 },
      ],
    },
    totals: { debater_a: { positive: 3, negative: 0, neutral: 0, net: 3, total: 3 }, debater_b: { positive: 0, negative: 0, neutral: 0, net: 0, total: 0 } },
    turns: [{
      turnId: 'turn_react',
      counts: { thumb_down: 0, thumb_up: 1, double_thumb: 0, laugh: 1, fire: 1, thinking: 0, clap: 0, skull: 0 },
      groups: { thumb: { thumb_down: 0, thumb_up: 1, double_thumb: 0 }, emoji: { laugh: 1, fire: 1, thinking: 0, clap: 0, skull: 0 } },
      total: 3,
    }],
  },
});
const reactionHtml = renderAsPlayer(reactionRoom);
assert.match(reactionHtml, /class="jury-panel/);
assert.doesNotMatch(reactionHtml, /Strong logic/);
assert.match(reactionHtml, /data-reaction-group="thumb"/);
assert.match(reactionHtml, /data-reaction-id="double_thumb"/);
assert.match(reactionHtml, /data-reaction-group="emoji"/);
assert.match(reactionHtml, /class="turn-reaction thumb active"/);
assert.match(reactionHtml, /<summary><span>Emoji<\/span><b>2<\/b><\/summary>/);

state.ui.roomTab = 'chat';
const formattedChatHtml = renderAsPlayer(makeRoom({
  chatMessages: [{
    id: 'chat_one',
    playerId: 'bettor2',
    displayName: 'Formatter',
    text: '**Bold** _italic_ __under__ <script>',
    createdAt: new Date().toISOString(),
  }],
}));
assert.match(formattedChatHtml, /data-chat-format="bold"/);
assert.match(formattedChatHtml, /data-chat-emoji="😂"/);
assert.match(formattedChatHtml, /<strong>Bold<\/strong>/);
assert.match(formattedChatHtml, /<em>italic<\/em>/);
assert.match(formattedChatHtml, /<u>under<\/u>/);
assert.match(formattedChatHtml, /&lt;script&gt;/);
assert.doesNotMatch(formattedChatHtml, /<script>/);
state.ui.roomTab = 'seats';

const resultRoom = makeRoom({
  status: 'RESULTS',
  currentPhase: 'Results',
  updatedAt: '2026-05-13T12:00:00.000Z',
  verdict: {
    winnerDebaterId: 'debater_a',
    winnerName: 'Professor Steelman',
    margin: 'clear',
    confidence: 0.84,
    scores: {
      debater_a: { total: 48, logicalCoherence: 9, responsiveness: 8, rhetoricalForce: 8, humor: 7, originality: 8, topicControl: 8 },
      debater_b: { total: 42, logicalCoherence: 7, responsiveness: 7, rhetoricalForce: 7, humor: 8, originality: 7, topicControl: 6 },
    },
    bestLine: { debaterId: 'debater_a', quote: 'The cleanest frame wins.' },
    worstArgument: { debaterId: 'debater_b', summary: 'Missed the strongest premise.' },
    audienceJury: { reactionCount: 3, crowdLeaderDebaterId: 'debater_a', crowdLeaderName: 'Professor Steelman', agreedWithJudge: true, summary: 'The audience agreed with the judge.' },
    verdict: 'Professor Steelman wins with a clearer frame.',
    propResults: [],
  },
  settlements: { leaderboard: [], settledAt: '2026-05-13T12:00:01.000Z' },
  jury: reactionRoom.jury,
});
state.ui.dismissedResultSpotlightKey = '';
state.ui.resultReviewOpenKey = '';
const resultHtml = renderAsPlayer(resultRoom);
assert.match(resultHtml, /class="result-spotlight"/);
assert.match(resultHtml, /data-result-spotlight="view"/);
assert.match(resultHtml, /id="round-result"/);
const spotlightKey = resultSpotlightKey(resultRoom);
state.ui.dismissedResultSpotlightKey = spotlightKey;
const collapsedResultHtml = renderAsPlayer(resultRoom);
assert.doesNotMatch(collapsedResultHtml, /class="result-spotlight"/);
assert.match(collapsedResultHtml, /Round result/);
state.ui.resultReviewOpenKey = spotlightKey;
const openResultHtml = renderAsPlayer(resultRoom);
assert.match(openResultHtml, /<details id="round-result" class="verdict panel inset result-review" open>/);

function makeNavItem(section) {
  const classes = new Set();
  const attrs = {};
  return {
    getAttribute(name) {
      return name === 'href' && ['live', 'bets', 'room'].includes(section) ? `#${section}` : '';
    },
    hasAttribute(name) {
      return (name === 'data-toggle-chat' && section === 'chat') || (name === 'data-toggle-host' && section === 'host');
    },
    setAttribute(name, value) {
      attrs[name] = value;
    },
    removeAttribute(name) {
      delete attrs[name];
    },
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
    },
    hasClass(name) {
      return classes.has(name);
    },
  };
}

const originalGetElementById = context.document.getElementById;
const originalQuerySelectorAll = context.document.querySelectorAll;
try {
  const navItems = ['live', 'bets', 'room', 'chat', 'host'].map(makeNavItem);
  const sectionPositions = {
    live: { getBoundingClientRect: () => ({ top: 800 }) },
    bets: { getBoundingClientRect: () => ({ top: 60 }) },
    room: { getBoundingClientRect: () => ({ top: 520 }) },
  };
  root.innerHTML = 'stable mobile room html';
  state.room = activeRoom;
  state.ui.hostConsoleOpen = false;
  state.ui.roomTab = 'seats';
  state.ui.activeSection = 'live';
  context.document.getElementById = (id) => sectionPositions[id] || (id === 'root' ? root : null);
  context.document.querySelectorAll = (selector) => selector.includes('mobile-section-nav') ? navItems : [];
  syncActiveSectionFromViewport();
  assert.equal(state.ui.activeSection, 'bets');
  assert.equal(root.innerHTML, 'stable mobile room html');
  assert.equal(navItems[1].hasClass('active'), true);
  assert.equal(navItems[0].hasClass('active'), false);

  let resultToggleHandler = null;
  const fakeDetails = {
    open: true,
    addEventListener(event, handler) {
      if (event === 'toggle') resultToggleHandler = handler;
    },
  };
  context.document.getElementById = (id) => id === 'round-result' ? fakeDetails : null;
  state.room = resultRoom;
  state.ui.resultReviewOpenKey = '';
  bindResultReview();
  assert.equal(typeof resultToggleHandler, 'function');
  resultToggleHandler();
  assert.equal(state.ui.resultReviewOpenKey, spotlightKey);
  fakeDetails.open = false;
  resultToggleHandler();
  assert.equal(state.ui.resultReviewOpenKey, '');
} finally {
  context.document.getElementById = originalGetElementById;
  context.document.querySelectorAll = originalQuerySelectorAll;
}

console.log('Renderer checks passed.');
