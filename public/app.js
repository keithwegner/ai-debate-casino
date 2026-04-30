const root = document.getElementById('root');
const storageKey = 'aiDebateCasinoSession';
const queryRoomId = new URLSearchParams(location.search).get('room')?.trim().toUpperCase() || '';

let state = {
  session: readSession(),
  room: null,
  personas: [],
  error: '',
  message: '',
  pendingAction: '',
  pollTimer: null,
  eventSource: null,
};

init();

async function init() {
  await loadPersonas();
  if (state.session?.roomId) {
    await loadRoom();
    startLiveUpdates();
  }
  render();
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
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
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
    state.error = e.message;
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
}

function render() {
  if (!state.session) {
    root.innerHTML = landingHtml();
    bindLanding();
    return;
  }
  if (!state.room) {
    root.innerHTML = `<main class="shell"><section class="panel hero"><h1>Loading room ${h(state.session.roomId)}…</h1>${flashHtml()}${processingHtml(null)}</section></main>`;
    return;
  }
  root.innerHTML = roomHtml(state.room);
  bindRoom();
}

function landingHtml() {
  return `
    <main class="shell landing">
      <section class="hero panel">
        <div class="kicker">Fake chips. Real model arguments.</div>
        <h1>AI Debate Casino</h1>
        <p class="lede">A party-game sportsbook where AI personas debate ridiculous propositions and an AI judge settles the fake-chip board.</p>
        ${flashHtml()}
        <div class="landing-grid">
          <form id="createForm" class="card form-card">
            <h2>Create a room</h2>
            <label>Your display name</label>
            <input name="displayName" value="Keith" maxlength="32" />
            <button class="primary" type="submit" ${state.pendingAction ? 'disabled' : ''}>${buttonContent('createRoom', 'Open the table')}</button>
          </form>
          <form id="joinForm" class="card form-card">
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
    <main class="app-shell">
      ${topBarHtml(room, me, isHost)}
      ${flashHtml()}
      ${processingHtml(room)}
      <section class="main-grid">
        <aside class="left-rail">
          ${debatersHtml(room)}
          ${leaderboardHtml(room)}
        </aside>
        <section class="stage panel">
          ${topicHtml(room)}
          ${transcriptHtml(room)}
          ${verdictHtml(room)}
        </section>
        <aside class="sportsbook panel">
          ${sportsbookHtml(room, me)}
          ${hecklesHtml(room, me)}
        </aside>
      </section>
      ${isHost ? hostControlsHtml(room) : ''}
      ${commentaryHtml(room)}
    </main>`;
}

function topBarHtml(room, me, isHost) {
  const ai = room.ai.mode === 'openai'
    ? `setup ${room.ai.setupModel} · debate ${room.ai.debateModel} · judge ${room.ai.judgeModel} · ${room.ai.debateScript || 'full'} script`
    : `mock fallback${room.ai.mockReason ? ` (${room.ai.mockReason})` : ''}`;
  return `
    <header class="topbar panel">
      <div><div class="kicker">Room</div><div class="room-code">${h(room.id)}</div></div>
      <div><div class="kicker">Phase</div><div class="phase"><span class="dot ${statusClass(room.status)}"></span>${h(room.currentPhase)}</div></div>
      <div><div class="kicker">AI</div><div class="muted small">${h(ai)}</div></div>
      <div><div class="kicker">You</div><div>${h(me?.displayName || 'Observer')} · <strong>${chips(me?.bankroll || 0)}</strong></div></div>
      <div class="top-actions">${isHost ? '<span class="host-badge">Host</span>' : ''}<button data-action="copyLink">Copy link</button><button data-action="leaveRoom">Leave</button></div>
    </header>`;
}

function topicHtml(room) {
  if (!room.topic) return `<div class="empty-state"><h2>No resolution yet</h2><p>The host can generate candidates, enter a custom topic, or run a one-click demo.</p></div>`;
  return `<div class="topic-card"><div class="kicker">Resolution</div><h2>${h(room.topic.resolution)}</h2><div class="topic-meta"><span>${h(room.topic.category)}</span><span>Comedy ${h(room.topic.comedyPotential)}/10</span><span>${h(room.topic.safetyRating)}</span></div></div>`;
}

function debatersHtml(room) {
  if (!room.debaters?.length) return `<section class="panel compact"><h3>Debaters</h3><p class="muted">Personas appear after topic selection.</p></section>`;
  return `<section class="panel compact"><h3>Debaters</h3>${room.debaters.map((d) => `<article class="debater ${d.id}"><div class="side-label">${h(d.sideLabel)}</div><h4>${h(d.displayName)}</h4><div class="muted">${h(d.archetype)}</div><p>${h(d.tagline)}</p><div class="stance">${h(d.stance)}</div></article>`).join('')}</section>`;
}

function transcriptHtml(room) {
  if (!room.turns?.length) return `<section class="transcript empty-transcript"><h3>Transcript</h3><p class="muted">Debate turns will appear here as the match progresses.</p></section>`;
  return `<section class="transcript"><h3>Live transcript</h3>${room.turns.map((t) => `<article class="turn ${t.speakerDebaterId}"><div class="turn-head"><span class="phase-chip">${h(t.phase)}</span><strong>${h(t.speakerName)}</strong><span class="muted">${h(t.persona)} · ${h(t.sideLabel)}</span>${t.heckleLabel ? `<span class="heckle-chip">${h(t.heckleLabel)}</span>` : ''}</div><p>${h(t.text)}</p></article>`).join('')}</section>`;
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
      <p>${h(v.verdict)}</p>
      <div class="score-grid">${scoreCardHtml(room.debaters[0], v.scores?.debater_a)}${scoreCardHtml(room.debaters[1], v.scores?.debater_b)}</div>
      <div class="callouts"><div><div class="kicker">Best line</div><blockquote>${h(v.bestLine?.quote || '')}</blockquote></div><div><div class="kicker">Worst argument</div><p>${h(v.worstArgument?.summary || '')}</p></div></div>
      ${props ? `<h4>Prop settlement</h4><table><tbody>${props}</tbody></table>` : ''}
    </section>`;
}

function scoreCardHtml(debater, score = {}) {
  if (!debater) return '';
  const rows = [['Logic', score.logicalCoherence], ['Response', score.responsiveness], ['Force', score.rhetoricalForce], ['Humor', score.humor], ['Originality', score.originality], ['Control', score.topicControl]];
  return `<div class="score-card ${debater.id}"><h4>${h(debater.displayName)}</h4><div class="score-total">${h(score.total || 0)}</div>${rows.map(([label, value]) => `<div class="score-row"><span>${label}</span><meter min="0" max="10" value="${Number(value || 0)}"></meter><b>${h(value || 0)}</b></div>`).join('')}</div>`;
}

function sportsbookHtml(room, me) {
  const myBets = room.bets.filter((b) => b.userId === me?.id);
  if (!room.markets?.length) return `<h3>Sportsbook</h3><p class="muted">The Oddsmaker has not posted lines yet.</p><p class="fineprint">Fake chips only. No cash value.</p>`;
  return `
    <h3>Sportsbook</h3>
    <div class="bet-status ${room.status === 'BETTING_OPEN' ? 'open' : 'closed'}">${room.status === 'BETTING_OPEN' ? 'Betting open' : 'Betting locked / closed'}</div>
    <label>Bet amount</label><input id="betAmount" type="number" min="10" max="500" step="10" value="100" ${room.status === 'BETTING_OPEN' ? '' : 'disabled'} />
    <div class="markets">${room.markets.map((m) => `<article class="market-card"><div class="market-title">${h(m.label)}</div><div class="odds">${Number(m.odds).toFixed(2)}x</div><p>${h(m.rationale)}</p><small>${h(m.settleRule)}</small><button data-action="placeBet" data-market-id="${h(m.id)}" ${room.status === 'BETTING_OPEN' ? '' : 'disabled'}>Bet</button></article>`).join('')}</div>
    <section class="my-bets"><h4>My bets</h4>${myBets.length ? `<table><tbody>${myBets.map((b) => `<tr><td>${h(b.marketLabel)}</td><td>${chips(b.amount)}</td><td>${h(b.status)}</td><td>${b.net === null ? '' : signedChips(b.net)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No active bets.</p>'}</section>
    <p class="fineprint">Fake chips only. No cash value. No real-money wagering.</p>`;
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
  return `<section class="panel compact leaderboard"><h3>Leaderboard</h3><table><tbody>${rows.map((p) => `<tr class="${p.userId === state.session?.playerId || p.id === state.session?.playerId ? 'me-row' : ''}"><td>${h(p.rank)}</td><td>${h(p.displayName)}${p.isBot ? ' <span class="bot">bot</span>' : ''}</td><td>${chips(p.bankroll)}</td></tr>`).join('')}</tbody></table></section>`;
}

function hostControlsHtml(room) {
  const canEdit = !['DEBATE', 'JUDGING', 'SETTLEMENT'].includes(room.status) && !room.running;
  return `
    <section class="host-controls panel">
      <div class="section-head"><div><div class="kicker">Host controls</div><h2>Pit boss console</h2></div><div class="button-row"><button data-action="quickDemo" class="primary" ${room.running ? 'disabled' : ''}>One-click demo round</button><button data-action="startDebate" ${room.status === 'BETTING_OPEN' && !room.running ? '' : 'disabled'}>Start debate</button><button data-action="resetRoom" ${room.running ? 'disabled' : ''}>Reset</button><button data-action="resetBankrolls" ${room.running ? 'disabled' : ''}>Reset bankrolls</button></div></div>
      <div class="host-grid">
        <div class="control-card"><h3>1. Topic</h3><textarea id="topicPrompt" rows="3" placeholder="Optional flavor: workplace absurdism, business parody, animal politics…" ${canEdit ? '' : 'disabled'}></textarea><button data-action="generateTopics" ${canEdit ? '' : 'disabled'}>Generate topic candidates</button><label>Custom resolution</label><input id="customTopic" placeholder="Resolved: The office microwave is a sovereign nation." ${canEdit ? '' : 'disabled'} /><button data-action="setCustomTopic" ${canEdit ? '' : 'disabled'}>Use custom topic</button><div class="topic-list">${(room.topics || []).map((t) => `<article class="mini-topic ${room.topic?.id === t.id ? 'selected' : ''}"><strong>${h(t.resolution)}</strong><div class="muted">${h(t.category)} · Comedy ${h(t.comedyPotential)}/10</div><button data-action="selectTopic" data-topic-id="${h(t.id)}" ${canEdit ? '' : 'disabled'}>Select</button></article>`).join('')}</div></div>
        <div class="control-card"><h3>2. Personas + odds</h3>${personaSelectHtml('personaA', room.debaters?.[0]?.personaId)}${personaSelectHtml('personaB', room.debaters?.[1]?.personaId)}<button data-action="setPersonas" ${room.topic && canEdit ? '' : 'disabled'}>Assign debaters</button><button data-action="postOdds" ${room.topic && room.debaters?.length === 2 && canEdit ? '' : 'disabled'}>Post odds</button><button data-action="demoFill" ${room.status === 'BETTING_OPEN' ? '' : 'disabled'}>Demo-fill audience + bets</button></div>
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

function personaSelectHtml(id, selected) {
  return `<label>${id === 'personaA' ? 'Debater A' : 'Debater B'}</label><select id="${id}">${state.personas.map((p) => `<option value="${h(p.id)}" ${selected === p.id ? 'selected' : ''}>${h(p.displayName)} — ${h(p.archetype)}</option>`).join('')}</select>`;
}

function commentaryHtml(room) {
  if (!room.commentary?.length) return '';
  return `<section class="commentary panel"><div class="kicker">Commentary ticker</div><div class="ticker-items">${room.commentary.slice(0, 10).map((c) => `<span>${h(c.text)}</span>`).join('')}</div></section>`;
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
      await handleAction(event.currentTarget.dataset.action, { marketId: event.currentTarget.dataset.marketId, topicId: event.currentTarget.dataset.topicId, cardId: event.currentTarget.dataset.cardId, mode: event.currentTarget.dataset.mode });
    });
  }
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
    personaAId: document.getElementById('personaA')?.value,
    personaBId: document.getElementById('personaB')?.value,
    betAmount: Number(document.getElementById('betAmount')?.value || 100),
  };
  await runAction(action, async () => {
    let data;
    switch (action) {
      case 'generateTopics': data = await api(`${roomPath}/topics/generate`, { method: 'POST', host: true, body: { prompt: inputs.topicPrompt } }); state.message = 'Topic candidates generated.'; break;
      case 'selectTopic': data = await api(`${roomPath}/topic`, { method: 'POST', host: true, body: { topicId: payload.topicId } }); state.message = 'Topic selected.'; break;
      case 'setCustomTopic': data = await api(`${roomPath}/topic`, { method: 'POST', host: true, body: { customTopic: inputs.customTopic } }); state.message = 'Custom topic selected.'; break;
      case 'setReadability': data = await api(`${roomPath}/readability`, { method: 'POST', host: true, body: { mode: payload.mode } }); state.message = `Audience set to ${payload.mode === 'kids' ? 'Kids' : 'Classic'}.`; break;
      case 'setPersonas': data = await api(`${roomPath}/personas`, { method: 'POST', host: true, body: { personaAId: inputs.personaAId, personaBId: inputs.personaBId } }); state.message = 'Debaters assigned.'; break;
      case 'postOdds': data = await api(`${roomPath}/odds`, { method: 'POST', host: true, body: {} }); state.message = 'Odds posted.'; break;
      case 'demoFill': data = await api(`${roomPath}/demo-fill`, { method: 'POST', host: true, body: {} }); state.message = 'Demo audience added.'; break;
      case 'quickDemo': data = await api(`${roomPath}/quick-demo`, { method: 'POST', host: true, body: {} }); state.message = 'One-click demo started.'; break;
      case 'startDebate': data = await api(`${roomPath}/start`, { method: 'POST', host: true, body: {} }); state.message = 'Debate started.'; break;
      case 'resetRoom': data = await api(`${roomPath}/reset`, { method: 'POST', host: true, body: { keepBankroll: true } }); state.message = 'Room reset.'; break;
      case 'resetBankrolls': data = await api(`${roomPath}/reset`, { method: 'POST', host: true, body: { keepBankroll: false } }); state.message = 'Room and bankrolls reset.'; break;
      case 'placeBet': data = await api(`${roomPath}/bets`, { method: 'POST', body: { playerId: state.session.playerId, marketId: payload.marketId, amount: inputs.betAmount } }); state.message = 'Bet placed.'; break;
      case 'submitHeckle': data = await api(`${roomPath}/heckles`, { method: 'POST', body: { playerId: state.session.playerId, cardId: payload.cardId } }); state.message = 'Heckle card bought.'; break;
      default: return;
    }
    if (data?.room) state.room = data.room;
  });
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
    createRoom: 'Opening the table',
    joinRoom: 'Taking a seat',
    generateTopics: 'Generating topics',
    selectTopic: 'Selecting topic',
    setCustomTopic: 'Normalizing topic',
    setReadability: 'Updating audience',
    setPersonas: 'Assigning debaters',
    postOdds: 'Posting odds',
    demoFill: 'Adding demo audience',
    quickDemo: 'Starting demo round',
    startDebate: 'Starting debate',
    resetRoom: 'Resetting room',
    resetBankrolls: 'Resetting bankrolls',
    placeBet: 'Placing bet',
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

function currentPlayer(room) { return room.players.find((p) => p.id === state.session?.playerId) || room.players[0]; }
function statusClass(status) { if (status === 'BETTING_OPEN') return 'green'; if (['DEBATE', 'JUDGING', 'SETTLEMENT'].includes(status)) return 'gold'; if (status === 'RESULTS') return 'blue'; if (status === 'ERROR') return 'red'; return 'gray'; }
function chips(value) { return `${Number(value || 0).toLocaleString()} chips`; }
function signedChips(value) { const n = Number(value || 0); return `${n >= 0 ? '+' : ''}${n.toLocaleString()}`; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function h(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
