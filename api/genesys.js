// Genesys Cloud Proxy — Vercel Serverless Function
// Roles needed: Supervisor + User (Communicate-User optional)
// GENESYS_REGION format: mypurecloud.de  (no https://, no trailing slash)
// GENESYS_QUEUE_NAME: e.g. Qmobility_Queue (default queue to resolve)
// GENESYS_DEBUG: set to "true" to enable verbose logging

const DEBUG = process.env.GENESYS_DEBUG === 'true';
const DEFAULT_QUEUE_NAME = process.env.GENESYS_QUEUE_NAME || 'Qmobility_Queue';

function dbg(...args) { if (DEBUG) console.log('[GENESYS]', ...args); }

// ── Token cache ──────────────────────────────────────────────────────────────
let _tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt - 30000) return _tokenCache.token;
  const region = getRegion();
  const clientId = (process.env.GENESYS_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GENESYS_CLIENT_SECRET || '').trim();
  if (!region || !clientId || !clientSecret) {
    throw new Error('Missing env vars: GENESYS_CLIENT_ID, GENESYS_CLIENT_SECRET, GENESYS_REGION');
  }
  const res = await fetch(`https://login.${region}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OAuth failed (${res.status}): ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  _tokenCache.token = data.access_token;
  _tokenCache.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  dbg('Token refreshed, expires in', data.expires_in, 's');
  return data.access_token;
}

function getRegion() {
  return (process.env.GENESYS_REGION || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function gGet(path) {
  const region = getRegion();
  const token = await getToken();
  const url = `https://api.${region}${path}`;
  dbg('GET', url);
  const t0 = Date.now();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  dbg('GET', path, '->', res.status, `(${Date.now() - t0}ms)`);
  if (!res.ok) {
    const err = await res.text();
    dbg('GET ERROR body:', err.slice(0, 500));
    throw new Error(`GET ${path} -> ${res.status}: ${err.slice(0, 250)}`);
  }
  return res.json();
}

async function gPost(path, body) {
  const region = getRegion();
  const token = await getToken();
  const url = `https://api.${region}${path}`;
  dbg('POST', url, JSON.stringify(body).slice(0, 400));
  const t0 = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  dbg('POST', path, '->', res.status, `(${Date.now() - t0}ms)`);
  if (!res.ok) {
    const err = await res.text();
    dbg('POST ERROR body:', err.slice(0, 500));
    throw new Error(`POST ${path} -> ${res.status}: ${err.slice(0, 250)}`);
  }
  return res.json();
}

// ── Interval builder ─────────────────────────────────────────────────────────
// Builds UTC interval spanning the LOCAL business day in Asia/Dubai (or tz param)
function buildInterval(query = {}) {
  const tz = query.timezone || 'Asia/Dubai';

  // Explicit start/end override
  if (query.start && query.end) {
    dbg('Interval from explicit params:', query.start, '-', query.end);
    return `${query.start}/${query.end}`;
  }

  // Date override (local date string like 2026-03-07)
  const dateStr = query.date || null;

  // Build start-of-day and end-of-day in target timezone
  const now = new Date();
  const localDateStr = dateStr || now.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
  const startLocal = new Date(`${localDateStr}T00:00:00`);
  const endLocal = new Date(`${localDateStr}T23:59:59`);

  // Convert local time to UTC by using timezone offset
  const toUTC = (localDate, timezone, isEnd) => {
    // Use Intl to find offset: format a reference date in that timezone
    const ref = isEnd ? localDate : localDate;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(ref);
    const p = {};
    parts.forEach(x => { p[x.type] = x.value; });
    const localStr = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
    const offset = ref.getTime() - new Date(localStr + 'Z').getTime();
    return new Date(ref.getTime() - offset);
  };

  // Build start/end as UTC Date objects for the local day boundaries
  const startUTC = new Date(Date.UTC(
    ...localDateStr.split('-').map(Number).map((v, i) => i === 1 ? v - 1 : v),
    0, 0, 0, 0
  ));

  // Get timezone offset in minutes for Asia/Dubai (UTC+4 = -240 minutes from UTC)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', hour12: false,
    timeZoneName: 'shortOffset'
  });
  // Simple approach: find offset by comparing UTC midnight vs local midnight
  const midnight = new Date(`${localDateStr}T00:00:00Z`);
  const localHour = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', hour12: false
  }).format(midnight));

  // localHour tells us how many hours ahead/behind. For Asia/Dubai (UTC+4):
  // midnight UTC = 04:00 local, so we need to go back 4h to get local midnight in UTC
  const offsetHours = localHour > 12 ? localHour - 24 : localHour;
  const startISO = new Date(midnight.getTime() - offsetHours * 3600000).toISOString();
  const endISO = new Date(midnight.getTime() - offsetHours * 3600000 + 86399999).toISOString();

  dbg('Interval:', startISO, '-', endISO, 'for tz:', tz, 'date:', localDateStr);
  return `${startISO}/${endISO}`;
}

// ── Format helpers ────────────────────────────────────────────────────────────
function fmtSec(sec) {
  if (!sec || sec <= 0) return '0s';
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

function metricStats(dataArr, metric) {
  const d = (dataArr || []).find(x => x.metric === metric);
  return d?.stats || null;
}

// ── Queue resolver ────────────────────────────────────────────────────────────
const _queueCache = {};
async function resolveQueue(queueId, queueName) {
  const name = queueName || DEFAULT_QUEUE_NAME;

  if (queueId) {
    dbg('Using explicit queueId:', queueId);
    return { id: queueId, name: name };
  }

  if (_queueCache[name]) {
    dbg('Queue cache hit:', name, '->', _queueCache[name]);
    return _queueCache[name];
  }

  dbg('Resolving queue by name:', name);
  const data = await gGet(`/api/v2/routing/queues?pageSize=100&name=${encodeURIComponent(name)}`);
  const q = (data.entities || []).find(x => x.name === name) || data.entities?.[0];
  if (!q) throw new Error(`Queue not found: "${name}"`);

  dbg('Resolved queue:', q.name, '->', q.id);
  _queueCache[name] = { id: q.id, name: q.name };
  return _queueCache[name];
}

// ── Normalise agent presence/routing ─────────────────────────────────────────
function normalizeStatus(systemPresence, routingStatus) {
  const rs = (routingStatus || '').toUpperCase();
  const sp = (systemPresence || '').toLowerCase();
  if (rs === 'INTERACTING' || rs === 'COMMUNICATING') return 'Interacting';
  if (rs === 'NOT_RESPONDING') return 'Not Responding';
  if (rs === 'IDLE') {
    if (sp === 'available') return 'Available';
    return 'Idle';
  }
  if (sp === 'available') return 'Available';
  if (sp === 'busy') return 'Busy';
  if (sp.includes('break') || sp.includes('pause')) return 'Break';
  if (sp === 'away') return 'Away';
  if (sp === 'meal') return 'Meal';
  if (sp === 'offline' || sp === 'off queue') return 'Offline';
  return systemPresence || 'Offline';
}

// ════════════════════════════════════════════════════════════════════════════
// HANDLER
// ════════════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const region = getRegion();
  const endpoint = (req.query.endpoint || req.query.action || '').trim();
  dbg('=== REQUEST endpoint:', endpoint, 'query:', JSON.stringify(req.query));

  const errResp = (status, error, details) => res.status(status).json({
    ok: false, error, details: details || '', endpoint, status,
  });

  try {

    // ── health ──────────────────────────────────────────────────────────────
    if (endpoint === 'health' || !endpoint) {
      const token = await getToken();
      return res.json({
        ok: true, region, hasToken: !!token,
        defaultQueueName: DEFAULT_QUEUE_NAME,
        debug: DEBUG,
      });
    }

    // ── presence ────────────────────────────────────────────────────────────
    if (endpoint === 'presence' || endpoint === 'users') {
      let allUsers = [], page = 1;
      while (true) {
        const data = await gGet(
          `/api/v2/users?pageSize=100&pageNumber=${page}&expand=presence,routingStatus&active=true`
        );
        allUsers = allUsers.concat(data.entities || []);
        if (!data.nextUri || allUsers.length >= (data.total || 0)) break;
        if (++page > 5) break;
      }

      const users = allUsers.map(u => {
        const sp = u.presence?.presenceDefinition?.systemPresence || 'Offline';
        const rs = u.routingStatus?.status || null;
        const normalized = normalizeStatus(sp, rs);
        const isOnline = normalized !== 'Offline';
        const isCC = rs !== null; // has a routing status → likely CC agent
        return {
          id: u.id,
          name: u.name,
          email: u.email || '',
          presence: sp,                  // raw: Available / Busy / Away / Offline / Break etc.
          presenceLabel: u.presence?.presenceDefinition?.name || sp,
          routingStatus: rs,             // raw: IDLE / INTERACTING / COMMUNICATING / NOT_RESPONDING / null
          normalized,                    // dashboard-friendly label
          isOnline,
          isCC,
          loginTime: u.presence?.modifiedDate || null,
        };
      });

      dbg('presence: returning', users.length, 'users');
      return res.json({ ok: true, users });
    }

    // ── queue_activity (live observations) ──────────────────────────────────
    if (endpoint === 'queue_activity' || endpoint === 'queue_obs') {
      const queue = await resolveQueue(req.query.queueId, req.query.queueName);

      const data = await gPost('/api/v2/analytics/queues/observations/query', {
        filter: {
          type: 'or',
          predicates: [{ type: 'dimension', dimension: 'queueId', operator: 'matches', value: queue.id }],
        },
        metrics: [
          'oWaiting', 'oInteracting', 'oAlerting',
          'oOnQueueUsers', 'oOffQueueUsers',
          'oIdleAgents', 'oNotRespondingAgents',
          'oCommunicatingAgents', 'oInteractingAgents',
          'oAvailableAgents',
          'oServiceLevel',
        ],
      });

      // results[0] is our queue
      const result = data.results?.[0] || {};
      const m = {};
      (result.data || []).forEach(d => { m[d.metric] = d.stats; });

      const slRaw = m.oServiceLevel?.pct ?? m.oServiceLevel?.ratio ?? null;

      const live = {
        waiting: m.oWaiting?.count || 0,
        interactions: m.oInteracting?.count || 0,
        alerting: m.oAlerting?.count || 0,
        onQueue: m.oOnQueueUsers?.count || 0,
        offQueue: m.oOffQueueUsers?.count || 0,
        idle: m.oIdleAgents?.count || 0,
        communicating: m.oCommunicatingAgents?.count || 0,
        interacting: m.oInteractingAgents?.count || 0,
        notResponding: m.oNotRespondingAgents?.count || 0,
        available: m.oAvailableAgents?.count || 0,
        serviceLevelLive: slRaw != null ? (slRaw <= 1 ? Math.round(slRaw * 100) : Math.round(slRaw)) : null,
      };
      // break not in obs — derive from presence endpoint if needed; set to null
      live.break = null;

      dbg('queue_activity:', JSON.stringify(live));
      return res.json({
        ok: true,
        queue: { id: queue.id, name: queue.name },
        interval: 'live',
        live,
        // Legacy compat keys (old frontend reads these)
        queues: [{ ...live, queueId: queue.id, waiting: live.waiting, interacting: live.interactions, serviceLevel: live.serviceLevelLive }],
        totalWaiting: live.waiting,
        totalInteracting: live.interactions,
      });
    }

    // ── queue_performance (aggregates for the day) ───────────────────────────
    if (endpoint === 'queue_performance' || endpoint === 'calls_today') {
      const interval = buildInterval(req.query);
      const queue = await resolveQueue(req.query.queueId, req.query.queueName);

      dbg('queue_performance interval:', interval, 'queue:', queue.id);

      // Aggregates for the queue — filtered to voice
      const aggData = await gPost('/api/v2/analytics/conversations/aggregates/query', {
        interval,
        groupBy: ['queueId'],
        filter: {
          type: 'and',
          predicates: [
            { type: 'dimension', dimension: 'queueId', operator: 'matches', value: queue.id },
            { type: 'dimension', dimension: 'mediaType', operator: 'matches', value: 'voice' },
          ],
        },
        metrics: [
          'nOffered', 'nAnswered', 'nAbandoned',
          'nConnected',
          'nInServiceLevel',
          'tHandle', 'tTalk', 'tHeld', 'tAcw', 'tAnswered',
          'tAbandoned',
        ],
        flattenMultivaluedDimensions: true,
      });

      let nOffered = 0, nAnswered = 0, nAbandoned = 0, nInSL = 0;
      let handleSum = 0, handleCnt = 0;
      let talkSum = 0, talkCnt = 0;
      let holdSum = 0, holdCnt = 0;
      let acwSum = 0, acwCnt = 0;
      let waitSum = 0, waitCnt = 0; // tAnswered = wait time for answered calls

      (aggData.results || []).forEach(r => {
        (r.data || []).forEach(d => {
          const cnt = d.stats?.count || 0;
          const sum = d.stats?.sum || 0;
          if (d.metric === 'nOffered') nOffered += cnt;
          if (d.metric === 'nAnswered' || d.metric === 'nConnected') nAnswered = Math.max(nAnswered, cnt);
          if (d.metric === 'nAbandoned') nAbandoned += cnt;
          if (d.metric === 'nInServiceLevel') nInSL += cnt;
          if (d.metric === 'tHandle' && cnt > 0) { handleSum += sum; handleCnt += cnt; }
          if (d.metric === 'tTalk'   && cnt > 0) { talkSum += sum; talkCnt += cnt; }
          if (d.metric === 'tHeld'   && cnt > 0) { holdSum += sum; holdCnt += cnt; }
          if (d.metric === 'tAcw'    && cnt > 0) { acwSum += sum; acwCnt += cnt; }
          if (d.metric === 'tAnswered' && cnt > 0) { waitSum += sum; waitCnt += cnt; } // ASA
        });
      });

      // SL % from inServiceLevel / answered
      const serviceLevelPct = nAnswered > 0 && nInSL >= 0
        ? parseFloat((nInSL / Math.max(nOffered, nAnswered) * 100).toFixed(1))
        : null;

      const avgHandleSec = handleCnt > 0 ? Math.round(handleSum / handleCnt / 1000) : 0;
      const avgTalkSec   = talkCnt   > 0 ? Math.round(talkSum   / talkCnt   / 1000) : 0;
      const avgHoldSec   = holdCnt   > 0 ? Math.round(holdSum   / holdCnt   / 1000) : 0;
      const avgAcwSec    = acwCnt    > 0 ? Math.round(acwSum    / acwCnt    / 1000) : 0;
      const asaSec       = waitCnt   > 0 ? Math.round(waitSum   / waitCnt   / 1000) : 0; // ASA

      const performance = {
        offered: nOffered,
        answered: nAnswered,
        abandoned: nAbandoned,
        answerPct: nOffered > 0 ? parseFloat((nAnswered / nOffered * 100).toFixed(1)) : 0,
        abandonPct: nOffered > 0 ? parseFloat((nAbandoned / nOffered * 100).toFixed(1)) : 0,
        asaSec,
        asaFmt: fmtSec(asaSec),
        serviceLevelPct,
        avgWaitSec: asaSec,   // alias — same value
        avgWaitFmt: fmtSec(asaSec),
        avgHandleSec,
        avgHandleFmt: fmtSec(avgHandleSec),
        avgTalkSec,
        avgTalkFmt: fmtSec(avgTalkSec),
        avgHoldSec,
        avgHoldFmt: fmtSec(avgHoldSec),
        avgAcwSec,
        avgAcwFmt: fmtSec(avgAcwSec),
        holdCount: holdCnt,
        transferCount: 0,  // not reliably available without analytics:readonly
      };

      dbg('queue_performance:', JSON.stringify(performance));

      // Also fetch live waiting for dashboard cards
      let currentWaiting = 0;
      let serviceLevelLive = null;
      try {
        const obsData = await gPost('/api/v2/analytics/queues/observations/query', {
          filter: { type: 'or', predicates: [{ type: 'dimension', dimension: 'queueId', operator: 'matches', value: queue.id }] },
          metrics: ['oWaiting', 'oServiceLevel'],
        });
        (obsData.results?.[0]?.data || []).forEach(d => {
          if (d.metric === 'oWaiting') currentWaiting = d.stats?.count || 0;
          if (d.metric === 'oServiceLevel') {
            const v = d.stats?.pct ?? d.stats?.ratio ?? null;
            if (v != null) serviceLevelLive = v <= 1 ? Math.round(v * 100) : Math.round(v);
          }
        });
      } catch (_) { /* live obs optional */ }

      // Legacy shape for old frontend that reads d.summary from calls_today
      const summary = {
        ...performance,
        currentWaiting,
        serviceLevel: performance.serviceLevelPct ?? serviceLevelLive,
        // Old field aliases consumed by frontend pick() logic
        avgAHT: avgHandleSec,
        avgHandle: avgHandleSec,
        avgASA: asaSec,
        avgTalk: avgTalkSec,
        abandonRate: performance.abandonPct,
      };

      return res.json({
        ok: true,
        queue: { id: queue.id, name: queue.name },
        interval,
        performance,
        summary, // legacy compat — old frontend reads res.summary
      });
    }

    // ── agent_performance ────────────────────────────────────────────────────
    // Uses only endpoints available with Supervisor + User roles.
    // Grouped by userId (no analytics:readonly needed for aggregates/query).
    if (endpoint === 'agent_performance' || endpoint === 'agent_kpis') {
      const interval = buildInterval(req.query);
      const queue = await resolveQueue(req.query.queueId, req.query.queueName);

      dbg('agent_kpis interval:', interval, 'queue:', queue.id);

      // Step 1: Aggregates grouped by userId, filtered to queue + voice
      // NOTE: groupBy userId on conversations/aggregates works with Supervisor role
      // but ONLY when also filtered by queueId. Without queueId filter it returns
      // organisation-wide data which requires Analytics role → 403.
      const [aggData, presData] = await Promise.all([
        gPost('/api/v2/analytics/conversations/aggregates/query', {
          interval,
          groupBy: ['userId'],
          filter: {
            type: 'and',
            predicates: [
              { type: 'dimension', dimension: 'queueId', operator: 'matches', value: queue.id },
              { type: 'dimension', dimension: 'mediaType', operator: 'matches', value: 'voice' },
            ],
          },
          metrics: ['nAnswered', 'nConnected', 'tHandle', 'tTalk', 'tHeld', 'tAcw'],
          flattenMultivaluedDimensions: true,
        }),
        // Presence for name + status
        gGet('/api/v2/users?pageSize=200&active=true&expand=presence,routingStatus'),
      ]);

      // Build user lookup map from presence call
      const userMap = {};
      (presData.entities || []).forEach(u => {
        const sp = u.presence?.presenceDefinition?.systemPresence || 'Offline';
        const rs = u.routingStatus?.status || null;
        userMap[u.id] = {
          name: u.name,
          presence: sp,
          routingStatus: rs,
          normalized: normalizeStatus(sp, rs),
          loginTime: u.presence?.modifiedDate || null,
        };
      });

      const agents = [];
      (aggData.results || []).forEach(r => {
        const userId = r.group?.userId;
        if (!userId) return;

        const m = {};
        (r.data || []).forEach(d => { m[d.metric] = d.stats; });

        const answered = Math.max(m.nAnswered?.count || 0, m.nConnected?.count || 0);
        // Include agents with 0 handled so frontend knows they exist
        const handled = answered;

        const avgHandleSec = m.tHandle?.count > 0 ? Math.round((m.tHandle.sum || 0) / m.tHandle.count / 1000) : 0;
        const avgTalkSec   = m.tTalk?.count   > 0 ? Math.round((m.tTalk.sum   || 0) / m.tTalk.count   / 1000) : 0;
        const avgHoldSec   = m.tHeld?.count   > 0 ? Math.round((m.tHeld.sum   || 0) / m.tHeld.count   / 1000) : 0;
        const avgAcwSec    = m.tAcw?.count    > 0 ? Math.round((m.tAcw.sum    || 0) / m.tAcw.count    / 1000) : 0;

        const user = userMap[userId] || {};

        agents.push({
          id: userId,
          name: user.name || userId,
          answered,
          handled,
          avgHandleSec,
          avgHandleFmt: fmtSec(avgHandleSec),
          avgAHT_sec: avgHandleSec,       // alias for old frontend
          avgAHT_fmt: fmtSec(avgHandleSec),
          avgTalkSec,
          avgTalkFmt: fmtSec(avgTalkSec),
          talkSec: avgTalkSec,             // alias for old frontend
          avgHoldSec,
          avgHoldFmt: fmtSec(avgHoldSec),
          holdSec: avgHoldSec,             // alias
          holdCount: m.tHeld?.count || 0,
          avgAcwSec,
          avgAcwFmt: fmtSec(avgAcwSec),
          acwSec: avgAcwSec,               // alias
          transferCount: 0,
          routingStatus: user.routingStatus || null,
          presence: user.normalized || 'Offline',
          loginTime: user.loginTime || null,
        });
      });

      // Sort descending by handled
      agents.sort((a, b) => b.handled - a.handled);

      dbg('agent_kpis: returning', agents.length, 'agents');
      return res.json({
        ok: true,
        queue: { id: queue.id, name: queue.name },
        interval,
        agents,
      });
    }

    // ── dashboard_summary ────────────────────────────────────────────────────
    // Single endpoint that returns presence + queue perf + queue activity combined.
    // Reduces to 3 Genesys calls instead of 4 separate frontend fetches.
    if (endpoint === 'dashboard_summary') {
      const interval = buildInterval(req.query);
      const queue = await resolveQueue(req.query.queueId, req.query.queueName);

      dbg('dashboard_summary interval:', interval, 'queue:', queue.id);

      const [presData, aggData, obsData] = await Promise.all([
        // 1. Presence / routing status of all users
        gGet('/api/v2/users?pageSize=200&active=true&expand=presence,routingStatus'),
        // 2. Queue performance for the day
        gPost('/api/v2/analytics/conversations/aggregates/query', {
          interval,
          groupBy: ['queueId'],
          filter: {
            type: 'and',
            predicates: [
              { type: 'dimension', dimension: 'queueId', operator: 'matches', value: queue.id },
              { type: 'dimension', dimension: 'mediaType', operator: 'matches', value: 'voice' },
            ],
          },
          metrics: ['nOffered', 'nAnswered', 'nAbandoned', 'nConnected', 'nInServiceLevel',
                    'tHandle', 'tTalk', 'tHeld', 'tAcw', 'tAnswered'],
          flattenMultivaluedDimensions: true,
        }),
        // 3. Live queue observations
        gPost('/api/v2/analytics/queues/observations/query', {
          filter: { type: 'or', predicates: [{ type: 'dimension', dimension: 'queueId', operator: 'matches', value: queue.id }] },
          metrics: ['oWaiting', 'oInteracting', 'oAlerting', 'oOnQueueUsers', 'oOffQueueUsers',
                    'oIdleAgents', 'oNotRespondingAgents', 'oCommunicatingAgents',
                    'oInteractingAgents', 'oAvailableAgents', 'oServiceLevel'],
        }),
      ]);

      // ── Parse presence ──
      const users = (presData.entities || []).map(u => {
        const sp = u.presence?.presenceDefinition?.systemPresence || 'Offline';
        const rs = u.routingStatus?.status || null;
        const normalized = normalizeStatus(sp, rs);
        return {
          id: u.id, name: u.name, email: u.email || '',
          presence: sp, routingStatus: rs, normalized,
          isOnline: normalized !== 'Offline',
          isCC: rs !== null,
          loginTime: u.presence?.modifiedDate || null,
        };
      });

      // ── Parse queue performance ──
      let nOffered=0, nAnswered=0, nAbandoned=0, nInSL=0;
      let handleSum=0, handleCnt=0, talkSum=0, talkCnt=0;
      let holdSum=0, holdCnt=0, acwSum=0, acwCnt=0, waitSum=0, waitCnt=0;

      (aggData.results || []).forEach(r => {
        (r.data || []).forEach(d => {
          const cnt = d.stats?.count || 0, sum = d.stats?.sum || 0;
          if (d.metric === 'nOffered') nOffered += cnt;
          if (d.metric === 'nAnswered' || d.metric === 'nConnected') nAnswered = Math.max(nAnswered, cnt);
          if (d.metric === 'nAbandoned') nAbandoned += cnt;
          if (d.metric === 'nInServiceLevel') nInSL += cnt;
          if (d.metric === 'tHandle' && cnt) { handleSum += sum; handleCnt += cnt; }
          if (d.metric === 'tTalk'   && cnt) { talkSum   += sum; talkCnt   += cnt; }
          if (d.metric === 'tHeld'   && cnt) { holdSum   += sum; holdCnt   += cnt; }
          if (d.metric === 'tAcw'    && cnt) { acwSum    += sum; acwCnt    += cnt; }
          if (d.metric === 'tAnswered' && cnt) { waitSum += sum; waitCnt   += cnt; }
        });
      });

      const slPct = nOffered > 0 ? parseFloat((nInSL / nOffered * 100).toFixed(1)) : null;
      const avgHandleSec = handleCnt > 0 ? Math.round(handleSum / handleCnt / 1000) : 0;
      const avgTalkSec   = talkCnt   > 0 ? Math.round(talkSum   / talkCnt   / 1000) : 0;
      const avgHoldSec   = holdCnt   > 0 ? Math.round(holdSum   / holdCnt   / 1000) : 0;
      const avgAcwSec    = acwCnt    > 0 ? Math.round(acwSum    / acwCnt    / 1000) : 0;
      const asaSec       = waitCnt   > 0 ? Math.round(waitSum   / waitCnt   / 1000) : 0;

      // ── Parse live observations ──
      const om = {};
      (obsData.results?.[0]?.data || []).forEach(d => { om[d.metric] = d.stats; });
      const slLiveRaw = om.oServiceLevel?.pct ?? om.oServiceLevel?.ratio ?? null;

      const live = {
        waiting: om.oWaiting?.count || 0,
        interactions: om.oInteracting?.count || 0,
        onQueue: om.oOnQueueUsers?.count || 0,
        offQueue: om.oOffQueueUsers?.count || 0,
        idle: om.oIdleAgents?.count || 0,
        communicating: om.oCommunicatingAgents?.count || 0,
        interacting: om.oInteractingAgents?.count || 0,
        notResponding: om.oNotRespondingAgents?.count || 0,
        available: om.oAvailableAgents?.count || 0,
        serviceLevelLive: slLiveRaw != null ? (slLiveRaw <= 1 ? Math.round(slLiveRaw * 100) : Math.round(slLiveRaw)) : null,
      };

      // ── Pre-computed top cards ──
      const ccUsers = users.filter(u => u.isCC);
      const cards = {
        // These are Genesys-side counts only — WFM counts (totalAgents, working etc)
        // come from frontend renderDashboard() which reads the schedule.
        // Genesys-side cards:
        waiting: live.waiting,
        interacting: live.interacting,
        onQueue: live.onQueue,
        offQueue: live.offQueue,
        idle: live.idle,
        available: live.available,
        notResponding: live.notResponding,
        offered: nOffered,
        answered: nAnswered,
        abandoned: nAbandoned,
        answerPct: nOffered > 0 ? parseFloat((nAnswered / nOffered * 100).toFixed(1)) : 0,
        abandonPct: nOffered > 0 ? parseFloat((nAbandoned / nOffered * 100).toFixed(1)) : 0,
        serviceLevelPct: slPct,
        asaSec, asaFmt: fmtSec(asaSec),
        avgHandleSec, avgHandleFmt: fmtSec(avgHandleSec),
        avgTalkSec, avgTalkFmt: fmtSec(avgTalkSec),
        avgHoldSec, avgHoldFmt: fmtSec(avgHoldSec),
        avgAcwSec, avgAcwFmt: fmtSec(avgAcwSec),
        // Legacy aliases for frontend pick() logic
        avgAHT: avgHandleSec,
        avgHandle: avgHandleSec,
        avgASA: asaSec,
        avgTalk: avgTalkSec,
        serviceLevel: slPct,
        abandonRate: nOffered > 0 ? parseFloat((nAbandoned / nOffered * 100).toFixed(1)) : 0,
        currentWaiting: live.waiting,
      };

      return res.json({
        ok: true,
        queue: { id: queue.id, name: queue.name },
        interval,
        users,
        live,
        summary: cards, // legacy compat — frontend reads d.summary
        performance: {
          offered: nOffered, answered: nAnswered, abandoned: nAbandoned,
          answerPct: cards.answerPct, abandonPct: cards.abandonPct,
          asaSec, asaFmt: fmtSec(asaSec),
          serviceLevelPct: slPct,
          avgHandleSec, avgHandleFmt: fmtSec(avgHandleSec),
          avgTalkSec, avgTalkFmt: fmtSec(avgTalkSec),
          avgHoldSec, avgHoldFmt: fmtSec(avgHoldSec),
          avgAcwSec, avgAcwFmt: fmtSec(avgAcwSec),
        },
        cards,
      });
    }

    // ── adherence ────────────────────────────────────────────────────────────
    if (endpoint === 'adherence') {
      const userIds = req.query.userIds ? req.query.userIds.split(',') : (req.body?.userIds || []);
      if (!userIds.length) return errResp(400, 'Pass userIds as ?userIds=id1,id2');
      const data = await gPost('/api/v2/workforcemanagement/adherence', { userIds });
      return res.json({ ok: true, adherence: data });
    }

    return errResp(400, `Unknown endpoint: "${endpoint}"`,
      'Valid: health, presence, queue_activity, queue_performance, agent_performance, dashboard_summary, adherence');

  } catch (err) {
    console.error('[GENESYS ERROR] endpoint:', endpoint, err.message);
    return errResp(500, err.message, 'Check Vercel function logs for full stack trace');
  }
}
