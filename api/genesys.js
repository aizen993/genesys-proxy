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
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();
      data = await genesysPost('/api/v2/analytics/conversations/details/query', {
        interval: `${startOfDay}/${endOfDay}`,
        order: 'asc',
        orderBy: 'conversationStart',
        paging: { pageSize: 200, pageNumber: 1 },
        segmentFilters: [],
        conversationFilters: [],
      }, region);
      // Aggregate per agent
      const agentMap = {};
      (data.conversations || []).forEach(conv => {
        (conv.participants || []).forEach(p => {
          if (p.purpose !== 'agent') return;
          const aid = p.userId;
          if (!aid) return;
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
      const agents = Object.values(agentMap).map(a => ({
        ...a,
        aht: a.calls > 0 ? Math.round(a.totalHandleMs / a.calls / 1000) : 0, // seconds
        talkTime: Math.round(a.totalTalkMs / 1000),
        holdTime: Math.round(a.totalHoldMs / 1000),
        acwTime: Math.round(a.totalAcwMs / 1000),
      }));
      return res.json({ ok: true, agents });
    }

    // ── Queue Observations (SLA, waiting, on-queue) ──────────────────────────
    if (endpoint === 'queue_obs') {
      // Get all queues first if queueId not specified
      const queueId = req.query.queueId;
      let queueIds = queueId ? [queueId] : [];
      if (!queueIds.length) {
        const queues = await genesysGet('/api/v2/routing/queues?pageSize=100', region);
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
        return {
          queueId: r.group?.queueId,
          waiting: metrics.oWaiting?.count || 0,
          interacting: metrics.oInteracting?.count || 0,
          alerting: metrics.oAlerting?.count || 0,
          serviceLevel: metrics.oServiceLevel?.pct || null,
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
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();
      data = await genesysPost('/api/v2/analytics/conversations/aggregates/query', {
        interval: `${startOfDay}/${endOfDay}`,
        groupBy: ['mediaType'],
        metrics: ['tHandle', 'tAcw', 'tTalk', 'tHeld', 'nOffered', 'nAnswered', 'nAbandoned'],
        flattenMultivaluedDimensions: true,
      }, region);
      const summary = { offered: 0, answered: 0, abandoned: 0, avgHandleSec: 0, avgTalkSec: 0 };
      (data.results || []).forEach(r => {
        (r.data || []).forEach(d => {
          if (d.metric === 'nOffered') summary.offered += d.stats?.count || 0;
          if (d.metric === 'nAnswered') summary.answered += d.stats?.count || 0;
          if (d.metric === 'nAbandoned') summary.abandoned += d.stats?.count || 0;
          if (d.metric === 'tHandle' && d.stats?.count > 0) summary.avgHandleSec = Math.round((d.stats.sum || 0) / d.stats.count / 1000);
          if (d.metric === 'tTalk' && d.stats?.count > 0) summary.avgTalkSec = Math.round((d.stats.sum || 0) / d.stats.count / 1000);
        });
      });
      summary.abandonRate = summary.offered > 0 ? ((summary.abandoned / summary.offered) * 100).toFixed(1) : '0.0';
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
