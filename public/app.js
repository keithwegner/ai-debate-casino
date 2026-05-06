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
  ui: {
    hostConsoleOpen: false,
    hostConsoleScrollTop: 0,
    topicSuggestionDraft: '',
    chatOpen: false,
    chatDraft: '',
    chatScrollTop: 0,
    chatStickToBottom: true,
    roomTab: 'seats',
    activeSection: 'live',
    navScrollBound: false,
    navFrame: 0,
    bettingExpiryRenderKey: '',
    scrollToLiveAfterRender: false,
  },
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
  else {
    localStorage.removeItem(storageKey);
    resetHostConsoleState();
    resetChatState();
  }
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
  const previous = state.room;
  if (!previous || previous.version !== room.version) {
    if (canPatchStreamingTurn(previous, room)) {
      state.room = room;
      patchStreamingTurn(room.streamingTurn);
      return;
    }
    state.room = room;
    render();
  } else {
    state.room = room;
  }
}

function canPatchStreamingTurn(previous, next) {
  if (!previous || !next?.streamingTurn || !previous.streamingTurn) return false;
  if (previous.id !== next.id || previous.status !== next.status || previous.currentPhase !== next.currentPhase) return false;
  if (previous.streamingTurn.id !== next.streamingTurn.id) return false;
  const previousTurns = previous.turns || [];
  const nextTurns = next.turns || [];
  if (previousTurns.length !== nextTurns.length) return false;
  return previousTurns.every((turn, index) => turn.id === nextTurns[index]?.id);
}

function patchStreamingTurn(turn) {
  const body = document.querySelector(`[data-turn-body="${turn.id}"]`);
  if (!body) {
    render();
    return;
  }
  const text = body.querySelector('[data-streaming-text]');
  if (!text) {
    render();
    return;
  }
  text.textContent = turn.text || 'Preparing response...';
  text.classList.toggle('typing-placeholder', !turn.text);
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
  captureHostConsoleState();
  captureTopicVoteState();
  captureChatState();
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
  restoreHostConsoleState();
  restoreTopicVoteState();
  restoreChatState();
  syncCountdownTimer();
  syncPostRenderFocus();
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
      <section class="hero casino-hero start-hero">
        <div class="marquee-band" aria-hidden="true"></div>
        <div class="hero-copy">
          <div class="casino-mark" aria-hidden="true"><span>AI</span></div>
          <div class="kicker">Topic → Debaters → Bets → Debate → Results → Replay</div>
          <h1>Start an AI debate game</h1>
          <p class="lede">Host a room, invite players, pick a topic, bet fake chips, watch the debate, and play another round.</p>
        </div>
        ${flashHtml()}
        <div class="landing-grid landing-entry" aria-label="Host or join a room">
          <form id="createForm" class="form-card cashier-card entry-card">
            <div class="entry-number">1</div>
            <h2>Host a room</h2>
            <p>Guide the round, choose setup options, and start each phase.</p>
            <label>Your display name</label>
            <input name="displayName" value="Keith" maxlength="32" />
            <button class="primary" type="submit" ${state.pendingAction ? 'disabled' : ''}>${buttonContent('createRoom', 'Host a room')}</button>
          </form>
          <form id="joinForm" class="form-card cashier-card entry-card">
            <div class="entry-number">2</div>
            <h2>Join a room</h2>
            <p>Enter the code, vote on topics, place fake-chip bets, chat, and react.</p>
            <label>Room code</label>
            <input name="roomId" placeholder="ABC123" maxlength="12" value="${h(queryRoomId)}" />
            <label>Your display name</label>
            <input name="displayName" placeholder="Player name" maxlength="32" />
            <button type="submit" ${state.pendingAction ? 'disabled' : ''}>${buttonContent('joinRoom', 'Join room')}</button>
          </form>
        </div>
        <p class="fineprint">Fake chips only. No cash value. No prizes. No real-money wagering.</p>
      </section>
    </main>`;
}

function roomHtml(room) {
  const me = currentPlayer(room);
  const isHost = Boolean(state.session?.hostToken);
  const loop = roundLoopState(room, me, isHost);
  const liveClass = room.status === 'DEBATE' ? 'debate-live' : '';
  const sidePanelLabel = hecklesVisibleState(room) ? 'Heckle Cards' : 'Bets';
  return `
    <main class="app-shell room-shell ${liveClass}">
      ${topBarHtml(room, me, isHost)}
      ${roundLoopHtml(loop)}
      ${flashHtml()}
      ${processingHtml(room)}
      <section class="experience-grid">
        <section id="live" class="stage panel live-section" aria-label="Debate table">
          <div class="table-marker" aria-hidden="true"></div>
          ${roleGuidanceHtml(room, me, isHost, loop)}
          ${topicHtml(room, me)}
          ${humanTurnHtml(room, me)}
          ${juryHtml(room, me)}
          ${transcriptHtml(room)}
          ${verdictHtml(room)}
        </section>
        <aside id="bets" class="sportsbook panel bets-section ${betsSectionClass(room)}" aria-label="${h(sidePanelLabel)}">
          ${roundActionPanelHtml(room, me)}
        </aside>
        <aside id="room" class="room-section" aria-label="Room details">
          ${roomPanelHtml(room, me, isHost)}
        </aside>
      </section>
      ${mobileSectionNavHtml(room, isHost, loop)}
      ${isHost ? hostControlsHtml(room) : ''}
    </main>`;
}

function mobileSectionNavHtml(room, isHost, loop) {
  const active = activeNavSection();
  const betsLabel = hecklesVisibleState(room) ? 'Heckle Cards' : 'Bets';
  const items = [
    ['live', 'Live', '#live'],
    ['bets', betsLabel, '#bets'],
    ['room', 'Room', '#room'],
  ];
  return `
    <nav class="mobile-section-nav ${isHost ? 'has-host' : 'player-only'}" aria-label="Room sections">
      ${items.map(([id, label, href]) => `<a class="${active === id ? 'active' : ''}" href="${href}"><span>${h(label)}</span>${navBadgeHtml(id, loop)}</a>`).join('')}
      <button type="button" class="${active === 'chat' ? 'active' : ''}" data-toggle-chat><span>Chat</span>${navBadgeHtml('chat', loop)}</button>
      ${isHost ? `<button type="button" class="${active === 'host' ? 'active' : ''}" data-toggle-host><span>Host</span>${navBadgeHtml('host', loop)}</button>` : ''}
    </nav>`;
}

function navBadgeHtml(section, loop) {
  const current = loop.current?.id || '';
  const labels = {
    live: current === 'debate' ? 'Now' : current === 'results' ? 'Judge' : current === 'replay' ? 'Done' : '',
    bets: current === 'bets' ? 'Now' : '',
    room: ['topic', 'debaters'].includes(current) ? 'Setup' : '',
    chat: '',
    host: loop.role === 'Host' && ['topic', 'debaters', 'bets', 'replay'].includes(current) ? 'Next' : '',
  };
  return labels[section] ? `<small class="nav-badge">${h(labels[section])}</small>` : '';
}

function activeNavSection() {
  if (state.ui.hostConsoleOpen) return 'host';
  if (state.ui.roomTab === 'chat') return 'chat';
  return state.ui.activeSection || 'live';
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
      <div class="topbar-cell player-cell"><div class="kicker">You</div><div class="player-status"><span class="player-name">${h(me?.displayName || 'Observer')}</span><strong>${chips(me?.bankroll || 0)}</strong></div></div>
      <div class="top-actions">${isHost ? '<button type="button" class="host-toggle" data-toggle-host>Host</button>' : ''}<button data-action="copyLink">Copy link</button><button data-action="leaveRoom">Leave</button></div>
    </header>`;
}

function betsSectionClass(room) {
  const hasMarkets = Boolean(room.markets?.length);
  const betting = bettingWindowState(room);
  const hecklesVisible = hecklesVisibleState(room);
  return [
    hasMarkets ? 'has-markets' : 'bets-pending',
    betting.active ? 'betting-open' : 'betting-closed',
    betting.done ? 'betting-done' : '',
    hecklesVisible ? 'heckles-only' : '',
  ].join(' ');
}

function bettingWindowState(room) {
  const status = room?.status || '';
  const windowState = room?.bettingWindow || null;
  const hasMarkets = Boolean(room?.markets?.length);
  const remainingMs = bettingWindowRemainingMs(windowState);
  const doneByStatus = ['BETTING_LOCKED', 'DEBATE', 'JUDGING', 'SETTLEMENT', 'RESULTS'].includes(status);
  const expiredByClient = Boolean(status === 'BETTING_OPEN' && windowState && !windowState.done && remainingMs <= 0);
  const done = Boolean(doneByStatus || (windowState && (windowState.done || expiredByClient)));
  const active = Boolean(status === 'BETTING_OPEN' && hasMarkets && windowState && !done);
  return {
    exists: Boolean(windowState),
    active,
    done,
    expiredByClient,
    remainingMs: Math.max(0, remainingMs),
    durationMs: Number(windowState?.durationMs || 0),
    doneReason: doneByStatus && !windowState?.done ? 'debate_started' : windowState?.doneReason || (expiredByClient ? 'timer_elapsed' : ''),
    eligibleCount: Number(windowState?.eligibleCount || 0),
    bettedCount: Number(windowState?.bettedCount || 0),
    openedAt: windowState?.openedAt || '',
    closesAt: windowState?.closesAt || '',
  };
}

function bettingWindowRemainingMs(windowState) {
  if (!windowState) return 0;
  const closesAtMs = Date.parse(windowState.closesAt || '');
  if (Number.isFinite(closesAtMs)) return Math.max(0, closesAtMs - Date.now());
  const fallbackRemaining = Number(windowState.remainingMs || 0);
  return Number.isFinite(fallbackRemaining) ? Math.max(0, fallbackRemaining) : 0;
}

function bettingWindowPercent(betting) {
  if (!betting.durationMs) return betting.remainingMs > 0 ? 100 : 0;
  return clamp((betting.remainingMs / betting.durationMs) * 100, 0, 100);
}

function bettingWindowCopy(betting) {
  if (!betting.exists) return 'Betting opens when the host posts odds.';
  if (betting.active) {
    const waiting = Math.max(0, betting.eligibleCount - betting.bettedCount);
    if (!betting.eligibleCount) return 'No eligible bettors are waiting, so the host can start immediately.';
    return waiting
      ? `${waiting} ${waiting === 1 ? 'bettor still needs' : 'bettors still need'} to place a bet, or the timer can run out.`
      : 'Every eligible bettor has placed a bet.';
  }
  if (betting.doneReason === 'all_bettors_ready') return 'All eligible bettors placed a bet. Heckle Cards are open until the debate moves into judging.';
  if (betting.doneReason === 'timer_elapsed') return 'The betting timer elapsed. Heckle Cards are open until the debate moves into judging.';
  if (betting.doneReason === 'no_eligible_bettors') return 'No eligible bettors are waiting. The host can start immediately.';
  return 'Betting is closed for this round.';
}

function bettingWindowPanelHtml(betting) {
  if (!betting.exists) return '';
  return `
    <section class="betting-window ${betting.active ? 'active' : 'done'}" aria-live="polite">
      <div class="betting-window-head">
        <div><div class="kicker">Betting window</div><h4>${betting.active ? 'Place bets now' : 'Betting done'}</h4></div>
        <strong data-betting-countdown>${h(betting.active ? formatCountdown(betting.remainingMs) : 'Done')}</strong>
      </div>
      <p>${h(bettingWindowCopy(betting))}</p>
      <div class="countdown-meter"><span data-betting-countdown-meter style="width:${bettingWindowPercent(betting)}%"></span></div>
      <small>${h(betting.bettedCount)} of ${h(betting.eligibleCount)} eligible bettors ready</small>
    </section>`;
}

function hecklesVisibleState(room) {
  const betting = bettingWindowState(room);
  return Boolean(room?.markets?.length && ['BETTING_OPEN', 'BETTING_LOCKED', 'DEBATE'].includes(room.status) && (room.status !== 'BETTING_OPEN' || betting.done));
}

function roundLoopHtml(loop) {
  return `
    <section class="round-loop panel ${loop.tone}" aria-label="Round loop">
      <div class="round-loop-copy">
        <div class="kicker">${h(loop.role)} next</div>
        <h2>${h(loop.title)}</h2>
        <p>${h(loop.detail)}</p>
      </div>
      <ol class="round-loop-steps">
        ${loop.steps.map((step, index) => `<li class="round-loop-step ${step.state}" ${step.state === 'current' ? 'aria-current="step"' : ''}><span class="round-step-index">${index + 1}</span><span>${h(step.label)}</span><small>${h(step.status)}</small></li>`).join('')}
      </ol>
      ${loop.action ? `<button type="button" class="round-loop-action ${loop.action.primary ? 'primary' : ''}" ${loop.action.attrs || ''}>${h(loop.action.label)}</button>` : ''}
    </section>`;
}

function roundLoopState(room, me, isHost) {
  const status = room.status || 'LOBBY';
  const hasTopic = Boolean(room.topic);
  const hasDebaters = (room.debaters?.length || 0) === 2;
  const hasMarkets = (room.markets?.length || 0) > 0;
  const betting = bettingWindowState(room);
  const isHumanDebater = Boolean(humanDebaterForCurrentPlayer(room, me));
  const debateStarted = ['BETTING_LOCKED', 'DEBATE', 'JUDGING', 'SETTLEMENT', 'RESULTS'].includes(status);
  const debateComplete = ['JUDGING', 'SETTLEMENT', 'RESULTS'].includes(status);
  const resultsComplete = status === 'RESULTS' || Boolean(room.verdict);
  const currentId = !hasTopic
    ? 'topic'
    : !hasDebaters
      ? 'debaters'
      : !hasMarkets || betting.active
        ? 'bets'
        : ['BETTING_OPEN', 'BETTING_LOCKED', 'DEBATE'].includes(status)
          ? 'debate'
          : ['JUDGING', 'SETTLEMENT'].includes(status)
            ? 'results'
            : resultsComplete
              ? 'replay'
              : 'topic';

  const steps = [
    loopStep('topic', 'Topic', currentId, hasTopic, hasTopic ? 'Set' : 'Choose'),
    loopStep('debaters', 'Debaters', currentId, hasDebaters, hasDebaters ? 'Assigned' : 'Pick'),
    loopStep('bets', 'Bets', currentId, debateStarted || betting.done, betting.active ? 'Open' : hasMarkets ? 'Done' : 'Post'),
    loopStep('debate', 'Debate', currentId, debateComplete, status === 'DEBATE' ? 'Live' : debateStarted ? 'Queued' : 'Start'),
    loopStep('results', 'Results', currentId, resultsComplete, resultsComplete ? 'Posted' : ['JUDGING', 'SETTLEMENT'].includes(status) ? 'Judging' : 'Pending'),
    loopStep('replay', 'Replay', currentId, false, resultsComplete ? 'Ready' : 'Later'),
  ];
  const role = isHost ? 'Host' : 'Player';

  if (!hasTopic) {
    return isHost
      ? loopState({ role, steps, title: 'Choose the topic', detail: 'Generate candidates, lock the top vote, or enter a custom topic.', tone: 'setup', action: { label: 'Open topic tools', attrs: 'data-toggle-host', primary: true } })
      : loopState({ role, steps, title: room.topicVote?.open ? 'Suggest or vote on a topic' : 'Waiting for the topic', detail: room.topicVote?.open ? 'Add one topic or vote for the one you want debated.' : 'The host is setting up the round.', tone: 'setup', action: { label: 'Go to topic', attrs: 'data-scroll-target="#live"' } });
  }
  if (!hasDebaters) {
    return isHost
      ? loopState({ role, steps, title: 'Assign debaters', detail: 'Pick two AI debaters, or put one lobby player against an AI debater.', tone: 'setup', action: { label: 'Pick debaters', attrs: 'data-toggle-host', primary: true } })
      : loopState({ role, steps, title: 'Debaters are being assigned', detail: 'The topic is set. The matchup is next.', tone: 'setup' });
  }
  if (!hasMarkets) {
    return isHost
      ? loopState({ role, steps, title: 'Post odds', detail: 'Publish markets to open a 90-second fake-chip betting window.', tone: 'betting', action: { label: 'Open betting tools', attrs: 'data-toggle-host', primary: true } })
      : loopState({ role, steps, title: 'Odds are coming', detail: 'Review the matchup while the host prepares betting.', tone: 'betting', action: { label: 'Review debaters', attrs: 'data-scroll-target="#room"' } });
  }
  if (betting.active) {
    return isHost
      ? loopState({ role, steps, title: 'Betting window is open', detail: `${formatCountdown(betting.remainingMs)} left. ${bettingWindowCopy(betting)}`, tone: 'betting', action: { label: 'Watch betting', attrs: 'data-scroll-target="#bets"', primary: true } })
      : loopState({ role, steps, title: isHumanDebater ? 'Betting is open to the audience' : 'Place your bet now', detail: isHumanDebater ? 'You are debating this round, so betting is blocked for you.' : `${formatCountdown(betting.remainingMs)} left. Pick one market before betting closes.`, tone: 'betting', action: isHumanDebater ? null : { label: 'Go to bets', attrs: 'data-scroll-target="#bets"', primary: true } });
  }
  if (status === 'BETTING_OPEN' && betting.done) {
    return isHost
      ? loopState({ role, steps, title: 'Start the debate', detail: bettingWindowCopy(betting), tone: 'live', action: { label: 'Start debate', attrs: 'data-action="startDebate"', primary: true } })
      : loopState({ role, steps, title: 'Heckle Cards are open', detail: 'Betting is done. Buy a card now if you want to influence the next debater.', tone: 'live', action: { label: 'Go to Heckle Cards', attrs: 'data-scroll-target="#bets"', primary: true } });
  }
  if (status === 'BETTING_LOCKED') {
    return isHost
      ? loopState({ role, steps, title: 'Debate is starting', detail: 'Bets are locked. The live turn will appear on the stage.', tone: 'live', action: { label: 'Go to live', attrs: 'data-scroll-target="#live"' } })
      : loopState({ role, steps, title: 'Debate is queued', detail: 'Bets are locked. The live turn will appear here next.', tone: 'live', action: { label: 'Go to live', attrs: 'data-scroll-target="#live"' } });
  }
  if (status === 'DEBATE') {
    return loopState({ role, steps, title: 'Debate live', detail: isHumanDebater ? 'Watch for your turn timer and type when called.' : 'Follow the current turn and react as the audience jury.', tone: 'live', action: { label: 'Watch live', attrs: 'data-scroll-target="#live"', primary: true } });
  }
  if (status === 'JUDGING' || status === 'SETTLEMENT') {
    return loopState({ role, steps, title: 'Scoring the debate', detail: 'The judge is reviewing the transcript and resolving bets.', tone: 'judging' });
  }
  if (status === 'RESULTS') {
    return isHost
      ? loopState({ role, steps, title: 'Play another round', detail: 'Results are posted. Reset the room to keep players and start the loop again.', tone: 'results', action: { label: 'Play another round', attrs: 'data-action="resetRoom"', primary: true } })
      : loopState({ role, steps, title: 'Results are posted', detail: 'Check the verdict, stay in the room, and invite players for the next round.', tone: 'results', action: { label: 'Copy invite link', attrs: 'data-action="copyLink"' } });
  }
  return loopState({ role, steps, title: room.currentPhase || 'Room open', detail: 'The next action will appear here as setup changes.', tone: 'setup' });
}

function loopState(stateValue) {
  return { action: null, ...stateValue, current: stateValue.steps.find((step) => step.state === 'current') || stateValue.steps[0] };
}

function loopStep(id, label, currentId, complete, status) {
  const state = id === currentId ? 'current' : complete ? 'complete' : 'upcoming';
  return { id, label, state, status };
}

function roleGuidanceHtml(room, me, isHost, loop = roundLoopState(room, me, isHost)) {
  const guidance = roleGuidanceState(room, me, isHost, loop);
  return `
    <section class="role-guidance ${isHost ? 'host-role' : 'player-role'}" aria-label="${h(guidance.role)} guidance">
      <div>
        <div class="kicker">${h(guidance.role)}</div>
        <h2>${h(guidance.title)}</h2>
        <p>${h(guidance.detail)}</p>
      </div>
      <div class="role-guidance-actions">
        ${guidance.action ? `<button type="button" class="${guidance.action.primary ? 'primary' : ''}" ${guidance.action.attrs || ''}>${h(guidance.action.label)}</button>` : ''}
        <span>${h(guidance.badge)}</span>
      </div>
    </section>`;
}

function roleGuidanceState(room, me, isHost, loop) {
  const status = room.status || 'LOBBY';
  const betting = bettingWindowState(room);
  const isHumanDebater = Boolean(humanDebaterForCurrentPlayer(room, me));
  const base = isHost
    ? { role: 'Host role', badge: 'You control setup' }
    : { role: me?.id ? 'Player role' : 'Observer role', badge: me?.id ? 'You can act when unlocked' : 'Join to play' };

  if (isHost) {
    if (loop.current.id === 'topic') return { ...base, title: 'Pick the topic first', detail: 'Use topic voting if players are here, or set a custom topic and move on.', action: { label: 'Open topic tools', attrs: 'data-toggle-host', primary: true } };
    if (loop.current.id === 'debaters') return { ...base, title: 'Build the matchup', detail: 'Choose two AI debaters, or assign one player against one AI debater.', action: { label: 'Pick debaters', attrs: 'data-toggle-host', primary: true } };
    if (loop.current.id === 'bets') return { ...base, title: betting.active ? 'Let the betting window run' : 'Post odds to unlock bets', detail: betting.active ? `${formatCountdown(betting.remainingMs)} left. ${bettingWindowCopy(betting)}` : 'Odds create the fake-chip markets players can understand at a glance.', action: { label: betting.active ? 'Watch betting' : 'Post odds', attrs: betting.active ? 'data-scroll-target="#bets"' : 'data-toggle-host', primary: true } };
    if (status === 'BETTING_OPEN' && betting.done) return { ...base, title: 'Betting is done', detail: 'Heckle Cards are open now. Start the debate when ready.', action: { label: 'Start debate', attrs: 'data-action="startDebate"', primary: true } };
    if (loop.current.id === 'debate') return { ...base, title: 'The debate is live', detail: 'Monitor the stage. Human debaters will get an inline timer when it is their turn.', action: { label: 'Watch live', attrs: 'data-scroll-target="#live"' } };
    if (loop.current.id === 'results') return { ...base, title: 'Judge is resolving the round', detail: 'Results, payouts, and the audience read will appear automatically.', action: null };
    return { ...base, title: 'Replay from the same room', detail: 'Keep the players, collapse the result, and start with a new topic.', action: { label: 'Play another round', attrs: 'data-action="resetRoom"', primary: true } };
  }

  if (loop.current.id === 'topic') return { ...base, title: room.topicVote?.open ? 'Help choose the topic' : 'Wait for the host to choose', detail: room.topicVote?.open ? 'Suggest one topic, vote for one option, then watch for the lock.' : 'The host is preparing the first step.', action: { label: 'Go to topic vote', attrs: 'data-scroll-target="#live"', primary: true } };
  if (loop.current.id === 'debaters') return { ...base, title: 'Matchup is next', detail: 'The topic is locked. The host is choosing who argues each side.', action: { label: 'See room', attrs: 'data-scroll-target="#room"' } };
  if (loop.current.id === 'bets') return isHumanDebater
    ? { ...base, title: 'You are debating this round', detail: 'Betting is blocked for active debaters. Watch for your typed turn during the debate.', action: null, badge: 'Bets blocked for debaters' }
    : { ...base, title: betting.active ? 'Place a fake-chip bet' : 'Odds are almost ready', detail: betting.active ? `${formatCountdown(betting.remainingMs)} left. Pick one market before betting closes.` : 'Review the matchup while the host posts odds.', action: { label: betting.active ? 'Go to bets' : 'Review room', attrs: betting.active ? 'data-scroll-target="#bets"' : 'data-scroll-target="#room"', primary: betting.active } };
  if (status === 'BETTING_OPEN' && betting.done) return { ...base, title: 'Heckle Cards are open', detail: 'Betting is done, so the only side action left is buying a Heckle Card before judging.', action: { label: 'Go to Heckle Cards', attrs: 'data-scroll-target="#bets"', primary: true }, badge: 'Cards unlocked' };
  if (loop.current.id === 'debate') return { ...base, title: isHumanDebater ? 'Watch for your turn' : 'React while the debate runs', detail: isHumanDebater ? 'When your timer appears, type your argument before AI fill-in takes over.' : 'Read the current turn, use jury reactions, and keep chat for table talk.', action: { label: 'Watch live', attrs: 'data-scroll-target="#live"', primary: true } };
  if (loop.current.id === 'results') return { ...base, title: 'Judge is scoring', detail: 'Bets are closed. Results and payouts will appear when judging finishes.', action: null };
  return { ...base, title: 'Stay in the room for replay', detail: 'Review the result, invite more players, and wait for the host to start another round.', action: { label: 'Copy invite link', attrs: 'data-action="copyLink"' }, badge: 'Ready for replay' };
}

function topicHtml(room, me) {
  if (!room.topic) return topicVoteHtml(room, me);
  return `
    <div class="topic-card">
      <div class="kicker">Topic</div>
      <h2>${h(topicDisplayText(room.topic.resolution))}</h2>
      <div class="topic-meta"><span>${h(room.topic.category)}</span><span>Comedy ${h(room.topic.comedyPotential)}/10</span><span>${h(room.topic.safetyRating)}</span></div>
      ${topicVoteResultHtml(room.topic.voteResult)}
    </div>`;
}

function topicVoteHtml(room, me) {
  const topics = room.topics || [];
  const submission = myTopicSubmission(room, me);
  const isHost = Boolean(state.session?.hostToken);
  const canSuggest = Boolean(state.session?.playerId && me?.id && !me.isBot && !submission && !state.pendingAction);
  const canVote = Boolean(state.session?.playerId && me?.id && !me.isBot && room.topicVote?.open && !state.pendingAction);
  return `
    <section class="topic-vote panel inset" aria-label="Topic vote">
      <div class="topic-vote-head">
        <div><div class="kicker">Topic vote</div><h2>${topics.length ? 'Choose the topic' : 'No topic yet'}</h2></div>
        <div class="topic-vote-count">${h(room.topicVote?.totalVotes || 0)} votes</div>
      </div>
      <form id="topicSuggestionForm" class="topic-suggestion">
        <label for="topicSuggestion">Suggest a topic</label>
        <div class="topic-suggestion-row">
          <textarea id="topicSuggestion" rows="2" maxlength="320" placeholder="The office microwave deserves its own passport." ${canSuggest ? '' : 'disabled'}>${h(state.ui.topicSuggestionDraft)}</textarea>
          <button type="submit" class="primary" ${canSuggest ? '' : 'disabled'}>${buttonContent('submitTopicSuggestion', submission ? 'Suggested' : 'Submit')}</button>
        </div>
      </form>
      <div class="topic-vote-list">
        ${topics.length ? topics.map((topic) => topicVoteCardHtml(topic, room, me, canVote)).join('') : guidedEmptyHtml(
          isHost ? 'Generate topic candidates' : 'Waiting for topic options',
          isHost ? 'Start with generated candidates or enter a custom topic from host setup.' : 'The host is preparing topic options. You can suggest one while voting is open.',
          isHost ? '<button type="button" class="primary" data-toggle-host>Open host setup</button>' : ''
        )}
      </div>
    </section>`;
}

function guidedEmptyHtml(title, detail, actionHtml = '') {
  return `<div class="guided-empty"><div><h3>${h(title)}</h3><p>${h(detail)}</p></div>${actionHtml}</div>`;
}

function topicVoteCardHtml(topic, room, me, canVote) {
  const count = topicVoteCount(room, topic.id);
  const voted = myTopicVote(room, me)?.topicId === topic.id;
  const leading = room.topicVote?.leaderTopicId === topic.id;
  const source = topic.source === 'player' ? `Suggested by ${topic.submittedByName || 'Player'}` : 'House candidate';
  return `
    <article class="topic-vote-card ${leading ? 'leading' : ''} ${voted ? 'voted' : ''}">
      <div class="topic-vote-card-head"><span>${h(source)}</span>${leading ? '<strong>Leading</strong>' : ''}</div>
      <h3>${h(topicDisplayText(topic.resolution))}</h3>
      <div class="topic-meta"><span>${h(topic.category)}</span><span>Comedy ${h(topic.comedyPotential)}/10</span><span>${h(topic.safetyRating)}</span></div>
      <div class="topic-vote-actions">
        <span>${h(count)} ${count === 1 ? 'vote' : 'votes'}</span>
        <button data-action="voteTopic" data-topic-id="${h(topic.id)}" ${canVote ? '' : 'disabled'}>${voted ? 'Voted' : 'Vote'}</button>
      </div>
    </article>`;
}

function topicVoteResultHtml(result) {
  if (!result) return '';
  const votes = result.votes || 0;
  const text = result.mode === 'top_vote'
    ? `Won topic vote with ${votes} ${votes === 1 ? 'vote' : 'votes'}.`
    : result.mode === 'host_override'
      ? `Host override locked this topic with ${votes} ${votes === 1 ? 'vote' : 'votes'}.`
      : result.mode === 'host_custom'
        ? 'Host custom topic.'
        : '';
  return text ? `<p class="topic-vote-result">${h(text)}</p>` : '';
}

function topicVoteCount(room, topicId) {
  return room.topicVote?.counts?.find((count) => count.topicId === topicId)?.count || 0;
}

function myTopicVote(room, me) {
  return (room.topicVote?.votes || []).find((vote) => vote.playerId === me?.id) || null;
}

function myTopicSubmission(room, me) {
  return (room.topicVote?.submissions || []).find((submission) => submission.playerId === me?.id) || null;
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

function juryHtml(room, me) {
  if (!['DEBATE', 'JUDGING', 'SETTLEMENT', 'RESULTS'].includes(room.status)) return '';
  const target = juryTargetTurn(room);
  const readableTarget = target && juryTurnIsReadable(target) ? target : null;
  const hasRecordedRead = Boolean((room.jury?.reactionsTotal || 0) > 0);
  if (!readableTarget && !hasRecordedRead) return '';
  const reactions = juryReactionOptions(room);
  const existing = readableTarget ? (room.juryReactions || []).find((r) => r.playerId === me?.id && r.turnId === readableTarget.id) : null;
  const isHumanDebater = Boolean(humanDebaterForCurrentPlayer(room, me));
  const isAudienceMember = Boolean(me?.id && !me.isBot && !isHumanDebater);
  const canReact = Boolean(readableTarget && room.status === 'DEBATE' && isAudienceMember);
  const showButtons = Boolean(readableTarget && (!me?.id || isAudienceMember));
  const message = juryHelpText(room, readableTarget, me, isHumanDebater, existing, hasRecordedRead);
  return `
    <section class="jury-panel panel inset" aria-label="Audience jury">
      <div class="jury-head">
        <div><div class="kicker">Audience jury</div><h3>${readableTarget ? `React to ${h(readableTarget.speakerName)}` : 'Audience read closed'}</h3></div>
        <div class="jury-count">${h(room.jury?.reactionsTotal || 0)} reads</div>
      </div>
      ${juryMomentumHtml(room)}
      <p class="muted small">${h(message)}</p>
      ${showButtons
        ? `<div class="jury-buttons" aria-label="${h(canReact ? 'Audience reactions open' : 'Audience reactions unavailable')}">${reactions.map((reaction) => `<button data-action="submitJuryReaction" data-turn-id="${h(readableTarget?.id || '')}" data-reaction-id="${h(reaction.id)}" class="${existing?.reactionId === reaction.id ? 'active' : ''}" ${canReact ? '' : 'disabled'}>${h(reaction.label)}</button>`).join('')}</div>`
        : `<div class="jury-status">${h(message)}</div>`}
    </section>`;
}

function juryTargetTurn(room) {
  if (room.streamingTurn?.id) return room.streamingTurn;
  return [...(room.turns || [])].at(-1) || null;
}

function juryTurnIsReadable(turn) {
  const text = String(turn?.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  const wordCount = text.split(' ').filter(Boolean).length;
  return text.length >= 80 || wordCount >= 14;
}

function juryReactionOptions(room) {
  return room.jury?.options || [
    { id: 'strong_logic', label: 'Strong logic', sentiment: 'positive' },
    { id: 'funny', label: 'Funny', sentiment: 'positive' },
    { id: 'great_rebuttal', label: 'Great rebuttal', sentiment: 'positive' },
    { id: 'dodged_point', label: 'Dodged the point', sentiment: 'negative' },
    { id: 'weak_argument', label: 'Weak argument', sentiment: 'negative' },
  ];
}

function juryHelpText(room, target, me, isHumanDebater, existing, hasRecordedRead) {
  if (isHumanDebater) return 'You are debating this round, so the jury bench is for the audience.';
  if (!target) return hasRecordedRead
    ? 'Audience reactions are closed. The jury meter stays up so everyone can compare the crowd read with the judge.'
    : 'The jury stays hidden until there is a readable turn on stage.';
  if (!me?.id) return 'Join the room to sit on the audience jury.';
  if (me.isBot) return 'Automated players cannot sit on the jury.';
  if (room.status !== 'DEBATE') return 'This turn is readable, but reactions are locked while the judge and settlement finish.';
  if (existing) return `Your read: ${existing.label}. You can change it while the debate is live.`;
  return 'Audience reactions unlock once a turn is readable. One reaction per player per turn while the debate is live.';
}

function juryMomentumHtml(room) {
  const momentum = juryMomentum(room);
  const debaterA = room.debaters?.[0] || { displayName: 'For' };
  const debaterB = room.debaters?.[1] || { displayName: 'Against' };
  return `
    <div class="jury-momentum" aria-label="Audience momentum">
      <div class="jury-momentum-labels"><span>${h(debaterA.displayName || 'For')}</span><span>${h(debaterB.displayName || 'Against')}</span></div>
      <div class="jury-meter" aria-hidden="true"><span class="jury-meter-a" style="width:${momentum.pctA}%"></span><span class="jury-meter-b" style="width:${momentum.pctB}%"></span></div>
      <div class="jury-momentum-scores"><span>${h(momentum.aLabel)}</span><span>${h(momentum.bLabel)}</span></div>
    </div>`;
}

function juryMomentum(room) {
  const totals = room.jury?.totals || {};
  const a = totals.debater_a || { positive: 0, negative: 0, net: 0, total: 0 };
  const b = totals.debater_b || { positive: 0, negative: 0, net: 0, total: 0 };
  const aScore = Math.max(0, a.positive || 0) + Math.max(0, b.negative || 0);
  const bScore = Math.max(0, b.positive || 0) + Math.max(0, a.negative || 0);
  const total = aScore + bScore;
  const pctA = total ? Math.round((aScore / total) * 100) : 50;
  return {
    pctA,
    pctB: 100 - pctA,
    aLabel: `${a.net > 0 ? '+' : ''}${a.net || 0}`,
    bLabel: `${b.net > 0 ? '+' : ''}${b.net || 0}`,
  };
}

function debatersHtml(room) {
  return `<section class="panel compact player-seats"><div class="kicker">Room</div><h3>Debaters</h3>${debatersContentHtml(room)}</section>`;
}

function debatersContentHtml(room) {
  const seats = room.debaters?.length
    ? room.debaters.map((d) => `<article class="debater ${d.id} ${d.kind === 'human' ? 'human-debater' : ''}"><div class="side-label">${h(d.sideLabel)}</div><h4>${h(d.displayName)}</h4><div class="muted">${h(d.archetype)}${d.kind === 'human' ? ' · Lobby player' : ''}</div><p>${h(d.tagline)}</p><div class="stance">${h(d.stance)}</div></article>`).join('')
    : '<p class="muted">Personas appear after topic selection.</p>';
  return `${seats}${lobbyHtml(room)}`;
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
  const completedTurns = room.turns || [];
  const activeTurn = room.streamingTurn ? { ...room.streamingTurn, streaming: true } : null;
  if (!completedTurns.length && !activeTurn) {
    const isHost = Boolean(state.session?.hostToken);
    const canStart = isHost && room.status === 'BETTING_LOCKED';
    return `<section class="transcript empty-transcript">${guidedEmptyHtml(
      canStart ? 'Start the debate' : 'Transcript will appear here',
      canStart ? 'Bets are locked. Open host setup and start the debate when ready.' : 'Debate turns will stack here once the host starts the live round.',
      canStart ? '<button type="button" class="primary" data-toggle-host>Open host setup</button>' : ''
    )}</section>`;
  }
  if (activeTurn) {
    return `
      <section class="transcript live-transcript">
        <div class="live-turn-feature">
          <div class="live-turn-label"><span class="dot gold"></span><span>Current turn</span></div>
          ${turnHtml(activeTurn, room, { featured: true })}
        </div>
        ${completedTurns.length ? `<div class="completed-turns"><h3>Earlier turns</h3>${completedTurns.map((turn) => turnHtml(turn, room)).join('')}</div>` : ''}
      </section>`;
  }
  return `<section class="transcript"><h3>Live transcript</h3>${completedTurns.map((turn) => turnHtml(turn, room)).join('')}</section>`;
}

function turnHtml(t, room, options = {}) {
  const body = t.streaming ? streamingTurnBodyHtml(t.text) : (t.text ? formattedTextHtml(t.text) : '<p class="typing-placeholder">Preparing response...</p>');
  return `<article class="turn ${t.speakerDebaterId} ${t.streaming ? 'streaming-turn' : ''} ${options.featured ? 'featured-turn' : ''}" data-turn-id="${h(t.id || '')}"><div class="turn-head"><span class="phase-chip">${h(t.phase)}</span><strong>${h(t.speakerName)}</strong><span class="muted">${h(t.persona)} · ${h(t.sideLabel)}</span>${turnSourceHtml(t)}${t.heckleLabel ? `<span class="heckle-chip">${h(t.heckleLabel)}</span>` : ''}</div><div class="turn-body" data-turn-body="${h(t.id || '')}">${body}</div>${turnJuryHtml(t, room)}</article>`;
}

function turnJuryHtml(turn, room) {
  const summary = (room.jury?.turns || []).find((item) => item.turnId === turn.id);
  if (!summary?.total) return '';
  const options = juryReactionOptions(room);
  const chips = options
    .map((option) => ({ option, count: summary.counts?.[option.id] || 0 }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
  return `<div class="turn-jury">${chips.map(({ option, count }) => `<span class="${option.sentiment === 'negative' ? 'negative' : 'positive'}">${h(option.label)} ${h(count)}</span>`).join('')}</div>`;
}

function streamingTurnBodyHtml(text) {
  const hasText = Boolean(text);
  return `<p class="streaming-text ${hasText ? '' : 'typing-placeholder'}" data-streaming-text>${h(hasText ? text : 'Preparing response...')}</p>`;
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
  const body = `
      ${formattedTextHtml(v.verdict)}
      <div class="score-grid">${scoreCardHtml(room.debaters[0], v.scores?.debater_a)}${scoreCardHtml(room.debaters[1], v.scores?.debater_b)}</div>
      ${audienceVsJudgeHtml(room)}
      <div class="callouts"><div><div class="kicker">Best line</div><blockquote>${formattedTextHtml(v.bestLine?.quote || '')}</blockquote></div><div><div class="kicker">Worst argument</div>${formattedTextHtml(v.worstArgument?.summary || '')}</div></div>
      ${props ? `<h4>Bet results</h4><table><tbody>${props}</tbody></table>` : ''}`;
  if (room.status === 'RESULTS') {
    return `
      <details class="verdict panel inset result-review">
        <summary><span>Round result</span><strong>${h(v.winnerName)} wins by ${h(v.margin)} margin</strong></summary>
        <div class="winner-banner">${h(v.winnerName)} wins by ${h(v.margin)} margin</div>
        ${body}
      </details>`;
  }
  return `
    <section class="verdict panel inset">
      <div class="winner-banner">${h(v.winnerName)} wins by ${h(v.margin)} margin</div>
      ${body}
    </section>`;
}

function audienceVsJudgeHtml(room) {
  const verdict = room.verdict;
  if (!verdict) return '';
  const jury = room.jury || {};
  const official = verdict.winnerName || room.debaters.find((d) => d.id === verdict.winnerDebaterId)?.displayName || 'the judge winner';
  const leaderName = jury.crowdLeaderName || verdict.audienceJury?.crowdLeaderName || '';
  const count = jury.reactionsTotal ?? verdict.audienceJury?.reactionCount ?? 0;
  const agreed = jury.crowdLeaderDebaterId ? jury.crowdLeaderDebaterId === verdict.winnerDebaterId : verdict.audienceJury?.agreedWithJudge;
  const status = !count ? 'No jury read' : agreed ? 'Audience agreed' : leaderName ? 'Audience split' : 'No clear crowd favorite';
  const summary = count
    ? `${leaderName ? `Current audience lean: ${leaderName}. ` : ''}${verdict.audienceJury?.summary || ''}`.trim()
    : verdict.audienceJury?.summary || 'The audience did not register enough reactions to compare against the judge.';
  return `<div class="audience-verdict"><div><div class="kicker">Audience vs Judge</div><h4>${h(status)}</h4><p>${h(summary)}</p></div><div class="audience-verdict-count">${h(count)} reads</div></div>`;
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
  const humanDebater = humanDebaterForCurrentPlayer(room, me);
  const betting = bettingWindowState(room);
  const isHost = Boolean(me?.isHost);
  const canBet = room.status === 'BETTING_OPEN' && betting.active && !humanDebater && !isHost;
  const unavailable = betUnavailableReason(room, humanDebater);
  if (!room.markets?.length) {
    return `
      <div class="kicker">Bets</div>
      <h3>Bets</h3>
      ${guidedEmptyHtml(
        isHost ? 'Post odds to open betting' : 'Waiting for odds',
        isHost ? 'Assign debaters, then post odds from host setup so players can bet.' : 'The host has not posted odds yet. Betting opens after odds are published.',
        isHost ? '<button type="button" class="primary" data-toggle-host>Open host setup</button>' : ''
      )}
      <p class="fineprint">Fake chips only. No cash value.</p>`;
  }
  if (!betting.active) return '';
  return `
    <div class="kicker">Bets</div>
    <h3>Bets</h3>
    ${bettingWindowPanelHtml(betting)}
    ${unavailable ? `<p class="bet-blocked">${h(unavailable)}</p>` : ''}
    ${isHost ? '' : `<label>Bet amount</label><input id="betAmount" type="number" min="10" max="500" step="10" value="100" ${canBet ? '' : 'disabled'} />`}
    <div class="markets">${room.markets.map((m) => `<article class="market-card"><div class="market-title">${h(m.label)}</div><div class="odds">${Number(m.odds).toFixed(2)}x</div><p>${h(m.rationale)}</p><small><strong>Result rule:</strong> ${h(m.settleRule)}</small>${isHost ? '' : `<button data-action="placeBet" data-market-id="${h(m.id)}" ${canBet ? '' : 'disabled'}>Place bet</button>`}</article>`).join('')}</div>
    <p class="fineprint">Fake chips only. No cash value. No real-money wagering.</p>`;
}

function betUnavailableReason(room, humanDebater) {
  if (humanDebater) return `You are debating as ${humanDebater.sideLabel}. Human debaters cannot bet in their own round.`;
  const me = currentPlayer(room);
  if (me?.isHost) return 'Hosts guide the round. Betting is for non-host audience players.';
  const betting = bettingWindowState(room);
  if (betting.done) return 'Betting is done for this round.';
  if (room.status === 'BETTING_OPEN') return '';
  if (room.status === 'BETTING_LOCKED') return 'Betting is locked because the debate is ready to start.';
  if (['DEBATE', 'JUDGING', 'SETTLEMENT', 'RESULTS'].includes(room.status)) return 'Betting is closed for this round.';
  return 'Betting opens after the host posts odds.';
}

function humanDebaterForCurrentPlayer(room, me) {
  return (room.debaters || []).find((d) => d.kind === 'human' && d.playerId === me?.id) || null;
}

function hecklesHtml(room, me) {
  if (!hecklesVisibleState(room)) return '';
  const allowed = ['BETTING_OPEN', 'BETTING_LOCKED', 'DEBATE'].includes(room.status);
  const pending = room.heckles.filter((x) => x.status === 'pending' || x.status === 'queued');
  const isHost = Boolean(me?.isHost);
  return `
    <section class="heckles">
      <div class="kicker">Unlocked after betting</div>
      <h3>Heckle Cards</h3>
      <p class="muted small">${h(isHost ? 'Queue a test Heckle Card before starting the debate. Cards close when judging begins.' : 'Spend fake chips to force the next debater to satisfy a constraint. Cards close when judging begins.')}</p>
      ${pending.length ? `<div class="pending-heckles"><div class="kicker">Queued now</div>${pending.map((x) => `<span>${h(x.label)} by ${h(x.displayName)}</span>`).join('')}</div>` : ''}
      <div class="heckle-grid">${(room.heckleCards || []).map((c) => {
        const queuedCount = pending.filter((item) => item.cardId === c.id).length;
        const meta = queuedCount ? `${queuedCount} queued · ${c.cost} chips` : `${c.cost} chips`;
        return `<button class="${queuedCount ? 'queued' : ''}" data-action="submitHeckle" data-card-id="${h(c.id)}" ${allowed && (me?.bankroll || 0) >= c.cost ? '' : 'disabled'}><strong>${h(c.label)}</strong><span>${h(meta)}</span></button>`;
      }).join('')}</div>
    </section>`;
}

function roundActionPanelHtml(room, me) {
  const content = `${sportsbookHtml(room, me)}${hecklesHtml(room, me)}`;
  if (content.trim()) return content;
  if (room.markets?.length && ['JUDGING', 'SETTLEMENT', 'RESULTS'].includes(room.status)) {
    return `
      <section class="side-status">
        <div class="kicker">Round actions</div>
        <h3>Closed for judging</h3>
        <p class="muted small">Side actions are closed. Watch the verdict and results on the live stage.</p>
      </section>`;
  }
  return content;
}

function leaderboardHtml(room) {
  return `<section class="panel compact leaderboard"><div class="kicker">Room</div><h3>Leaderboard</h3>${leaderboardContentHtml(room)}</section>`;
}

function leaderboardContentHtml(room) {
  const rows = room.settlements?.leaderboard || [...room.players].sort((a, b) => b.bankroll - a.bankroll || a.displayName.localeCompare(b.displayName)).map((p, idx) => ({ rank: idx + 1, userId: p.id, ...p }));
  return `<table><tbody>${rows.map((p) => `<tr class="${p.userId === state.session?.playerId || p.id === state.session?.playerId ? 'me-row' : ''}"><td>${h(p.rank)}</td><td>${h(p.displayName)}${p.isBot ? ' <span class="bot">bot</span>' : ''}</td><td>${chips(p.bankroll)}</td></tr>`).join('')}</tbody></table>`;
}

function roomPanelHtml(room, me, isHost) {
  const tabs = [
    ['seats', 'Seats'],
    ['leaderboard', 'Standings'],
    ['chat', 'Chat'],
  ];
  const active = tabs.some(([id]) => id === state.ui.roomTab) ? state.ui.roomTab : 'seats';
  const content = active === 'leaderboard'
    ? `<div class="room-panel-content leaderboard">${leaderboardContentHtml(room)}</div>`
    : active === 'chat'
      ? chatHtml(room, me, isHost, true)
      : `<div class="room-panel-content player-seats">${debatersContentHtml(room)}</div>`;
  return `
    <section class="panel compact room-panel">
      <div class="room-panel-head">
        <div><div class="kicker">Room</div><h3>Room</h3></div>
        <div class="room-tabs" role="tablist" aria-label="Room sections">
          ${tabs.map(([id, label]) => `<button type="button" role="tab" data-room-tab="${id}" class="${active === id ? 'active' : ''}" aria-selected="${active === id ? 'true' : 'false'}">${h(label)}</button>`).join('')}
        </div>
      </div>
      ${content}
    </section>`;
}

function chatHtml(room, me, isHost, embedded = false) {
  const messages = room.chatMessages || [];
  const canSend = Boolean(me?.id && !me.isBot && !state.pendingAction);
  return `
    <section id="chat" class="${embedded ? 'chat-panel embedded' : `panel compact chat-panel ${state.ui.chatOpen ? 'open' : ''}`}" aria-label="Room chat">
      <div class="chat-head">
        <div><div class="kicker">Room</div><h3>Chat</h3></div>
        <div class="chat-actions">
          ${isHost ? `<button type="button" class="chat-clear" data-action="clearChat" ${messages.length ? '' : 'disabled'}>Clear</button>` : ''}
          <button type="button" class="chat-close" data-toggle-chat>Close</button>
        </div>
      </div>
      <div class="chat-list" data-chat-list>
        ${messages.length ? messages.map((message) => chatMessageHtml(message, me)).join('') : '<div class="chat-empty">No messages yet.</div>'}
      </div>
      <form id="chatForm" class="chat-form">
        <textarea id="chatText" rows="1" maxlength="500" placeholder="Message the room" ${canSend ? '' : 'disabled'}>${h(state.ui.chatDraft)}</textarea>
        <button type="submit" class="primary" ${canSend ? '' : 'disabled'}>${buttonContent('sendChatMessage', 'Send')}</button>
      </form>
    </section>`;
}

function chatMessageHtml(message, me) {
  const own = message.playerId === me?.id;
  return `
    <article class="chat-message ${own ? 'mine' : ''}">
      <div class="chat-meta"><strong>${h(message.displayName || 'Player')}</strong>${message.isHost ? '<span>Host</span>' : ''}<time>${h(formatChatTime(message.createdAt))}</time></div>
      <div class="chat-bubble">${h(message.text || '')}</div>
    </article>`;
}

function formatChatTime(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function hostControlsHtml(room) {
  const canEdit = !['DEBATE', 'JUDGING', 'SETTLEMENT'].includes(room.status) && !room.running;
  const defaultA = debaterSelectionValue(room.debaters?.[0]) || `ai:${personasForRoom(room)[0]?.id || ''}`;
  const defaultB = debaterSelectionValue(room.debaters?.[1]) || `ai:${personasForRoom(room)[1]?.id || ''}`;
  const loop = roundLoopState(room, currentPlayer(room), true);
  return `
    <details id="host-console" class="host-drawer" data-open="${state.ui.hostConsoleOpen ? 'true' : 'false'}" ${state.ui.hostConsoleOpen ? 'open' : ''}>
      <summary><span>Host setup</span><small>${h(loop.current?.label || 'Next step')}</small></summary>
      <section class="host-controls pit-console">
        <div class="host-sheet-head">
          <div><div class="kicker">Host wizard</div><h2>${h(loop.title)}</h2><p>${h(loop.detail)}</p></div>
          <button type="button" class="host-sheet-close" data-close-host>Close</button>
        </div>
        ${hostWizardHtml(room, canEdit, defaultA, defaultB, loop)}
        ${hostMaintenanceHtml(room)}
      </section>
    </details>`;
}

function hostWizardHtml(room, canEdit, defaultA, defaultB, loop) {
  const stepId = loop.current?.id || 'topic';
  const stepMap = {
    topic: {
      eyebrow: 'Step 1 of 4',
      title: 'Topic',
      detail: 'Choose the topic everyone can understand before any other setup appears.',
      body: topicControlsHtml(room, canEdit),
    },
    debaters: {
      eyebrow: 'Step 2 of 4',
      title: 'Debaters',
      detail: 'Assign the two sides. One lobby player can debate against one AI debater.',
      body: debaterControlsHtml(room, canEdit, defaultA, defaultB),
    },
    bets: {
      eyebrow: 'Step 3 of 4',
      title: 'Bets',
      detail: bettingWindowState(room).active ? 'Betting is open. The debate unlocks when the timer ends or all eligible bettors act.' : 'Post odds so players get one clear betting panel.',
      body: bettingControlsHtml(room, canEdit),
    },
    debate: {
      eyebrow: 'Step 4 of 4',
      title: 'Start',
      detail: 'The live stage owns this phase once the debate begins.',
      body: debateControlsHtml(room),
    },
    results: {
      eyebrow: 'Results',
      title: 'Judging',
      detail: 'The judge is scoring the transcript and resolving bets.',
      body: judgingControlsHtml(room),
    },
    replay: {
      eyebrow: 'Replay',
      title: 'Play another round',
      detail: 'Keep the room together and restart the loop from Topic.',
      body: replayControlsHtml(room),
    },
  };
  const step = stepMap[stepId] || stepMap.topic;
  return `
    <section class="host-wizard" aria-label="Host setup wizard">
      <ol class="host-wizard-steps">
        ${loop.steps.slice(0, 4).map((item, index) => `<li class="${item.state}"><span>${index + 1}</span><strong>${h(item.label)}</strong></li>`).join('')}
      </ol>
      <article class="host-wizard-card">
        <div class="host-wizard-card-head">
          <div><div class="kicker">${h(step.eyebrow)}</div><h3>${h(step.title)}</h3><p>${h(step.detail)}</p></div>
          <span>${h(stepId === 'replay' ? 'Ready' : stepId === 'results' ? 'Automatic' : 'One action')}</span>
        </div>
        ${step.body}
      </article>
    </section>`;
}

function topicControlsHtml(room, canEdit) {
  const voteOpen = Boolean(room.topicVote?.open && !room.topic);
  const canControl = canEdit && voteOpen;
  const hasCandidates = Boolean((room.topics || []).length);
  return `
    <div class="wizard-fields">
      <textarea id="topicPrompt" rows="3" placeholder="Optional flavor: workplace absurdism, business parody, animal politics…" ${canControl ? '' : 'disabled'}></textarea>
      <div class="button-row split-actions">
        <button class="primary" data-action="generateTopics" ${canControl ? '' : 'disabled'}>Generate topic candidates</button>
        <button data-action="closeTopicVote" ${canControl && hasCandidates ? '' : 'disabled'}>Lock top vote</button>
      </div>
      <label>Custom topic</label>
      <input id="customTopic" placeholder="The office microwave is a sovereign nation." ${canControl ? '' : 'disabled'} />
      <button data-action="setCustomTopic" ${canControl ? '' : 'disabled'}>Use custom topic</button>
      <p class="control-help">${h(topicControlHelp(room, canEdit))}</p>
      <div class="topic-list">${(room.topics || []).map((t) => `<article class="mini-topic ${room.topic?.id === t.id ? 'selected' : ''}"><strong>${h(topicDisplayText(t.resolution))}</strong><div class="muted">${h(t.category)} · ${h(topicVoteCount(room, t.id))} votes</div><button data-action="selectTopic" data-topic-id="${h(t.id)}" ${canControl ? '' : 'disabled'}>Override & lock</button></article>`).join('')}</div>
    </div>`;
}

function topicControlHelp(room, canEdit) {
  if (!canEdit) return 'Topic controls lock while a debate or judging is active.';
  if (room.topic) return 'Topic is locked for this round. Play another round to choose a new one.';
  if ((room.topics || []).length) return 'Players can vote now. Lock the top vote or override with a clear host choice.';
  return 'Generate options, let players suggest one, or type the exact topic yourself.';
}

function debaterControlsHtml(room, canEdit, defaultA, defaultB) {
  return `
    <div class="wizard-fields">
      ${debaterSlotSelectHtml('debaterA', room.debaters?.[0], room, canEdit)}
      ${debaterSlotSelectHtml('debaterB', room.debaters?.[1], room, canEdit)}
      <button id="assignDebatersButton" class="primary" data-action="setPersonas" ${room.topic && canEdit ? '' : 'disabled'}>Assign debaters</button>
      <p id="assignDebatersHelp" class="control-help">${h(debaterAssignmentHelpFromValues(defaultA, defaultB, room))}</p>
      <details class="host-advanced">
        <summary>Create a custom AI debater</summary>
        <div class="custom-debater-box">
          <label>Debater name</label>
          <input id="customPersonaName" maxlength="48" placeholder="Madame Tax Volcano" ${canEdit ? '' : 'disabled'} />
          <label>Profile / personality</label>
          <textarea id="customPersonaProfile" rows="3" maxlength="600" placeholder="A furious accountant who treats every argument like an audit with fireworks." ${canEdit ? '' : 'disabled'}></textarea>
          <button data-action="createCustomDebater" ${canEdit ? '' : 'disabled'}>Generate draft</button>
          ${customPersonaDraftHtml(room.pendingCustomPersona, canEdit)}
        </div>
      </details>
    </div>`;
}

function bettingControlsHtml(room, canEdit) {
  const canPost = Boolean(room.topic && room.debaters?.length === 2 && canEdit);
  const betting = bettingWindowState(room);
  const canStart = room.status === 'BETTING_OPEN' && betting.done && !room.running;
  return `
    <div class="wizard-fields">
      ${roundSetupSummaryHtml(room)}
      ${room.markets?.length
        ? `${bettingWindowPanelHtml(betting)}<p class="control-help ${betting.done ? 'ready' : ''}">${h(betting.done ? 'Betting is done. Start the debate when ready.' : bettingWindowCopy(betting))}</p><button class="primary" data-action="startDebate" ${canStart ? '' : 'disabled'}>${buttonContent('startDebate', betting.done ? 'Start debate' : `Start unlocks in ${formatCountdown(betting.remainingMs)}`)}</button>`
        : `<button class="primary" data-action="postOdds" ${canPost ? '' : 'disabled'}>${buttonContent('postOdds', 'Post odds')}</button><p class="control-help">${h(postOddsHelp(room, canEdit))}</p>`}
    </div>`;
}

function debateControlsHtml(room) {
  const betting = bettingWindowState(room);
  if (room.status === 'BETTING_OPEN' && betting.done && !room.running) {
    return `
    <div class="wizard-fields">
      ${roundSetupSummaryHtml(room)}
      <p class="control-help ready">${h(bettingWindowCopy(betting))}</p>
      <button class="primary" data-action="startDebate">${buttonContent('startDebate', 'Start debate')}</button>
    </div>`;
  }
  return `
    <div class="wizard-fields">
      <p class="control-help ready">${room.status === 'DEBATE' ? 'Debate is live. The stage will advance turn by turn.' : 'Debate is queued. The first live turn will appear as soon as the runner starts.'}</p>
      <button data-scroll-target="#live" class="primary">Watch live debate</button>
    </div>`;
}

function judgingControlsHtml(room) {
  return `
    <div class="wizard-fields">
      <p class="control-help ready">${h(room.currentPhase || 'Judging in progress')}. No host action is needed while scoring finishes.</p>
      <button data-scroll-target="#live">Watch results area</button>
    </div>`;
}

function replayControlsHtml(room) {
  return `
    <div class="wizard-fields">
      <p class="control-help ready">Start a fresh topic while keeping players and bankroll history in the room.</p>
      <div class="button-row split-actions">
        <button class="primary" data-action="resetRoom" ${room.running ? 'disabled' : ''}>${buttonContent('resetRoom', 'Play another round')}</button>
        <button data-action="copyLink">Copy invite link</button>
      </div>
    </div>`;
}

function roundSetupSummaryHtml(room) {
  const topic = topicDisplayText(room.topic?.resolution) || 'No topic yet';
  const debaters = room.debaters?.length === 2 ? room.debaters.map((debater) => debater.displayName).join(' vs ') : 'Debaters not assigned';
  return `<div class="round-setup-summary"><div><strong>Topic</strong><span>${h(topic)}</span></div><div><strong>Matchup</strong><span>${h(debaters)}</span></div></div>`;
}

function hostMaintenanceHtml(room) {
  return `
    <details class="host-maintenance">
      <summary>Room maintenance</summary>
      <div class="button-row split-actions">
        <button data-action="resetRoom" ${room.running ? 'disabled' : ''}>Reset round</button>
        <button data-action="resetBankrolls" ${room.running ? 'disabled' : ''}>Reset bankrolls</button>
      </div>
      <p class="control-help">Use these only when you need to restart setup or clear bankroll history.</p>
    </details>`;
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
  throw new Error('Choose two AI debaters, or one AI debater and one lobby player.');
}

function debaterAssignmentMode(slots) {
  const humanCount = slots.filter((slot) => slot.kind === 'human').length;
  const aiSlots = slots.filter((slot) => slot.kind === 'ai');
  if (aiSlots.length === 2) return aiSlots[0].personaId !== aiSlots[1].personaId ? 'ai' : '';
  if (aiSlots.length === 1 && humanCount === 1) return 'mixed';
  return '';
}

function debaterAssignmentModeFromValues(a, b) {
  try {
    const slots = [parseDebaterSelection(a), parseDebaterSelection(b)];
    return debaterAssignmentMode(slots);
  } catch {
    return '';
  }
}

function syncDebaterAssignmentButton() {
  const button = document.getElementById('assignDebatersButton');
  if (!button || button.disabled && !state.room?.topic) return;
  const a = document.getElementById('debaterA')?.value;
  const b = document.getElementById('debaterB')?.value;
  const locked = state.room?.running || ['DEBATE', 'JUDGING', 'SETTLEMENT'].includes(state.room?.status);
  button.disabled = !state.room?.topic || locked || !debaterAssignmentModeFromValues(a, b);
  const help = document.getElementById('assignDebatersHelp');
  if (help) help.textContent = debaterAssignmentHelpFromValues(a, b, state.room);
  if (help) help.classList.toggle('ready', !button.disabled);
}

function debaterAssignmentHelpFromValues(a, b, room) {
  if (!room?.topic) return 'Select or create a topic before assigning debaters.';
  if (room.running || ['DEBATE', 'JUDGING', 'SETTLEMENT'].includes(room.status)) return 'Debaters are locked while a round is running.';
  try {
    const slots = [parseDebaterSelection(a), parseDebaterSelection(b)];
    const humanCount = slots.filter((slot) => slot.kind === 'human').length;
    const aiSlots = slots.filter((slot) => slot.kind === 'ai');
    if (aiSlots.length === 2 && aiSlots[0].personaId === aiSlots[1].personaId) return 'Choose two different AI debaters.';
    if (aiSlots.length === 2) return 'Ready to assign an AI-vs-AI debate.';
    if (aiSlots.length === 1 && humanCount === 1) return 'Ready to assign a lobby player against an AI debater.';
    if (humanCount === 2) return 'V1 supports one lobby player against one AI debater.';
    return 'Choose two AI debaters, or one AI debater and one lobby player.';
  } catch {
    return 'Choose two AI debaters, or one AI debater and one lobby player.';
  }
}

function postOddsHelp(room, canEdit) {
  if (!room?.topic) return 'Choose a topic before posting odds.';
  if ((room.debaters?.length || 0) !== 2) return 'Assign both debaters before posting odds.';
  if (!canEdit) return 'Odds are locked while a round is running.';
  if (room.markets?.length) return bettingWindowCopy(bettingWindowState(room));
  return 'Ready to open a 90-second betting window for eligible audience players.';
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
  if (room.status === 'JUDGING') return { active: true, title: 'Judge is deliberating', detail: 'Scoring arguments and resolving bet results.', progress: processingProgress(room) };
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
  bindHostConsole();
  bindTopicVote();
  bindChat();
  bindSectionNav();
  for (const el of document.querySelectorAll('[data-room-tab]')) {
    el.addEventListener('click', () => {
      state.ui.roomTab = el.dataset.roomTab || 'seats';
      state.ui.chatOpen = false;
      if (state.ui.roomTab !== 'chat') state.ui.activeSection = 'room';
      render();
    });
  }
  for (const el of document.querySelectorAll('[data-toggle-host]')) {
    el.addEventListener('click', () => {
      const drawer = document.getElementById('host-console');
      const nextOpen = !(drawer?.open || state.ui.hostConsoleOpen);
      if (drawer) drawer.open = nextOpen;
      state.ui.hostConsoleOpen = nextOpen;
      state.ui.chatOpen = false;
      if (!state.ui.hostConsoleOpen) state.ui.hostConsoleScrollTop = 0;
      render();
    });
  }
  for (const el of document.querySelectorAll('[data-close-host]')) {
    el.addEventListener('click', () => {
      const drawer = document.getElementById('host-console');
      if (drawer) drawer.open = false;
      resetHostConsoleState();
      render();
    });
  }
  for (const el of document.querySelectorAll('[data-toggle-chat]')) {
    el.addEventListener('click', () => {
      state.ui.roomTab = 'chat';
      state.ui.chatOpen = false;
      const drawer = document.getElementById('host-console');
      if (drawer) drawer.open = false;
      resetHostConsoleState();
      render();
      requestAnimationFrame(() => document.getElementById('room')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    });
  }
  for (const el of document.querySelectorAll('[data-scroll-target]')) {
    el.addEventListener('click', () => {
      document.querySelector(el.dataset.scrollTarget)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  for (const el of document.querySelectorAll('[data-action]')) {
    el.addEventListener('click', async (event) => {
      await handleAction(event.currentTarget.dataset.action, { marketId: event.currentTarget.dataset.marketId, topicId: event.currentTarget.dataset.topicId, cardId: event.currentTarget.dataset.cardId, reactionId: event.currentTarget.dataset.reactionId, turnId: event.currentTarget.dataset.turnId, pendingTurnId: event.currentTarget.dataset.pendingTurnId });
    });
  }
  for (const select of document.querySelectorAll('[data-role="debater-slot"]')) {
    select.addEventListener('change', syncDebaterAssignmentButton);
  }
  syncDebaterAssignmentButton();
}

function bindSectionNav() {
  for (const el of document.querySelectorAll('.mobile-section-nav a[href^="#"]')) {
    el.addEventListener('click', () => {
      state.ui.activeSection = el.getAttribute('href').slice(1) || 'live';
      if (state.ui.roomTab === 'chat') state.ui.roomTab = 'seats';
      render();
    });
  }
  if (state.ui.navScrollBound) return;
  state.ui.navScrollBound = true;
  window.addEventListener('scroll', scheduleActiveSectionSync, { passive: true });
  window.addEventListener('resize', scheduleActiveSectionSync, { passive: true });
}

function scheduleActiveSectionSync() {
  if (state.ui.navFrame) return;
  state.ui.navFrame = requestAnimationFrame(() => {
    state.ui.navFrame = 0;
    syncActiveSectionFromViewport();
  });
}

function syncActiveSectionFromViewport() {
  if (!state.room || state.ui.hostConsoleOpen || state.ui.roomTab === 'chat') return;
  const sections = ['live', 'bets', 'room']
    .map((id) => ({ id, el: document.getElementById(id) }))
    .filter((item) => item.el);
  if (!sections.length) return;
  const anchor = Math.min(window.innerHeight * 0.32, 220);
  const current = sections
    .map((item) => ({ id: item.id, distance: Math.abs(item.el.getBoundingClientRect().top - anchor) }))
    .sort((a, b) => a.distance - b.distance)[0]?.id || 'live';
  if (current !== state.ui.activeSection) {
    state.ui.activeSection = current;
    render();
  }
}

function bindHostConsole() {
  const drawer = document.getElementById('host-console');
  if (!drawer) return;
  drawer.addEventListener('toggle', () => {
    state.ui.hostConsoleOpen = drawer.open;
    if (!drawer.open) state.ui.hostConsoleScrollTop = 0;
  });
  drawer.addEventListener('scroll', () => {
    if (drawer.open) state.ui.hostConsoleScrollTop = drawer.scrollTop;
  }, { passive: true });
}

function captureHostConsoleState() {
  const drawer = document.getElementById('host-console');
  if (!drawer) return;
  state.ui.hostConsoleOpen = drawer.open;
  state.ui.hostConsoleScrollTop = drawer.scrollTop;
}

function restoreHostConsoleState() {
  const drawer = document.getElementById('host-console');
  if (!drawer) return;
  drawer.open = state.ui.hostConsoleOpen;
  const scrollTop = state.ui.hostConsoleScrollTop;
  drawer.scrollTop = scrollTop;
  requestAnimationFrame(() => {
    drawer.scrollTop = scrollTop;
  });
}

function resetHostConsoleState() {
  state.ui.hostConsoleOpen = false;
  state.ui.hostConsoleScrollTop = 0;
}

function afterStartDebateUi() {
  const drawer = document.getElementById('host-console');
  if (drawer) {
    drawer.open = false;
    drawer.scrollTop = 0;
  }
  resetHostConsoleState();
  state.ui.activeSection = 'live';
  state.ui.roomTab = 'seats';
  state.ui.chatOpen = false;
  state.ui.scrollToLiveAfterRender = true;
}

function bindTopicVote() {
  const form = document.getElementById('topicSuggestionForm');
  const textarea = document.getElementById('topicSuggestion');
  if (!form || !textarea) return;
  textarea.addEventListener('input', () => {
    state.ui.topicSuggestionDraft = textarea.value;
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await handleAction('submitTopicSuggestion');
  });
}

function captureTopicVoteState() {
  const textarea = document.getElementById('topicSuggestion');
  if (textarea) state.ui.topicSuggestionDraft = textarea.value;
}

function restoreTopicVoteState() {
  const textarea = document.getElementById('topicSuggestion');
  if (!textarea) return;
  if (textarea.value !== state.ui.topicSuggestionDraft) textarea.value = state.ui.topicSuggestionDraft;
}

function bindChat() {
  const form = document.getElementById('chatForm');
  const textarea = document.getElementById('chatText');
  if (!form || !textarea) return;
  autoGrowChatInput(textarea);
  textarea.addEventListener('input', () => {
    state.ui.chatDraft = textarea.value;
    autoGrowChatInput(textarea);
  });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await handleAction('sendChatMessage');
  });
}

function autoGrowChatInput(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 124)}px`;
}

function captureChatState() {
  const textarea = document.getElementById('chatText');
  if (textarea) state.ui.chatDraft = textarea.value;
  const list = document.querySelector('[data-chat-list]');
  if (!list) return;
  state.ui.chatScrollTop = list.scrollTop;
  state.ui.chatStickToBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 24;
}

function restoreChatState() {
  const textarea = document.getElementById('chatText');
  if (textarea) {
    if (textarea.value !== state.ui.chatDraft) textarea.value = state.ui.chatDraft;
    autoGrowChatInput(textarea);
  }
  const list = document.querySelector('[data-chat-list]');
  if (!list) return;
  const scrollTop = state.ui.chatStickToBottom ? list.scrollHeight : state.ui.chatScrollTop;
  list.scrollTop = scrollTop;
  requestAnimationFrame(() => {
    list.scrollTop = state.ui.chatStickToBottom ? list.scrollHeight : scrollTop;
  });
}

function resetChatState() {
  state.ui.chatOpen = false;
  state.ui.chatDraft = '';
  state.ui.chatScrollTop = 0;
  state.ui.chatStickToBottom = true;
  state.ui.topicSuggestionDraft = '';
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
  if (action === 'clearChat' && !window.confirm('Clear room chat for everyone?')) return;
  const inputs = {
    topicPrompt: document.getElementById('topicPrompt')?.value || '',
    customTopic: document.getElementById('customTopic')?.value || '',
    topicSuggestion: document.getElementById('topicSuggestion')?.value || '',
    customPersonaName: document.getElementById('customPersonaName')?.value || '',
    customPersonaProfile: document.getElementById('customPersonaProfile')?.value || '',
    debaterA: document.getElementById('debaterA')?.value,
    debaterB: document.getElementById('debaterB')?.value,
    humanTurnText: document.getElementById('humanTurnText')?.value || '',
    chatText: document.getElementById('chatText')?.value || '',
    betAmount: Number(document.getElementById('betAmount')?.value || 100),
  };
  await runAction(action, async () => {
    let data;
    switch (action) {
      case 'generateTopics': data = await api(`${roomPath}/topics/generate`, { method: 'POST', host: true, body: { prompt: inputs.topicPrompt } }); state.message = 'Topic candidates generated.'; break;
      case 'selectTopic': data = await api(`${roomPath}/topic`, { method: 'POST', host: true, body: { topicId: payload.topicId } }); state.message = 'Topic locked by host override.'; break;
      case 'setCustomTopic': data = await api(`${roomPath}/topic`, { method: 'POST', host: true, body: { customTopic: inputs.customTopic } }); state.message = 'Custom topic selected.'; break;
      case 'submitTopicSuggestion':
        validateTopicSuggestion(inputs.topicSuggestion);
        data = await api(`${roomPath}/topics/submit`, { method: 'POST', body: { playerId: state.session.playerId, text: inputs.topicSuggestion } });
        state.ui.topicSuggestionDraft = '';
        state.message = 'Topic suggested.';
        break;
      case 'voteTopic':
        data = await api(`${roomPath}/topics/vote`, { method: 'POST', body: { playerId: state.session.playerId, topicId: payload.topicId } });
        state.message = 'Topic vote recorded.';
        break;
      case 'closeTopicVote':
        data = await api(`${roomPath}/topics/close`, { method: 'POST', host: true, body: {} });
        state.message = 'Top topic locked.';
        break;
      case 'setPersonas': {
        const slots = [parseDebaterSelection(inputs.debaterA), parseDebaterSelection(inputs.debaterB)];
        const assignmentMode = debaterAssignmentMode(slots);
        if (assignmentMode === 'ai') {
          data = await api(`${roomPath}/personas`, { method: 'POST', host: true, body: { personaAId: slots[0].personaId, personaBId: slots[1].personaId } });
        } else if (assignmentMode === 'mixed') {
          data = await api(`${roomPath}/debaters`, { method: 'POST', host: true, body: { debaterA: slots[0], debaterB: slots[1] } });
        } else {
          throw new Error('Choose two different AI debaters, or one AI debater and one lobby player.');
        }
        state.message = 'Debaters assigned.';
        break;
      }
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
      case 'startDebate':
        data = await api(`${roomPath}/start`, { method: 'POST', host: true, body: {} });
        afterStartDebateUi();
        state.message = 'Debate started.';
        break;
      case 'resetRoom': data = await api(`${roomPath}/reset`, { method: 'POST', host: true, body: { keepBankroll: true } }); state.message = 'Ready for another round.'; break;
      case 'resetBankrolls': data = await api(`${roomPath}/reset`, { method: 'POST', host: true, body: { keepBankroll: false } }); state.message = 'Room and bankrolls reset.'; break;
      case 'placeBet': data = await api(`${roomPath}/bets`, { method: 'POST', body: { playerId: state.session.playerId, marketId: payload.marketId, amount: inputs.betAmount } }); state.message = 'Bet placed.'; break;
      case 'submitHumanTurn':
        validateHumanTurnInput(inputs.humanTurnText);
        data = await api(`${roomPath}/turns/human`, { method: 'POST', body: { playerId: state.session.playerId, pendingTurnId: payload.pendingTurnId || state.room?.pendingHumanTurn?.id, text: inputs.humanTurnText } });
        state.message = 'Turn submitted.';
        break;
      case 'submitHeckle': data = await api(`${roomPath}/heckles`, { method: 'POST', body: { playerId: state.session.playerId, cardId: payload.cardId } }); state.message = 'Heckle card bought.'; break;
      case 'sendChatMessage':
        validateChatInput(inputs.chatText);
        data = await api(`${roomPath}/chat`, { method: 'POST', body: { playerId: state.session.playerId, text: inputs.chatText } });
        state.ui.chatDraft = '';
        state.ui.chatStickToBottom = true;
        break;
      case 'clearChat':
        data = await api(`${roomPath}/chat`, { method: 'DELETE', host: true });
        state.ui.chatStickToBottom = true;
        state.message = 'Room chat cleared.';
        break;
      case 'submitJuryReaction': data = await api(`${roomPath}/jury`, { method: 'POST', body: { playerId: state.session.playerId, turnId: payload.turnId, reactionId: payload.reactionId } }); state.message = 'Jury reaction recorded.'; break;
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

function validateTopicSuggestion(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 2) throw new Error('Type a topic before submitting.');
  if (clean.length > 320) throw new Error('Topic suggestions must be 320 characters or fewer.');
}

function validateHumanTurnInput(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 2) throw new Error('Type your turn before submitting.');
  if (clean.length > 1400) throw new Error('Human turn must be 1,400 characters or fewer.');
}

function validateChatInput(text) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('Type a chat message before sending.');
  if (clean.length > 500) throw new Error('Chat message must be 500 characters or fewer.');
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
    createRoom: 'Creating room',
    joinRoom: 'Joining room',
    generateTopics: 'Generating topics',
    selectTopic: 'Selecting topic',
    setCustomTopic: 'Normalizing topic',
    submitTopicSuggestion: 'Submitting topic',
    voteTopic: 'Recording vote',
    closeTopicVote: 'Locking top vote',
    setPersonas: 'Assigning debaters',
    createCustomDebater: 'Generating draft',
    acceptCustomDebater: 'Accepting debater',
    discardCustomDebater: 'Discarding draft',
    postOdds: 'Posting odds',
    startDebate: 'Starting debate',
    resetRoom: 'Resetting room',
    resetBankrolls: 'Resetting bankrolls',
    placeBet: 'Placing bet',
    submitHumanTurn: 'Submitting turn',
    submitHeckle: 'Buying heckle card',
    sendChatMessage: 'Sending message',
    clearChat: 'Clearing chat',
    submitJuryReaction: 'Recording jury read',
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
  const betting = bettingWindowState(state.room);
  const hasBettingWindow = Boolean(betting.active);
  if ((hasPending || hasBettingWindow) && !state.countdownTimer) {
    state.countdownTimer = setInterval(updateCountdownDisplay, 500);
  }
  if (!hasPending && !hasBettingWindow && state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
  updateCountdownDisplay();
}

function syncPostRenderFocus() {
  if (!state.ui.scrollToLiveAfterRender) return;
  state.ui.scrollToLiveAfterRender = false;
  requestAnimationFrame(() => {
    document.getElementById('live')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function updateCountdownDisplay() {
  const pending = state.room?.pendingHumanTurn;
  if (pending) {
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

  const betting = bettingWindowState(state.room);
  if (betting.exists) {
    for (const el of document.querySelectorAll('[data-betting-countdown]')) {
      el.textContent = betting.active ? formatCountdown(betting.remainingMs) : 'Done';
    }
    for (const el of document.querySelectorAll('[data-betting-countdown-meter]')) {
      el.style.width = `${bettingWindowPercent(betting)}%`;
    }
  }
  const expiryKey = `${state.room?.id || ''}:${betting.openedAt || ''}`;
  if (betting.expiredByClient && expiryKey && state.ui.bettingExpiryRenderKey !== expiryKey) {
    state.ui.bettingExpiryRenderKey = expiryKey;
    render();
  }
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
function topicDisplayText(value) { return String(value || '').replace(/^Resolved:\s*/i, '').trim(); }
function statusClass(status) { if (status === 'BETTING_OPEN') return 'green'; if (['DEBATE', 'JUDGING', 'SETTLEMENT'].includes(status)) return 'gold'; if (status === 'RESULTS') return 'blue'; if (status === 'ERROR') return 'red'; return 'gray'; }
function chips(value) { return `${Number(value || 0).toLocaleString()} chips`; }
function signedChips(value) { const n = Number(value || 0); return `${n >= 0 ? '+' : ''}${n.toLocaleString()}`; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function h(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
