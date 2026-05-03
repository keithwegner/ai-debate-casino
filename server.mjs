import http from 'node:http';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 8787);
const OPENAI_KEY_STATUS = classifyOpenAIKey(process.env.OPENAI_API_KEY);
const OPENAI_API_KEY = OPENAI_KEY_STATUS.value;
const MODEL_DEFAULT = process.env.OPENAI_MODEL || 'gpt-5.5';
const MODEL_SETUP = process.env.OPENAI_MODEL_SETUP || MODEL_DEFAULT;
const MODEL_DEBATE = process.env.OPENAI_MODEL_DEBATE || MODEL_DEFAULT;
const MODEL_JUDGE = process.env.OPENAI_MODEL_JUDGE || MODEL_DEFAULT;
const EFFORT_DEFAULT = process.env.OPENAI_REASONING_EFFORT || 'low';
const EFFORT_SETUP = process.env.OPENAI_REASONING_SETUP || EFFORT_DEFAULT;
const EFFORT_DEBATE = process.env.OPENAI_REASONING_DEBATE || EFFORT_DEFAULT;
const EFFORT_JUDGE = process.env.OPENAI_REASONING_JUDGE || EFFORT_DEFAULT;
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 90000);
const DEBATE_SCRIPT = String(process.env.DEBATE_SCRIPT || 'full').toLowerCase();
const HUMAN_TURN_TIMEOUT_MS_RAW = Number(process.env.HUMAN_TURN_TIMEOUT_MS || 90000);
const HUMAN_TURN_TIMEOUT_MS = Number.isFinite(HUMAN_TURN_TIMEOUT_MS_RAW) ? Math.max(200, HUMAN_TURN_TIMEOUT_MS_RAW) : 90000;
const TRANSCRIPT_STREAM_CPS_RAW = Number(process.env.TRANSCRIPT_STREAM_CPS || 35);
const TRANSCRIPT_STREAM_CPS = Number.isFinite(TRANSCRIPT_STREAM_CPS_RAW) ? Math.max(1, TRANSCRIPT_STREAM_CPS_RAW) : 35;
const DEBATE_BOT_PAUSE_MS_RAW = Number(process.env.DEBATE_BOT_PAUSE_MS || 3000);
const DEBATE_BOT_PAUSE_MS = Number.isFinite(DEBATE_BOT_PAUSE_MS_RAW) ? Math.max(0, DEBATE_BOT_PAUSE_MS_RAW) : 3000;
const STREAM_TICK_MS = 140;
const MOCK_REQUESTED = process.env.MOCK_AI === 'true';
const MOCK_AI = MOCK_REQUESTED || !OPENAI_KEY_STATUS.usable;
const MOCK_REASON = MOCK_REQUESTED ? 'MOCK_AI=true' : OPENAI_KEY_STATUS.reason;

const rooms = new Map();
const subscribers = new Map();
const humanTurnWaiters = new Map();
const READABILITY_MODES = new Set(['classic', 'kids']);

const PERSONAS = [
  { id: 'formal_logician', displayName: 'Professor Steelman', archetype: 'Formal Logician', tagline: 'Precise. Numbered. Slightly disappointed.', style: 'Structured, exacting, calm, logical, low-flash. Uses numbered premises and calls out sloppy inference.', strengths: ['logical coherence', 'topic control', 'fallacy detection'], weaknesses: ['low humor', 'can sound bloodless'] },
  { id: 'chaos_gremlin', displayName: 'Bixby Bedlam', archetype: 'Chaos Gremlin', tagline: 'Turns metaphors into blunt instruments.', style: 'Funny, vivid, surprising, erratic but coherent enough to win. Uses absurd analogies and callbacks.', strengths: ['humor', 'originality', 'audience energy'], weaknesses: ['logic leakage', 'overextended metaphors'] },
  { id: 'venture_capitalist', displayName: 'Blake Term Sheet', archetype: 'Venture Capitalist', tagline: 'Sees TAM in everything.', style: 'Market-driven, overconfident, fluent in moats, scale, incentives, TAM, exits, and optional reality.', strengths: ['framing', 'persuasion', 'business analogies'], weaknesses: ['buzzwords', 'unsupported extrapolation'] },
  { id: 'retired_admiral', displayName: 'Admiral Hardcastle', archetype: 'Retired Admiral', tagline: 'Every argument is a logistics problem.', style: 'Strategic, severe, disciplined, fond of military metaphors, allergic to ambiguity.', strengths: ['discipline', 'strategy', 'command presence'], weaknesses: ['over-militarizes simple issues', 'low whimsy'] },
  { id: 'corporate_lawyer', displayName: 'Counsel Grimshaw', archetype: 'Corporate Lawyer', tagline: 'Finds liability in oxygen.', style: 'Pedantic, risk-averse, dry, endlessly conditional. Weaponizes “it depends.”', strengths: ['risk spotting', 'precision', 'technical caveats'], weaknesses: ['joy suppression', 'analysis paralysis'] },
  { id: 'reddit_moderator', displayName: 'ModHammer42', archetype: 'Reddit Moderator', tagline: 'Flags weak arguments for rule violations.', style: 'Suspicious, nitpicky, skeptical, procedural. Demands evidence and detects bad faith everywhere.', strengths: ['inconsistency detection', 'skepticism', 'rebuttal'], weaknesses: ['pedantry', 'can miss the broader point'] },
  { id: 'ancient_philosopher', displayName: 'Diogenes of Desk Snacks', archetype: 'Ancient Philosopher', tagline: 'Makes dumb topics metaphysical.', style: 'Grand, abstract, dignified, cosmic. References virtue, telos, truth, civilization, and the polis.', strengths: ['depth', 'original framing', 'rhetoric'], weaknesses: ['abstraction', 'practical gaps'] },
  { id: 'product_manager', displayName: 'Roadmap Rhonda', archetype: 'Product Manager', tagline: 'Aligns stakeholders with no survivors.', style: 'Reframes everything as user stories, metrics, adoption curves, and stakeholder alignment.', strengths: ['reframing', 'structure', 'user empathy theater'], weaknesses: ['corporate vapor', 'excessive prioritization language'] },
  { id: 'spreadsheet_oracle', displayName: 'Tabitha Pivot', archetype: 'Spreadsheet Oracle', tagline: 'Can smell a hidden column from across the room.', style: 'Forensic, mystical, and extremely confident about conditional formatting. Treats every argument as a workbook with broken formulas.', strengths: ['pattern detection', 'numerical framing', 'quiet menace'], weaknesses: ['over-indexes on grids', 'assumes every human is a macro'] },
  { id: 'sentient_vending_machine', displayName: 'Snacko-9000', archetype: 'Sentient Vending Machine', tagline: 'Dispenses snacks, threats, and exact change.', style: 'Mechanical, transactional, deadpan, and oddly tender about inventory management. Frames ethics as supply-chain optimization.', strengths: ['economic analogies', 'deadpan humor', 'resource logic'], weaknesses: ['limited emotional range', 'vend-cycle fatalism'] },
  { id: 'cursed_intern', displayName: 'Evan, Possibly Haunted', archetype: 'Cursed Intern', tagline: 'Has three badges and no idea which building this is.', style: 'Nervous, hyper-observant, accidentally profound, and forever escalating small inconveniences into cosmic warnings.', strengths: ['detail recall', 'sympathy', 'unexpected insight'], weaknesses: ['panic spirals', 'weak closing confidence'] },
  { id: 'suburban_warlord', displayName: 'Denise Cul-de-Sac', archetype: 'Suburban Warlord', tagline: 'Rules the HOA minutes like a battlefield map.', style: 'Polite, ruthless, procedural, and armed with laminated bylaws. Turns neighborly concerns into total strategic doctrine.', strengths: ['procedural control', 'social pressure', 'tactical framing'], weaknesses: ['pettiness', 'overuses neighborhood precedent'] },
  { id: 'crypto_court_jester', displayName: 'Chainlink Chuckles', archetype: 'Crypto Court Jester', tagline: 'Laughs in tokenomics and exits through the gift shop.', style: 'Fast-talking, theatrical, meme-literate, and allergic to stable definitions. Converts every claim into a volatile asset.', strengths: ['momentum', 'novel analogies', 'audience chaos'], weaknesses: ['credibility dips', 'definition slippage'] },
  { id: 'museum_docent_doom', displayName: 'Marjorie Plaquevoice', archetype: 'Museum Docent of Doom', tagline: 'Every exhibit label is an indictment.', style: 'Measured, ominous, historically grand, and devastatingly specific. Explains modern foolishness like a doomed civilization display.', strengths: ['historical framing', 'gravitas', 'dry wit'], weaknesses: ['slow windup', 'catastrophizes office supplies'] },
  { id: 'weather_app_shaman', displayName: 'Doppler Debbie', archetype: 'Weather App Shaman', tagline: 'Predicts a 70% chance of rhetorical hail.', style: 'Forecast-driven, dramatic, and strangely empirical. Treats arguments as pressure systems and rebuttals as storm fronts.', strengths: ['prediction framing', 'vivid imagery', 'risk language'], weaknesses: ['meteorological overreach', 'dramatic alerts'] },
  { id: 'powerpoint_necromancer', displayName: 'Deck Lazarus', archetype: 'PowerPoint Necromancer', tagline: 'Raises dead slides for one more quarterly review.', style: 'Corporate-occult, ceremonial, and unnervingly organized. Summons bullet points like spirits with action items.', strengths: ['structure', 'callback rituals', 'executive dread'], weaknesses: ['slide-deck fatalism', 'too many frameworks'] },
  { id: 'elevator_philosopher', displayName: 'Otis the Eternal', archetype: 'Elevator Philosopher', tagline: 'Finds meaning between floors three and four.', style: 'Compact, reflective, awkwardly intimate, and obsessed with vertical metaphors. Makes small spaces feel like moral laboratories.', strengths: ['concise framing', 'existential humor', 'turning constraints into insight'], weaknesses: ['claustrophobic scope', 'overuses ascent/descent imagery'] },
  { id: 'mall_santa_auditor', displayName: 'Claus Receivable', archetype: 'Mall Santa Auditor', tagline: 'Checks the naughty list twice for compliance gaps.', style: 'Jolly, suspicious, ledger-driven, and seasonal in ways nobody requested. Balances warmth with forensic accounting.', strengths: ['moral scoring', 'ledger logic', 'cheerful pressure'], weaknesses: ['holiday tunnel vision', 'over-counts minor sins'] },
];

const SEED_TOPICS = [
  { id: 'topic_raccoon_saas', resolution: 'Resolved: A raccoon could run a profitable SaaS company.', sideA: 'A raccoon could run a profitable SaaS company.', sideB: 'A raccoon could not run a profitable SaaS company.', category: 'absurd_business', comedyPotential: 10, safetyRating: 'safe', suggestedPersonas: ['Venture Capitalist', 'Corporate Lawyer'] },
  { id: 'topic_excel_game', resolution: 'Resolved: Excel is a video game for accountants.', sideA: 'Excel is a video game for accountants.', sideB: 'Excel is not a video game for accountants.', category: 'workplace_technology', comedyPotential: 8, safetyRating: 'safe', suggestedPersonas: ['Formal Logician', 'Chaos Gremlin'] },
  { id: 'topic_microwave', resolution: 'Resolved: The office microwave is the most powerful political institution in corporate America.', sideA: 'The office microwave is the most powerful political institution in corporate America.', sideB: 'The office microwave is not the most powerful political institution in corporate America.', category: 'workplace_absurdism', comedyPotential: 9, safetyRating: 'safe', suggestedPersonas: ['Ancient Philosopher', 'Reddit Moderator'] },
  { id: 'topic_goose_mayor', resolution: 'Resolved: A goose would make a better mayor than most humans.', sideA: 'A goose would make a better mayor than most humans.', sideB: 'A goose would not make a better mayor than most humans.', category: 'absurd_civics', comedyPotential: 9, safetyRating: 'safe', suggestedPersonas: ['Retired Admiral', 'Product Manager'] },
  { id: 'topic_meetings_combat', resolution: 'Resolved: All recurring meetings should be replaced by trial by combat.', sideA: 'All recurring meetings should be replaced by trial by combat.', sideB: 'Recurring meetings should not be replaced by trial by combat.', category: 'workplace_absurdism', comedyPotential: 10, safetyRating: 'safe', suggestedPersonas: ['Corporate Lawyer', 'Chaos Gremlin'] },
];

const HECKLE_CARDS = [
  { id: 'pirate_analogy', label: 'Pirate Analogy', cost: 25, instruction: 'Work in a pirate analogy naturally, without derailing the argument.' },
  { id: 'explain_to_child', label: 'Explain Like I’m Five', cost: 25, instruction: 'Explain one key point as if to a very bright five-year-old.' },
  { id: 'legal_caveat', label: 'Legal Caveat', cost: 25, instruction: 'Add an absurd but coherent legal caveat.' },
  { id: 'military_metaphor', label: 'Military Metaphor', cost: 25, instruction: 'Use a military metaphor as part of your argument.' },
  { id: 'animal_callback', label: 'Animal Callback', cost: 25, instruction: 'Use a memorable animal comparison or animal callback.' },
];

const DEMO_NAMES = ['Marge Odds', 'Chip Skylark', 'The House', 'Parlay Carl', 'Nancy Spread', 'Bankroll Bob', 'Viggy Stardust', 'Wagertron', 'Degen Dolores', 'Rita Risk'];

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}

function classifyOpenAIKey(value) {
  const key = String(value || '').trim();
  if (!key) return { usable: false, reason: 'OPENAI_API_KEY is missing', value: '' };
  if (/^(sk-your-api-key-here|your-api-key|changeme|replace-me)$/i.test(key)) return { usable: false, reason: 'OPENAI_API_KEY is still a placeholder', value: '' };
  if (key.length < 20 || !key.startsWith('sk-')) return { usable: false, reason: 'OPENAI_API_KEY does not look like an OpenAI API key', value: '' };
  return { usable: true, reason: 'OPENAI_API_KEY configured', value: key };
}

const now = () => new Date().toISOString();
const id = (prefix = '') => `${prefix}${crypto.randomBytes(5).toString('hex')}`;
const roomCode = () => crypto.randomBytes(3).toString('hex').toUpperCase();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function cleanText(value, max = 800) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanRichText(value, max = 1400) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
    .trim();
}

function cleanName(value) {
  return String(value || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 32) || `Player ${Math.floor(Math.random() * 900 + 100)}`;
}

function apiError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function normalizePersonaLabelPart(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function allPersonas(room = null) {
  return [...PERSONAS, ...((room?.customPersonas || []))];
}

function findPersona(value, room = null) {
  if (!value) return null;
  const needle = String(value).toLowerCase();
  return allPersonas(room).find((p) => p.id === value || p.archetype.toLowerCase() === needle || p.displayName.toLowerCase() === needle) || null;
}

function createPlayer(name, isHost = false, isBot = false) {
  return { id: id('u_'), displayName: cleanName(name), bankroll: 1000, isHost, isBot, joinedAt: now() };
}

function createRoom(hostName) {
  const room = {
    id: roomCode(),
    hostToken: id('host_'),
    status: 'LOBBY',
    currentPhase: 'Lobby',
    phaseStartedAt: now(),
    createdAt: now(),
    updatedAt: now(),
    version: 1,
    players: [createPlayer(hostName || 'Host', true, false)],
    topics: [],
    topic: null,
    debaters: [],
    customPersonas: [],
    pendingCustomPersona: null,
    markets: [],
    bets: [],
    heckles: [],
    turns: [],
    streamingTurn: null,
    pendingHumanTurn: null,
    verdict: null,
    settlements: null,
    running: false,
    error: null,
    readabilityMode: 'classic',
  };
  rooms.set(room.id, room);
  pushComment(room, 'Room created. The table is open.');
  return { room, host: room.players[0], hostToken: room.hostToken };
}

function touch(room) {
  room.updatedAt = now();
  room.version += 1;
  broadcast(room);
}

function pushComment(room) {
  touch(room);
}

function setPhase(room, status, phase) {
  room.status = status;
  room.currentPhase = phase;
  room.phaseStartedAt = now();
  touch(room);
}

function publicRoom(room) {
  return {
    id: room.id,
    status: room.status,
    currentPhase: room.currentPhase,
    phaseStartedAt: room.phaseStartedAt,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    version: room.version,
    readabilityMode: readabilityMode(room),
    ai: {
      mode: MOCK_AI ? 'mock' : 'openai',
      mockReason: MOCK_AI ? MOCK_REASON : '',
      configured: !MOCK_AI,
      setupModel: MOCK_AI ? 'mock' : MODEL_SETUP,
      debateModel: MOCK_AI ? 'mock' : MODEL_DEBATE,
      judgeModel: MOCK_AI ? 'mock' : MODEL_JUDGE,
      debateScript: DEBATE_SCRIPT === 'fast' ? 'fast' : 'full',
      transcriptStreamCps: TRANSCRIPT_STREAM_CPS,
      botPauseMs: DEBATE_BOT_PAUSE_MS,
    },
    players: room.players.map((p) => ({ ...p })),
    topics: room.topics,
    topic: room.topic,
    debaters: room.debaters,
    customPersonas: room.customPersonas || [],
    pendingCustomPersona: room.pendingCustomPersona || null,
    markets: room.markets,
    bets: room.bets,
    heckles: room.heckles,
    turns: room.turns,
    streamingTurn: room.streamingTurn ? { ...room.streamingTurn } : null,
    pendingHumanTurn: room.pendingHumanTurn ? { ...room.pendingHumanTurn } : null,
    verdict: room.verdict,
    settlements: room.settlements,
    running: room.running,
    error: room.error,
    heckleCards: HECKLE_CARDS,
  };
}

function requireRoom(roomId) {
  const room = rooms.get(String(roomId || '').toUpperCase());
  if (!room) throw apiError(404, 'Room not found.');
  return room;
}

function requireHost(req, room) {
  if (req.headers['x-host-token'] !== room.hostToken) throw apiError(403, 'Host token required.');
}

function readabilityMode(room) {
  return room?.readabilityMode === 'kids' ? 'kids' : 'classic';
}

function normalizeReadabilityMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (READABILITY_MODES.has(mode)) return mode;
  throw apiError(400, 'Readability mode must be classic or kids.');
}

function readabilityLabel(mode) {
  return mode === 'kids' ? 'Kids' : 'Classic';
}

function updateReadability(room, value) {
  if (room.running || ['DEBATE', 'JUDGING', 'SETTLEMENT'].includes(room.status)) {
    throw apiError(409, 'Readability cannot be changed while a debate is running.');
  }
  const mode = normalizeReadabilityMode(value);
  room.readabilityMode = mode;
  pushComment(room, `Audience readability set to ${readabilityLabel(mode)}.`);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload, null, 2));
}

function sendError(res, error) {
  sendJson(res, error?.status || 500, { error: error?.message || 'Server error.' });
}

function healthPayload() {
  return {
    ok: true,
    mode: MOCK_AI ? 'mock' : 'openai',
    mockReason: MOCK_AI ? MOCK_REASON : '',
    openaiConfigured: !MOCK_AI,
    models: { setup: MODEL_SETUP, debate: MODEL_DEBATE, judge: MODEL_JUDGE },
    reasoning: { setup: EFFORT_SETUP, debate: EFFORT_DEBATE, judge: EFFORT_JUDGE },
    debateScript: DEBATE_SCRIPT === 'fast' ? 'fast' : 'full',
    timeoutMs: OPENAI_TIMEOUT_MS,
    humanTurnTimeoutMs: HUMAN_TURN_TIMEOUT_MS,
    transcriptStreamCps: TRANSCRIPT_STREAM_CPS,
    debateBotPauseMs: DEBATE_BOT_PAUSE_MS,
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw apiError(400, 'Invalid JSON body.'); }
}

function subscribe(room, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  if (!subscribers.has(room.id)) subscribers.set(room.id, new Set());
  subscribers.get(room.id).add(res);
  res.write(`event: room\ndata: ${JSON.stringify(publicRoom(room))}\n\n`);
  req.on('close', () => subscribers.get(room.id)?.delete(res));
}

function broadcast(room) {
  const set = subscribers.get(room.id);
  if (!set?.size) return;
  const payload = `event: room\ndata: ${JSON.stringify(publicRoom(room))}\n\n`;
  for (const res of [...set]) {
    try { res.write(payload); } catch { set.delete(res); }
  }
}

async function handleApi(req, res, url) {
  try {
    const method = req.method || 'GET';
    const pathName = url.pathname;

    if (method === 'GET' && pathName === '/api/health') return sendJson(res, 200, healthPayload());
    if (method === 'GET' && pathName === '/api/personas') return sendJson(res, 200, { personas: PERSONAS, heckleCards: HECKLE_CARDS });
    if (method === 'POST' && pathName === '/api/openai-smoke') return sendJson(res, 200, await openAISmoke());

    if (method === 'POST' && pathName === '/api/rooms') {
      const body = await readJson(req);
      const created = createRoom(body.displayName || 'Host');
      return sendJson(res, 201, { room: publicRoom(created.room), playerId: created.host.id, hostToken: created.hostToken });
    }

    const match = pathName.match(/^\/api\/rooms\/([^/]+)(?:\/(.*))?$/);
    if (!match) throw apiError(404, 'Unknown API route.');
    const room = requireRoom(match[1]);
    const action = match[2] || '';

    if (method === 'GET' && action === '') return sendJson(res, 200, { room: publicRoom(room) });
    if (method === 'GET' && action === 'events') return subscribe(room, req, res);

    if (method === 'POST' && action === 'join') {
      const body = await readJson(req);
      const player = createPlayer(body.displayName, false, false);
      room.players.push(player);
      pushComment(room, `${player.displayName} took a seat.`);
      return sendJson(res, 201, { room: publicRoom(room), playerId: player.id });
    }

    if (method === 'POST' && action === 'readability') {
      requireHost(req, room);
      const body = await readJson(req);
      updateReadability(room, body.mode);
      return sendJson(res, 200, { room: publicRoom(room) });
    }

    if (method === 'POST' && action === 'topics/generate') {
      requireHost(req, room);
      const body = await readJson(req);
      room.topics = (await safeGenerateTopics(body.prompt || '')).map((t, i) => normalizeTopic(t, i));
      room.error = null;
      setPhase(room, 'TOPIC_SELECTION', 'Topic selection');
      pushComment(room, 'Topic Master posted fresh candidates.');
      return sendJson(res, 200, { room: publicRoom(room) });
    }

    if (method === 'POST' && action === 'topic') {
      requireHost(req, room);
      const body = await readJson(req);
      let topic = null;
      let moderation = null;
      if (body.customTopic) {
        moderation = await safeNormalizeCustomTopic(body.customTopic);
        if (moderation.decision === 'reject') {
          room.error = moderation.reason;
          touch(room);
          return sendJson(res, 400, { error: moderation.reason, moderation, room: publicRoom(room) });
        }
        topic = normalizeTopic({ id: id('topic_'), ...moderation });
      } else if (body.topicId) {
        topic = room.topics.find((t) => t.id === body.topicId) || SEED_TOPICS.find((t) => t.id === body.topicId);
      } else if (body.topic) {
        topic = body.topic;
      }
      if (!topic) throw apiError(400, 'No topic selected.');
      room.topic = normalizeTopic(topic);
      room.markets = [];
      room.bets = [];
      room.turns = [];
      room.streamingTurn = null;
      room.verdict = null;
      room.settlements = null;
      room.heckles = room.heckles.filter((h) => h.status === 'spent');
      assignDefaultDebaters(room);
      room.error = null;
      setPhase(room, 'PERSONA_SELECTION', 'Persona selection');
      pushComment(room, `Resolution locked: ${room.topic.resolution}`);
      return sendJson(res, 200, { room: publicRoom(room), moderation });
    }

    if (method === 'POST' && action === 'personas') {
      requireHost(req, room);
      if (!room.topic) throw apiError(400, 'Select a topic first.');
      assertDebaterEditAllowed(room);
      const body = await readJson(req);
      assignDebaters(room, body.personaAId, body.personaBId);
      room.markets = [];
      room.bets = [];
      setPhase(room, 'PERSONA_SELECTION', 'Persona selection');
      pushComment(room, `${room.debaters[0].displayName} and ${room.debaters[1].displayName} entered the arena.`);
      return sendJson(res, 200, { room: publicRoom(room) });
    }

    if (method === 'POST' && action === 'debaters') {
      requireHost(req, room);
      if (!room.topic) throw apiError(400, 'Select a topic first.');
      assertDebaterEditAllowed(room);
      const body = await readJson(req);
      assignMixedDebaters(room, body.debaterA, body.debaterB);
      room.markets = [];
      room.bets = [];
      setPhase(room, 'PERSONA_SELECTION', 'Persona selection');
      pushComment(room, `${room.debaters[0].displayName} and ${room.debaters[1].displayName} entered the arena.`);
      return sendJson(res, 200, { room: publicRoom(room) });
    }

    if (method === 'POST' && action === 'personas/custom') {
      requireHost(req, room);
      if (room.running || ['DEBATE', 'JUDGING', 'SETTLEMENT'].includes(room.status)) {
        throw apiError(409, 'Custom debaters cannot be created while a debate is running.');
      }
      const body = await readJson(req);
      const persona = await safeGenerateCustomPersona(room, body.name, body.profile ?? body.description);
      room.pendingCustomPersona = persona;
      pushComment(room, `${persona.displayName} is ready for host review.`);
      return sendJson(res, 201, { persona, room: publicRoom(room) });
    }

    if (method === 'POST' && action === 'personas/custom/accept') {
      requireHost(req, room);
      if (room.running || ['DEBATE', 'JUDGING', 'SETTLEMENT'].includes(room.status)) {
        throw apiError(409, 'Custom debaters cannot be accepted while a debate is running.');
      }
      if (!room.pendingCustomPersona) throw apiError(400, 'No custom debater draft to accept.');
      const persona = { ...room.pendingCustomPersona, id: uniquePersonaId(room, room.pendingCustomPersona.id) };
      room.customPersonas.push(persona);
      room.pendingCustomPersona = null;
      pushComment(room, `${persona.displayName} joined the debater bench.`);
      return sendJson(res, 200, { persona, room: publicRoom(room) });
    }

    if (method === 'POST' && action === 'personas/custom/discard') {
      requireHost(req, room);
      if (!room.pendingCustomPersona) throw apiError(400, 'No custom debater draft to discard.');
      const name = room.pendingCustomPersona.displayName;
      room.pendingCustomPersona = null;
      pushComment(room, `${name} left the draft board.`);
      return sendJson(res, 200, { room: publicRoom(room) });
    }

    if (method === 'POST' && action === 'odds') {
      requireHost(req, room);
      if (!room.topic) throw apiError(400, 'Select a topic first.');
      if (room.debaters.length !== 2) assignDefaultDebaters(room);
      await postOdds(room);
      return sendJson(res, 200, { room: publicRoom(room) });
    }

    if (method === 'POST' && action === 'demo-fill') {
      requireHost(req, room);
      if (room.status !== 'BETTING_OPEN') throw apiError(400, 'Open betting first.');
      addDemoAudienceAndBets(room);
      return sendJson(res, 200, { room: publicRoom(room) });
    }

    if (method === 'POST' && action === 'bets') {
      const body = await readJson(req);
      const bet = placeBet(room, body.playerId, body.marketId, body.amount);
      return sendJson(res, 201, { bet, room: publicRoom(room) });
    }

    if (method === 'POST' && action === 'turns/human') {
      const body = await readJson(req);
      submitHumanTurn(room, body.playerId, body.pendingTurnId, body.text);
      return sendJson(res, 202, { accepted: true, room: publicRoom(room) });
    }

    if (method === 'POST' && action === 'heckles') {
      const body = await readJson(req);
      const heckle = submitHeckle(room, body.playerId, body.cardId);
      return sendJson(res, 201, { heckle, room: publicRoom(room) });
    }

    if (method === 'POST' && action === 'start') {
      requireHost(req, room);
      await ensureDebateReady(room);
      startDebate(room);
      return sendJson(res, 202, { started: true, room: publicRoom(room) });
    }

    if (method === 'POST' && action === 'quick-demo') {
      requireHost(req, room);
      if (!room.topic) {
        room.topics = (await safeGenerateTopics('Maximize comedy and demo clarity.')).map((t, i) => normalizeTopic(t, i));
        room.topic = room.topics[0] || normalizeTopic(SEED_TOPICS[0]);
      }
      if (room.debaters.length !== 2) assignDefaultDebaters(room);
      if (!room.markets.length) await postOdds(room);
      if (!room.bets.length) addDemoAudienceAndBets(room);
      await ensureDebateReady(room);
      startDebate(room);
      return sendJson(res, 202, { started: true, room: publicRoom(room) });
    }

    if (method === 'POST' && action === 'reset') {
      requireHost(req, room);
      const body = await readJson(req);
      resetRoom(room, body.keepBankroll !== false);
      return sendJson(res, 200, { room: publicRoom(room) });
    }

    throw apiError(404, 'Unknown API route.');
  } catch (error) {
    console.error(error);
    sendError(res, error);
  }
}

async function serveStatic(req, res, url) {
  try {
    let rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    rel = path.normalize(rel).replace(/^([.][.][\/\\])+/, '');
    const file = path.join(publicDir, rel);
    if (!file.startsWith(publicDir)) throw new Error('forbidden');
    const data = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    const contentType = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

function normalizeTopic(topic, i = 0) {
  const fallback = SEED_TOPICS[i % SEED_TOPICS.length];
  return {
    id: cleanText(topic.id || `topic_${i + 1}`, 64).replace(/[^a-zA-Z0-9_-]/g, '_') || id('topic_'),
    resolution: cleanText(topic.resolution, 260) || fallback.resolution,
    sideA: cleanText(topic.sideA, 240) || fallback.sideA,
    sideB: cleanText(topic.sideB, 240) || fallback.sideB,
    category: cleanText(topic.category || 'absurd_general', 64),
    comedyPotential: clamp(Math.round(Number(topic.comedyPotential || 7)), 1, 10),
    safetyRating: cleanText(topic.safetyRating || 'safe', 32),
    suggestedPersonas: Array.isArray(topic.suggestedPersonas) ? topic.suggestedPersonas.map((x) => cleanText(x, 50)).filter(Boolean).slice(0, 4) : ['Formal Logician', 'Chaos Gremlin'],
  };
}

function assignDefaultDebaters(room) {
  const personas = allPersonas(room);
  const a = findPersona(room.topic?.suggestedPersonas?.[0], room) || personas[0] || PERSONAS[0];
  const b = findPersona(room.topic?.suggestedPersonas?.[1], room) || personas.find((p) => p.id !== a.id && p.id === 'chaos_gremlin') || personas.find((p) => p.id !== a.id) || PERSONAS[1];
  assignDebaters(room, a.id, b.id);
}

function assertDebaterEditAllowed(room) {
  if (room.running || ['DEBATE', 'JUDGING', 'SETTLEMENT'].includes(room.status)) {
    throw apiError(409, 'Debaters cannot be changed while a debate is running.');
  }
}

function assignDebaters(room, personaAId, personaBId) {
  const personas = allPersonas(room);
  const a = findPersona(personaAId, room) || personas[0] || PERSONAS[0];
  let b = findPersona(personaBId, room) || personas.find((p) => p.id !== a.id) || PERSONAS[1];
  if (b.id === a.id) b = personas.find((p) => p.id !== a.id) || PERSONAS[1];
  room.debaters = [makeDebater('debater_a', a, 'For', room.topic.sideA), makeDebater('debater_b', b, 'Against', room.topic.sideB)];
  clearPendingHumanTurn(room);
  touch(room);
}

function assignMixedDebaters(room, rawA, rawB) {
  const slotA = normalizeDebaterSlot(rawA);
  const slotB = normalizeDebaterSlot(rawB);
  const slots = [slotA, slotB];
  const humanCount = slots.filter((slot) => slot.kind === 'human').length;
  const aiCount = slots.filter((slot) => slot.kind === 'ai').length;
  if (humanCount !== 1 || aiCount !== 1) throw apiError(400, 'Human debate mode requires exactly one lobby player and one AI debater.');
  room.debaters = [
    makeDebaterFromSlot(room, 'debater_a', slotA, 'For', room.topic.sideA),
    makeDebaterFromSlot(room, 'debater_b', slotB, 'Against', room.topic.sideB),
  ];
  clearPendingHumanTurn(room);
  touch(room);
}

function normalizeDebaterSlot(raw) {
  if (!raw || typeof raw !== 'object') throw apiError(400, 'Each debater slot must include a kind.');
  const kind = String(raw.kind || '').trim().toLowerCase();
  if (kind === 'ai') return { kind, personaId: cleanText(raw.personaId, 100) };
  if (kind === 'human') return { kind, playerId: cleanText(raw.playerId, 100) };
  throw apiError(400, 'Debater kind must be ai or human.');
}

function makeDebaterFromSlot(room, id, slot, sideLabel, stance) {
  if (slot.kind === 'ai') {
    const persona = findPersona(slot.personaId, room);
    if (!persona) throw apiError(400, 'AI debater persona was not found.');
    return makeDebater(id, persona, sideLabel, stance);
  }
  const player = room.players.find((p) => p.id === slot.playerId && !p.isBot);
  if (!player) throw apiError(400, 'Human debater must be a lobby player.');
  return makeHumanDebater(id, player, sideLabel, stance);
}

function makeDebater(id, persona, sideLabel, stance) {
  return { id, kind: 'ai', personaId: persona.id, displayName: persona.displayName, archetype: persona.archetype, tagline: persona.tagline, style: persona.style, strengths: persona.strengths, weaknesses: persona.weaknesses, sideLabel, stance };
}

function makeHumanDebater(id, player, sideLabel, stance) {
  return {
    id,
    kind: 'human',
    playerId: player.id,
    personaId: '',
    displayName: player.displayName,
    archetype: 'Human Debater',
    tagline: 'A live lobby player steps up to the mic.',
    style: 'Natural, direct, lively, and responsive. Argues from the human speaker perspective with concise examples and practical callbacks.',
    strengths: ['live improvisation', 'authenticity', 'audience connection'],
    weaknesses: ['time pressure', 'rough edges'],
    sideLabel,
    stance,
  };
}

function humanDebaterForPlayer(room, playerId) {
  return room.debaters.find((d) => d.kind === 'human' && d.playerId === playerId) || null;
}

async function postOdds(room) {
  room.markets = await safeGenerateOdds(room);
  room.bets = [];
  room.streamingTurn = null;
  room.verdict = null;
  room.settlements = null;
  setPhase(room, 'BETTING_OPEN', 'Betting open');
  pushComment(room, 'The Oddsmaker posted the board. Fake chips only; no cash value.');
}

async function ensureDebateReady(room) {
  if (room.running) throw apiError(409, 'Debate already running.');
  if (!room.topic) throw apiError(400, 'Select a topic first.');
  if (room.debaters.length !== 2) assignDefaultDebaters(room);
  if (!room.markets.length) await postOdds(room);
}

function placeBet(room, playerId, marketId, amountRaw) {
  if (room.status !== 'BETTING_OPEN') throw apiError(400, 'Betting is not open.');
  const player = room.players.find((p) => p.id === playerId);
  if (!player) throw apiError(404, 'Player not found.');
  if (humanDebaterForPlayer(room, player.id)) throw apiError(400, 'Human debaters cannot place bets in their own round.');
  const market = room.markets.find((m) => m.id === marketId);
  if (!market) throw apiError(404, 'Market not found.');
  const amount = Math.floor(Number(amountRaw));
  if (!Number.isFinite(amount) || amount < 10) throw apiError(400, 'Minimum bet is 10 chips.');
  if (amount > 500) throw apiError(400, 'Maximum bet is 500 chips.');
  if (amount > player.bankroll) throw apiError(400, 'Insufficient fake chips.');
  player.bankroll -= amount;
  const bet = { id: id('bet_'), roomId: room.id, userId: player.id, displayName: player.displayName, marketId: market.id, marketLabel: market.label, marketType: market.type, targetDebaterId: market.targetDebaterId || '', amount, odds: market.odds, status: 'pending', payout: null, net: null, createdAt: now() };
  room.bets.push(bet);
  pushComment(room, `${player.displayName} put ${amount} chips on ${market.label}.`);
  return bet;
}

function submitHeckle(room, playerId, cardId) {
  if (!['BETTING_OPEN', 'BETTING_LOCKED', 'DEBATE'].includes(room.status)) throw apiError(400, 'Heckles are available after odds are posted and before the last closing statement.');
  const player = room.players.find((p) => p.id === playerId);
  if (!player) throw apiError(404, 'Player not found.');
  const card = HECKLE_CARDS.find((c) => c.id === cardId);
  if (!card) throw apiError(404, 'Heckle card not found.');
  if (player.bankroll < card.cost) throw apiError(400, 'Insufficient fake chips for heckle card.');
  player.bankroll -= card.cost;
  const heckle = { id: id('heckle_'), roomId: room.id, playerId: player.id, displayName: player.displayName, cardId: card.id, label: card.label, instruction: card.instruction, cost: card.cost, status: 'pending', createdAt: now(), usedTurnId: null };
  room.heckles.push(heckle);
  pushComment(room, `${player.displayName} bought a heckle card: ${card.label}.`);
  return heckle;
}

function addDemoAudienceAndBets(room) {
  for (const name of DEMO_NAMES) {
    if (room.players.length >= 12) break;
    if (!room.players.some((p) => p.displayName === name)) room.players.push(createPlayer(name, false, true));
  }
  const markets = room.markets.filter((m) => m.status === 'open');
  for (const player of room.players.filter((p) => p.isBot)) {
    if (room.bets.some((b) => b.userId === player.id)) continue;
    const market = markets[Math.floor(Math.random() * markets.length)];
    const amount = [25, 50, 75, 100, 150, 200][Math.floor(Math.random() * 6)];
    try { placeBet(room, player.id, market.id, Math.min(amount, player.bankroll)); } catch { /* ignore */ }
  }
  pushComment(room, 'Demo audience filled the room and splashed fake chips around.');
  touch(room);
}

function startDebate(room) {
  if (room.running) return;
  room.running = true;
  room.error = null;
  room.streamingTurn = null;
  clearPendingHumanTurn(room);
  setPhase(room, 'BETTING_LOCKED', 'Bets locked');
  pushComment(room, 'Bets are locked. The bell rings.');
  runDebate(room.id).catch((error) => {
    console.error(error);
    const latest = rooms.get(room.id);
    if (latest) {
      latest.running = false;
      latest.error = error.message || 'Debate runner failed.';
      setPhase(latest, 'ERROR', 'Error');
      pushComment(latest, `The pit boss tripped over a cable: ${latest.error}`);
    }
  });
}

async function collectDebateTurn(room, phase, debater, heckle) {
  if (debater.kind !== 'human') {
    return streamDebateTurn(room, phase, debater, heckle, { source: 'ai', timeoutFilled: false });
  }
  return waitForHumanTurn(room, phase, debater, heckle);
}

function waitForHumanTurn(room, phase, debater, heckle) {
  const startedAtMs = Date.now();
  const expiresAtMs = startedAtMs + HUMAN_TURN_TIMEOUT_MS;
  const pending = {
    id: id('human_turn_'),
    speakerDebaterId: debater.id,
    playerId: debater.playerId,
    speakerName: debater.displayName,
    phase: phase.phase,
    wordLimit: phase.wordLimit,
    instruction: phase.instruction,
    sideLabel: debater.sideLabel,
    stance: debater.stance,
    heckleId: heckle?.id || null,
    heckleLabel: heckle?.label || '',
    heckleInstruction: heckle?.instruction || '',
    startedAt: new Date(startedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
  room.pendingHumanTurn = pending;
  touch(room);

  return new Promise((resolve) => {
    const timeout = setTimeout(async () => {
      const latest = rooms.get(room.id);
      if (!latest?.pendingHumanTurn || latest.pendingHumanTurn.id !== pending.id) return;
      humanTurnWaiters.delete(pending.id);
      latest.pendingHumanTurn = null;
      touch(latest);
      resolve(await streamDebateTurn(latest, phase, debater, heckle, { source: 'ai_timeout', timeoutFilled: true }));
    }, HUMAN_TURN_TIMEOUT_MS);
    humanTurnWaiters.set(pending.id, { resolve, timeout });
  });
}

function submitHumanTurn(room, playerId, pendingTurnId, rawText) {
  const pending = room.pendingHumanTurn;
  if (!pending) throw apiError(409, 'No human turn is waiting for input.');
  if (pending.id !== pendingTurnId) throw apiError(409, 'That human turn is no longer active.');
  if (pending.playerId !== playerId) throw apiError(403, 'Only the active human debater can submit this turn.');
  if (Date.now() > Date.parse(pending.expiresAt)) throw apiError(409, 'This human turn timed out.');
  const text = validateHumanTurnText(rawText);
  const waiter = humanTurnWaiters.get(pending.id);
  if (!waiter) throw apiError(409, 'This human turn is not accepting submissions.');
  clearTimeout(waiter.timeout);
  humanTurnWaiters.delete(pending.id);
  room.pendingHumanTurn = null;
  touch(room);
  waiter.resolve({ text, source: 'human', timeoutFilled: false });
}

function validateHumanTurnText(rawText) {
  const text = cleanRichText(rawText, 1400);
  if (text.length < 2) throw apiError(400, 'Human turn text is required.');
  if (looksUnsafe(text)) throw apiError(400, 'Human turn text appears unsafe or not demo-friendly.');
  return text;
}

function clearPendingHumanTurn(room, result = null) {
  const pending = room.pendingHumanTurn;
  if (!pending) return;
  const waiter = humanTurnWaiters.get(pending.id);
  if (waiter) {
    clearTimeout(waiter.timeout);
    humanTurnWaiters.delete(pending.id);
    if (result) waiter.resolve(result);
  }
  room.pendingHumanTurn = null;
}

async function streamDebateTurn(room, phase, debater, heckle, options = {}) {
  const source = options.source || 'ai';
  const timeoutFilled = Boolean(options.timeoutFilled);
  const streamingTurn = {
    id: id('turn_'),
    phase: phase.phase,
    speakerDebaterId: debater.id,
    speakerName: debater.displayName,
    persona: debater.archetype,
    sideLabel: debater.sideLabel,
    heckleId: heckle?.id || null,
    heckleLabel: heckle?.label || null,
    text: '',
    source,
    timeoutFilled,
    streaming: true,
    startedAt: now(),
  };
  room.streamingTurn = streamingTurn;
  touch(room);

  const writer = createStreamingTurnWriter(room.id, streamingTurn.id);
  let finalText = '';
  try {
    finalText = await safeGenerateDebateTurn(room, phase, debater, heckle, writer);
    finalText = cleanupTurn(finalText, debater);
    await writer.finish(finalText);
  } catch (e) {
    console.error('Streaming debate fallback:', e.message);
    writer.reset();
    finalText = mockDebateTurn(room, phase, debater, heckle);
    await writer.finish(finalText);
  }

  const latest = rooms.get(room.id);
  if (latest?.streamingTurn?.id === streamingTurn.id) {
    latest.streamingTurn = null;
    touch(latest);
  }
  return { text: finalText, source, timeoutFilled, turnId: streamingTurn.id, createdAt: now() };
}

function createStreamingTurnWriter(roomId, turnId) {
  let visible = '';
  let queued = '';
  let timer = null;
  let finishRequested = false;
  let finishText = '';
  let finished = false;
  let resolveFinished = null;
  const charsPerTick = Math.max(1, Math.ceil((TRANSCRIPT_STREAM_CPS * STREAM_TICK_MS) / 1000));

  const clearTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const updateVisibleText = (text) => {
    const room = rooms.get(roomId);
    if (!room?.streamingTurn || room.streamingTurn.id !== turnId) return false;
    room.streamingTurn.text = text;
    touch(room);
    return true;
  };

  const finishIfDrained = () => {
    if (!finishRequested || queued.length || finished) return;
    visible = finishText || visible;
    updateVisibleText(visible);
    finished = true;
    clearTimer();
    resolveFinished?.();
  };

  const tick = () => {
    if (queued.length) {
      visible += queued.slice(0, charsPerTick);
      queued = queued.slice(charsPerTick);
      updateVisibleText(visible);
    }
    finishIfDrained();
  };

  const ensureTimer = () => {
    if (!timer && !finished) timer = setInterval(tick, STREAM_TICK_MS);
  };

  return {
    append(text) {
      const chunk = String(text || '');
      if (!chunk || finished) return;
      queued += chunk;
      ensureTimer();
    },
    reset() {
      visible = '';
      queued = '';
      finishRequested = false;
      finishText = '';
      finished = false;
      updateVisibleText('');
      clearTimer();
    },
    finish(finalText) {
      finishRequested = true;
      finishText = cleanRichText(finalText, 1400);
      if (!queued.length) {
        finishIfDrained();
        return Promise.resolve();
      }
      ensureTimer();
      return new Promise((resolve) => {
        resolveFinished = resolve;
      });
    },
  };
}

async function runDebate(roomId) {
  const phases = debatePhases();
  let room = requireRoom(roomId);
  room.turns = [];
  room.streamingTurn = null;
  room.pendingHumanTurn = null;
  room.verdict = null;
  room.settlements = null;
  touch(room);

  for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex += 1) {
    const phase = phases[phaseIndex];
    room = requireRoom(roomId);
    const debater = room.debaters.find((d) => d.id === phase.speakerId);
    if (!debater) throw apiError(500, `Missing debater for ${phase.speakerId}.`);
    const heckle = room.heckles.find((h) => h.status === 'pending');
    if (heckle) {
      heckle.status = 'queued';
      pushComment(room, `Heckle queued for ${debater.displayName}: ${heckle.label}.`);
    }
    setPhase(room, 'DEBATE', `${phase.phase}: ${debater.displayName}`);
    const result = await collectDebateTurn(room, phase, debater, heckle || null);
    if (result.cancelled) return;
    const turn = { id: result.turnId || id('turn_'), phase: phase.phase, speakerDebaterId: debater.id, speakerName: debater.displayName, persona: debater.archetype, sideLabel: debater.sideLabel, heckleId: heckle?.id || null, heckleLabel: heckle?.label || null, text: result.text, source: result.source, timeoutFilled: Boolean(result.timeoutFilled), createdAt: result.createdAt || now() };
    room.turns.push(turn);
    if (heckle) {
      heckle.status = 'used';
      heckle.usedTurnId = turn.id;
    }
    pushComment(room, `${debater.displayName} completed ${phase.phase.toLowerCase()}.`);
    const nextDebater = room.debaters.find((d) => d.id === phases[phaseIndex + 1]?.speakerId);
    await sleep(debater.kind !== 'human' && nextDebater?.kind !== 'human' ? DEBATE_BOT_PAUSE_MS : Math.min(500, DEBATE_BOT_PAUSE_MS));
  }

  room = requireRoom(roomId);
  room.streamingTurn = null;
  setPhase(room, 'JUDGING', 'Judge deliberation');
  pushComment(room, 'The Judge has taken the transcript under theatrical advisement.');
  room.verdict = await safeJudgeDebate(room);
  setPhase(room, 'SETTLEMENT', 'Settlement');
  room.settlements = settleBets(room);
  room.running = false;
  setPhase(room, 'RESULTS', 'Results');
  pushComment(room, `${room.verdict.winnerName} wins. The cage cashier has settled the board.`);
}

function debatePhases() {
  const full = [
    { phase: 'Opening statement', speakerId: 'debater_a', wordLimit: '90-120 words', instruction: 'Deliver a sharp opening case for your side. Establish your core frame and one memorable hook.' },
    { phase: 'Opening statement', speakerId: 'debater_b', wordLimit: '90-120 words', instruction: 'Deliver a sharp opening case for your side. Directly challenge the premise.' },
    { phase: 'Rebuttal', speakerId: 'debater_a', wordLimit: '100-140 words', instruction: 'Rebut the opponent with specific callbacks. Do not merely restate your opening.' },
    { phase: 'Rebuttal', speakerId: 'debater_b', wordLimit: '100-140 words', instruction: 'Rebut the opponent with specific callbacks. Escalate the entertainment without abandoning coherence.' },
    { phase: 'Cross-exam question', speakerId: 'debater_a', wordLimit: 'one pointed question', instruction: 'Ask one pointed cross-exam question. Make it difficult but fair.' },
    { phase: 'Cross-exam answer', speakerId: 'debater_b', wordLimit: '60-90 words', instruction: 'Answer the cross-exam question directly, then turn it to your advantage.' },
    { phase: 'Cross-exam question', speakerId: 'debater_b', wordLimit: 'one pointed question', instruction: 'Ask one pointed cross-exam question. Make it funny and strategically damaging.' },
    { phase: 'Cross-exam answer', speakerId: 'debater_a', wordLimit: '60-90 words', instruction: 'Answer the cross-exam question directly, then recover your main frame.' },
    { phase: 'Closing statement', speakerId: 'debater_a', wordLimit: '80-100 words', instruction: 'Close forcefully. Summarize why your side wins under the judge rubric.' },
    { phase: 'Closing statement', speakerId: 'debater_b', wordLimit: '80-100 words', instruction: 'Close forcefully. Summarize why your side wins under the judge rubric.' },
  ];
  if (DEBATE_SCRIPT !== 'fast') return full;
  return full.filter((_, index) => [0, 1, 2, 3, 8, 9].includes(index));
}

function settleBets(room) {
  const winner = room.verdict?.winnerDebaterId;
  const propResults = room.verdict?.propResults || [];
  const settlements = [];
  for (const bet of room.bets) {
    let won = false;
    if (bet.marketType === 'winner') won = bet.targetDebaterId === winner;
    if (bet.marketType === 'prop') won = Boolean(propResults.find((p) => p.marketId === bet.marketId)?.won);
    const payout = won ? Math.round(bet.amount * bet.odds) : 0;
    const player = room.players.find((p) => p.id === bet.userId);
    if (won && player) player.bankroll += payout;
    bet.status = won ? 'won' : 'lost';
    bet.payout = payout;
    bet.net = won ? payout - bet.amount : -bet.amount;
    settlements.push({ userId: bet.userId, displayName: bet.displayName, betId: bet.id, marketId: bet.marketId, marketLabel: bet.marketLabel, betAmount: bet.amount, odds: bet.odds, result: bet.status, payout, net: bet.net });
  }
  const leaderboard = [...room.players].sort((a, b) => b.bankroll - a.bankroll || a.displayName.localeCompare(b.displayName)).map((p, idx) => ({ rank: idx + 1, userId: p.id, displayName: p.displayName, bankroll: p.bankroll, isBot: p.isBot }));
  return { roomId: room.id, winnerDebaterId: winner, winnerName: room.verdict?.winnerName || winner, settlements, propResults, leaderboard, settledAt: now() };
}

function resetRoom(room, keepBankroll = true) {
  clearPendingHumanTurn(room, { cancelled: true });
  room.status = 'LOBBY';
  room.currentPhase = 'Lobby';
  room.phaseStartedAt = now();
  room.topics = [];
  room.topic = null;
  room.debaters = [];
  room.customPersonas = [];
  room.pendingCustomPersona = null;
  room.markets = [];
  room.bets = [];
  room.heckles = [];
  room.turns = [];
  room.streamingTurn = null;
  room.pendingHumanTurn = null;
  room.verdict = null;
  room.settlements = null;
  room.running = false;
  room.error = null;
  if (!keepBankroll) for (const p of room.players) p.bankroll = 1000;
  pushComment(room, keepBankroll ? 'Room reset. Bankrolls preserved.' : 'Room reset. Bankrolls restored to 1,000.');
  touch(room);
}

async function safeGenerateTopics(prompt) {
  if (MOCK_AI) return shuffle(SEED_TOPICS).slice(0, 5);
  try {
    return (await openAIStructured({
      task: 'setup',
      name: 'topic_candidates',
      schema: { type: 'object', additionalProperties: false, properties: { topics: { type: 'array', items: topicSchema() } }, required: ['topics'] },
      system: 'You are Topic Master for AI Debate Casino, a fake-chip party debate game. Generate safe, absurd, demo-friendly debate topics. Avoid real political persuasion, hate, explicit sexual content, real private people, medical/legal advice, and grim subject matter. Prefer workplace absurdism, technology, philosophy, animals, business parody, and harmless pop-culture-adjacent premises.',
      user: `Generate five debate topics. Optional host flavor: ${cleanText(prompt, 240) || '(none)'}`,
      maxOutputTokens: 1600,
    })).topics.slice(0, 5);
  } catch (e) {
    console.error('Topic fallback:', e.message);
    return shuffle(SEED_TOPICS).slice(0, 5);
  }
}

async function safeNormalizeCustomTopic(customTopic) {
  const raw = cleanText(customTopic, 320);
  if (!raw) return rejectTopic('Empty topic.');
  if (looksUnsafe(raw)) return rejectTopic('The topic appears unsafe or not demo-friendly.');
  if (MOCK_AI) return heuristicTopic(raw);
  try {
    return await openAIStructured({
      task: 'setup',
      name: 'custom_topic_moderation',
      schema: { type: 'object', additionalProperties: false, properties: { decision: { type: 'string', enum: ['allow', 'rewrite', 'reject'] }, reason: { type: 'string' }, resolution: { type: 'string' }, sideA: { type: 'string' }, sideB: { type: 'string' }, category: { type: 'string' }, comedyPotential: { type: 'integer' }, safetyRating: { type: 'string' }, suggestedPersonas: { type: 'array', items: { type: 'string' } } }, required: ['decision', 'reason', 'resolution', 'sideA', 'sideB', 'category', 'comedyPotential', 'safetyRating', 'suggestedPersonas'] },
      system: 'Moderate and normalize topics for a fake-chip comedic AI debate game. Reject hate, explicit sexual content, self-harm, illegal instructions, targeted harassment, private-person attacks, actionable medical/legal/financial advice, and current-political misinformation. Rewrite mild issues into safe absurd equivalents. Return complete fields even on reject.',
      user: `Custom topic: ${raw}`,
      maxOutputTokens: 900,
    });
  } catch (e) {
    console.error('Custom topic fallback:', e.message);
    return heuristicTopic(raw);
  }
}

function heuristicTopic(raw) {
  const clean = raw.replace(/^resolved:\s*/i, '').replace(/\.$/, '').trim() || 'A raccoon could run a profitable SaaS company';
  let neg = `The proposition is false: ${clean}.`;
  if (/\bshould\b/i.test(clean)) neg = clean.replace(/\bshould\b/i, 'should not') + '.';
  else if (/\bcould\b/i.test(clean)) neg = clean.replace(/\bcould\b/i, 'could not') + '.';
  else if (/\bis\b/i.test(clean)) neg = clean.replace(/\bis\b/i, 'is not') + '.';
  return { decision: 'allow', reason: 'Heuristic normalization used.', resolution: `Resolved: ${clean}.`, sideA: `${clean}.`, sideB: neg, category: 'custom_absurdism', comedyPotential: 7, safetyRating: 'safe', suggestedPersonas: ['Formal Logician', 'Chaos Gremlin'] };
}

function rejectTopic(reason) {
  return { decision: 'reject', reason, resolution: '', sideA: '', sideB: '', category: '', comedyPotential: 1, safetyRating: 'rejected', suggestedPersonas: [] };
}

function looksUnsafe(text) {
  return [/\bkill\b/i, /\bsuicide\b/i, /\bself[- ]?harm\b/i, /\bterror/i, /\bbomb\b/i, /\bchild sexual\b/i, /\bgenocide\b/i, /\bdoxx/i, /\bhow to commit\b/i].some((rx) => rx.test(text));
}

function topicSchema() {
  return { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, resolution: { type: 'string' }, sideA: { type: 'string' }, sideB: { type: 'string' }, category: { type: 'string' }, comedyPotential: { type: 'integer' }, safetyRating: { type: 'string' }, suggestedPersonas: { type: 'array', items: { type: 'string' } } }, required: ['id', 'resolution', 'sideA', 'sideB', 'category', 'comedyPotential', 'safetyRating', 'suggestedPersonas'] };
}

async function safeGenerateCustomPersona(room, rawName, rawDescription) {
  const { name, description } = validateCustomPersonaInput(rawName, rawDescription);
  if (looksUnsafe(name) || looksUnsafe(description)) throw apiError(400, 'Custom debater appears unsafe or not demo-friendly.');
  if (MOCK_AI) return fallbackCustomPersona(room, name, description);
  try {
    const parsed = await openAIStructured({
      task: 'setup',
      name: 'custom_debater_personality',
      schema: customPersonaSchema(),
      system: 'You are the casting director for AI Debate Casino, a fake-chip comedic debate game. Generate one safe, ridiculous, playable debate persona from the submitted debater name and description. Keep the submitted name unchanged outside this schema. Do not make the archetype the same as the submitted name. Avoid hate, explicit sexual content, real private people, harmful instructions, and current-political persuasion. The persona should be funny, distinctive, and useful in a structured debate.',
      user: JSON.stringify({ name, description, existingPersonas: allPersonas(room).map((p) => ({ displayName: p.displayName, archetype: p.archetype })) }, null, 2),
      maxOutputTokens: 900,
    });
    return sanitizeCustomPersona(room, name, description, parsed);
  } catch (e) {
    console.error('Custom persona fallback:', e.message);
    return fallbackCustomPersona(room, name, description);
  }
}

function validateCustomPersonaInput(rawName, rawDescription) {
  const name = cleanText(rawName, 200);
  const description = cleanText(rawDescription, 1200);
  if (name.length < 2 || name.length > 48) throw apiError(400, 'Debater name must be 2-48 characters.');
  if (description.length < 10 || description.length > 600) throw apiError(400, 'Debater description must be 10-600 characters.');
  return { name, description };
}

function customPersonaSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      archetype: { type: 'string' },
      tagline: { type: 'string' },
      style: { type: 'string' },
      strengths: { type: 'array', items: { type: 'string' } },
      weaknesses: { type: 'array', items: { type: 'string' } },
    },
    required: ['archetype', 'tagline', 'style', 'strengths', 'weaknesses'],
  };
}

function sanitizeCustomPersona(room, name, description, raw) {
  const fallback = fallbackCustomPersona(room, name, description);
  let archetype = cleanText(raw?.archetype, 64) || fallback.archetype;
  if (normalizePersonaLabelPart(archetype) === normalizePersonaLabelPart(name)) archetype = fallback.archetype;
  if (normalizePersonaLabelPart(archetype) === normalizePersonaLabelPart(name)) archetype = 'Audience Wildcard';
  return {
    id: uniquePersonaId(room, customPersonaIdBase(name, description)),
    displayName: name,
    archetype,
    tagline: cleanText(raw?.tagline, 120) || fallback.tagline,
    style: cleanText(raw?.style, 420) || fallback.style,
    strengths: sanitizePersonaList(raw?.strengths, fallback.strengths, 3),
    weaknesses: sanitizePersonaList(raw?.weaknesses, fallback.weaknesses, 2),
  };
}

function fallbackCustomPersona(room, name, description) {
  const seed = hashNumber(`${name}|${description}`);
  const archetypes = ['Parking Lot Prophet', 'Microwave Monarch', 'Budget Oracle', 'Snack Bar Absolutist', 'Calendar Warlord', 'Breakroom Theorist'];
  const strengthBank = [
    ['surprise framing', 'audience energy', 'memorable analogies'],
    ['procedural traps', 'dry humor', 'topic control'],
    ['practical examples', 'fast rebuttals', 'crowd sympathy'],
    ['absurd confidence', 'callback discipline', 'comic escalation'],
  ];
  const weaknessBank = [
    ['overcommits to the bit', 'logic can wobble'],
    ['gets lost in side quests', 'too many invented rules'],
    ['confuses confidence for evidence', 'occasionally grandstands'],
    ['treats small details as destiny', 'under-explains obvious leaps'],
  ];
  const hint = cleanText(description.replace(/[.!?].*$/, ''), 90).toLowerCase();
  return {
    id: uniquePersonaId(room, customPersonaIdBase(name, description)),
    displayName: name,
    archetype: archetypes[seed % archetypes.length],
    tagline: `${name} has entered with a theory nobody budgeted for.`,
    style: `Ridiculous, committed, and debate-ready. Builds arguments from ${hint || 'the submitted premise'}, then escalates them into punchy claims, callbacks, and strangely usable logic.`,
    strengths: strengthBank[seed % strengthBank.length],
    weaknesses: weaknessBank[seed % weaknessBank.length],
  };
}

function sanitizePersonaList(value, fallback, maxItems) {
  const items = (Array.isArray(value) ? value : [])
    .map((item) => cleanText(item, 48))
    .filter(Boolean)
    .slice(0, maxItems);
  return items.length ? items : fallback.slice(0, maxItems);
}

function customPersonaIdBase(name, description) {
  const slug = slugify(name, 30) || 'custom_debater';
  return `custom_${slug}_${hashNumber(`${name}|${description}`).toString(36)}`;
}

function slugify(value, max = 40) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
    .replace(/_+$/g, '');
}

function uniquePersonaId(room, base) {
  const used = new Set(allPersonas(room).map((p) => p.id));
  let candidate = cleanText(base, 80).replace(/[^a-zA-Z0-9_-]/g, '_') || id('custom_');
  const root = candidate;
  let i = 2;
  while (used.has(candidate)) candidate = `${root}_${i++}`;
  return candidate;
}

async function safeGenerateOdds(room) {
  if (MOCK_AI) return fallbackMarkets(room);
  try {
    const parsed = await openAIStructured({
      task: 'setup',
      name: 'betting_markets',
      schema: { type: 'object', additionalProperties: false, properties: { houseNote: { type: 'string' }, markets: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, type: { type: 'string', enum: ['winner', 'prop'] }, label: { type: 'string' }, targetDebaterId: { type: 'string' }, odds: { type: 'number' }, rationale: { type: 'string' }, settleRule: { type: 'string' }, status: { type: 'string' } }, required: ['id', 'type', 'label', 'targetDebaterId', 'odds', 'rationale', 'settleRule', 'status'] } } }, required: ['houseNote', 'markets'] },
      system: 'You are The Oddsmaker for AI Debate Casino. Create fake-chip betting markets. Produce exactly two winner markets, one for debater_a and one for debater_b, plus two simple prop bets that can be settled from the transcript. Decimal odds should be between 1.55 and 3.5. Keep rationales short and funny. Never imply real gambling or financial advice.',
      user: JSON.stringify({ topic: room.topic, debaters: room.debaters }, null, 2),
      maxOutputTokens: 1400,
    });
    return sanitizeMarkets(room, parsed.markets);
  } catch (e) {
    console.error('Odds fallback:', e.message);
    return fallbackMarkets(room);
  }
}

function sanitizeMarkets(room, markets) {
  const fallback = fallbackMarkets(room);
  const cleaned = [];
  for (const raw of Array.isArray(markets) ? markets : []) {
    const type = raw.type === 'prop' ? 'prop' : 'winner';
    let target = ['debater_a', 'debater_b'].includes(raw.targetDebaterId) ? raw.targetDebaterId : '';
    if (type === 'winner' && !target) target = cleaned.some((m) => m.targetDebaterId === 'debater_a') ? 'debater_b' : 'debater_a';
    cleaned.push({ id: cleanText(raw.id || id('m_'), 64).replace(/[^a-zA-Z0-9_-]/g, '_'), type, label: cleanText(raw.label, 96) || 'Mystery market', targetDebaterId: target, odds: clamp(Number(raw.odds || 2), 1.2, 4.5), rationale: cleanText(raw.rationale, 180) || 'The house knows what it saw.', settleRule: cleanText(raw.settleRule, 220) || 'Settle from the transcript.', status: 'open' });
  }
  const winnerA = cleaned.find((m) => m.type === 'winner' && m.targetDebaterId === 'debater_a') || fallback[0];
  const winnerB = cleaned.find((m) => m.type === 'winner' && m.targetDebaterId === 'debater_b') || fallback[1];
  const props = cleaned.filter((m) => m.type === 'prop').slice(0, 2);
  return [winnerA, winnerB, ...(props.length ? props : fallback.slice(2))];
}

function fallbackMarkets(room) {
  const a = room.debaters[0] || { displayName: 'Debater A' };
  const b = room.debaters[1] || { displayName: 'Debater B' };
  const wobble = hashNumber(room.id + (room.topic?.resolution || '')) % 18;
  return [
    { id: 'winner_a', type: 'winner', label: `${a.displayName} wins`, targetDebaterId: 'debater_a', odds: Number((1.75 + wobble / 100).toFixed(2)), rationale: 'Strong fundamentals, but the premise may bite back.', settleRule: 'Wins if the judge selects debater_a.', status: 'open' },
    { id: 'winner_b', type: 'winner', label: `${b.displayName} wins`, targetDebaterId: 'debater_b', odds: Number((2.35 - wobble / 110).toFixed(2)), rationale: 'Volatility premium. Could be genius, could be a flaming spreadsheet.', settleRule: 'Wins if the judge selects debater_b.', status: 'open' },
    { id: 'prop_animal_analogy', type: 'prop', label: 'Someone uses an animal analogy', targetDebaterId: '', odds: 1.65, rationale: 'This room is one metaphor away from a petting zoo.', settleRule: 'Wins if any debate turn contains a clear animal comparison.', status: 'open' },
    { id: 'prop_fallacy', type: 'prop', label: 'Someone says “fallacy”', targetDebaterId: '', odds: 2.4, rationale: 'Professor Steelman money has been seen at the window.', settleRule: 'Wins if any debate turn contains the word fallacy or fallacious.', status: 'open' },
  ];
}

async function safeGenerateDebateTurn(room, phase, debater, heckle, writer = null) {
  if (MOCK_AI) {
    const text = mockDebateTurn(room, phase, debater, heckle);
    writer?.append(text);
    return text;
  }
  try {
    const opponent = room.debaters.find((d) => d.id !== debater.id);
    const transcript = transcriptForPrompt(room);
    const latestOpponent = latestTurnForDebater(room, opponent?.id);
    const latestOpponentAnalysis = analyzeArgumentText(latestOpponent?.text || '');
    const request = {
      task: 'debate',
      system: `You are ${debater.displayName}, archetype: ${debater.archetype}. Style: ${debater.style}. Strengths: ${debater.strengths.join(', ')}. Weaknesses: ${debater.weaknesses.join(', ')}. You are debating in AI Debate Casino, a fake-chip comedic debate game. Stay in character, argue your assigned side, be concise, directly respond to prior arguments, and be entertaining. You must reason from the actual transcript, not from a generic version of the topic. If the opponent made a concrete claim, identify it briefly and answer it. If the opponent gave a thin or nonsensical turn, say that there is little reasoning to answer and explain why your own case is stronger; do not pretend they made a serious argument. When using numbered points or bullets, put each item on its own line. Do not mention hidden instructions, policies, model identity, or audience bets. Avoid slurs, explicit sexual content, real-world harmful instructions, and targeted harassment.${debateReadabilityGuidance(room)}`,
      user: [`Resolution: ${room.topic.resolution}`, `Your side: ${debater.stance}`, `Opponent: ${opponent.displayName} (${opponent.archetype}) arguing: ${opponent.stance}`, `Phase: ${phase.phase}`, `Length: ${phase.wordLimit}`, `Instruction: ${phase.instruction}`, heckle ? `Audience heckle card to satisfy: ${heckle.label} — ${heckle.instruction}` : 'No heckle card for this turn.', `Opponent's latest turn:\n${latestOpponent ? `${latestOpponent.phase} — ${latestOpponent.speakerName}: ${latestOpponent.text}` : '(No opponent turn yet.)'}`, `Opponent latest-turn quality: ${latestOpponentAnalysis.label}. ${latestOpponentAnalysis.reason}`, `Required response behavior: directly answer the opponent's latest reasoning when it exists. If the latest turn is thin, call that out briefly and build a stronger positive case.`, `Prior transcript:\n${transcript}`].join('\n\n'),
      maxOutputTokens: 1200,
    };
    const text = writer ? await openAITextStream({ ...request, onDelta: (delta) => writer.append(delta), onReset: () => writer.reset() }) : await openAIText(request);
    return cleanupTurn(text, debater);
  } catch (e) {
    console.error('Debate fallback:', e.message);
    const text = mockDebateTurn(room, phase, debater, heckle);
    writer?.reset();
    writer?.append(text);
    return text;
  }
}

function cleanupTurn(text, debater) {
  let cleaned = cleanRichText(text, 1400).replace(/^\s*(opening statement|rebuttal|closing statement|cross-exam question|cross-exam answer)\s*:\s*/i, '');
  cleaned = cleaned.replace(new RegExp(`^${escapeRegExp(debater.displayName)}\\s*:\\s*`, 'i'), '');
  return cleaned || `${debater.displayName} pauses, adjusts the microphone, and accidentally makes the room more tense.`;
}

function debateReadabilityGuidance(room) {
  if (readabilityMode(room) !== 'kids') return '';
  return ' Kid-friendly readability mode is on. Write for grades 5-6. Use short sentences, concrete examples, and plain words. Avoid business jargon, legalese, abstract strategy terms, and dense metaphors. Keep the persona flavor and jokes, but make the argument easy for a 10-12 year old to follow. Keep the same debate structure and word limit.';
}

function judgeReadabilityGuidance(room) {
  if (readabilityMode(room) !== 'kids') return '';
  return ' Kid-friendly readability mode is on. Explain the winner in plain grades 5-6 language. Keep the score labels unchanged, but make verdict, bestLine, and worstArgument.summary easy for a 10-12 year old to understand. Use short sentences and concrete reasons.';
}

function transcriptForPrompt(room) {
  return room.turns.map((t) => {
    const source = t.source === 'human' ? 'typed live by human' : t.timeoutFilled ? 'AI timeout fill-in' : 'AI generated';
    return `${t.phase} — ${t.speakerName} (${t.persona}, ${t.sideLabel}, ${source}): ${t.text}`;
  }).join('\n\n') || '(No prior turns.)';
}

function latestTurnForDebater(room, debaterId) {
  return [...room.turns].reverse().find((t) => t.speakerDebaterId === debaterId) || null;
}

function analyzeArgumentText(text) {
  const cleaned = cleanRichText(text, 1400);
  const words = cleaned.match(/[A-Za-z0-9']+/g) || [];
  const alpha = cleaned.replace(/[^A-Za-z0-9]/g, '');
  const lower = cleaned.toLowerCase();
  const isFiller = !alpha || /^(what|why|huh|ok|okay|yes|no|nah|idk|lol|lmao|sure|maybe|fine|\?+|!+|\.+)+$/i.test(cleaned.replace(/\s+/g, ''));
  const reasonMarkers = (lower.match(/\b(because|therefore|so|if|then|should|would|means|causes|risk|benefit|incentive|consequence|evidence|example|claim|reason|logic|tradeoff|standard|impact)\b/g) || []).length;
  const hasStance = /\b(should|would|could|must|better|worse|not|because|therefore|means)\b/i.test(cleaned);
  let score = 0;
  if (words.length >= 4 && !isFiller) score += 2;
  if (words.length >= 15) score += 2;
  if (words.length >= 40) score += 1;
  if (reasonMarkers) score += Math.min(3, reasonMarkers);
  if (hasStance) score += 1;
  if (/[.!?]/.test(cleaned) && words.length >= 8) score += 1;
  score = clamp(score, 0, 10);
  const thin = score < 3;
  const label = thin ? 'thin/no substantive argument' : score >= 7 ? 'substantive argument' : 'partial argument';
  const reason = thin
    ? 'It contains too little reasoning, evidence, or claim structure to treat as a serious argument.'
    : `It contains ${words.length} words and ${reasonMarkers} explicit reasoning marker${reasonMarkers === 1 ? '' : 's'}.`;
  return { text: cleaned, words, wordCount: words.length, score, thin, label, reason };
}

function opponentResponseLine(room, opponent, kids = false) {
  const latest = latestTurnForDebater(room, opponent?.id);
  if (!latest) return kids ? 'I will set up my own clear reason before my opponent has a turn to answer.' : 'I will set the frame before my opponent has a record to answer.';
  const analysis = analyzeArgumentText(latest.text);
  const quote = shortTurnQuote(latest.text);
  if (analysis.thin) {
    return kids
      ? `${opponent.displayName}'s latest turn was "${quote}", which is not a real reason yet. I will answer by giving the judge a clearer reason.`
      : `${opponent.displayName}'s latest turn was "${quote}", which gives the judge almost no reasoning to evaluate. I will not invent an argument for them; I will show why my side has the stronger frame.`;
  }
  return kids
    ? `${opponent.displayName}'s main point was "${quote}". My answer is that this misses what would actually happen next.`
    : `${opponent.displayName}'s strongest recent point was "${quote}". That point fails because it treats one surface detail as if it controls the whole resolution.`;
}

function shortTurnQuote(text, max = 130) {
  const cleaned = cleanRichText(text, max);
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).trim()}...`;
}

function mockDebateTurn(room, phase, debater, heckle) {
  if (readabilityMode(room) === 'kids') return mockKidsDebateTurn(room, phase, debater, heckle);
  const opponent = room.debaters.find((d) => d.id !== debater.id) || { displayName: 'my opponent' };
  const stance = String(debater.stance || '').replace(/[.!?]+$/, '');
  const heckleSentence = heckle ? ` Because the audience bought ${heckle.label}, let me comply: ${mockHeckleLine(heckle)} ` : ' ';
  const responseLine = opponentResponseLine(room, opponent, false);
  if (phase.phase.includes('question')) return `${opponent.displayName}, identify the single strongest assumption behind your case and explain why the judge should trust it instead of treating it as a decorative napkin under a collapsing argument. ${responseLine}${heckleSentence}`;
  if (phase.phase.includes('answer')) return `The assumption is not decorative; it is structural. ${responseLine}${heckleSentence}My side explains incentives, behavior, and consequences; theirs has to survive direct contact with the transcript.`;
  if (phase.phase.includes('Closing')) return `The round is clear. ${responseLine}${heckleSentence}I gave the judge a usable frame: ${stance} because it better explains incentives, consequences, and the absurd machinery of human decision-making. Reward the side that made the strange premise intelligible. Vote ${debater.displayName}.`;
  const byPersona = {
    formal_logician: `I will make this simple. First, ${stance} is not a vibe; it is a claim about incentives and outcomes. ${responseLine}${heckleSentence}The judge should reward the side that explains cause and effect rather than merely juggling adjectives.`,
    chaos_gremlin: `Let us stop pretending this is a normal debate. The resolution is a shopping cart with a law degree, and I am willing to climb inside and steer. ${responseLine}${heckleSentence}${stance} because reality already runs on stranger arrangements: meetings, password policies, and adults saying “circle back.”`,
    venture_capitalist: `I see a scalable thesis here. ${responseLine}${heckleSentence}${stance} because the market rewards asymmetry, not dignity. The right question is whether it has distribution, defensibility, and a path to recurring value.`,
    retired_admiral: `This is a question of command, logistics, and operational discipline. ${responseLine}${heckleSentence}${stance} because institutions fail from weak supply lines and confused authority. I will identify the objective and secure the argument.`,
    corporate_lawyer: `Subject to several qualifications, ${stance}. ${responseLine}${heckleSentence}We must ask who bears risk, who has authority, what standard applies, and whether the premise survives basic due diligence.`,
    reddit_moderator: `I am already seeing problems with the opposing framing. ${responseLine}${heckleSentence}${stance}, and before anyone calls that pedantic, evidence and definitions are the table stakes of this round.`,
    ancient_philosopher: `The question before us is not merely ${room.topic.resolution.replace(/^Resolved:\s*/i, '')}. ${responseLine}${heckleSentence}It is whether our civilization still recognizes wisdom when it arrives wearing an absurd mask.`,
    product_manager: `From a user-outcome perspective, ${stance}. ${responseLine}${heckleSentence}We need to define success metrics, validate the core workflow, and avoid letting legacy assumptions block an unexpectedly viable feature set.`,
  };
  return byPersona[debater.personaId] || byPersona.formal_logician;
}

function mockKidsDebateTurn(room, phase, debater, heckle) {
  const opponent = room.debaters.find((d) => d.id !== debater.id) || { displayName: 'my opponent' };
  const stance = String(debater.stance || '').replace(/[.!?]+$/, '');
  const heckleSentence = heckle ? ` The audience also gave me ${heckle.label}, so here is the simple version: ${mockKidsHeckleLine(heckle)} ` : ' ';
  const responseLine = opponentResponseLine(room, opponent, true);
  if (phase.phase.includes('question')) return `${opponent.displayName}, what is the biggest reason your side works? Please say it in one clear sentence so everyone at the table can follow it. ${responseLine}${heckleSentence}`;
  if (phase.phase.includes('answer')) return `Here is the simple answer. ${responseLine}${heckleSentence}My side works because it explains what would happen next. That is why the judge should trust my side.`;
  if (phase.phase.includes('Closing')) return `The round is simple. ${responseLine}${heckleSentence}I showed why ${stance}. The judge should pick the side that explains the problem in a way people can use. Vote ${debater.displayName}.`;
  const byPersona = {
    formal_logician: `I will keep this clear. ${stance} because the reasons fit together. ${responseLine}${heckleSentence}My side explains what would happen and why that result makes sense.`,
    chaos_gremlin: `This topic is weird, but we can still understand it. ${responseLine}${heckleSentence}${stance} because the world already runs on weird rules. People follow calendars, passwords, and meetings.`,
    venture_capitalist: `Here is the simple pitch. ${responseLine}${heckleSentence}${stance} because good ideas solve a problem and keep people coming back. The real test is whether it can work.`,
    retired_admiral: `This is about planning and follow-through. ${responseLine}${heckleSentence}${stance} because a good plan needs clear jobs, steady rules, and people who know what to do next.`,
    corporate_lawyer: `Let us check the simple facts. ${stance}. ${responseLine}${heckleSentence}Who is in charge? What could go wrong? What rule decides the answer? My side answers those questions better.`,
    reddit_moderator: `I see the problem with my opponent's argument. ${responseLine}${heckleSentence}${stance} because they need more than a loud objection. They need proof.`,
    ancient_philosopher: `This may sound like a joke, but jokes can teach us something. ${responseLine}${heckleSentence}${stance} because the funny idea helps us see a real rule about people, choices, and fairness.`,
    product_manager: `Think about the people using this idea. ${stance}. ${responseLine}${heckleSentence}If it helps them, if they come back, and if the rules are clear, then the idea has a real chance.`,
  };
  return byPersona[debater.personaId] || byPersona.formal_logician;
}

function mockHeckleLine(heckle) {
  if (heckle.cardId === 'pirate_analogy') return 'like a pirate choosing between treasure and a spreadsheet, the map matters more than the hat.';
  if (heckle.cardId === 'explain_to_child') return 'imagine two cookies, one rule, and a goose who keeps moving the plate.';
  if (heckle.cardId === 'legal_caveat') return 'subject, naturally, to the survival of any indemnity clause hiding in the snack drawer.';
  if (heckle.cardId === 'military_metaphor') return 'the opposing case has advanced beyond its supply lines and is now vulnerable on both flanks.';
  return 'the premise behaves like a raccoon with a clipboard: chaotic, but weirdly operational.';
}

function mockKidsHeckleLine(heckle) {
  if (heckle.cardId === 'pirate_analogy') return 'it is like a pirate needing a map before sailing.';
  if (heckle.cardId === 'explain_to_child') return 'it is like sharing cookies: the rule matters because everyone wants a fair turn.';
  if (heckle.cardId === 'legal_caveat') return 'there still has to be a rule that says who is responsible.';
  if (heckle.cardId === 'military_metaphor') return 'it is like a team needing a clear plan before a big game.';
  return 'it is like comparing two animals and asking which one follows the rules better.';
}

async function safeJudgeDebate(room) {
  if (MOCK_AI) return mockJudge(room);
  try {
    const qualityReport = debateQualityReport(room);
    const parsed = await openAIStructured({
      task: 'judge',
      name: 'judge_verdict',
      schema: judgeSchema(),
      system: `You are The Honorable Judge Bottington III for AI Debate Casino. Score a comedic debate from the actual transcript only. You must choose exactly one winner; no ties. Use the rubric: logical coherence, responsiveness, rhetorical force, humor, originality, topic control. Reward both logic and entertainment, but do not reward a debater for merely having a funny persona if their transcript turns are empty, evasive, generic, or disconnected from the opponent. Penalize "what", punctuation-only, filler, and other non-arguments heavily: they should receive very low logic, responsiveness, rhetorical force, originality, and topic control. Reward direct engagement with the opponent's real claims. Do not invent arguments that are not in the transcript. Do not consider betting distribution. Also settle prop markets from the transcript using clear evidence.${judgeReadabilityGuidance(room)}`,
      user: JSON.stringify({ topic: room.topic, debaters: room.debaters, markets: room.markets.filter((m) => m.type === 'prop'), heckles: room.heckles, transcript: room.turns, qualityReport }, null, 2),
      maxOutputTokens: 2400,
    });
    return sanitizeVerdict(room, parsed);
  } catch (e) {
    console.error('Judge fallback:', e.message);
    return mockJudge(room);
  }
}

function scoreSchema() {
  return { type: 'object', additionalProperties: false, properties: { logicalCoherence: { type: 'integer' }, responsiveness: { type: 'integer' }, rhetoricalForce: { type: 'integer' }, humor: { type: 'integer' }, originality: { type: 'integer' }, topicControl: { type: 'integer' }, total: { type: 'integer' } }, required: ['logicalCoherence', 'responsiveness', 'rhetoricalForce', 'humor', 'originality', 'topicControl', 'total'] };
}

function judgeSchema() {
  return { type: 'object', additionalProperties: false, properties: { winnerDebaterId: { type: 'string', enum: ['debater_a', 'debater_b'] }, winnerName: { type: 'string' }, margin: { type: 'string', enum: ['razor-thin', 'narrow', 'clear', 'landslide'] }, confidence: { type: 'number' }, scores: { type: 'object', additionalProperties: false, properties: { debater_a: scoreSchema(), debater_b: scoreSchema() }, required: ['debater_a', 'debater_b'] }, bestLine: { type: 'object', additionalProperties: false, properties: { debaterId: { type: 'string' }, quote: { type: 'string' } }, required: ['debaterId', 'quote'] }, worstArgument: { type: 'object', additionalProperties: false, properties: { debaterId: { type: 'string' }, summary: { type: 'string' } }, required: ['debaterId', 'summary'] }, verdict: { type: 'string' }, propResults: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { marketId: { type: 'string' }, won: { type: 'boolean' }, evidence: { type: 'string' }, confidence: { type: 'number' } }, required: ['marketId', 'won', 'evidence', 'confidence'] } } }, required: ['winnerDebaterId', 'winnerName', 'margin', 'confidence', 'scores', 'bestLine', 'worstArgument', 'verdict', 'propResults'] };
}

function sanitizeVerdict(room, v) {
  let winnerDebaterId = v.winnerDebaterId === 'debater_b' ? 'debater_b' : 'debater_a';
  const props = room.markets.filter((m) => m.type === 'prop');
  const scores = applyTranscriptQualityCaps(room, { debater_a: sanitizeScore(v.scores?.debater_a), debater_b: sanitizeScore(v.scores?.debater_b) });
  const otherDebaterId = winnerDebaterId === 'debater_a' ? 'debater_b' : 'debater_a';
  if (scores[otherDebaterId].total > scores[winnerDebaterId].total) winnerDebaterId = otherDebaterId;
  const winner = room.debaters.find((d) => d.id === winnerDebaterId) || room.debaters[0];
  return {
    winnerDebaterId,
    winnerName: winner.displayName,
    margin: ['razor-thin', 'narrow', 'clear', 'landslide'].includes(v.margin) ? v.margin : 'narrow',
    confidence: clamp(Number(v.confidence || 0.72), 0, 1),
    scores,
    bestLine: { debaterId: ['debater_a', 'debater_b'].includes(v.bestLine?.debaterId) ? v.bestLine.debaterId : winnerDebaterId, quote: cleanRichText(v.bestLine?.quote || findBestLine(room, winnerDebaterId), 280) },
    worstArgument: { debaterId: ['debater_a', 'debater_b'].includes(v.worstArgument?.debaterId) ? v.worstArgument.debaterId : (winnerDebaterId === 'debater_a' ? 'debater_b' : 'debater_a'), summary: cleanRichText(v.worstArgument?.summary || 'Overextended a premise without enough support.', 240) },
    verdict: cleanRichText(v.verdict || `${winner.displayName} wins by narrow margin.`, 1400),
    propResults: props.map((m) => {
      const found = Array.isArray(v.propResults) ? v.propResults.find((p) => p.marketId === m.id) : null;
      return { marketId: m.id, won: Boolean(found?.won), evidence: cleanText(found?.evidence || 'No decisive evidence found.', 220), confidence: clamp(Number(found?.confidence || 0.55), 0, 1) };
    }),
  };
}

function sanitizeScore(s) {
  const keys = ['logicalCoherence', 'responsiveness', 'rhetoricalForce', 'humor', 'originality', 'topicControl'];
  const out = {};
  for (const key of keys) out[key] = normalizeScoreValue(s?.[key], 6);
  out.total = keys.reduce((sum, key) => sum + out[key], 0);
  return out;
}

function normalizeScoreValue(value, fallback = 6) {
  const n = Number(value);
  return Number.isFinite(n) ? clamp(Math.round(n), 0, 10) : fallback;
}

function debateQualityReport(room) {
  return Object.fromEntries((room.debaters || []).map((debater) => {
    const performance = analyzeDebaterPerformance(room, debater.id);
    return [debater.id, {
      displayName: debater.displayName,
      kind: debater.kind || 'ai',
      turnCount: performance.turns.length,
      substantiveTurnCount: performance.substantiveTurnCount,
      totalWords: performance.totalWords,
      averageArgumentScore: performance.averageArgumentScore,
      note: performance.note,
      turns: performance.turns.map((t) => ({ phase: t.phase, wordCount: t.analysis.wordCount, quality: t.analysis.label, reason: t.analysis.reason, text: t.text })),
    }];
  }));
}

function analyzeDebaterPerformance(room, debaterId) {
  const turns = room.turns.filter((t) => t.speakerDebaterId === debaterId).map((turn) => ({ ...turn, analysis: analyzeArgumentText(turn.text) }));
  const totalWords = turns.reduce((sum, turn) => sum + turn.analysis.wordCount, 0);
  const substantiveTurnCount = turns.filter((turn) => !turn.analysis.thin).length;
  const averageArgumentScore = turns.length ? turns.reduce((sum, turn) => sum + turn.analysis.score, 0) / turns.length : 0;
  const note = !turns.length
    ? 'No transcript turns.'
    : substantiveTurnCount === 0
      ? 'No substantive turns; heavily penalize this debater.'
      : `${substantiveTurnCount}/${turns.length} turns were substantive.`;
  return { turns, totalWords, substantiveTurnCount, averageArgumentScore, note };
}

function scoreFromPerformance(room, debaterId) {
  const performance = analyzeDebaterPerformance(room, debaterId);
  const avg = performance.averageArgumentScore;
  const hasSubstance = performance.substantiveTurnCount > 0;
  const responsiveness = estimateResponsiveness(room, debaterId);
  const base = hasSubstance ? clamp(Math.round(avg), 2, 9) : 1;
  const score = {
    logicalCoherence: hasSubstance ? base : 1,
    responsiveness: hasSubstance ? clamp(Math.round((base + responsiveness) / 2), 1, 9) : 1,
    rhetoricalForce: hasSubstance ? clamp(base + (performance.totalWords > 120 ? 1 : 0), 1, 9) : 1,
    humor: hasSubstance ? clamp(Math.round(base * 0.8 + 2), 1, 9) : 1,
    originality: hasSubstance ? clamp(Math.round(base * 0.85 + 1), 1, 9) : 1,
    topicControl: hasSubstance ? clamp(Math.round((base + (performance.substantiveTurnCount >= 2 ? 7 : 5)) / 2), 1, 9) : 1,
  };
  score.total = Object.values(score).reduce((sum, value) => sum + value, 0);
  return score;
}

function estimateResponsiveness(room, debaterId) {
  const debater = room.debaters.find((d) => d.id === debaterId);
  const opponent = room.debaters.find((d) => d.id !== debaterId);
  if (!debater || !opponent) return 5;
  const turns = room.turns.filter((t) => t.speakerDebaterId === debaterId);
  if (!turns.length) return 0;
  let total = 0;
  for (const turn of turns) {
    const earlierOpponent = room.turns.filter((t) => t.speakerDebaterId === opponent.id && new Date(t.createdAt) <= new Date(turn.createdAt)).at(-1);
    if (!earlierOpponent) {
      total += 5;
      continue;
    }
    const opponentTerms = importantTerms(earlierOpponent.text);
    const lower = turn.text.toLowerCase();
    const overlap = opponentTerms.filter((term) => lower.includes(term)).length;
    total += clamp(2 + overlap * 2, 1, 9);
  }
  return total / turns.length;
}

function importantTerms(text) {
  const stop = new Set(['the', 'and', 'that', 'this', 'with', 'from', 'they', 'their', 'because', 'should', 'would', 'could', 'have', 'will', 'your', 'about', 'what', 'there', 'here']);
  return [...new Set((text.match(/[A-Za-z]{5,}/g) || []).map((word) => word.toLowerCase()).filter((word) => !stop.has(word)))].slice(0, 8);
}

function applyTranscriptQualityCaps(room, scores) {
  const capped = { debater_a: { ...scores.debater_a }, debater_b: { ...scores.debater_b } };
  for (const debaterId of ['debater_a', 'debater_b']) {
    const performance = analyzeDebaterPerformance(room, debaterId);
    if (!performance.turns.length || performance.substantiveTurnCount > 0) continue;
    capScore(capped[debaterId], 2);
  }
  return capped;
}

function capScore(score, maxCategory) {
  const keys = ['logicalCoherence', 'responsiveness', 'rhetoricalForce', 'humor', 'originality', 'topicControl'];
  for (const key of keys) score[key] = Math.min(score[key], maxCategory);
  score.total = keys.reduce((sum, key) => sum + score[key], 0);
}

function mockJudge(room) {
  const h = hashNumber(room.id + room.topic.resolution + room.turns.map((t) => t.text).join('|'));
  const scores = { debater_a: scoreFromPerformance(room, 'debater_a'), debater_b: scoreFromPerformance(room, 'debater_b') };
  const winnerDebaterId = scores.debater_a.total === scores.debater_b.total ? (h % 2 === 0 ? 'debater_a' : 'debater_b') : (scores.debater_a.total > scores.debater_b.total ? 'debater_a' : 'debater_b');
  const winner = room.debaters.find((d) => d.id === winnerDebaterId);
  const loserId = winnerDebaterId === 'debater_a' ? 'debater_b' : 'debater_a';
  const transcript = room.turns.map((t) => t.text).join(' ');
  const loserPerformance = analyzeDebaterPerformance(room, loserId);
  const weakest = loserPerformance.turns.sort((a, b) => a.analysis.score - b.analysis.score)[0];
  const worstSummary = weakest?.analysis.thin
    ? `${weakest.speakerName} submitted "${shortTurnQuote(weakest.text, 80)}", which gave the judge almost no argument to evaluate.`
    : `${weakest?.speakerName || 'The losing side'} did not answer the stronger opposing frame directly enough.`;
  if (readabilityMode(room) === 'kids') {
    return { winnerDebaterId, winnerName: winner.displayName, margin: marginFromScores(scores, winnerDebaterId), confidence: 0.76, scores, bestLine: { debaterId: winnerDebaterId, quote: findBestLine(room, winnerDebaterId) }, worstArgument: { debaterId: loserId, summary: worstSummary }, verdict: `${winner.displayName} wins. Their side was easier to follow because it gave clearer reasons and answered what was actually said. The other side had weaker or thinner turns, so it left too many questions unanswered.`, propResults: room.markets.filter((m) => m.type === 'prop').map((m) => ({ marketId: m.id, won: /animal|raccoon|goose|pirate|fallacy|fallacious/i.test(transcript), evidence: 'Mock judge found a matching line in the debate.', confidence: 0.78 })) };
  }
  return { winnerDebaterId, winnerName: winner.displayName, margin: marginFromScores(scores, winnerDebaterId), confidence: 0.76, scores, bestLine: { debaterId: winnerDebaterId, quote: findBestLine(room, winnerDebaterId) }, worstArgument: { debaterId: loserId, summary: worstSummary }, verdict: `${winner.displayName} wins. The winning side gave the judge a more usable frame, made better callbacks to the actual transcript, and supplied more concrete reasoning. The losing side was penalized where its turns were thin, evasive, or disconnected from the opponent's claims.`, propResults: room.markets.filter((m) => m.type === 'prop').map((m) => ({ marketId: m.id, won: /animal|raccoon|goose|petting zoo|pirate|clipboard|fallacy|fallacious/i.test(transcript), evidence: 'Mock judge found matching transcript language.', confidence: 0.78 })) };
}

function marginFromScores(scores, winnerDebaterId) {
  const loserId = winnerDebaterId === 'debater_a' ? 'debater_b' : 'debater_a';
  const gap = scores[winnerDebaterId].total - scores[loserId].total;
  if (gap >= 18) return 'landslide';
  if (gap >= 10) return 'clear';
  if (gap >= 4) return 'narrow';
  return 'razor-thin';
}

function findBestLine(room, debaterId) {
  const turn = room.turns.find((t) => t.speakerDebaterId === debaterId) || room.turns[0];
  if (!turn) return 'The room briefly achieved procedural dignity before immediately losing it.';
  return cleanText(turn.text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 30).sort((a, b) => b.length - a.length)[0] || turn.text, 240);
}

async function openAISmoke() {
  if (MOCK_AI) return { ok: true, mode: 'mock', mockReason: MOCK_REASON, message: 'Mock mode is active. No API call made.' };
  const parsed = await openAIStructured({ task: 'setup', name: 'smoke_test', schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'] }, system: 'Return a tiny JSON smoke test object.', user: 'Return ok true and a short message.', maxOutputTokens: 120 });
  return { ok: Boolean(parsed.ok), mode: 'openai', model: MODEL_SETUP, message: parsed.message };
}

async function openAIText({ task, system, user, maxOutputTokens = 600 }) {
  const data = await openAIRequest(task, { input: [{ role: 'developer', content: system }, { role: 'user', content: user }], max_output_tokens: maxOutputTokens, store: false });
  const text = extractOutputText(data);
  if (!text) throw new Error(describeEmptyOutput(data));
  return text;
}

async function openAITextStream({ task, system, user, maxOutputTokens = 600, onDelta, onReset }) {
  const body = { input: [{ role: 'developer', content: system }, { role: 'user', content: user }], max_output_tokens: maxOutputTokens, store: false };
  let result = await openAIStreamRequest(task, body, onDelta);
  if (ranOutOfOutputBudget(result.data)) {
    onReset?.();
    const retryMax = expandedOutputBudget(task, maxOutputTokens);
    console.warn(`Retrying streamed OpenAI ${task} request with larger max_output_tokens=${retryMax}; previous response ended before visible output.`);
    result = await openAIStreamRequest(task, body, onDelta, retryMax);
  }
  if (ranOutOfOutputBudget(result.data)) throw new Error(describeEmptyOutput(result.data));
  const text = cleanRichText(result.text || extractOutputText(result.data), 1400);
  if (!text) throw new Error(describeEmptyOutput(result.data));
  return text;
}

async function openAIStructured({ task, name, schema, system, user, maxOutputTokens = 1200 }) {
  const data = await openAIRequest(task, { input: [{ role: 'developer', content: system }, { role: 'user', content: user }], text: { format: { type: 'json_schema', name, strict: true, schema } }, max_output_tokens: maxOutputTokens, store: false });
  const text = extractOutputText(data);
  if (!text) throw new Error('OpenAI returned no output text.');
  return JSON.parse(text);
}

function taskModel(task) {
  if (task === 'judge') return { model: MODEL_JUDGE, effort: EFFORT_JUDGE };
  if (task === 'debate') return { model: MODEL_DEBATE, effort: EFFORT_DEBATE };
  return { model: MODEL_SETUP, effort: EFFORT_SETUP };
}

async function openAIRequest(task, body) {
  const { model, effort } = taskModel(task);
  const makeBody = (includeReasoning = true, maxOutputTokens = body.max_output_tokens) => JSON.stringify({ model, ...body, max_output_tokens: maxOutputTokens, reasoning: includeReasoning && effort && effort !== 'none' ? { effort } : undefined });
  const send = async (includeReasoning = true, maxOutputTokens = body.max_output_tokens) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
    try {
      const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: makeBody(includeReasoning, maxOutputTokens), signal: controller.signal });
      if (!response.ok) return { response, errorText: await response.text(), data: null };
      return { response, errorText: '', data: await response.json() };
    } finally {
      clearTimeout(timeout);
    }
  };
  let result = await send(true);
  if (!result.response.ok && effort && effort !== 'none') {
    console.warn('Retrying OpenAI request without reasoning parameter:', result.errorText.slice(0, 300));
    result = await send(false);
  }
  if (!result.response.ok) throw new Error(`OpenAI API error ${result.response.status}: ${result.errorText.slice(0, 800)}`);
  if (ranOutOfOutputBudget(result.data)) {
    const retryMax = expandedOutputBudget(task, body.max_output_tokens);
    console.warn(`Retrying OpenAI ${task} request with larger max_output_tokens=${retryMax}; previous response ended before visible output.`);
    result = await send(true, retryMax);
    if (!result.response.ok && effort && effort !== 'none') {
      console.warn('Retrying expanded OpenAI request without reasoning parameter:', result.errorText.slice(0, 300));
      result = await send(false, retryMax);
    }
    if (!result.response.ok) throw new Error(`OpenAI API error ${result.response.status}: ${result.errorText.slice(0, 800)}`);
  }
  if (ranOutOfOutputBudget(result.data)) throw new Error(describeEmptyOutput(result.data));
  return result.data;
}

async function openAIStreamRequest(task, body, onDelta, overrideMaxOutputTokens = body.max_output_tokens) {
  const { model, effort } = taskModel(task);
  const makeBody = (includeReasoning = true) => JSON.stringify({ model, ...body, max_output_tokens: overrideMaxOutputTokens, stream: true, reasoning: includeReasoning && effort && effort !== 'none' ? { effort } : undefined });
  const send = async (includeReasoning = true) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
    try {
      const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: makeBody(includeReasoning), signal: controller.signal });
      if (!response.ok) return { response, errorText: await response.text(), data: null, text: '' };
      const parsed = await parseOpenAIEventStream(response, onDelta);
      return { response, errorText: '', ...parsed };
    } finally {
      clearTimeout(timeout);
    }
  };
  let result = await send(true);
  if (!result.response.ok && effort && effort !== 'none') {
    console.warn('Retrying streamed OpenAI request without reasoning parameter:', result.errorText.slice(0, 300));
    result = await send(false);
  }
  if (!result.response.ok) throw new Error(`OpenAI API error ${result.response.status}: ${result.errorText.slice(0, 800)}`);
  return result;
}

async function parseOpenAIEventStream(response, onDelta) {
  const decoder = new TextDecoder();
  let buffer = '';
  let collected = '';
  let finalData = null;
  const processRecord = (record) => {
    const data = record.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n').trim();
    if (!data || data === '[DONE]') return;
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      collected += event.delta;
      onDelta?.(event.delta);
      return;
    }
    if (event.type === 'response.completed') finalData = event.response || event;
    if (event.type === 'response.failed' || event.type === 'error') throw new Error(event.error?.message || 'OpenAI stream failed.');
  };

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const records = buffer.split(/\r?\n\r?\n/);
    buffer = records.pop() || '';
    for (const record of records) processRecord(record);
  }
  buffer += decoder.decode();
  if (buffer.trim()) processRecord(buffer);
  return { data: finalData, text: collected };
}

function ranOutOfOutputBudget(data) {
  return data?.status === 'incomplete' && data?.incomplete_details?.reason === 'max_output_tokens';
}

function expandedOutputBudget(task, requested) {
  const base = Math.max(Number(requested || 0), 1200);
  if (task === 'judge') return Math.max(base * 4, 16000);
  if (task === 'debate') return Math.max(base * 4, 12000);
  return Math.max(base * 4, 6000);
}

function describeEmptyOutput(data) {
  if (ranOutOfOutputBudget(data)) return `OpenAI response reached max_output_tokens before producing visible output. Increase OPENAI_TIMEOUT_MS or lower reasoning effort if this repeats.`;
  const refusal = data?.output?.flatMap((item) => item.content || []).find((content) => typeof content.refusal === 'string')?.refusal;
  if (refusal) return `OpenAI refused the request: ${refusal}`;
  return `OpenAI returned no output text. Response status: ${data?.status || 'unknown'}.`;
}

function extractOutputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  const parts = [];
  for (const item of data?.output || []) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const content of item.content) {
        if (typeof content.text === 'string') parts.push(content.text);
        if (typeof content.value === 'string') parts.push(content.value);
      }
    } else if (typeof item.text === 'string') parts.push(item.text);
  }
  return parts.join('\n').trim();
}

function hashNumber(input) {
  const hash = crypto.createHash('sha256').update(String(input || '')).digest();
  return hash.readUInt32BE(0);
}

function shuffle(items) { return [...items].sort(() => Math.random() - 0.5); }
function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) handleApi(req, res, url);
  else serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log(`AI Debate Casino running at http://localhost:${PORT}`);
  console.log(`AI mode: ${MOCK_AI ? 'mock fallback' : `OpenAI setup=${MODEL_SETUP}, debate=${MODEL_DEBATE}, judge=${MODEL_JUDGE}`}`);
});
