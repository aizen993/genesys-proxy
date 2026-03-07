// Genesys Cloud Proxy — Vercel Serverless Function
// Deploy to: api/genesys.js
// Required env vars in Vercel: GENESYS_CLIENT_ID, GENESYS_CLIENT_SECRET, GENESYS_REGION
// GENESYS_REGION format: mypurecloud.com  OR  euw2.pure.cloud  (NO https://, NO trailing slash)

let _tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt - 30000) {
    return _tokenCache.token;
  }
  const region = (process.env.GENESYS_REGION || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const clientId = (process.env.GENESYS_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GENESYS_CLIENT_SECRET || '').trim();

  if (!region || !clientId || !clientSecret) {
    throw new Error('Missing env vars: GENESYS_CLIENT_ID, GENESYS_CLIENT_SECRET, GENESYS_REGION');
  }

  const loginUrl = `https://login.${region}/oauth/token`;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(loginUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OAuth failed (${res.status}): ${text}`);
  }

  const data = JSON.parse(text);
  _tokenCache.token = data.access_token;
  _tokenCache.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return data.access_token;
}

async function genesysGet(path, region) {
  const token = await getToken();
  const url = `https://api.${region}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Genesys API error ${res.status}: ${err}`);
  }
  return res.json();
}

async function genesysPost(path, body, region) {
  const token = await getToken();
  const url = `https://api.${region}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Genesys API error ${res.status}: ${err}`);
  }
  return res.json();
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const region = (process.env.GENESYS_REGION || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const endpoint = req.query.endpoint || '';

  try {
    let data;

    // ── Presence / Login Status ──────────────────────────────────────────────
    if (endpoint === 'presence') {
      // Returns all users with their current presence (Available, Busy, Away, Offline, etc.)
      data = await genesysGet('/api/v2/users?pageSize=200&expand=presence', region);
      const users = (data.entities || []).map(u => ({
        id: u.id,
        name: u.name,
        email: u.email,
        presence: u.presence?.presenceDefinition?.systemPresence || 'Offline',
        presenceLabel: u.presence?.presenceDefinition?.name || 'Offline',
        routingStatus: u.routingStatus?.status || null,
        loginTime: u.presence?.modifiedDate || null,
      }));
      return res.json({ ok: true, users });
    }

    // ── Adherence / Break Status ─────────────────────────────────────────────
    if (endpoint === 'adherence') {
      // Returns WFM adherence data (on break, on queue, etc.)
      // Requires user IDs — accept via query param or POST body
      const userIds = req.query.userIds ? req.query.userIds.split(',') : (req.body?.userIds || []);
      if (!userIds.length) {
        return res.json({ ok: false, error: 'Pass userIds as query param or POST body' });
      }
      data = await genesysPost('/api/v2/workforcemanagement/adherence', { userIds }, region);
      return res.json({ ok: true, adherence: data });
    }

    // ── Agent KPIs (conversation metrics) ───────────────────────────────────
    if (endpoint === 'agent_kpis') {
      const now = new Date();
      // Use UTC midnight for interval to match Genesys expectations
      const y = now.getFullYear(), m = String(now.getMonth()+1).padStart(2,'0'), d2 = String(now.getDate()).padStart(2,'0');
      const interval = `${y}-${m}-${d2}T00:00:00.000Z/${y}-${m}-${d2}T23:59:59.999Z`;
      let agentMap = {};
      try {
        data = await genesysPost('/api/v2/analytics/conversations/details/query', {
          interval,
          paging: { pageSize: 100, pageNumber: 1 },
        }, region);
        (data.conversations || []).forEach(conv => {
          (conv.participants || []).forEach(p => {
            if (p.purpose !== 'agent' || !p.userId) return;
            const aid = p.userId;
            if (!agentMap[aid]) agentMap[aid] = { userId: aid, name: p.participantName || aid, calls: 0, totalHandleMs: 0, totalTalkMs: 0, totalHoldMs: 0, totalAcwMs: 0 };
            agentMap[aid].calls++;
            (p.sessions || []).forEach(s => {
              (s.segments || []).forEach(seg => {
                const dur = seg.durationMs || 0;
                if (seg.segmentType === 'interact') agentMap[aid].totalTalkMs += dur;
                if (seg.segmentType === 'hold') agentMap[aid].totalHoldMs += dur;
                if (seg.segmentType === 'wrapup') agentMap[aid].totalAcwMs += dur;
              });
            });
            agentMap[aid].totalHandleMs = agentMap[aid].totalTalkMs + agentMap[aid].totalHoldMs + agentMap[aid].totalAcwMs;
          });
        });
      } catch(e) {
        // If details query fails (permissions), fall back to aggregate query per user
        console.error('agent_kpis details query failed:', e.message);
        agentMap = {}; // return empty but don't crash
      }
      const agents = Object.values(agentMap).map(a => ({
        id: a.userId,
        name: a.name,
        handled: a.calls,
        avgAHT_sec: a.calls > 0 ? Math.round(a.totalHandleMs / a.calls / 1000) : 0,
        talkSec: Math.round(a.totalTalkMs / 1000),
        holdSec: Math.round(a.totalHoldMs / 1000),
        acwSec: Math.round(a.totalAcwMs / 1000),
        avgAHT_fmt: (() => { const s = a.calls > 0 ? Math.round(a.totalHandleMs/a.calls/1000) : 0; return s > 0 ? Math.floor(s/60)+'m'+String(s%60).padStart(2,'0')+'s' : '0s'; })(),
      }));
      return res.json({ ok: true, agents });
    }

    // ── Queue Observations (SLA, waiting, on-queue) ──────────────────────────
    if (endpoint === 'queue_obs') {
      const queueId = req.query.queueId;
      let queueIds = queueId ? [queueId] : [];
      if (!queueIds.length) {
        const queues = await genesysGet('/api/v2/routing/queues?pageSize=100&active=true', region);
        queueIds = (queues.entities || []).map(q => q.id);
      }
      if (!queueIds.length) return res.json({ ok: true, queues: [] });
      data = await genesysPost('/api/v2/analytics/queues/observations/query', {
        filter: {
          type: 'or',
          predicates: queueIds.map(id => ({ type: 'dimension', dimension: 'queueId', operator: 'matches', value: id })),
        },
        metrics: ['oWaiting', 'oInteracting', 'oAlerting', 'oServiceLevel', 'tAnswered', 'tAbandoned', 'tHandle', 'tAcw'],
      }, region);
      const queues = (data.results || []).map(r => {
        const metrics = {};
        (r.data || []).forEach(d => { metrics[d.metric] = d.stats; });
        const slRaw = metrics.oServiceLevel?.pct ?? metrics.oServiceLevel?.ratio ?? null;
        return {
          queueId: r.group?.queueId,
          waiting: metrics.oWaiting?.count || 0,
          interacting: metrics.oInteracting?.count || 0,
          alerting: metrics.oAlerting?.count || 0,
          serviceLevel: slRaw != null ? (slRaw <= 1 ? Math.round(slRaw * 100) : Math.round(slRaw)) : null,
          answered: metrics.tAnswered?.count || 0,
          abandoned: metrics.tAbandoned?.count || 0,
          avgHandle: metrics.tHandle?.count > 0 ? Math.round((metrics.tHandle?.sum || 0) / metrics.tHandle.count / 1000) : 0,
        };
      });
      return res.json({ ok: true, queues });
    }

    // ── Call Summary (today's stats) ─────────────────────────────────────────
    if (endpoint === 'calls_today') {
      const now = new Date();
      const y = now.getFullYear(), m = String(now.getMonth()+1).padStart(2,'0'), d2 = String(now.getDate()).padStart(2,'0');
      const interval = `${y}-${m}-${d2}T00:00:00.000Z/${y}-${m}-${d2}T23:59:59.999Z`;
      data = await genesysPost('/api/v2/analytics/conversations/aggregates/query', {
        interval,
        groupBy: ['mediaType'],
        metrics: ['tHandle', 'tAcw', 'tTalk', 'tHeld', 'tAnswered', 'nOffered', 'nAnswered', 'nAbandoned', 'nConnected'],
        flattenMultivaluedDimensions: true,
      }, region);
      const summary = { offered: 0, answered: 0, abandoned: 0, avgHandleSec: 0, avgTalkSec: 0, avgWaitSec: 0 };
      let handleCount = 0, talkCount = 0, waitCount = 0, handleSum = 0, talkSum = 0, waitSum = 0;
      (data.results || []).forEach(r => {
        (r.data || []).forEach(d => {
          const cnt = d.stats?.count || 0;
          const sum = d.stats?.sum || 0;
          if (d.metric === 'nOffered') summary.offered += cnt;
          if (d.metric === 'nAnswered' || d.metric === 'nConnected') summary.answered = Math.max(summary.answered, cnt);
          if (d.metric === 'nAbandoned') summary.abandoned += cnt;
          if (d.metric === 'tHandle' && cnt > 0) { handleSum += sum; handleCount += cnt; }
          if (d.metric === 'tTalk' && cnt > 0) { talkSum += sum; talkCount += cnt; }
          if (d.metric === 'tAnswered' && cnt > 0) { waitSum += sum; waitCount += cnt; }
        });
      });
      if (handleCount > 0) summary.avgHandleSec = Math.round(handleSum / handleCount / 1000);
      if (talkCount > 0) summary.avgTalkSec = Math.round(talkSum / talkCount / 1000);
      if (waitCount > 0) summary.avgWaitSec = Math.round(waitSum / waitCount / 1000);
      summary.abandonRate = summary.offered > 0 ? ((summary.abandoned / summary.offered) * 100).toFixed(1) : '0.0';
      // Try to get service level from queue observations
      try {
        const qAll = await genesysGet('/api/v2/routing/queues?pageSize=100&active=true', region);
        const qIds = (qAll.entities || []).map(q => q.id);
        if (qIds.length) {
          const qObs = await genesysPost('/api/v2/analytics/queues/observations/query', {
            filter: { type: 'or', predicates: qIds.map(id => ({ type: 'dimension', dimension: 'queueId', operator: 'matches', value: id })) },
            metrics: ['oServiceLevel', 'oWaiting', 'oInteracting'],
          }, region);
          let totalWaiting = 0;
          (qObs.results || []).forEach(r => {
            (r.data || []).forEach(d => {
              if (d.metric === 'oWaiting') totalWaiting += d.stats?.count || 0;
              if (d.metric === 'oServiceLevel' && d.stats != null) {
                const v = d.stats.pct ?? d.stats.ratio ?? d.stats.current ?? null;
                if (v != null) summary.serviceLevel = v <= 1 ? Math.round(v * 100) : Math.round(v);
              }
            });
          });
          summary.currentWaiting = totalWaiting;
        }
      } catch(e2) { /* SL lookup optional */ }
      return res.json({ ok: true, summary });
    }

    // ── Health Check ─────────────────────────────────────────────────────────
    if (endpoint === 'health' || !endpoint) {
      const token = await getToken();
      return res.json({ ok: true, message: 'Genesys proxy connected', region, hasToken: !!token });
    }

    return res.status(400).json({ ok: false, error: `Unknown endpoint: ${endpoint}. Valid: presence, adherence, agent_kpis, queue_obs, calls_today, health` });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
