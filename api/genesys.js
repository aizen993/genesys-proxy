// Genesys Cloud Proxy — Vercel Serverless Function
// Roles needed: Supervisor + User (Communicate-User optional)
// GENESYS_REGION format: mypurecloud.de  (no https://, no trailing slash)

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
  const res = await fetch(`https://login.${region}/oauth/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OAuth failed (${res.status}): ${text}`);
  const data = JSON.parse(text);
  _tokenCache.token = data.access_token;
  _tokenCache.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return data.access_token;
}

async function gGet(path, region) {
  const token = await getToken();
  const res = await fetch(`https://api.${region}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GET ${path} -> ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

async function gPost(path, body, region) {
  const token = await getToken();
  const res = await fetch(`https://api.${region}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`POST ${path} -> ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

function todayInterval() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}T00:00:00.000Z/${y}-${m}-${d}T23:59:59.999Z`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const region = (process.env.GENESYS_REGION || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const endpoint = req.query.endpoint || '';

  try {

    if (endpoint === 'health' || !endpoint) {
      const token = await getToken();
      return res.json({ ok: true, message: 'Genesys proxy connected', region, hasToken: !!token });
    }

    if (endpoint === 'presence') {
      let allUsers = [];
      let pageNumber = 1;
      while (true) {
        const data = await gGet(
          `/api/v2/users?pageSize=100&pageNumber=${pageNumber}&expand=presence,routingStatus&active=true`,
          region
        );
        allUsers = allUsers.concat(data.entities || []);
        if (!data.nextUri || allUsers.length >= (data.total || 0)) break;
        pageNumber++;
        if (pageNumber > 5) break;
      }
      const users = allUsers.map(u => ({
        id: u.id,
        name: u.name,
        email: u.email || '',
        presence: u.presence?.presenceDefinition?.systemPresence || 'Offline',
        presenceLabel: u.presence?.presenceDefinition?.name || 'Offline',
        routingStatus: u.routingStatus?.status || null,
        loginTime: u.presence?.modifiedDate || null,
      }));
      return res.json({ ok: true, users });
    }

    if (endpoint === 'queue_obs') {
      const queueId = req.query.queueId;
      let queueIds = queueId ? [queueId] : [];
      if (!queueIds.length) {
        const queues = await gGet('/api/v2/routing/queues?pageSize=100&active=true', region);
        queueIds = (queues.entities || []).map(q => q.id);
      }
      if (!queueIds.length) return res.json({ ok: true, queues: [], totalWaiting: 0, totalInteracting: 0 });

      const data = await gPost('/api/v2/analytics/queues/observations/query', {
        filter: {
          type: 'or',
          predicates: queueIds.map(id => ({
            type: 'dimension', dimension: 'queueId', operator: 'matches', value: id,
          })),
        },
        metrics: ['oWaiting', 'oInteracting', 'oAlerting', 'oServiceLevel', 'tAnswered', 'tAbandoned', 'tHandle'],
      }, region);

      let totalWaiting = 0, totalInteracting = 0;
      const queues = (data.results || []).map(r => {
        const m = {};
        (r.data || []).forEach(d => { m[d.metric] = d.stats; });
        const slRaw = m.oServiceLevel?.pct ?? m.oServiceLevel?.ratio ?? null;
        const sl = slRaw != null ? (slRaw <= 1 ? Math.round(slRaw * 100) : Math.round(slRaw)) : null;
        totalWaiting += m.oWaiting?.count || 0;
        totalInteracting += m.oInteracting?.count || 0;
        return {
          queueId: r.group?.queueId,
          waiting: m.oWaiting?.count || 0,
          interacting: m.oInteracting?.count || 0,
          alerting: m.oAlerting?.count || 0,
          serviceLevel: sl,
          answered: m.tAnswered?.count || 0,
          abandoned: m.tAbandoned?.count || 0,
          avgHandle: m.tHandle?.count > 0 ? Math.round((m.tHandle.sum || 0) / m.tHandle.count / 1000) : 0,
        };
      });
      return res.json({ ok: true, queues, totalWaiting, totalInteracting });
    }

    if (endpoint === 'calls_today') {
      const interval = todayInterval();

      const [aggData, queueListData] = await Promise.all([
        gPost('/api/v2/analytics/conversations/aggregates/query', {
          interval,
          groupBy: ['mediaType'],
          metrics: ['nOffered', 'nAnswered', 'nAbandoned', 'nConnected', 'tHandle', 'tAcw', 'tTalk', 'tHeld', 'tAnswered'],
          flattenMultivaluedDimensions: true,
        }, region),
        gGet('/api/v2/routing/queues?pageSize=100&active=true', region),
      ]);

      const summary = { offered: 0, answered: 0, abandoned: 0, avgHandleSec: 0, avgTalkSec: 0, avgWaitSec: 0, serviceLevel: null, currentWaiting: 0 };
      let handleSum = 0, handleCount = 0, talkSum = 0, talkCount = 0, waitSum = 0, waitCount = 0;

      (aggData.results || []).forEach(r => {
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

      const queueIds = (queueListData.entities || []).map(q => q.id);
      if (queueIds.length) {
        try {
          const obsData = await gPost('/api/v2/analytics/queues/observations/query', {
            filter: { type: 'or', predicates: queueIds.map(id => ({ type: 'dimension', dimension: 'queueId', operator: 'matches', value: id })) },
            metrics: ['oWaiting', 'oServiceLevel'],
          }, region);
          (obsData.results || []).forEach(r => {
            (r.data || []).forEach(d => {
              if (d.metric === 'oWaiting') summary.currentWaiting += d.stats?.count || 0;
              if (d.metric === 'oServiceLevel') {
                const v = d.stats?.pct ?? d.stats?.ratio ?? null;
                if (v != null) summary.serviceLevel = v <= 1 ? Math.round(v * 100) : Math.round(v);
              }
            });
          });
        } catch (e2) { /* SL optional */ }
      }

      return res.json({ ok: true, summary });
    }

    if (endpoint === 'agent_kpis') {
      const interval = todayInterval();

      // Aggregate grouped by userId — works with Supervisor role (no analytics:readonly needed)
      const [aggData, usersData] = await Promise.all([
        gPost('/api/v2/analytics/conversations/aggregates/query', {
          interval,
          groupBy: ['userId'],
          metrics: ['nAnswered', 'nConnected', 'tHandle', 'tTalk', 'tHeld', 'tAcw'],
          flattenMultivaluedDimensions: true,
        }, region),
        gGet('/api/v2/users?pageSize=200&active=true', region),
      ]);

      const userMap = {};
      (usersData.entities || []).forEach(u => { userMap[u.id] = u.name; });

      const agents = [];
      (aggData.results || []).forEach(r => {
        const userId = r.group?.userId;
        if (!userId) return;
        const m = {};
        (r.data || []).forEach(d => { m[d.metric] = d.stats; });
        const handled = Math.max(m.nAnswered?.count || 0, m.nConnected?.count || 0);
        if (handled === 0) return;
        const handleSec = m.tHandle?.count > 0 ? Math.round((m.tHandle.sum || 0) / m.tHandle.count / 1000) : 0;
        const talkSec = m.tTalk?.count > 0 ? Math.round((m.tTalk.sum || 0) / m.tTalk.count / 1000) : 0;
        const holdSec = m.tHeld?.count > 0 ? Math.round((m.tHeld.sum || 0) / m.tHeld.count / 1000) : 0;
        const acwSec = m.tAcw?.count > 0 ? Math.round((m.tAcw.sum || 0) / m.tAcw.count / 1000) : 0;
        const fmt = s => s > 0 ? Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's' : '0s';
        agents.push({
          id: userId,
          name: userMap[userId] || userId,
          handled,
          avgAHT_sec: handleSec,
          avgAHT_fmt: fmt(handleSec),
          talkSec,
          holdSec,
          acwSec,
        });
      });

      return res.json({ ok: true, agents });
    }

    if (endpoint === 'adherence') {
      const userIds = req.query.userIds ? req.query.userIds.split(',') : (req.body?.userIds || []);
      if (!userIds.length) return res.json({ ok: false, error: 'Pass userIds as ?userIds=id1,id2' });
      const data = await gPost('/api/v2/workforcemanagement/adherence', { userIds }, region);
      return res.json({ ok: true, adherence: data });
    }

    return res.status(400).json({ ok: false, error: `Unknown endpoint: "${endpoint}". Valid: health, presence, queue_obs, calls_today, agent_kpis, adherence` });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
