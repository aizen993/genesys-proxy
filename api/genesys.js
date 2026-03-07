// Genesys Cloud Proxy — Vercel Serverless Function (ESM)
// Region: mypurecloud.de
// VALID ConversationAggregateMetrics for this region:
//   nOffered, nConnected, nConversations, nBlindTransferred,
//   nConsult, nConsultTransferred, nError, nOutbound,
//   tHandle, tTalk, tHeld, tAcw, tAnswered, tAbandoned
// INVALID on this region: nAnswered, nAbandoned, nInServiceLevel

const DEBUG = process.env.GENESYS_DEBUG === 'true';
const DEFAULT_QUEUE_NAME = process.env.GENESYS_QUEUE_NAME || 'Qmobility_Queue';

function log(...a)  { console.log('[GENESYS]',  ...a); }
function dbg(...a)  { if (DEBUG) log(...a); }
function lerr(...a) { console.error('[GENESYS ERR]', ...a); }

// ── Token cache ───────────────────────────────────────────────────────────────
let _tok = { token: null, exp: 0 };

function getRegion() {
  return (process.env.GENESYS_REGION || '').trim()
    .replace(/^https?:\/\//, '').replace(/\/$/, '');
}

async function getToken() {
  if (_tok.token && Date.now() < _tok.exp - 30000) return _tok.token;
  const region = getRegion();
  const id     = (process.env.GENESYS_CLIENT_ID     || '').trim();
  const secret = (process.env.GENESYS_CLIENT_SECRET || '').trim();
  if (!region || !id || !secret)
    throw new Error('Missing GENESYS_CLIENT_ID / GENESYS_CLIENT_SECRET / GENESYS_REGION');
  const r = await fetch(`https://login.${region}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`OAuth ${r.status}: ${txt.slice(0, 300)}`);
  const d = JSON.parse(txt);
  _tok = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return _tok.token;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function gGet(path) {
  const token = await getToken();
  const url   = `https://api.${getRegion()}${path}`;
  dbg('GET', url);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const e = await r.text();
    lerr('GET', path, r.status, e.slice(0, 500));
    throw new Error(`GET ${path} → ${r.status}: ${e.slice(0, 300)}`);
  }
  return r.json();
}

async function gPost(path, body) {
  const token   = await getToken();
  const url     = `https://api.${getRegion()}${path}`;
  const payload = JSON.stringify(body);
  log('POST', url);
  log('PAYLOAD', payload.slice(0, 600));
  const r = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    payload,
  });
  const txt = await r.text();
  if (!r.ok) {
    lerr('POST', path, r.status, txt.slice(0, 1000));
    throw new Error(`POST ${path} → ${r.status}: ${txt.slice(0, 500)}`);
  }
  return JSON.parse(txt);
}

// ── Interval: local day in Dubai (UTC+4, no DST) ─────────────────────────────
function buildInterval(q = {}) {
  if (q.start && q.end) {
    log('interval (override)', q.start, q.end);
    return `${q.start}/${q.end}`;
  }
  const tz      = q.timezone || 'Asia/Dubai';
  const dateStr = q.date || new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const [y, m, d] = dateStr.split('-').map(Number);
  // Dubai = UTC+4, no DST
  const startUTC = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 4 * 3600000);
  const endUTC   = new Date(startUTC.getTime() + 86400000 - 1);
  const interval = `${startUTC.toISOString()}/${endUTC.toISOString()}`;
  log('interval (auto)', interval, 'for', dateStr, tz);
  return interval;
}

// ── fmt seconds → "Xm Ys" ─────────────────────────────────────────────────────
function fmt(sec) {
  if (!sec || sec <= 0) return '0s';
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

// ── Queue resolver ─────────────────────────────────────────────────────────────
const _qCache = {};
async function resolveQueue(queueId, queueName) {
  const name = (queueName || DEFAULT_QUEUE_NAME).trim();
  if (queueId) return { id: queueId, name };
  if (_qCache[name]) return _qCache[name];
  const data = await gGet(`/api/v2/routing/queues?pageSize=100&name=${encodeURIComponent(name)}`);
  const q    = (data.entities || []).find(x => x.name === name) || data.entities?.[0];
  if (!q) throw new Error(`Queue not found: "${name}"`);
  _qCache[name] = { id: q.id, name: q.name };
  log('resolved queue', q.name, q.id);
  return _qCache[name];
}

// ── Status normalizer ─────────────────────────────────────────────────────────
function normalizeStatus(sp, rs) {
  const r = (rs || '').toUpperCase();
  const p = (sp || '').toLowerCase();
  if (r === 'INTERACTING' || r === 'COMMUNICATING') return 'Interacting';
  if (r === 'NOT_RESPONDING')  return 'Not Responding';
  if (r === 'IDLE') return p === 'available' ? 'Available' : 'Idle';
  if (p === 'available')                               return 'Available';
  if (p.includes('break') || p.includes('pause'))     return 'Break';
  if (p === 'busy')  return 'Busy';
  if (p === 'away')  return 'Away';
  if (p === 'meal')  return 'Meal';
  if (p === 'offline' || !sp)                          return 'Offline';
  return sp;
}

// ── Parse aggregates — no silent zero fallback ─────────────────────────────────
function parseAggregates(aggData) {
  let nOffered = 0, nConnected = 0;
  let handleSum = 0, handleCnt = 0;
  let talkSum   = 0, talkCnt   = 0;
  let holdSum   = 0, holdCnt   = 0;
  let acwSum    = 0, acwCnt    = 0;
  let waitSum   = 0, waitCnt   = 0;

  (aggData.results || []).forEach(r => {
    (r.data || []).forEach(d => {
      const cnt = d.stats?.count || 0;
      const sum = d.stats?.sum   || 0;
      if (d.metric === 'nOffered')              nOffered   += cnt;
      if (d.metric === 'nConnected')            nConnected += cnt;
      if (d.metric === 'tHandle'   && cnt > 0) { handleSum += sum; handleCnt += cnt; }
      if (d.metric === 'tTalk'     && cnt > 0) { talkSum   += sum; talkCnt   += cnt; }
      if (d.metric === 'tHeld'     && cnt > 0) { holdSum   += sum; holdCnt   += cnt; }
      if (d.metric === 'tAcw'      && cnt > 0) { acwSum    += sum; acwCnt    += cnt; }
      if (d.metric === 'tAnswered' && cnt > 0) { waitSum   += sum; waitCnt   += cnt; }
    });
  });

  const nAbandoned   = Math.max(0, nOffered - nConnected);
  const avgHandleSec = handleCnt > 0 ? Math.round(handleSum / handleCnt / 1000) : 0;
  const avgTalkSec   = talkCnt   > 0 ? Math.round(talkSum   / talkCnt   / 1000) : 0;
  const avgHoldSec   = holdCnt   > 0 ? Math.round(holdSum   / holdCnt   / 1000) : 0;
  const avgAcwSec    = acwCnt    > 0 ? Math.round(acwSum    / acwCnt    / 1000) : 0;
  const asaSec       = waitCnt   > 0 ? Math.round(waitSum   / waitCnt   / 1000) : 0;

  log('parseAggregates →', { nOffered, nConnected, nAbandoned, avgHandleSec, asaSec });

  return {
    offered:    nOffered,
    answered:   nConnected,
    abandoned:  nAbandoned,
    answerPct:  nOffered > 0 ? parseFloat((nConnected / nOffered * 100).toFixed(1)) : 0,
    abandonPct: nOffered > 0 ? parseFloat((nAbandoned / nOffered * 100).toFixed(1)) : 0,
    asaSec,       asaFmt:       fmt(asaSec),
    serviceLevelPct: null,
    avgHandleSec, avgHandleFmt: fmt(avgHandleSec),
    avgTalkSec,   avgTalkFmt:   fmt(avgTalkSec),
    avgHoldSec,   avgHoldFmt:   fmt(avgHoldSec),
    avgAcwSec,    avgAcwFmt:    fmt(avgAcwSec),
    // legacy aliases
    avgAHT:     avgHandleSec,
    avgHandle:  avgHandleSec,
    avgASA:     asaSec,
    avgWaitSec: asaSec,
    avgTalk:    avgTalkSec,
    abandonRate: nOffered > 0 ? parseFloat((nAbandoned / nOffered * 100).toFixed(1)) : 0,
  };
}

// ── VALID observation metrics for this region ─────────────────────────────────
const OBS_METRICS = [
  'oOnQueueUsers', 'oOffQueueUsers', 'oInteracting',
  'oAlerting', 'oLongestWaiting', 'oLongestInteracting', 'oMemberUsers',
];
// NOTE: oWaiting is NOT valid on mypurecloud.de — use oOnQueueUsers for queue depth

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const endpoint = (req.query.endpoint || req.query.action || '').trim();
  log('REQUEST endpoint:', endpoint, 'query:', JSON.stringify(req.query));

  const fail = (status, error, details = '') => {
    lerr('FAIL', status, error, details);
    return res.status(status).json({ ok: false, error, details, endpoint, status });
  };

  try {

    // ── health ────────────────────────────────────────────────────────────────
    if (!endpoint || endpoint === 'health') {
      const token = await getToken();
      return res.json({
        ok: true, region: getRegion(), hasToken: !!token,
        defaultQueueName: DEFAULT_QUEUE_NAME, debug: DEBUG,
      });
    }

    // ── presence ──────────────────────────────────────────────────────────────
    if (endpoint === 'presence' || endpoint === 'users') {
      let all = [], page = 1;
      while (true) {
        const d = await gGet(
          `/api/v2/users?pageSize=100&pageNumber=${page}&expand=presence,routingStatus&active=true`
        );
        all = all.concat(d.entities || []);
        if (!d.nextUri || all.length >= (d.total || 0) || ++page > 10) break;
      }
      const users = all.map(u => {
        const sp         = u.presence?.presenceDefinition?.systemPresence || 'Offline';
        const rs         = u.routingStatus?.status || null;
        const normalized = normalizeStatus(sp, rs);
        return {
          id: u.id, name: u.name, email: (u.email || '').toLowerCase(),
          presence: sp, presenceLabel: u.presence?.presenceDefinition?.name || sp,
          routingStatus: rs, normalized,
          isOnline:  normalized !== 'Offline',
          isCC:      rs !== null,
          loginTime: u.presence?.modifiedDate || null,
        };
      });
      return res.json({ ok: true, users });
    }

    // ── queue_activity ────────────────────────────────────────────────────────
    if (endpoint === 'queue_activity' || endpoint === 'queue_obs') {
      const queue = await resolveQueue(req.query.queueId, req.query.queueName);
      const data  = await gPost('/api/v2/analytics/queues/observations/query', {
        filter: {
          type: 'or',
          predicates: [{ type: 'dimension', dimension: 'queueId', operator: 'matches', value: queue.id }],
        },
        metrics: OBS_METRICS,
      });

      const m = {};
      (data.results?.[0]?.data || []).forEach(d => { m[d.metric] = d.stats; });

      // oWaiting is NOT valid on this region — use oOnQueueUsers for queue depth
      // oInteracting = active conversations (agents currently on calls)
      const live = {
        waiting:         m.oOnQueueUsers?.count  || 0,  // callers waiting in queue
        interactions:    m.oInteracting?.count   || 0,  // active interactions
        alerting:        m.oAlerting?.count      || 0,  // ringing
        onQueue:         m.oOnQueueUsers?.count  || 0,
        offQueue:        m.oOffQueueUsers?.count || 0,
        onQueueCount:    m.oOnQueueUsers?.count  || 0,
        interacting:     m.oInteracting?.count   || 0,
        longestWaiting:  m.oLongestWaiting?.max  || m.oLongestWaiting?.count || 0,
        serviceLevelLive: null,
      };

      return res.json({
        ok: true,
        queue:    { id: queue.id, name: queue.name },
        interval: 'live',
        live,
        totalWaiting:     live.waiting,
        totalInteracting: live.interacting,
      });
    }

    // ── queue_performance ─────────────────────────────────────────────────────
    if (endpoint === 'queue_performance' || endpoint === 'calls_today') {
      const interval = buildInterval(req.query);
      const queue    = await resolveQueue(req.query.queueId, req.query.queueName);
      log('queue_performance', interval, queue.id);

      const aggQuery = {
        interval,
        groupBy: ['queueId'],
        filter: {
          type: 'and',
          predicates: [
            { type: 'dimension', dimension: 'queueId',   operator: 'matches', value: queue.id },
            { type: 'dimension', dimension: 'mediaType', operator: 'matches', value: 'voice'  },
          ],
        },
        metrics: ['nOffered', 'nConnected', 'tHandle', 'tTalk', 'tHeld', 'tAcw', 'tAnswered'],
        flattenMultivaluedDimensions: true,
      };

      // Aggregate fails hard (requirement: no silent zeros)
      // Observations failure is non-fatal
      const [aggData, obsData] = await Promise.all([
        gPost('/api/v2/analytics/conversations/aggregates/query', aggQuery),
        gPost('/api/v2/analytics/queues/observations/query', {
          filter: {
            type: 'or',
            predicates: [{ type: 'dimension', dimension: 'queueId', operator: 'matches', value: queue.id }],
          },
          metrics: OBS_METRICS,
        }).catch(e => { lerr('obs non-fatal:', e.message); return { results: [] }; }),
      ]);

      const performance = parseAggregates(aggData);

      const om = {};
      (obsData.results?.[0]?.data || []).forEach(d => { om[d.metric] = d.stats; });
      performance.currentWaiting = om.oOnQueueUsers?.count || 0;

      return res.json({
        ok: true,
        queue:    { id: queue.id, name: queue.name },
        interval,
        performance,
      });
    }

    // ── agent_performance ─────────────────────────────────────────────────────
    // Fix: merge ALL active users with aggregate results so zero-call agents appear
    if (endpoint === 'agent_performance' || endpoint === 'agent_kpis') {
      const interval = buildInterval(req.query);
      const queue    = await resolveQueue(req.query.queueId, req.query.queueName);
      log('agent_performance', interval, queue.id);

      const aggQuery = {
        interval,
        groupBy: ['userId'],
        filter: {
          type: 'and',
          predicates: [
            { type: 'dimension', dimension: 'queueId',   operator: 'matches', value: queue.id },
            { type: 'dimension', dimension: 'mediaType', operator: 'matches', value: 'voice'  },
          ],
        },
        metrics: ['nOffered', 'nConnected', 'tHandle', 'tTalk', 'tHeld', 'tAcw'],
        flattenMultivaluedDimensions: true,
      };

      const [aggData, presData] = await Promise.all([
        gPost('/api/v2/analytics/conversations/aggregates/query', aggQuery),
        gGet('/api/v2/users?pageSize=200&active=true&expand=presence,routingStatus'),
      ]);

      // Build presence map for all active users
      const userMap = {};
      (presData.entities || []).forEach(u => {
        const sp = u.presence?.presenceDefinition?.systemPresence || 'Offline';
        const rs = u.routingStatus?.status || null;
        userMap[u.id] = {
          name:          u.name,
          email:        (u.email || '').toLowerCase(),
          presence:      normalizeStatus(sp, rs),
          routingStatus: rs,
          loginTime:     u.presence?.modifiedDate || null,
          isCC:          rs !== null,
        };
      });

      // Build aggregate map indexed by userId
      const aggMap = {};
      (aggData.results || []).forEach(r => {
        const userId = r.group?.userId;
        if (!userId) return;
        const m = {};
        (r.data || []).forEach(d => { m[d.metric] = d.stats; });
        aggMap[userId] = m;
      });

      // Merge: return ALL users who are either isCC or have aggregate data
      const agents = [];
      const seenIds = new Set();

      // First: users with aggregate data
      Object.entries(aggMap).forEach(([userId, m]) => {
        seenIds.add(userId);
        const user         = userMap[userId] || {};
        const handled      = m.nConnected?.count || 0;
        const avgHandleSec = m.tHandle?.count > 0 ? Math.round((m.tHandle.sum || 0) / m.tHandle.count / 1000) : 0;
        const avgTalkSec   = m.tTalk?.count   > 0 ? Math.round((m.tTalk.sum   || 0) / m.tTalk.count   / 1000) : 0;
        const avgHoldSec   = m.tHeld?.count   > 0 ? Math.round((m.tHeld.sum   || 0) / m.tHeld.count   / 1000) : 0;
        const avgAcwSec    = m.tAcw?.count    > 0 ? Math.round((m.tAcw.sum    || 0) / m.tAcw.count    / 1000) : 0;

        agents.push({
          id: userId, name: user.name || userId, email: user.email || '',
          answered: handled, handled,
          avgHandleSec, avgHandleFmt: fmt(avgHandleSec),
          avgAHT_sec:   avgHandleSec, avgAHT_fmt: fmt(avgHandleSec),
          avgTalkSec,   avgTalkFmt:   fmt(avgTalkSec),  talkSec: avgTalkSec,
          avgHoldSec,   avgHoldFmt:   fmt(avgHoldSec),  holdSec: avgHoldSec,
          holdCount:    m.tHeld?.count || 0,
          avgAcwSec,    avgAcwFmt:    fmt(avgAcwSec),   acwSec: avgAcwSec,
          transferCount:   0,
          routingStatus:   user.routingStatus || null,
          presence:        user.presence || 'Offline',
          loginTime:       user.loginTime || null,
        });
      });

      // Second: CC users with no aggregate data (zero-call agents)
      Object.entries(userMap).forEach(([userId, user]) => {
        if (seenIds.has(userId)) return;
        if (!user.isCC) return;  // only include queue agents, not all Genesys users
        agents.push({
          id: userId, name: user.name, email: user.email || '',
          answered: 0, handled: 0,
          avgHandleSec: 0, avgHandleFmt: '0s',
          avgAHT_sec:   0, avgAHT_fmt:   '0s',
          avgTalkSec:   0, avgTalkFmt:   '0s', talkSec: 0,
          avgHoldSec:   0, avgHoldFmt:   '0s', holdSec: 0,
          holdCount:    0,
          avgAcwSec:    0, avgAcwFmt:    '0s', acwSec: 0,
          transferCount:   0,
          routingStatus:   user.routingStatus || null,
          presence:        user.presence || 'Offline',
          loginTime:       user.loginTime || null,
        });
      });

      agents.sort((a, b) => b.handled - a.handled);
      log('agent_performance:', agents.length, 'agents (incl. zero-call)');

      return res.json({
        ok: true,
        queue:    { id: queue.id, name: queue.name },
        interval,
        agents,
      });
    }

    // ── dashboard_summary ─────────────────────────────────────────────────────
    // Returns: { ok, queue, interval, users, live, performance }
    if (endpoint === 'dashboard_summary') {
      const interval = buildInterval(req.query);
      const queue    = await resolveQueue(req.query.queueId, req.query.queueName);
      log('dashboard_summary', interval, queue.id);

      const aggQuery = {
        interval,
        groupBy: ['queueId'],
        filter: {
          type: 'and',
          predicates: [
            { type: 'dimension', dimension: 'queueId',   operator: 'matches', value: queue.id },
            { type: 'dimension', dimension: 'mediaType', operator: 'matches', value: 'voice'  },
          ],
        },
        metrics: ['nOffered', 'nConnected', 'tHandle', 'tTalk', 'tHeld', 'tAcw', 'tAnswered'],
        flattenMultivaluedDimensions: true,
      };

      // presence + obs: non-fatal; aggregate: fatal
      const [presData, aggData, obsData] = await Promise.all([
        gGet('/api/v2/users?pageSize=200&active=true&expand=presence,routingStatus')
          .catch(e => { lerr('presence non-fatal:', e.message); return { entities: [] }; }),
        gPost('/api/v2/analytics/conversations/aggregates/query', aggQuery),
        gPost('/api/v2/analytics/queues/observations/query', {
          filter: {
            type: 'or',
            predicates: [{ type: 'dimension', dimension: 'queueId', operator: 'matches', value: queue.id }],
          },
          metrics: OBS_METRICS,
        }).catch(e => { lerr('obs non-fatal:', e.message); return { results: [] }; }),
      ]);

      const users = (presData.entities || []).map(u => {
        const sp         = u.presence?.presenceDefinition?.systemPresence || 'Offline';
        const rs         = u.routingStatus?.status || null;
        const normalized = normalizeStatus(sp, rs);
        return {
          id: u.id, name: u.name, email: (u.email || '').toLowerCase(),
          presence: sp, presenceLabel: u.presence?.presenceDefinition?.name || sp,
          routingStatus: rs, normalized,
          isOnline:  normalized !== 'Offline',
          isCC:      rs !== null,
          loginTime: u.presence?.modifiedDate || null,
        };
      });

      const performance = parseAggregates(aggData);

      const om = {};
      (obsData.results?.[0]?.data || []).forEach(d => { om[d.metric] = d.stats; });
      const live = {
        waiting:         om.oOnQueueUsers?.count  || 0,
        interactions:    om.oInteracting?.count   || 0,
        alerting:        om.oAlerting?.count      || 0,
        onQueue:         om.oOnQueueUsers?.count  || 0,
        offQueue:        om.oOffQueueUsers?.count || 0,
        onQueueCount:    om.oOnQueueUsers?.count  || 0,
        interacting:     om.oInteracting?.count   || 0,
        longestWaiting:  om.oLongestWaiting?.max  || om.oLongestWaiting?.count || 0,
        serviceLevelLive: null,
      };
      performance.currentWaiting = live.waiting;

      return res.json({
        ok: true,
        queue:    { id: queue.id, name: queue.name },
        interval,
        users,
        live,
        performance,
      });
    }

    // ── adherence ─────────────────────────────────────────────────────────────
    if (endpoint === 'adherence') {
      const userIds = req.query.userIds ? req.query.userIds.split(',') : [];
      if (!userIds.length) return fail(400, 'Pass ?userIds=id1,id2');
      const data = await gPost('/api/v2/workforcemanagement/adherence', { userIds });
      return res.json({ ok: true, adherence: data });
    }

    return fail(400, `Unknown endpoint: "${endpoint}"`,
      'Valid: health, presence, queue_activity, queue_performance, agent_performance, dashboard_summary, adherence');

  } catch (e) {
    lerr('UNHANDLED', endpoint, e.message);
    return fail(500, e.message,
      `endpoint=${endpoint} — see Vercel function logs for full payload/response`);
  }
}
