// ═══════════════════════════════════════════════════════════════
// Genesys Cloud KPI Proxy — Vercel Serverless Function
// ═══════════════════════════════════════════════════════════════

const GENESYS_REGION = process.env.GENESYS_REGION || "mec1.pure.cloud";
const GENESYS_CLIENT_ID = process.env.GENESYS_CLIENT_ID;
const GENESYS_CLIENT_SECRET = process.env.GENESYS_CLIENT_SECRET;

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  const res = await fetch(`https://login.${GENESYS_REGION}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${GENESYS_CLIENT_ID}:${GENESYS_CLIENT_SECRET}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`OAuth failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function genesysAPI(path, body, token) {
  const res = await fetch(`https://api.${GENESYS_REGION}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Genesys API ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function getAllUsers(token) {
  let users = [], page = 1, hasMore = true;
  while (hasMore) {
    const data = await genesysAPI(`/api/v2/users?pageSize=100&pageNumber=${page}&expand=presence,routingStatus`, null, token);
    if (data.entities) users = users.concat(data.entities);
    hasMore = data.entities && data.entities.length === 100;
    if (++page > 10) break;
  }
  return users;
}

// Get queue stats for a given interval (today or month)
async function getQueueStats(token, interval) {
  const body = {
    interval,
    granularity: "PT1H", // hourly buckets
    groupBy: ["queueId"],
    metrics: ["nOffered","nAnswered","nAbandonedWithinXSeconds","nAbandoned","tAnswered","tHandle","oWaiting","oInteracting"],
    flattenMultivaluedDimensions: true,
  };
  try {
    return await genesysAPI("/api/v2/analytics/queues/aggregates/query", body, token);
  } catch(e) {
    // Fall back to conversation aggregates
    const body2 = {
      interval,
      granularity: "PT24H",
      metrics: ["nOffered","nAnswered","nAbandonedWithinXSeconds","nAbandoned","tAnswered","tHandle"],
      flattenMultivaluedDimensions: true,
    };
    try { return await genesysAPI("/api/v2/analytics/conversations/aggregates/query", body2, token); }
    catch(e2) { return null; }
  }
}

// Get real-time queue observations (live calls right now)
async function getLiveObservations(token) {
  try {
    const body = {
      filter: { type: "and", predicates: [] },
      metrics: ["oWaiting","oInteracting","oAlerting"],
    };
    return await genesysAPI("/api/v2/analytics/queues/observations/query", body, token);
  } catch(e) {
    console.warn("Live observations failed:", e.message);
    return null;
  }
}

// Extract aggregated queue metrics from results
function extractQueueStats(results) {
  let nOffered=0,nAnswered=0,nAbandoned=0,tAnsweredSum=0,tAnsweredCount=0,tHandleSum=0,tHandleCount=0,oWaiting=0;
  if (!results || !results.results) return {nOffered,nAnswered,nAbandoned,tAnsweredSum,tAnsweredCount,tHandleSum,tHandleCount,oWaiting};
  for (const group of results.results) {
    for (const bucket of (group.data || [])) {
      for (const m of (bucket.metrics || [])) {
        if (m.metric === "nOffered") nOffered += m.stats?.count || 0;
        if (m.metric === "nAnswered") nAnswered += m.stats?.count || 0;
        if (m.metric === "nAbandonedWithinXSeconds" || m.metric === "nAbandoned") nAbandoned += m.stats?.count || 0;
        if (m.metric === "oWaiting") oWaiting += m.stats?.count || 0;
        if (m.metric === "tAnswered" && m.stats?.count) { tAnsweredSum += m.stats.sum || 0; tAnsweredCount += m.stats.count; }
        if (m.metric === "tHandle" && m.stats?.count) { tHandleSum += m.stats.sum || 0; tHandleCount += m.stats.count; }
      }
    }
  }
  return {nOffered,nAnswered,nAbandoned,tAnsweredSum,tAnsweredCount,tHandleSum,tHandleCount,oWaiting};
}

// Get conversation aggregates for KPIs
async function getConversationAggregates(token, interval) {
  const body = {
    interval, granularity: "PT720H", groupBy: ["userId"],
    metrics: ["nOffered","nConnected","tAnswered","tHandle","tTalk","tHeld","tAcw","nTransferred"],
    filter: { type: "and", predicates: [{ dimension: "mediaType", value: "voice" }] },
  };
  return genesysAPI("/api/v2/analytics/conversations/aggregates/query", body, token);
}

// Get agent quality evaluation scores
async function getAgentEvaluations(token, startDate, endDate) {
  try {
    return await genesysAPI(
      `/api/v2/quality/agents/activity?pageSize=100&startTime=${encodeURIComponent(startDate)}&endTime=${encodeURIComponent(endDate)}&expand=evaluations`,
      null, token
    );
  } catch(e) { console.warn("Agent evaluations failed:", e.message); return null; }
}

// Get CSAT from External Tag Q2 surveys
async function getCSATSurveys(token, startDate, endDate) {
  try {
    // Try the surveys/forms endpoint for customer satisfaction
    const data = await genesysAPI(
      `/api/v2/quality/surveys?pageSize=100&startTime=${encodeURIComponent(startDate)}&endTime=${encodeURIComponent(endDate)}&expand=answers`,
      null, token
    );
    return data;
  } catch(e) {
    console.warn("CSAT surveys failed:", e.message);
    return null;
  }
}

function monthInterval(yearMonth) {
  const [y, m] = yearMonth.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return `${start.toISOString()}/${end.toISOString()}`;
}

function todayInterval() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));
  return `${start.toISOString()}/${end.toISOString()}`;
}

function extractStats(results) {
  const agents = {};
  if (!results || !results.results) return agents;
  for (const group of results.results) {
    const userId = group.group?.userId;
    if (!userId) continue;
    const data = group.data?.[0];
    if (!data?.metrics) continue;
    const stats = {};
    for (const m of data.metrics) stats[m.metric] = m.stats;
    const answered = stats.nConnected?.count || stats.nOffered?.count || 0;
    const handleSum = stats.tHandle?.sum || 0;
    const handleCount = Math.max(stats.tHandle?.count || 1, 1);
    agents[userId] = {
      answered, handled: handleCount,
      avgHandle: handleSum / handleCount / 1000,
      avgTalk: (stats.tTalk?.sum || 0) / Math.max(stats.tTalk?.count || 1, 1) / 1000,
      avgHold: (stats.tHeld?.sum || 0) / Math.max(stats.tHeld?.count || 1, 1) / 1000,
      avgAcw: (stats.tAcw?.sum || 0) / Math.max(stats.tAcw?.count || 1, 1) / 1000,
      transfers: stats.nTransferred?.count || 0,
    };
  }
  return agents;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (!GENESYS_CLIENT_ID || !GENESYS_CLIENT_SECRET)
      return res.status(500).json({ error: "Genesys credentials not configured" });

    const token = await getAccessToken();
    const { action } = req.query;

    // ─── users: full presence + routingStatus ───
    if (action === "users") {
      const users = await getAllUsers(token);
      return res.json({ ok: true, users: users.map(u => ({
        id: u.id, name: u.name, email: u.email, department: u.department, title: u.title,
        presence: { presenceDefinition: { systemPresence: u.presence?.presenceDefinition?.systemPresence || "Unknown" } },
        routingStatus: { status: u.routingStatus?.status || "OFF_QUEUE", startTime: u.routingStatus?.startTime },
        state: u.state,
      }))});
    }

    // ─── today: today's call volume stats ───
    if (action === "today") {
      const interval = todayInterval();
      const [todayStats, liveObs] = await Promise.allSettled([
        getQueueStats(token, interval),
        getLiveObservations(token),
      ]);
      const ts = todayStats.status === "fulfilled" ? extractQueueStats(todayStats.value) : {};
      let oWaiting = ts.oWaiting || 0;
      // Override oWaiting with live observations if available
      if (liveObs.status === "fulfilled" && liveObs.value?.results) {
        let liveWait = 0;
        for (const g of liveObs.value.results) {
          for (const m of (g.data || [])) {
            if (m.metric === "oWaiting") liveWait += m.stats?.count || 0;
          }
        }
        if (liveWait > 0) oWaiting = liveWait;
      }
      const avgASA = ts.tAnsweredCount > 0 ? Math.round(ts.tAnsweredSum / ts.tAnsweredCount / 1000) : 0;
      const avgAHT = ts.tHandleCount > 0 ? Math.round(ts.tHandleSum / ts.tHandleCount / 1000) : 0;
      const abandonPct = ts.nOffered > 0 ? (ts.nAbandoned / ts.nOffered * 100).toFixed(1) : "0.0";
      const answerPct = ts.nOffered > 0 ? (ts.nAnswered / ts.nOffered * 100).toFixed(1) : "0.0";
      // Service level: answered within target (approximate from ASA if below 20s = 80%+ SL)
      const sl = ts.nOffered > 0 ? Math.round((ts.nAnswered - ts.nAbandoned * 0.5) / ts.nOffered * 100) : null;
      return res.json({
        ok: true, interval, region: GENESYS_REGION,
        offered: ts.nOffered || 0,
        answered: ts.nAnswered || 0,
        abandoned: ts.nAbandoned || 0,
        abandonPct, answerPct,
        avgASA, avgAHT, oWaiting,
        sl,
      });
    }

    // ─── realtime: live queue observations ───
    if (action === "realtime") {
      const interval = todayInterval();
      const [qStats, liveObs] = await Promise.allSettled([
        getQueueStats(token, interval),
        getLiveObservations(token),
      ]);
      const ts = qStats.status === "fulfilled" ? extractQueueStats(qStats.value) : {};
      let oWaiting = ts.oWaiting || 0, oInteracting = 0;
      if (liveObs.status === "fulfilled" && liveObs.value?.results) {
        for (const g of liveObs.value.results) {
          for (const m of (g.data || [])) {
            if (m.metric === "oWaiting") oWaiting += m.stats?.count || 0;
            if (m.metric === "oInteracting") oInteracting += m.stats?.count || 0;
          }
        }
      }
      const avgASA = ts.tAnsweredCount > 0 ? Math.round(ts.tAnsweredSum / ts.tAnsweredCount / 1000) : 0;
      const avgAHT = ts.tHandleCount > 0 ? Math.round(ts.tHandleSum / ts.tHandleCount / 1000) : 0;
      return res.json({
        ok: true,
        stats: [{
          data: [
            { metric: "oWaiting", stats: { count: oWaiting } },
            { metric: "nAnswered", stats: { count: ts.nAnswered || 0 } },
            { metric: "nOffered", stats: { count: ts.nOffered || 0 } },
            { metric: "nAbandoned", stats: { count: ts.nAbandoned || 0 } },
            { metric: "tAnswered", stats: { sum: ts.tAnsweredSum || 0, count: ts.tAnsweredCount || 0 } },
            { metric: "tHandle", stats: { sum: ts.tHandleSum || 0, count: ts.tHandleCount || 0 } },
          ]
        }],
      });
    }

    // ─── kpis: monthly agent KPIs with QA + CSAT from surveys ───
    if (action === "kpis") {
      const month = req.query.month || "2026-02";
      const interval = monthInterval(month);
      const [y, m] = month.split("-").map(Number);
      const startDate = new Date(Date.UTC(y, m - 1, 1)).toISOString();
      const endDate = new Date(Date.UTC(y, m, 1)).toISOString();

      const [users, convAgg, evalData, surveyData] = await Promise.all([
        getAllUsers(token),
        getConversationAggregates(token, interval),
        getAgentEvaluations(token, startDate, endDate),
        getCSATSurveys(token, startDate, endDate),
      ]);

      const convStats = extractStats(convAgg);

      // QA scores from evaluations
      const qaMap = {};
      if (evalData?.entities) {
        for (const agentData of evalData.entities) {
          const userId = agentData.user?.id;
          if (!userId) continue;
          for (const ev of (agentData.evaluations || [])) {
            const score = ev.totalScorePercent ?? ev.totalScore;
            if (score != null && score > 0) {
              if (!qaMap[userId]) qaMap[userId] = { total: 0, count: 0 };
              qaMap[userId].total += score;
              qaMap[userId].count += 1;
            }
          }
        }
      }

      // CSAT from External Tag Q2: ((score4+score5)/overall)*100
      // Survey format: answers contain question responses; Q2 is typically the satisfaction question
      const csatMap = {}; // userId -> { score4plus5, overall }
      if (surveyData?.entities) {
        for (const survey of surveyData.entities) {
          const userId = survey.agent?.id;
          if (!userId) continue;
          if (!csatMap[userId]) csatMap[userId] = { positive: 0, total: 0 };
          // Look for Q2 in answers
          const answers = survey.answers?.answers || [];
          for (const ans of answers) {
            // External Tag Q2 — score 4 or 5 = positive
            if (ans.questionId && ans.questionId.includes("Q2") || ans.text?.includes("Q2") || ans.label?.includes("Q2") || ans.order === 2) {
              csatMap[userId].total += 1;
              if (ans.answerId && (ans.answerId.includes("5") || ans.answerId.includes("4") || ans.freeTextAnswer >= 4)) {
                csatMap[userId].positive += 1;
              }
            }
          }
          // Fallback: if no Q2 found, use overall survey score
          if (answers.length === 0 && survey.status === "Finished") {
            csatMap[userId].total += 1;
            if (survey.totalScore && survey.totalScore >= 4) csatMap[userId].positive += 1;
          }
        }
      }

      const kpis = {};
      for (const user of users) {
        const conv = convStats[user.id];
        const qa = qaMap[user.id];
        const csat = csatMap[user.id];
        if ((!conv || conv.handled === 0) && !qa) continue;
        const avgQa = qa?.count > 0 ? Math.round((qa.total / qa.count) * 10) / 10 : 0;
        // CSAT % = (score4+score5) / overall * 100
        const csatPct = csat?.total > 0 ? Math.round((csat.positive / csat.total) * 1000) / 10 : 0;
        kpis[user.name] = {
          genesysId: user.id,
          answered: conv?.answered || 0, handled: conv?.handled || 0,
          avgHandle: conv ? Math.round(conv.avgHandle) : 0,
          avgTalk: conv ? Math.round(conv.avgTalk) : 0,
          avgHold: conv ? Math.round(conv.avgHold) : 0,
          avgAcw: conv ? Math.round(conv.avgAcw) : 0,
          transfers: conv?.transfers || 0,
          aht: conv ? Math.round(conv.avgHandle) : 0,
          interactions: conv?.handled || 0,
          qa: avgQa, qaCount: qa?.count || 0,
          csat: csatPct, csatTotal: csat?.positive || 0, csatOverall: csat?.total || 0,
        };
      }

      return res.json({ ok: true, month, interval, region: GENESYS_REGION, agentCount: Object.keys(kpis).length, kpis });
    }

    // ─── status: quick agent presence ───
    if (action === "status") {
      const users = await getAllUsers(token);
      return res.json({ ok: true, statuses: users.map(u => ({
        id: u.id, name: u.name,
        presence: u.presence?.presenceDefinition?.systemPresence || "Unknown",
        routingStatus: u.routingStatus?.status || "OFF_QUEUE",
      }))});
    }

    // ─── health ───
    if (action === "health") {
      return res.json({ ok: true, region: GENESYS_REGION, tokenCached: !!cachedToken, tokenExpiresIn: Math.max(0, Math.round((tokenExpiry - Date.now()) / 1000)) });
    }

    return res.json({ ok: true, message: "Genesys Cloud KPI Proxy", region: GENESYS_REGION, actions: { health: "GET /api/genesys?action=health", users: "GET /api/genesys?action=users", kpis: "GET /api/genesys?action=kpis&month=2026-02", today: "GET /api/genesys?action=today", realtime: "GET /api/genesys?action=realtime", status: "GET /api/genesys?action=status" } });

  } catch (err) {
    console.error("Genesys proxy error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
