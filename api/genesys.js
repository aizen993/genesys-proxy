// Genesys Cloud Proxy — Vercel Serverless Function
// Handles: health, kpis, users, queues actions
// Deploy to Vercel with env vars: GENESYS_CLIENT_ID, GENESYS_CLIENT_SECRET, GENESYS_REGION

const CLIENT_ID = process.env.GENESYS_CLIENT_ID;
const CLIENT_SECRET = process.env.GENESYS_CLIENT_SECRET;
const REGION = process.env.GENESYS_REGION || "mec1.pure.cloud";

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) {
    return cachedToken;
  }
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`https://login.${REGION}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Auth failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function genesysGet(path, token) {
  const res = await fetch(`https://api.${REGION}/api/v2${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Genesys API ${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function genesysPost(path, body, token) {
  const res = await fetch(`https://api.${REGION}/api/v2${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Genesys POST ${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Parse month string like "2026-02" into start/end ISO dates
function monthToInterval(monthStr) {
  const [year, month] = monthStr.split("-").map(Number);
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const action = req.query.action || "health";

  try {
    if (!CLIENT_ID || !CLIENT_SECRET) {
      return res.status(500).json({
        ok: false,
        error: "Missing GENESYS_CLIENT_ID or GENESYS_CLIENT_SECRET environment variables.",
      });
    }

    const token = await getToken();

    // ─── HEALTH CHECK ───
    if (action === "health") {
      return res.status(200).json({
        ok: true,
        region: REGION,
        tokenCached: cachedToken !== null,
        message: "Genesys proxy connected successfully",
      });
    }

    // ─── FETCH KPIs ───
    if (action === "kpis") {
      const month = req.query.month || new Date().toISOString().slice(0, 7);
      const { start, end } = monthToInterval(month);

      // Get all users
      const usersData = await genesysGet("/users?pageSize=200&expand=routingStatus,conversationSummary", token);
      const users = usersData.entities || [];

      // Get conversation analytics for the month
      const analyticsBody = {
        interval: `${start}/${end}`,
        granularity: "PT1H",
        groupBy: ["userId"],
        metrics: ["nConnectedOutbound", "nConnectedInbound", "tTalk", "tHeld", "tAcw", "nTransferred", "nAnswered"],
        flattenMultivaluedDimensions: true,
      };

      let analytics = null;
      try {
        analytics = await genesysPost("/analytics/conversations/aggregates/query", analyticsBody, token);
      } catch (e) {
        console.warn("Analytics query failed:", e.message);
      }

      // Build user metrics map
      const metricsMap = {};
      if (analytics && analytics.results) {
        for (const result of analytics.results) {
          const userId = result.group?.userId;
          if (!userId) continue;
          if (!metricsMap[userId]) {
            metricsMap[userId] = { tTalk: 0, tHeld: 0, tAcw: 0, nAnswered: 0, nTransferred: 0 };
          }
          for (const metric of result.data || []) {
            const key = metric.metric;
            const val = metric.stats?.sum || 0;
            if (key === "tTalk") metricsMap[userId].tTalk += val;
            if (key === "tHeld") metricsMap[userId].tHeld += val;
            if (key === "tAcw") metricsMap[userId].tAcw += val;
            if (key === "nAnswered") metricsMap[userId].nAnswered += val;
            if (key === "nTransferred") metricsMap[userId].nTransferred += val;
          }
        }
      }

      // Build KPI response
      const kpis = {};
      for (const user of users) {
        if (!user.name) continue;
        const m = metricsMap[user.id] || {};
        const answered = m.nAnswered || 0;
        const totalTalkHold = (m.tTalk || 0) + (m.tHeld || 0) + (m.tAcw || 0);
        const aht = answered > 0 ? Math.round(totalTalkHold / answered / 1000) : 0; // in seconds

        kpis[user.name] = {
          aht,
          interactions: answered,
          avgTalk: answered > 0 ? Math.round((m.tTalk || 0) / answered / 1000) : 0,
          avgHold: answered > 0 ? Math.round((m.tHeld || 0) / answered / 1000) : 0,
          avgAcw: answered > 0 ? Math.round((m.tAcw || 0) / answered / 1000) : 0,
          answered,
          transfers: m.nTransferred || 0,
          userId: user.id,
          routingStatus: user.routingStatus?.status || "UNKNOWN",
        };
      }

      return res.status(200).json({
        ok: true,
        month,
        region: REGION,
        kpis,
        totalUsers: users.length,
        totalWithData: Object.values(kpis).filter((k) => k.answered > 0).length,
      });
    }

    // ─── FETCH USERS ───
    if (action === "users") {
      const data = await genesysGet("/users?pageSize=200&expand=routingStatus,presence,conversationSummary", token);
      return res.status(200).json({ ok: true, users: data.entities || [] });
    }

    // ─── FETCH QUEUES ───
    if (action === "queues") {
      const data = await genesysGet("/routing/queues?pageSize=100", token);
      return res.status(200).json({ ok: true, queues: data.entities || [] });
    }

    // ─── REAL-TIME STATS ───
    if (action === "realtime") {
      const queues = await genesysGet("/routing/queues?pageSize=100", token);
      const queueIds = (queues.entities || []).map((q) => q.id).slice(0, 50);
      if (!queueIds.length) return res.status(200).json({ ok: true, queues: [] });

      const statsBody = {
        filter: { type: "or", predicates: queueIds.map((id) => ({ type: "dimension", dimension: "queueId", operator: "matches", value: id })) },
        metrics: ["oWaiting", "oInteracting", "oAlerting", "nOnQueueUsers", "nAvailableUsers"],
        flattenMultivaluedDimensions: true,
        groupBy: ["queueId"],
      };
      const stats = await genesysPost("/analytics/queues/observations/query", statsBody, token);
      return res.status(200).json({ ok: true, stats: stats.results || [] });
    }

    return res.status(400).json({ ok: false, error: `Unknown action: ${action}. Valid: health, kpis, users, queues, realtime` });
  } catch (err) {
    console.error("Genesys proxy error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
