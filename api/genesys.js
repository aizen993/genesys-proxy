// Genesys Cloud Proxy — Vercel Serverless Function
// Region: mypurecloud.de
// Valid ConversationAggregateMetrics (verified from API error):
//   nOffered, nConnected, nConversations, nBlindTransferred,
//   nConsult, nConsultTransferred, nError, nOutbound
//   tHandle, tTalk, tHeld, tAcw, tAnswered, tAbandoned (time-based = valid)
// NOT valid: nAnswered, nAbandoned, nInServiceLevel (these 400 on this region)

const DEBUG = process.env.GENESYS_DEBUG === 'true';
const DEFAULT_QUEUE_NAME = process.env.GENESYS_QUEUE_NAME || 'Qmobility_Queue';
function dbg(...a) { if (DEBUG) console.log('[GENESYS]', ...a); }

// ── Token cache ──────────────────────────────────────────────────────────────
let _tok = { token: null, exp: 0 };
function getRegion() {
  return (process.env.GENESYS_REGION || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
}
async function getToken() {
  if (_tok.token && Date.now() < _tok.exp - 30000) return _tok.token;
  const region = getRegion();
  const id = (process.env.GENESYS_CLIENT_ID || '').trim();
  const secret = (process.env.GENESYS_CLIENT_SECRET || '').trim();
  if (!region || !id || !secret) throw new Error('Missing GENESYS_CLIENT_ID / GENESYS_CLIENT_SECRET / GENESYS_REGION');
  const r = await fetch(`https://login.${region}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`OAuth ${r.status}: ${txt.slice(0, 200)}`);
  const d = JSON.parse(txt);
  _tok.token = d.access_token;
  _tok.exp = Date.now() + (d.expires_in || 3600) * 1000;
  return _tok.token;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function gGet(path) {
  const token = await getToken();
  const url = `https://api.${getRegion()}${path}`;
  dbg('GET', url);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) { const e = await r.text(); dbg('GET ERR', e.slice(0,500)); throw new Error(`GET ${path} -> ${r.status}: ${e.slice(0,250)}`); }
  return r.json();
}
async function gPost(path, body) {
  const token = await getToken();
  const url = `https://api.${getRegion()}${path}`;
  dbg('POST', url, JSON.stringify(body).slice(0, 300));
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { const e = await r.text(); dbg('POST ERR', e.slice(0,500)); throw new Error(`POST ${path} -> ${r.status}: ${e.slice(0,250)}`); }
  return r.json();
}

// ── Interval: local day in Asia/Dubai ───────────────────────────────────────
function buildInterval(q = {}) {
  if (q.start && q.end) return `${q.start}/${q.end}`;
  const tz = q.timezone || 'Asia/Dubai';
  const dateStr = q.date || new Date().toLocaleDateString('en-CA', { timeZone: tz });
  // midnight UTC for that local date in Asia/Dubai (UTC+4)
  const [y, m, d] = dateStr.split('-').map(Number);
  // Asia/Dubai = UTC+4 always (no DST)
  const startUTC = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 4 * 3600000);
  const endUTC   = new Date(startUTC.getTime() + 86400000 - 1);
  const s = startUTC.toISOString();
  const e = endUTC.toISOString();
  dbg('interval', s, e, 'for', dateStr, tz);
  return `${s}/${e}`;
}

// ── Format seconds ───────────────────────────────────────────────────────────
function fmt(sec) {
  if (!sec || sec <= 0) return '0s';
  const m = Math.floor(sec / 60), s = String(sec % 60).padStart(2, '0');
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

// ── Queue resolver ────────────────────────────────────────────────────────────
const _qCache = {};
async function resolveQueue(queueId, queueName) {
  const name = queueName || DEFAULT_QUEUE_NAME;
  if (queueId) return { id: queueId, name };
  if (_qCache[name]) return _qCache[name];
  const data = await gGet(`/api/v2/routing/queues?pageSize=100&name=${encodeURIComponent(name)}`);
  const q = (data.entities || []).find(x => x.name === name) || data.entities?.[0];
  if (!q) throw new Error(`Queue not found: "${name}"`);
  _qCache[name] = { id: q.id, name: q.name };
  dbg('resolved queue', q.name, q.id);
  return _qCache[name];
}

// ── Normalize agent status ────────────────────────────────────────────────────
function normalizeStatus(sp, rs) {
  const r = (rs || '').toUpperCase();
  const p = (sp || '').toLowerCase();
  if (r === 'INTERACTING' || r === 'COMMUNICATING') return 'Interacting';
  if (r === 'NOT_RESPONDING') return 'Not Responding';
  if (r === 'IDLE') return p === 'available' ? 'Available' : 'Idle';
  if (p === 'available') return 'Available';
  if (p.includes('break') || p.includes('pause')) return 'Break';
  if (p === 'busy') return 'Busy';
  if (p === 'away') return 'Away';
  if (p === 'meal') return 'Meal';
  return sp || 'Offline';
}

// ════════════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const endpoint = (req.query.endpoint || req.query.action || '').trim();
  dbg('endpoint:', endpoint, 'query:', JSON.stringify(req.query));

  const fail = (status, error, details = '') =>
    res.status(status).json({ ok: false, error, details, endpoint, status });

  try {

    // ── health ──────────────────────────────────────────────────────────────
    if (!endpoint || endpoint === 'health') {
      const token = await getToken();
      return res.json({ ok: true, region: getRegion(), hasToken: !!token, defaultQueueName: DEFAULT_QUEUE_NAME, debug: DEBUG });
    }

    // ── presence ────────────────────────────────────────────────────────────
    if (endpoint === 'presence' || endpoint === 'users') {
      let all = [], page = 1;
      while (true) {
        const d = await gGet(`/api/v2/users?pageSize=100&pageNumber=${page}&expand=presence,routingStatus&active=true`);
        all = all.concat(d.entities || []);
        if (!d.nextUri || all.length >= (d.total || 0) || ++page > 5) break;
      }
      const users = all.map(u => {
        const sp = u.presence?.presenceDefinition?.systemPresence || 'Offline';
        const rs = u.routingStatus?.status || null;
        const normalized = normalizeStatus(sp, rs);
        return {
          id: u.id, name: u.name, email: u.email || '',
          presence: sp, presenceLabel: u.presence?.presenceDefinition?.name || sp,
          routingStatus: rs, normalized,
          isOnline: normalized !== 'Offline',
          isCC: rs !== null,
          loginTime: u.presence?.modifiedDate || null,
        };
      });
      return res.json({ ok: true, users });
    }

    // ── queue_activity (live observations) ──────────────────────────────────
    if (endpoint === 'queue_activity' || endpoint === 'queue_obs') {
      const queue = await resolveQueue(req.query.queueId, req.query.queueName);
      const data = await gPost('/api/v2/analytics/queues/observations/query', {
        filter: { type: 'or', predicates: [{ type: 'dimension', dimension: 'queueId', operator: 'matches', value: queue.id }] },
        metrics: ['oOnQueueUsers', 'oOffQueueUsers', 'oInteracting', 'oAlerting', 'oLongestWaiting', 'oLongestInteracting', 'oMemberUsers'],
      });
      const m = {};
      (data.results?.[0]?.data || []).forEach(d => { m[d.metric] = d.stats; });
      const live = {
        waiting: m.oInteracting?.count || 0,
        interactions: m.oInteracting?.count || 0,
        alerting: m.oAlerting?.count || 0,
        onQueue: m.oOnQueueUsers?.count || 0,
        offQueue: m.oOffQueueUsers?.count || 0,
        onQueueCount: m.oOnQueueUsers?.count || 0,
        interacting: m.oInteracting?.count || 0,
        alerting: m.oAlerting?.count || 0,
        longestWaiting: m.oLongestWaiting?.count || 0,
        serviceLevelLive: null,
      };
      // legacy compat
      return res.json({ ok: true, queue: { id: queue.id, name: queue.name }, interval: 'live', live,
        queues: [{ ...live, queueId: queue.id, waiting: live.onQueueCount, interacting: live.interacting, serviceLevel: null }],
        totalWaiting: live.onQueueCount, totalInteracting: live.interacting });
    }

    // ── queue_performance & calls_today ──────────────────────────────────────
    // VALID metrics only: nOffered, nConnected (=answered), tHandle, tTalk, tHeld, tAcw, tAnswered
    // nAbandoned = nOffered - nConnected
    // SL comes from live observations only (oServiceLevel)
    if (endpoint === 'queue_performance' || endpoint === 'calls_today') {
      const interval = buildInterval(req.query);
      const queue = await resolveQueue(req.query.queueId, req.query.queueName);
      dbg('queue_performance interval:', interval, 'queue:', queue.id);

      // Run aggregate + live obs in parallel
      const [aggData, obsData] = await Promise.all([
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
          // ONLY valid metrics for this region
          metrics: ['nOffered', 'nConnected', 'tHandle', 'tTalk', 'tHeld', 'tAcw', 'tAnswered'],
          flattenMultivaluedDimensions: true,
        }),
        gPost('/api/v2/analytics/queues/observations/query', {
          filter: { type: 'or', predicates: [{ type: 'dimension', dimension: 'queueId', operator: 'matches', value: queue.id }] },
          metrics: ['oOnQueueUsers', 'oInteracting', 'oAlerting', 'oLongestWaiting'],
        }).catch(() => ({ results: [] })),
      ]);

      let nOffered = 0, nConnected = 0;
      let handleSum = 0, handleCnt = 0, talkSum = 0, talkCnt = 0;
      let holdSum = 0, holdCnt = 0, acwSum = 0, acwCnt = 0, waitSum = 0, waitCnt = 0;

      (aggData.results || []).forEach(r => {
        (r.data || []).forEach(d => {
          const cnt = d.stats?.count || 0, sum = d.stats?.sum || 0;
          if (d.metric === 'nOffered')   nOffered   += cnt;
          if (d.metric === 'nConnected') nConnected  = Math.max(nConnected, cnt);
          if (d.metric === 'tHandle'  && cnt) { handleSum += sum; handleCnt += cnt; }
          if (d.metric === 'tTalk'    && cnt) { talkSum   += sum; talkCnt   += cnt; }
          if (d.metric === 'tHeld'    && cnt) { holdSum   += sum; holdCnt   += cnt; }
          if (d.metric === 'tAcw'     && cnt) { acwSum    += sum; acwCnt    += cnt; }
          if (d.metric === 'tAnswered' && cnt) { waitSum  += sum; waitCnt   += cnt; } // ASA
        });
      });

      // Derived
      const nAbandoned = Math.max(0, nOffered - nConnected);
      const avgHandleSec = handleCnt > 0 ? Math.round(handleSum / handleCnt / 1000) : 0;
      const avgTalkSec   = talkCnt   > 0 ? Math.round(talkSum   / talkCnt   / 1000) : 0;
      const avgHoldSec   = holdCnt   > 0 ? Math.round(holdSum   / holdCnt   / 1000) : 0;
      const avgAcwSec    = acwCnt    > 0 ? Math.round(acwSum    / acwCnt    / 1000) : 0;
      const asaSec       = waitCnt   > 0 ? Math.round(waitSum   / waitCnt   / 1000) : 0;

      // SL from live observations
      let slPct = null, currentWaiting = 0;
      (obsData.results?.[0]?.data || []).forEach(d => {
        if (d.metric === 'oInteracting') currentWaiting = d.stats?.count || 0;
        // oServiceLevel not valid in this region
      });

      const performance = {
        offered: nOffered, answered: nConnected, abandoned: nAbandoned,
        answerPct:  nOffered > 0 ? parseFloat((nConnected / nOffered * 100).toFixed(1)) : 0,
        abandonPct: nOffered > 0 ? parseFloat((nAbandoned / nOffered * 100).toFixed(1)) : 0,
        asaSec, asaFmt: fmt(asaSec), serviceLevelPct: slPct,
        avgHandleSec, avgHandleFmt: fmt(avgHandleSec),
        avgTalkSec,   avgTalkFmt:   fmt(avgTalkSec),
        avgHoldSec,   avgHoldFmt:   fmt(avgHoldSec),
        avgAcwSec,    avgAcwFmt:    fmt(avgAcwSec),
        holdCount: holdCnt, transferCount: 0,
      };

      // Legacy summary shape (frontend reads d.summary)
      const summary = {
        ...performance, currentWaiting,
        serviceLevel: slPct, avgAHT: avgHandleSec, avgHandle: avgHandleSec,
        avgASA: asaSec, avgWaitSec: asaSec, avgTalk: avgTalkSec,
        avgHandleSec, avgTalkSec, abandonRate: performance.abandonPct,
      };

      return res.json({ ok: true, queue: { id: queue.id, name: queue.name }, interval, performance, summary });
    }

    // ── agent_performance & agent_kpis ────────────────────────────────────────
    // groupBy userId + queueId filter = works with Supervisor role
    // WITHOUT queueId filter = requires Analytics role = 403
    if (endpoint === 'agent_performance' || endpoint === 'agent_kpis') {
      const interval = buildInterval(req.query);
      const queue = await resolveQueue(req.query.queueId, req.query.queueName);
      dbg('agent_performance interval:', interval, 'queue:', queue.id);

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
          // ONLY valid metrics
          metrics: ['nOffered', 'nConnected', 'tHandle', 'tTalk', 'tHeld', 'tAcw'],
          flattenMultivaluedDimensions: true,
        }),
        gGet('/api/v2/users?pageSize=200&active=true&expand=presence,routingStatus'),
      ]);

      const userMap = {};
      (presData.entities || []).forEach(u => {
        const sp = u.presence?.presenceDefinition?.systemPresence || 'Offline';
        const rs = u.routingStatus?.status || null;
        userMap[u.id] = { name: u.name, presence: normalizeStatus(sp, rs), routingStatus: rs, loginTime: u.presence?.modifiedDate || null };
      });

      const agents = [];
      (aggData.results || []).forEach(r => {
        const userId = r.group?.userId;
        if (!userId) return;
        const m = {};
        (r.data || []).forEach(d => { m[d.metric] = d.stats; });
        const handled = m.nConnected?.count || 0;
        const avgHandleSec = m.tHandle?.count > 0 ? Math.round((m.tHandle.sum||0) / m.tHandle.count / 1000) : 0;
        const avgTalkSec   = m.tTalk?.count   > 0 ? Math.round((m.tTalk.sum  ||0) / m.tTalk.count   / 1000) : 0;
        const avgHoldSec   = m.tHeld?.count   > 0 ? Math.round((m.tHeld.sum  ||0) / m.tHeld.count   / 1000) : 0;
        const avgAcwSec    = m.tAcw?.count    > 0 ? Math.round((m.tAcw.sum   ||0) / m.tAcw.count    / 1000) : 0;
        const user = userMap[userId] || {};
        agents.push({
          id: userId, name: user.name || userId,
          answered: handled, handled,
          avgHandleSec, avgHandleFmt: fmt(avgHandleSec), avgAHT_sec: avgHandleSec, avgAHT_fmt: fmt(avgHandleSec),
          avgTalkSec,   avgTalkFmt:   fmt(avgTalkSec),   talkSec: avgTalkSec,
          avgHoldSec,   avgHoldFmt:   fmt(avgHoldSec),   holdSec: avgHoldSec,
          holdCount: m.tHeld?.count || 0,
          avgAcwSec,    avgAcwFmt:    fmt(avgAcwSec),    acwSec: avgAcwSec,
          transferCount: 0,
          routingStatus: user.routingStatus || null,
          presence: user.presence || 'Offline',
          loginTime: user.loginTime || null,
        });
      });

      agents.sort((a, b) => b.handled - a.handled);
      dbg('agent_performance:', agents.length, 'agents');
      return res.json({ ok: true, queue: { id: queue.id, name: queue.name }, interval, agents });
    }

    // ── dashboard_summary ────────────────────────────────────────────────────
    if (endpoint === 'dashboard_summary') {
      const interval = buildInterval(req.query);
      const queue = await resolveQueue(req.query.queueId, req.query.queueName);
      dbg('dashboard_summary interval:', interval, 'queue:', queue.id);

      const [presData, aggData, obsData] = await Promise.all([
        gGet('/api/v2/users?pageSize=200&active=true&expand=presence,routingStatus'),
        gPost('/api/v2/analytics/conversations/aggregates/query', {
          interval, groupBy: ['queueId'],
          filter: { type: 'and', predicates: [
            { type: 'dimension', dimension: 'queueId', operator: 'matches', value: queue.id },
            { type: 'dimension', dimension: 'mediaType', operator: 'matches', value: 'voice' },
          ]},
          metrics: ['nOffered', 'nConnected', 'tHandle', 'tTalk', 'tHeld', 'tAcw', 'tAnswered'],
          flattenMultivaluedDimensions: true,
        }),
        gPost('/api/v2/analytics/queues/observations/query', {
          filter: { type: 'or', predicates: [{ type: 'dimension', dimension: 'queueId', operator: 'matches', value: queue.id }] },
          metrics: ['oOnQueueUsers', 'oOffQueueUsers', 'oInteracting', 'oAlerting', 'oLongestWaiting', 'oLongestInteracting', 'oMemberUsers'],
        }),
      ]);

      // Presence
      const users = (presData.entities || []).map(u => {
        const sp = u.presence?.presenceDefinition?.systemPresence || 'Offline';
        const rs = u.routingStatus?.status || null;
        const normalized = normalizeStatus(sp, rs);
        return { id: u.id, name: u.name, email: u.email||'', presence: sp, presenceLabel: u.presence?.presenceDefinition?.name||sp,
          routingStatus: rs, normalized, isOnline: normalized !== 'Offline', isCC: rs !== null, loginTime: u.presence?.modifiedDate||null };
      });

      // Aggregates
      let nOffered=0, nConnected=0;
      let handleSum=0,handleCnt=0,talkSum=0,talkCnt=0,holdSum=0,holdCnt=0,acwSum=0,acwCnt=0,waitSum=0,waitCnt=0;
      (aggData.results||[]).forEach(r=>{
        (r.data||[]).forEach(d=>{
          const cnt=d.stats?.count||0, sum=d.stats?.sum||0;
          if(d.metric==='nOffered')   nOffered   +=cnt;
          if(d.metric==='nConnected') nConnected  =Math.max(nConnected,cnt);
          if(d.metric==='tHandle' &&cnt){handleSum+=sum;handleCnt+=cnt;}
          if(d.metric==='tTalk'   &&cnt){talkSum  +=sum;talkCnt  +=cnt;}
          if(d.metric==='tHeld'   &&cnt){holdSum  +=sum;holdCnt  +=cnt;}
          if(d.metric==='tAcw'    &&cnt){acwSum   +=sum;acwCnt   +=cnt;}
          if(d.metric==='tAnswered'&&cnt){waitSum +=sum;waitCnt  +=cnt;}
        });
      });
      const nAbandoned = Math.max(0, nOffered - nConnected);
      const avgHandleSec=handleCnt>0?Math.round(handleSum/handleCnt/1000):0;
      const avgTalkSec  =talkCnt  >0?Math.round(talkSum  /talkCnt  /1000):0;
      const avgHoldSec  =holdCnt  >0?Math.round(holdSum  /holdCnt  /1000):0;
      const avgAcwSec   =acwCnt   >0?Math.round(acwSum   /acwCnt   /1000):0;
      const asaSec      =waitCnt  >0?Math.round(waitSum  /waitCnt  /1000):0;

      // Live obs
      const om={};
      (obsData.results?.[0]?.data||[]).forEach(d=>{om[d.metric]=d.stats;});
      const slPct=null; // oServiceLevel not a valid QueueObservationMetric
      const live={
        waiting:      om.oInteracting?.count||0,
        interactions: om.oInteracting?.count||0,
        onQueue:      om.oOnQueueUsers?.count||0,
        offQueue:     om.oOffQueueUsers?.count||0,
        idle:         0,
        communicating:0,
        interacting:  om.oInteracting?.count||0,
        notResponding:0,
        available:    0,
        serviceLevelLive: null,
      };

      const summary={
        offered:nOffered, answered:nConnected, abandoned:nAbandoned,
        answerPct: nOffered>0?parseFloat((nConnected/nOffered*100).toFixed(1)):0,
        abandonPct:nOffered>0?parseFloat((nAbandoned/nOffered*100).toFixed(1)):0,
        asaSec, asaFmt:fmt(asaSec), serviceLevelPct:slPct, serviceLevel:slPct,
        avgHandleSec, avgHandleFmt:fmt(avgHandleSec),
        avgTalkSec,   avgTalkFmt:  fmt(avgTalkSec),
        avgHoldSec,   avgHoldFmt:  fmt(avgHoldSec),
        avgAcwSec,    avgAcwFmt:   fmt(avgAcwSec),
        // legacy aliases
        avgAHT:avgHandleSec, avgHandle:avgHandleSec, avgASA:asaSec,
        avgWaitSec:asaSec, avgTalk:avgTalkSec, abandonRate:nOffered>0?parseFloat((nAbandoned/nOffered*100).toFixed(1)):0,
        currentWaiting:live.interactions,
      };

      return res.json({ ok:true, queue:{id:queue.id,name:queue.name}, interval, users, live, summary, performance:summary, cards:summary });
    }

    // ── adherence ────────────────────────────────────────────────────────────
    if (endpoint === 'adherence') {
      const userIds = req.query.userIds ? req.query.userIds.split(',') : [];
      if (!userIds.length) return fail(400, 'Pass ?userIds=id1,id2');
      const data = await gPost('/api/v2/workforcemanagement/adherence', { userIds });
      return res.json({ ok: true, adherence: data });
    }

    return fail(400, `Unknown endpoint: "${endpoint}"`,
      'Valid: health, presence, queue_activity, queue_performance, agent_performance, dashboard_summary, adherence');

  } catch (err) {
    console.error('[GENESYS]', endpoint, err.message);
    return fail(500, err.message, 'Check Vercel function logs');
  }
}
