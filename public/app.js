const root = document.getElementById('root');
const storageKey = 'aiDebateCasinoSession';
const queryRoomId = new URLSearchParams(location.search).get('room')?.trim().toUpperCase() || '';

let state = {
  session: readSession(),
  access: { required: false, authenticated: true },
  room: null,
  personas: [],
  error: '',
  message: '',
  pendingAction: '',
  pollTimer: null,
  eventSource: null,
  countdownTimer: null,
};

initAmbientMotion();
init();

function initAmbientMotion() {
  const rootEl = document.documentElement;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let enabled = !reduced.matches;
  let frame = 0;
  let targetX = 0;
  let targetY = 0;

  function syncMotionPreference() {
    enabled = !reduced.matches;
    rootEl.dataset.motion = enabled ? 'ambient' : 'reduced';
    if (!enabled) {
      rootEl.style.setProperty('--parallax-x', '0px');
      rootEl.style.setProperty('--parallax-y', '0px');
      rootEl.style.setProperty('--scroll-shift', '0px');
    }
  }

  function applyMotion() {
    frame = 0;
    if (!enabled) return;
    rootEl.style.setProperty('--parallax-x', `${targetX.toFixed(2)}px`);
    rootEl.style.setProperty('--parallax-y', `${targetY.toFixed(2)}px`);
    rootEl.style.setProperty('--scroll-shift', `${(Math.min(window.scrollY || 0, 900) * -0.06).toFixed(2)}px`);
  }

  function scheduleMotion() {
    if (!frame) frame = requestAnimationFrame(applyMotion);
  }

  window.addEventListener('pointermove', (event) => {
    if (!enabled) return;
    targetX = ((event.clientX / window.innerWidth) - 0.5) * 28;
    targetY = ((event.clientY / window.innerHeight) - 0.5) * 22;
    scheduleMotion();
  }, { passive: true });

  window.addEventListener('scroll', scheduleMotion, { passive: true });
  reduced.addEventListener?.('change', syncMotionPreference);
  syncMotionPreference();
}

async function init() {
  await loadAccess();
  if (!needsAccess()) await bootstrapRoomData();
  render();
}

async function bootstrapRoomData() {
  await loadPersonas();
  if (state.session?.roomId) {
    await loadRoom();
    startLiveUpdates();
  }
}

function readSession() {
  try { return JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { return null; }
}

function writeSession(session) {
  state.session = session;
  if (session) localStorage.setItem(storageKey, JSON.stringify(session));
  else localStorage.removeItem(storageKey);
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (options.host && state.session?.hostToken) headers['X-Host-Token'] = state.session.hostToken;
  const response = await fetch(path, { method: options.method || 'GET', headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    if (response.status === 401) {
      state.access = { required: true, authenticated: false };
      stopLiveUpdates();
    }
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function loadAccess() {
  try {
    state.access = await api('/api/access');
  } catch (e) {
    state.access = { required: false, authenticated: true };
    state.error = e.message;
  }
}

function needsAccess() {
  return Boolean(state.access?.required && !state.access?.authenticated);
}

async function loadPersonas() {
  try {
    const data = await api('/api/personas');
    state.personas = data.personas || [];
  } catch (e) {
    state.error = e.message;
  }
}

async function loadRoom() {
  if (!state.session?.roomId) return;
  try {
    const data = await api(`/api/rooms/${state.session.roomId}`);
    setRoom(data.room);
  } catch (e) {
    if (e.status === 404) {
      const roomId = state.session.roomId;
      stopLiveUpdates();
      writeSession(null);
      state.room = null;
      state.error = `Saved room ${roomId} is no longer active. Start a new table or join with a fresh room code.`;
    } else {
      state.error = e.message;
    }
    render();
  }
}

function setRoom(room) {
  if (!state.room || state.room.version !== room.version) {
    state.room = room;
    render();
  } else {
    state.room = room;
  }
}

function startLiveUpdates() {
  if (!state.session?.roomId) return;
  if (state.eventSource) state.eventSource.close();
  state.eventSource = new EventSource(`/api/rooms/${state.session.roomId}/events`);
  state.eventSource.addEventListener('room', (event) => {
    try { setRoom(JSON.parse(event.data)); } catch { /* ignore */ }
  });
  state.eventSource.onerror = () => {
    if (!state.pollTimer) state.pollTimer = setInterval(loadRoom, 1600);
  };
}

function stopLiveUpdates() {
  if (state.eventSource) state.eventSource.close();
  state.eventSource = null;
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = null;
}

function render() {
  if (needsAccess()) {
    root.innerHTML = accessHtml();
    bindAccess();
    syncCountdownTimer();
    return;
  }
  if (!state.session) {
    root.innerHTML = landingHtml();
    bindLanding();
    syncCountdownTimer();
    return;
  }
  if (!state.room) {
    root.innerHTML = `<main class="shell loading-shell"><section class="panel loading-card"><div class="kicker">Table status</div><h1>Loading room ${h(state.session.roomId)}…</h1>${flashHtml()}${processingHtml(null)}</section></main>`;
    syncCountdownTimer();
    return;
  }
  root.innerHTML = roomHtml(state.room);
  bindRoom();
  syncCountdownTimer();
}

function accessHtml() {
  return `
    <main class="shell landing access-shell">
      <section class="hero casino-hero access-hero">
        <div class="marquee-band" aria-hidden="true"></div>
        <div class="hero-copy">
          <div class="casino-mark" aria-hidden="true"><span>AI</span></div>
          <div class="kicker">Invite required</div>
          <h1>AI Debate Casino</h1>
          <p class="lede">Enter the host-provided access code to open the table.</p>
        </div>
        ${flashHtml()}
        <form id="accessForm" class="form-card cashier-card access-card">
          <h2>Access code</h2>
          <label>Invite code</label>
          <input name="code" type="password" autocomplete="current-password" required autofocus />
          <button class="primary" type="submit" ${state.pendingAction ? 'disabled' : ''}>${buttonContent('accessCode', 'Enter')}</button>
        </form>
      </section>
    </main>`;
}

function landingHtml() {
  return `
    <main class="shell landing">
      <section class="hero casino-hero">
        <div class="marquee-band" aria-hidden="true"></div>
        <div class="hero-copy">
          <div class="casino-mark" aria-hidden="true"><span>AI</span></div>
          <div class="kicker">Fake chips. Real model arguments.</div>
          <h1>AI Debate Casino</h1>
          <p class="lede">A party-game sportsbook where AI personas debate ridiculous propositions and an AI judge settles the fake-chip board.</p>
        </div>
        ${flashHtml()}
        <div class="landing-grid" aria-label="Create or join a room">
          <form id="createForm" class="form-card cashier-card">
            <h2>Create a room</h2>
            <label>Your display name</label>
            <input name="displayName" value="Keith" maxlength="32" />
            <button class="primary" type="submit" ${state.pendingAction ? 'disabled' : ''}>${buttonContent('createRoom', 'Open the table')}</button>
          </form>
          <form id="joinForm" class="form-card cashier-card">
            <h2>Join a room</h2>
            <label>Room code</label>
            <input name="roomId" placeholder="ABC123" maxlength="12" value="${h(queryRoomId)}" />
            <label>Your display name</label>
            <input name="displayName" placeholder="Player name" maxlength="32" />
            <button type="submit" ${state.pendingAction ? 'disabled' : ''}>${buttonContent('joinRoom', 'Take a seat')}</button>
          </form>
        </div>
        <p class="fineprint">Fake chips only. No cash value. No prizes. No real-money wagering.</p>
      </section>
    </main>`;
}

function roomHtml(room) {
  const me = currentPlayer(room);
  const isHost = Boolean(state.session?.hostToken);
  return `
    <main class="app-shell room-shell">
      ${topBarHtml(room, me, isHost)}
      ${setupProgressHtml(room)}
      ${flashHtml()}
      ${processingHtml(room)}
      <section class="main-grid">
        <aside class="left-rail">
          ${debatersHtml(room)}
          ${leaderboardHtml(room)}
        </aside>
        <section class="stage panel" aria-label="Debate table">
          <div class="table-marker" aria-hidden="true"></div>
          ${topicHtml(room)}
          ${humanTurnHtml(room, me)}
          ${transcriptHtml(room)}
          ${verdictHtml(room)}
        </section>
        <aside class="sportsbook panel">
          ${sportsbookHtml(room, me)}
          ${hecklesHtml(room, me)}
        </aside>
      </section>
      ${isHost ? hostControlsHtml(room) : ''}
    </main>`;
}

function topBarHtml(room, me, isHost) {
  const ai = room.ai.mode === 'openai'
    ? `setup ${room.ai.setupModel} · debate ${room.ai.debateModel} · judge ${room.ai.judgeModel} · ${room.ai.debateScript || 'full'} script`
    : `mock fallback${room.ai.mockReason ? ` (${room.ai.mockReason})` : ''}`;
  return `
    <header class="topbar panel">
      <div class="topbar-cell room-cell"><div class="kicker">Room</div><div class="room-code">${h(room.id)}</div></div>
      <div class="topbar-cell"><div class="kicker">Phase</div><div class="phase"><span class="dot ${statusClass(room.status)}"></span>${h(room.currentPhase)}</div></div>
      <div class="topbar-cell"><div class="kicker">AI</div><div class="muted small">${h(ai)}</div></div>
      <div class="topbar-cell"><div class="kicker">You</div><div>${h(me?.displayName || 'Observer')} · <strong>${chips(me?.bankroll || 0)}</strong></div></div>
      <div class="top-actions">${isHost ? '<span class="host-badge">Host</span>' : ''}<button data-action="copyLink">Copy link</button><button data-action="leaveRoom">Leave</button></div>
    </header>`;
}

function setupProgressHtml(room) {
  const steps = setupProgressSteps(room);
  const activeIndex = Math.max(0, ...steps.map((step, index) => step.state === 'upcoming' ? -1 : index));
  const progress = Math.round((activeIndex / Math.max(steps.length - 1, 1)) * 100);
  return `
    <section class="setup-progress panel" aria-label="Round setup progress" style="--setup-progress:${progress}%">
      <ol class="setup-steps">
        ${steps.map((step, index) => `<li class="setup-step ${step.state}" ${step.state === 'current' ? 'aria-current="step"' : ''}><span class="setup-chip">${index + 1}</span><span class="setup-label">${h(step.label)}</span><span class="setup-status">${h(step.status)}</span></li>`).join('')}
      </ol>
    </section>`;
}

function setupProgressSteps(room) {
  const status = room.status || 'LOBBY';
  const hasTopic = Boolean(room.topic);
  const hasDebaters = (room.debaters?.length || 0) === 2;
  const hasMarkets = (room.markets?.length || 0) > 0;
  const debatersConfirmed = hasDebaters && state.message === 'Debaters assigned.';
  const bettingComplete = ['BETTING_LOCKED', 'DEBATE', 'JUDGING', 'SETTLEMENT', 'RESULTS'].includes(status);
  const debateStarted = ['DEBATE', 'JUDGING', 'SETTLEMENT', 'RESULTS'].includes(status);
  const resultsComplete = Boolean(room.verdict) || status === 'RESULTS';

  return [
    stepState('Generate / Select Topic', !hasTopic || status === 'TOPIC_SELECTION', hasTopic, 'Set', 'Active', 'Next'),
    stepState('Assign Debaters', hasTopic && !hasMarkets && !debatersConfirmed, hasDebaters, 'Assigned', 'Active', 'Next'),
    stepState('Post Odds', hasDebaters && !hasMarkets && debatersConfirmed, hasMarkets, 'Posted', 'Active', 'Next'),
    stepState('Betting Open', status === 'BETTING_OPEN', bettingComplete, 'Closed', 'Open', 'Queued'),
    stepState('Start Debate', status === 'BETTING_LOCKED', debateStarted, 'Started', 'Starting', 'Queued'),
    stepState('Results', status === 'JUDGING' || status === 'SETTLEMENT', resultsComplete, 'Complete', 'Judging', 'Pending'),
  ];
}

function stepState(label, isCurrent, isComplete, completeText, currentText, upcomingText) {
  const state = isCurrent ? 'current' : isComplete ? 'complete' : 'upcoming';
  const status = state === 'current' ? currentText : state === 'complete' ? completeText : upcomingText;
  return { label, state, status };
}

function topicHtml(room) {
  if (!room.topic) return `<div class="empty-state"><h2>No resolution yet</h2><p>The host can generate candidates, enter a custom topic, or run a one-click demo.</p></div>`;
  return `<div class="topic-card"><div class="kicker">Resolution</div><h2>${h(room.topic.resolution)}</h2><div class="topic-meta"><span>${h(room.topic.category)}</span><span>Comedy ${h(room.topic.comedyPotential)}/10</span><span>${h(room.topic.safetyRating)}</span></div></div>`;
}

function humanTurnHtml(room, me) {
  const pending = room.pendingHumanTurn;
  if (!pending) return '';
  const remaining = formatCountdown(remainingMs(pending));
  const pct = countdownPercent(pending);
  const isSpeaker = me?.id === pending.playerId;
  const heckle = pending.heckleLabel ? `<div class="human-turn-heckle"><strong>${h(pending.heckleLabel)}</strong><span>${h(pending.heckleInstruction)}</span></div>` : '';
  if (!isSpeaker) {
    return `
      <section class="human-turn panel inset waiting" aria-live="polite">
        <div class="human-turn-head"><div><div class="kicker">Human turn</div><h3>${h(pending.speakerName)} is on the clock</h3></div><div class="countdown" data-countdown>${h(remaining)}</div></div>
        <p class="muted">${h(pending.phase)} · ${h(pending.wordLimit)}</p>
        ${heckle}
        <div class="countdown-meter"><span data-countdown-meter style="width:${pct}%"></span></div>
      </section>`;
  }
  return `
    <section class="human-turn panel inset active" aria-live="polite">
      <div class="human-turn-head"><div><div class="kicker">Your turn</div><h3>${h(pending.phase)}</h3></div><div class="countdown" data-countdown>${h(remaining)}</div></div>
      <p class="muted">${h(pending.instruction)} Length: ${h(pending.wordLimit)}.</p>
      ${heckle}
      <label for="humanTurnText">Type your argument. <span data-countdown>${h(remaining)}</span> left.</label>
      <textarea id="humanTurnText" rows="6" maxlength="1400" placeholder="Type your turn here. ${h(remaining)} left before AI fill-in."></textarea>
      <div class="countdown-meter"><span data-countdown-meter style="width:${pct}%"></span></div>
      <button class="primary" data-action="submitHumanTurn" data-pending-turn-id="${h(pending.id)}">${buttonContent('submitHumanTurn', 'Submit turn')}</button>
    </section>`;
}

function debatersHtml(room) {
  const seats = room.debaters?.length
    ? room.debaters.map((d) => `<article class="debater ${d.id} ${d.kind === 'human' ? 'human-debater' : ''}"><div class="side-label">${h(d.sideLabel)}</div><h4>${h(d.displayName)}</h4><div class="muted">${h(d.archetype)}${d.kind === 'human' ? ' · Lobby player' : ''}</div><p>${h(d.tagline)}</p><div class="stance">${h(d.stance)}</div></article>`).join('')
    : '<p class="muted">Personas appear after topic selection.</p>';
  return `<section class="panel compact player-seats"><div class="kicker">Table seats</div><h3>Debaters</h3>${seats}${lobbyHtml(room)}</section>`;
}

function lobbyHtml(room) {
  const players = lobbyPlayers(room);
  const rows = players.map((player) => {
    const assigned = assignedDebaterSlotForPlayer(room, player.id);
    const badges = [
      player.isHost ? '<span class="seat-badge">Host</span>' : '',
      player.id === state.session?.playerId ? '<span class="seat-badge">You</span>' : '',
      assigned ? `<span class="seat-badge active">${h(assigned)}</span>` : '',
    ].filter(Boolean).join('');
    return `<li><span class="lobby-name">${h(player.displayName)}</span><span class="lobby-badges">${badges}</span></li>`;
  }).join('');
  return `<div class="lobby-subsection"><div class="kicker">Lobby</div>${rows ? `<ul>${rows}</ul>` : '<p class="muted small">No lobby players yet.</p>'}</div>`;
}

function lobbyPlayers(room) {
  return (room.players || []).filter((p) => !p.isBot);
}

function assignedDebaterSlotForPlayer(room, playerId) {
  const debater = (room.debaters || []).find((d) => d.kind === 'human' && d.playerId === playerId);
  return debater ? debater.sideLabel : '';
}

function transcriptHtml(room) {
  const turns = [...(room.turns || []), ...(room.streamingTurn ? [{ ...room.streamingTurn, streaming: true }] : [])];
  if (!turns.length) return `<section class="transcript empty-transcript"><h3>Transcript</h3><p class="muted">Debate turns will appear here as the match progresses.</p></section>`;
  return `<section class="transcript"><h3>Live transcript</h3>${turns.map(turnHtml).join('')}</section>`;
}

function turnHtml(t) {
  const body = t.text ? formattedTextHtml(t.text) : '<p class="typing-placeholder">Preparing response...</p>';
  return `<article class="turn ${t.speakerDebaterId} ${t.streaming ? 'streaming-turn' : ''}"><div class="turn-head"><span class="phase-chip">${h(t.phase)}</span><strong>${h(t.speakerName)}</strong><span class="muted">${h(t.persona)} · ${h(t.sideLabel)}</span>${turnSourceHtml(t)}${t.heckleLabel ? `<span class="heckle-chip">${h(t.heckleLabel)}</span>` : ''}</div>${body}</article>`;
}

function turnSourceHtml(turn) {
  if (turn.streaming) return '<span class="source-chip streaming">Typing</span>';
  if (turn.timeoutFilled) return '<span class="source-chip timeout">AI fill-in</span>';
  if (turn.source === 'human') return '<span class="source-chip human">Typed live</span>';
  return '';
}

function verdictHtml(room) {
  if (!room.verdict) return '';
  const v = room.verdict;
  const props = v.propResults?.map((p) => {
    const market = room.markets.find((m) => m.id === p.marketId);
    return `<tr><td>${h(market?.label || p.marketId)}</td><td>${p.won ? 'Won' : 'Lost'}</td><td>${h(p.evidence)}</td></tr>`;
  }).join('') || '';
  return `
    <section class="verdict panel inset">
      <div class="winner-banner">${h(v.winnerName)} wins by ${h(v.margin)} margin</div>
      ${formattedTextHtml(v.verdict)}
      <div class="score-grid">${scoreCardHtml(room.debaters[0], v.scores?.debater_a)}${scoreCardHtml(room.debaters[1], v.scores?.debater_b)}</div>
      <div class="callouts"><div><div class="kicker">Best line</div><blockquote>${formattedTextHtml(v.bestLine?.quote || '')}</blockquote></div><div><div class="kicker">Worst argument</div>${formattedTextHtml(v.worstArgument?.summary || '')}</div></div>
      ${props ? `<h4>Prop settlement</h4><table><tbody>${props}</tbody></table>` : ''}
    </section>`;
}

function formattedTextHtml(text) {
  const blocks = textBlocks(text);
  if (!blocks.length) return '';
  return `<div class="formatted-text">${blocks.map((block) => {
    if (block.type === 'ol') return `<ol>${block.items.map((item) => `<li>${h(item)}</li>`).join('')}</ol>`;
    if (block.type === 'ul') return `<ul>${block.items.map((item) => `<li>${h(item)}</li>`).join('')}</ul>`;
    return `<p>${h(block.text)}</p>`;
  }).join('')}</div>`;
}

function textBlocks(text) {
  const normalized = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+(\d{1,2})[.)]\s+/g, '\n$1. ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) return [];
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  const blocks = [];
  let paragraph = [];
  let list = null;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'p', text: paragraph.join(' ') });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(list);
    list = null;
  };
  for (const line of lines) {
    const ordered = line.match(/^(\d{1,2})[.)]\s+(.+)$/);
    const unordered = line.match(/^[-*]\s+(.+)$/);
    if (ordered || unordered) {
      flushParagraph();
      const type = ordered ? 'ol' : 'ul';
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push(ordered ? ordered[2] : unordered[1]);
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

function scoreCardHtml(debater, score = {}) {
  if (!debater) return '';
  const rows = [['Logic', score.logicalCoherence], ['Response', score.responsiveness], ['Force', score.rhetoricalForce], ['Humor', score.humor], ['Originality', score.originality], ['Control', score.topicControl]];
  return `<div class="score-card ${debater.id}"><h4>${h(debater.displayName)}</h4><div class="score-total">${h(score.total || 0)}</div>${rows.map(([label, value]) => `<div class="score-row"><span>${label}</span><meter min="0" max="10" value="${Number(value || 0)}"></meter><b>${h(value || 0)}</b></div>`).join('')}</div>`;
}

function sportsbookHtml(room, me) {
  const myBets = room.bets.filter((b) => b.userId === me?.id);
  const humanDebater = humanDebaterForCurrentPlayer(room, me);
  const canBet = room.status === 'BETTING_OPEN' && !humanDebater;
  if (!room.markets?.length) return `<div class="kicker">Sportsbook</div><h3>Betting window</h3><p class="muted">The Oddsmaker has not posted lines yet.</p><p class="fineprint">Fake chips only. No cash value.</p>`;
  return `
    <div class="kicker">Sportsbook</div>
    <h3>Betting window</h3>
    <div class="bet-status ${room.status === 'BETTING_OPEN' ? 'open' : 'closed'}">${room.status === 'BETTING_OPEN' ? 'Betting open' : 'Betting locked / closed'}</div>
    ${humanDebater ? `<p class="bet-blocked">You are debating as ${h(humanDebater.sideLabel)}. Human debaters cannot bet in their own round.</p>` : ''}
    <label>Bet amount</label><input id="betAmount" type="number" min="10" max="500" step="10" value="100" ${canBet ? '' : 'disabled'} />
    <div class="markets">${room.markets.map((m) => `<article class="market-card"><div class="market-title">${h(m.label)}</div><div class="odds">${Number(m.odds).toFixed(2)}x</div><p>${h(m.rationale)}</p><small>${h(m.settleRule)}</small><button data-action="placeBet" data-market-id="${h(m.id)}" ${canBet ? '' : 'disabled'}>Bet</button></article>`).join('')}</div>
    <section class="my-bets"><h4>My bets</h4>${myBets.length ? `<table><tbody>${myBets.map((b) => `<tr><td>${h(b.marketLabel)}</td><td>${chips(b.amount)}</td><td>${h(b.status)}</td><td>${b.net === null ? '' : signedChips(b.net)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No active bets.</p>'}</section>
    <p class="fineprint">Fake chips only. No cash value. No real-money wagering.</p>`;
}

function humanDebaterForCurrentPlayer(room, me) {
  return (room.debaters || []).find((d) => d.kind === 'human' && d.playerId === me?.id) || null;
}

function hecklesHtml(room, me) {
  if (!room.markets?.length) return '';
  const allowed = ['BETTING_OPEN', 'BETTING_LOCKED', 'DEBATE'].includes(room.status);
  const pending = room.heckles.filter((x) => x.status === 'pending' || x.status === 'queued');
  return `
    <section class="heckles">
      <h3>Heckle cards</h3>
      <p class="muted small">Spend 25 fake chips to force the next debater to satisfy a constraint.</p>
      <div class="heckle-grid">${(room.heckleCards || []).map((c) => `<button data-action="submitHeckle" data-card-id="${h(c.id)}" ${allowed && (me?.bankroll || 0) >= c.cost ? '' : 'disabled'}><strong>${h(c.label)}</strong><span>${h(c.cost)} chips</span></button>`).join('')}</div>
      ${pending.length ? `<div class="pending-heckles"><div class="kicker">Pending</div>${pending.map((x) => `<span>${h(x.label)} by ${h(x.displayName)}</span>`).join('')}</div>` : ''}
    </section>`;
}

function leaderboardHtml(room) {
  const rows = room.settlements?.leaderboard || [...room.players].sort((a, b) => b.bankroll - a.bankroll || a.displayName.localeCompare(b.displayName)).map((p, idx) => ({ rank: idx + 1, userId: p.id, ...p }));
  return `<section class="panel compact leaderboard"><div class="kicker">House board</div><h3>Leaderboard</h3><table><tbody>${rows.map((p) => `<tr class="${p.userId === state.session?.playerId || p.id === state.session?.playerId ? 'me-row' : ''}"><td>${h(p.rank)}</td><td>${h(p.displayName)}${p.isBot ? ' <span class="bot">bot</span>' : ''}</td><td>${chips(p.bankroll)}</td></tr>`).join('')}</tbody></table></section>`;
}

function hostControlsHtml(room) {
  const canEdit = !['DEBATE', 'JUDGING', 'SETTLEMENT'].includes(room.status) && !room.running;
  return `
    <section class="host-controls pit-console">
      <div class="section-head"><div><div class="kicker">Host controls</div><h2>Pit boss console</h2></div><div class="button-row"><button data-action="quickDemo" class="primary" ${room.running ? 'disabled' : ''}>One-click demo round</button><button data-action="startDebate" ${room.status === 'BETTING_OPEN' && !room.running ? '' : 'disabled'}>Start debate</button><button data-action="resetRoom" ${room.running ? 'disabled' : ''}>Reset</button><button data-action="resetBankrolls" ${room.running ? 'disabled' : ''}>Reset bankrolls</button></div></div>
      <div class="host-grid">
        <div class="control-card"><h3>1. Topic</h3><textarea id="topicPrompt" rows="3" placeholder="Optional flavor: workplace absurdism, business parody, animal politics…" ${canEdit ? '' : 'disabled'}></textarea><button data-action="generateTopics" ${canEdit ? '' : 'disabled'}>Generate topic candidates</button><label>Custom resolution</label><input id="customTopic" placeholder="Resolved: The office microwave is a sovereign nation." ${canEdit ? '' : 'disabled'} /><button data-action="setCustomTopic" ${canEdit ? '' : 'disabled'}>Use custom topic</button><div class="topic-list">${(room.topics || []).map((t) => `<article class="mini-topic ${room.topic?.id === t.id ? 'selected' : ''}"><strong>${h(t.resolution)}</strong><div class="muted">${h(t.category)} · Comedy ${h(t.comedyPotential)}/10</div><button data-action="selectTopic" data-topic-id="${h(t.id)}" ${canEdit ? '' : 'disabled'}>Select</button></article>`).join('')}</div></div>
        <div class="control-card"><h3>2. Debaters + odds</h3>${debaterSlotSelectHtml('debaterA', room.debaters?.[0], room, canEdit)}${debaterSlotSelectHtml('debaterB', room.debaters?.[1], room, canEdit)}<button id="assignDebatersButton" data-action="setPersonas" ${room.topic && canEdit ? '' : 'disabled'}>Assign debaters</button><button data-action="postOdds" ${room.topic && room.debaters?.length === 2 && canEdit ? '' : 'disabled'}>Post odds</button><button data-action="demoFill" ${room.status === 'BETTING_OPEN' ? '' : 'disabled'}>Demo-fill audience + bets</button><div class="custom-debater-box"><h4>Create debater</h4><label>Debater name</label><input id="customPersonaName" maxlength="48" placeholder="Madame Tax Volcano" ${canEdit ? '' : 'disabled'} /><label>Profile / personality</label><textarea id="customPersonaProfile" rows="3" maxlength="600" placeholder="A furious accountant who treats every argument like an audit with fireworks." ${canEdit ? '' : 'disabled'}></textarea><button data-action="createCustomDebater" ${canEdit ? '' : 'disabled'}>Generate draft</button>${customPersonaDraftHtml(room.pendingCustomPersona, canEdit)}</div></div>
        <div class="control-card"><h3>3. Run sheet</h3>${readabilityControlHtml(room, canEdit)}<ol><li>Generate/select a topic.</li><li>Assign personas.</li><li>Post fake-chip odds.</li><li>Let humans or demo bots bet.</li><li>Start debate.</li></ol><p class="fineprint">The one-click button handles all setup and starts the round.</p></div>
      </div>
    </section>`;
}

function readabilityControlHtml(room, canEdit) {
  const mode = room.readabilityMode === 'kids' ? 'kids' : 'classic';
  return `
    <div class="audience-control">
      <label>Audience</label>
      <div class="segmented-control" role="group" aria-label="Audience readability">
        <button data-action="setReadability" data-mode="classic" class="${mode === 'classic' ? 'active' : ''}" aria-pressed="${mode === 'classic'}" ${canEdit ? '' : 'disabled'}>Classic</button>
        <button data-action="setReadability" data-mode="kids" class="${mode === 'kids' ? 'active' : ''}" aria-pressed="${mode === 'kids'}" ${canEdit ? '' : 'disabled'}>Kids</button>
      </div>
    </div>`;
}

function debaterSlotSelectHtml(id, debater, room, canEdit) {
  const selected = debaterSelectionValue(debater) || `ai:${personasForRoom(room)[id === 'debaterA' ? 0 : 1]?.id || ''}`;
  const aiOptions = personasForRoom(room).map((p) => `<option value="ai:${h(p.id)}" ${selected === `ai:${p.id}` ? 'selected' : ''}>${h(personaLabel(p))}</option>`).join('');
  const lobbyOptions = lobbyPlayers(room).map((p) => {
    const suffix = [p.isHost ? 'Host' : '', p.id === state.session?.playerId ? 'You' : ''].filter(Boolean).join(', ');
    return `<option value="human:${h(p.id)}" ${selected === `human:${p.id}` ? 'selected' : ''}>${h(p.displayName)}${suffix ? ` (${h(suffix)})` : ''}</option>`;
  }).join('');
  return `<label>${id === 'debaterA' ? 'Debater A' : 'Debater B'}</label><select id="${id}" data-role="debater-slot" ${canEdit ? '' : 'disabled'}><optgroup label="AI debaters">${aiOptions}</optgroup><optgroup label="Lobby">${lobbyOptions}</optgroup></select>`;
}

function debaterSelectionValue(debater) {
  if (!debater) return '';
  if (debater.kind === 'human' && debater.playerId) return `human:${debater.playerId}`;
  if (debater.personaId) return `ai:${debater.personaId}`;
  return '';
}

function personasForRoom(room) {
  return [...state.personas, ...((room?.customPersonas || []))];
}

function parseDebaterSelection(value) {
  const [kind, id] = String(value || '').split(':');
  if (kind === 'ai' && id) return { kind, personaId: id };
  if (kind === 'human' && id) return { kind, playerId: id };
  throw new Error('Choose one AI debater and one lobby player.');
}

function isMixedDebaterSelection(a, b) {
  try {
    const slots = [parseDebaterSelection(a), parseDebaterSelection(b)];
    return slots.filter((slot) => slot.kind === 'human').length === 1 && slots.filter((slot) => slot.kind === 'ai').length === 1;
  } catch {
    return false;
  }
}

function syncDebaterAssignmentButton() {
  const button = document.getElementById('assignDebatersButton');
  if (!button || button.disabled && !state.room?.topic) return;
  const a = document.getElementById('debaterA')?.value;
  const b = document.getElementById('debaterB')?.value;
  const locked = state.room?.running || ['DEBATE', 'JUDGING', 'SETTLEMENT'].includes(state.room?.status);
  button.disabled = !state.room?.topic || locked || !isMixedDebaterSelection(a, b);
}

function personaLabel(persona) {
  const displayName = String(persona?.displayName || '').trim();
  const archetype = String(persona?.archetype || '').trim();
  if (!archetype || normalizePersonaLabelPart(displayName) === normalizePersonaLabelPart(archetype)) return displayName || archetype;
  return `${displayName} — ${archetype}`;
}

function customPersonaDraftHtml(persona, canEdit) {
  if (!persona) return '';
  return `
    <article class="custom-debater-draft">
      <div class="kicker">Draft review</div>
      <h4>${h(personaLabel(persona))}</h4>
      <p>${h(persona.tagline || '')}</p>
      <div class="draft-field"><strong>Style</strong><span>${h(persona.style || '')}</span></div>
      <div class="draft-field"><strong>Strengths</strong><span>${h((persona.strengths || []).join(', '))}</span></div>
      <div class="draft-field"><strong>Weaknesses</strong><span>${h((persona.weaknesses || []).join(', '))}</span></div>
      <div class="button-row draft-actions"><button data-action="acceptCustomDebater" ${canEdit ? '' : 'disabled'}>Accept debater</button><button data-action="discardCustomDebater" ${canEdit ? '' : 'disabled'}>Discard</button></div>
    </article>`;
}

function normalizePersonaLabelPart(value) {
  return String(value || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function processingHtml(room) {
  const status = processingState(room);
  if (!status.active) return '';
  return `
    <section class="processing-strip panel" role="status" aria-live="polite">
      <div class="spinner" aria-hidden="true"></div>
      <div class="processing-copy">
        <div class="processing-title">${h(status.title)}</div>
        <div class="muted small">${h(status.detail)}</div>
      </div>
      <div class="processing-meter" aria-hidden="true"><span style="width:${status.progress}%"></span></div>
    </section>`;
}

function processingState(room) {
  if (state.pendingAction) {
    return { active: true, title: actionLabel(state.pendingAction), detail: 'Waiting for the model-backed server step to finish.', progress: processingProgress(room) };
  }
  if (!room || !room.running) return { active: false, title: '', detail: '', progress: 0 };
  if (room.status === 'DEBATE') return { active: true, title: 'AI debate in progress', detail: room.currentPhase, progress: processingProgress(room) };
  if (room.status === 'JUDGING') return { active: true, title: 'Judge is deliberating', detail: 'Scoring arguments and settling prop markets.', progress: processingProgress(room) };
  if (room.status === 'SETTLEMENT') return { active: true, title: 'Settling the board', detail: 'Calculating payouts and ranking the leaderboard.', progress: processingProgress(room) };
  return { active: true, title: 'AI is setting up the round', detail: room.currentPhase || 'Preparing the next step.', progress: processingProgress(room) };
}

function processingProgress(room) {
  if (!room) return 12;
  if (room.status === 'LOBBY') return 8;
  if (room.status === 'TOPIC_SELECTION') return 18;
  if (room.status === 'PERSONA_SELECTION') return 32;
  if (room.status === 'BETTING_OPEN') return 45;
  if (room.status === 'BETTING_LOCKED') return 52;
  if (room.status === 'DEBATE') {
    const expectedTurns = room.ai?.debateScript === 'fast' ? 6 : 10;
    return clamp(54 + ((room.turns?.length || 0) / expectedTurns) * 32, 54, 86);
  }
  if (room.status === 'JUDGING') return 90;
  if (room.status === 'SETTLEMENT') return 96;
  if (room.status === 'RESULTS') return 100;
  return 15;
}

function flashHtml() {
  return `${state.error ? `<div class="flash error">${h(state.error)}</div>` : ''}${state.message ? `<div class="flash success">${h(state.message)}</div>` : ''}`;
}

function bindAccess() {
  document.getElementById('accessForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await runAction('accessCode', async () => {
      state.access = await api('/api/access', { method: 'POST', body: { code: form.get('code') } });
      await bootstrapRoomData();
      state.message = 'Access granted.';
    });
  });
}

function bindLanding() {
  document.getElementById('createForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await runAction('createRoom', async () => {
      const data = await api('/api/rooms', { method: 'POST', body: { displayName: form.get('displayName') } });
      writeSession({ roomId: data.room.id, playerId: data.playerId, hostToken: data.hostToken, displayName: form.get('displayName') || 'Host' });
      state.room = data.room;
      state.message = 'Room created.';
      startLiveUpdates();
    });
  });
  document.getElementById('joinForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const roomId = String(form.get('roomId') || '').trim().toUpperCase();
    await runAction('joinRoom', async () => {
      const data = await api(`/api/rooms/${roomId}/join`, { method: 'POST', body: { displayName: form.get('displayName') } });
      writeSession({ roomId: data.room.id, playerId: data.playerId, hostToken: '', displayName: form.get('displayName') || 'Player' });
      state.room = data.room;
      state.message = 'Joined room.';
      startLiveUpdates();
    });
  });
}

function bindRoom() {
  markPendingControls();
  for (const el of document.querySelectorAll('[data-action]')) {
    el.addEventListener('click', async (event) => {
      await handleAction(event.currentTarget.dataset.action, { marketId: event.currentTarget.dataset.marketId, topicId: event.currentTarget.dataset.topicId, cardId: event.currentTarget.dataset.cardId, mode: event.currentTarget.dataset.mode, pendingTurnId: event.currentTarget.dataset.pendingTurnId });
    });
  }
  for (const select of document.querySelectorAll('[data-role="debater-slot"]')) {
    select.addEventListener('change', syncDebaterAssignmentButton);
  }
  syncDebaterAssignmentButton();
}

async function handleAction(action, payload = {}) {
  const roomId = state.session?.roomId;
  if (!roomId) return;
  const roomPath = `/api/rooms/${roomId}`;
  if (action === 'leaveRoom') {
    stopLiveUpdates();
    writeSession(null);
    state.room = null;
    render();
    return;
  }
  if (action === 'copyLink') {
    const url = `${location.origin}/?room=${roomId}`;
    try { await navigator.clipboard.writeText(url); } catch { /* ignore */ }
    state.message = `Room link copied: ${url}`;
    state.error = '';
    render();
    return;
  }
  const inputs = {
    topicPrompt: document.getElementById('topicPrompt')?.value || '',
    customTopic: document.getElementById('customTopic')?.value || '',
    customPersonaName: document.getElementById('customPersonaName')?.value || '',
    customPersonaProfile: document.getElementById('customPersonaProfile')?.value || '',
    debaterA: document.getElementById('debaterA')?.value,
    debaterB: document.getElementById('debaterB')?.value,
    humanTurnText: document.getElementById('humanTurnText')?.value || '',
    betAmount: Number(document.getElementById('betAmount')?.value || 100),
  };
  await runAction(action, async () => {
    let data;
    switch (action) {
      case 'generateTopics': data = await api(`${roomPath}/topics/generate`, { method: 'POST', host: true, body: { prompt: inputs.topicPrompt } }); state.message = 'Topic candidates generated.'; break;
      case 'selectTopic': data = await api(`${roomPath}/topic`, { method: 'POST', host: true, body: { topicId: payload.topicId } }); state.message = 'Topic selected.'; break;
      case 'setCustomTopic': data = await api(`${roomPath}/topic`, { method: 'POST', host: true, body: { customTopic: inputs.customTopic } }); state.message = 'Custom topic selected.'; break;
      case 'setReadability': data = await api(`${roomPath}/readability`, { method: 'POST', host: true, body: { mode: payload.mode } }); state.message = `Audience set to ${payload.mode === 'kids' ? 'Kids' : 'Classic'}.`; break;
      case 'setPersonas': data = await api(`${roomPath}/debaters`, { method: 'POST', host: true, body: { debaterA: parseDebaterSelection(inputs.debaterA), debaterB: parseDebaterSelection(inputs.debaterB) } }); state.message = 'Debaters assigned.'; break;
      case 'createCustomDebater':
        validateCustomDebaterInputs(inputs.customPersonaName, inputs.customPersonaProfile);
        data = await api(`${roomPath}/personas/custom`, { method: 'POST', host: true, body: { name: inputs.customPersonaName, profile: inputs.customPersonaProfile } });
        state.message = `${data.persona?.displayName || 'Custom debater'} draft generated.`;
        break;
      case 'acceptCustomDebater':
        data = await api(`${roomPath}/personas/custom/accept`, { method: 'POST', host: true, body: {} });
        state.message = `${data.persona?.displayName || 'Custom debater'} accepted.`;
        break;
      case 'discardCustomDebater':
        data = await api(`${roomPath}/personas/custom/discard`, { method: 'POST', host: true, body: {} });
        state.message = 'Custom debater draft discarded.';
        break;
      case 'postOdds': data = await api(`${roomPath}/odds`, { method: 'POST', host: true, body: {} }); state.message = 'Odds posted.'; break;
      case 'demoFill': data = await api(`${roomPath}/demo-fill`, { method: 'POST', host: true, body: {} }); state.message = 'Demo audience added.'; break;
      case 'quickDemo': data = await api(`${roomPath}/quick-demo`, { method: 'POST', host: true, body: {} }); state.message = 'One-click demo started.'; break;
      case 'startDebate': data = await api(`${roomPath}/start`, { method: 'POST', host: true, body: {} }); state.message = 'Debate started.'; break;
      case 'resetRoom': data = await api(`${roomPath}/reset`, { method: 'POST', host: true, body: { keepBankroll: true } }); state.message = 'Room reset.'; break;
      case 'resetBankrolls': data = await api(`${roomPath}/reset`, { method: 'POST', host: true, body: { keepBankroll: false } }); state.message = 'Room and bankrolls reset.'; break;
      case 'placeBet': data = await api(`${roomPath}/bets`, { method: 'POST', body: { playerId: state.session.playerId, marketId: payload.marketId, amount: inputs.betAmount } }); state.message = 'Bet placed.'; break;
      case 'submitHumanTurn':
        validateHumanTurnInput(inputs.humanTurnText);
        data = await api(`${roomPath}/turns/human`, { method: 'POST', body: { playerId: state.session.playerId, pendingTurnId: payload.pendingTurnId || state.room?.pendingHumanTurn?.id, text: inputs.humanTurnText } });
        state.message = 'Turn submitted.';
        break;
      case 'submitHeckle': data = await api(`${roomPath}/heckles`, { method: 'POST', body: { playerId: state.session.playerId, cardId: payload.cardId } }); state.message = 'Heckle card bought.'; break;
      default: return;
    }
    if (data?.room) state.room = data.room;
  });
}

function validateCustomDebaterInputs(name, description) {
  const cleanName = String(name || '').replace(/\s+/g, ' ').trim();
  const cleanDescription = String(description || '').replace(/\s+/g, ' ').trim();
  if (cleanName.length < 2 || cleanName.length > 48) throw new Error('Debater name must be 2-48 characters.');
  if (cleanDescription.length < 10 || cleanDescription.length > 600) throw new Error('Debater description must be 10-600 characters.');
}

function validateHumanTurnInput(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 2) throw new Error('Type your turn before submitting.');
  if (clean.length > 1400) throw new Error('Human turn must be 1,400 characters or fewer.');
}

function markPendingControls() {
  if (!state.pendingAction) return;
  for (const button of document.querySelectorAll('button[data-action]')) {
    const action = button.dataset.action;
    if (!['copyLink', 'leaveRoom'].includes(action)) button.disabled = true;
    if (action === state.pendingAction) button.innerHTML = buttonContent(action, actionLabel(action));
  }
}

function buttonContent(action, label) {
  if (state.pendingAction !== action) return h(label);
  return `<span class="button-spinner" aria-hidden="true"></span><span>${h(label)}</span>`;
}

function actionLabel(action) {
  const labels = {
    accessCode: 'Checking invite',
    createRoom: 'Opening the table',
    joinRoom: 'Taking a seat',
    generateTopics: 'Generating topics',
    selectTopic: 'Selecting topic',
    setCustomTopic: 'Normalizing topic',
    setReadability: 'Updating audience',
    setPersonas: 'Assigning debaters',
    createCustomDebater: 'Generating draft',
    acceptCustomDebater: 'Accepting debater',
    discardCustomDebater: 'Discarding draft',
    postOdds: 'Posting odds',
    demoFill: 'Adding demo audience',
    quickDemo: 'Starting demo round',
    startDebate: 'Starting debate',
    resetRoom: 'Resetting room',
    resetBankrolls: 'Resetting bankrolls',
    placeBet: 'Placing bet',
    submitHumanTurn: 'Submitting turn',
    submitHeckle: 'Buying heckle card',
  };
  return labels[action] || 'Working';
}

async function runAction(action, fn) {
  state.error = '';
  state.message = '';
  state.pendingAction = action;
  render();
  try {
    await fn();
  } catch (e) {
    state.error = e.message || 'Action failed.';
  } finally {
    state.pendingAction = '';
    render();
  }
}

function syncCountdownTimer() {
  const hasPending = Boolean(state.room?.pendingHumanTurn);
  if (hasPending && !state.countdownTimer) {
    state.countdownTimer = setInterval(updateCountdownDisplay, 500);
  }
  if (!hasPending && state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
  updateCountdownDisplay();
}

function updateCountdownDisplay() {
  const pending = state.room?.pendingHumanTurn;
  if (!pending) return;
  const remaining = formatCountdown(remainingMs(pending));
  const pct = countdownPercent(pending);
  for (const el of document.querySelectorAll('[data-countdown]')) {
    el.textContent = remainingMs(pending) <= 0 ? 'Time expired' : remaining;
  }
  for (const el of document.querySelectorAll('[data-countdown-meter]')) {
    el.style.width = `${pct}%`;
  }
  const textarea = document.getElementById('humanTurnText');
  if (textarea && !textarea.value) textarea.placeholder = `${remaining} left before AI fill-in. Type your turn here.`;
}

function remainingMs(pending) {
  return Math.max(0, Date.parse(pending?.expiresAt || '') - Date.now());
}

function countdownPercent(pending) {
  const start = Date.parse(pending?.startedAt || '');
  const end = Date.parse(pending?.expiresAt || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return remainingMs(pending) > 0 ? 100 : 0;
  return clamp((remainingMs(pending) / (end - start)) * 100, 0, 100);
}

function formatCountdown(ms) {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function currentPlayer(room) { return room.players.find((p) => p.id === state.session?.playerId) || room.players[0]; }
function statusClass(status) { if (status === 'BETTING_OPEN') return 'green'; if (['DEBATE', 'JUDGING', 'SETTLEMENT'].includes(status)) return 'gold'; if (status === 'RESULTS') return 'blue'; if (status === 'ERROR') return 'red'; return 'gray'; }
function chips(value) { return `${Number(value || 0).toLocaleString()} chips`; }
function signedChips(value) { const n = Number(value || 0); return `${n >= 0 ? '+' : ''}${n.toLocaleString()}`; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function h(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
