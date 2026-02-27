// ═══════════════════════════════════════════════════════════════
// Genesys Cloud KPI Proxy — Vercel Serverless Function
// Fetches agent performance metrics from Genesys Cloud API
// and returns them in a format the Command Hub can consume.
// ═══════════════════════════════════════════════════════════════

const GENESYS_REGION = process.env.GENESYS_REGION || "mec1.pure.cloud";
const GENESYS_CLIENT_ID = process.env.GENESYS_CLIENT_ID;
const GENESYS_CLIENT_SECRET = process.env.GENESYS_CLIENT_SECRET;

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  const loginUrl = `https://login.${GENESYS_REGION}/oauth/token`;
  const res = await fetch(loginUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${GENESYS_CLIENT_ID}:${GENESYS_CLIENT_SECRET}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`OAuth failed (${res.status}): ${err}`); }
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function genesysAPI(path, body, token) {
  const url = `https://api.${GENESYS_REGION}${path}`;
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`Genesys API ${path} failed (${res.status}): ${err}`); }
  return res.json();
}

// Get all users — paginated, with presence AND routingStatus
async function getAllUsers(token) {
  let users = [];
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const data = await genesysAPI(
      `/api/v2/users?pageSize=100&pageNumber=${page}&expand=presence,routingStatus`,
      null, token
    );
    if (data.entities) users = users.concat(data.entities);
    hasMore = data.entities && data.entities.length === 100;
    page++;
    if (page > 10) break;
  }
  return users;
}

// Get conversation aggregates
async function getConversationAggregates(token, interval, userIds) {
  const body = {
    interval,
    granularity: "PT720H",
    groupBy: ["userId"],
    metrics: ["nOffered","nConnected","tAnswered","tHandle","tTalk","tHeld","tAcw","nTransferred"],
    filter: { type: "and", predicates: [{ dimension: "mediaType", value: "voice" }] },
  };
  if (userIds && userIds.length > 0) {
    body.filter = { type: "and", clauses: [
      { type: "or", predicates: userIds.map(id => ({ dimension: "userId", value: id })) },
      { type: "or", predicates: [{ dimension: "mediaType", value: "voice" }] },
    ]};
  }
  return genesysAPI("/api/v2/analytics/conversations/aggregates/query", body, token);
}

// Get agent quality evaluation scores
async function getAgentEvaluations(token, startDate, endDate) {
  try {
    const data = await genesysAPI(
      `/api/v2/quality/agents/activity?pageSize=100&startTime=${encodeURIComponent(startDate)}&endTime=${encodeURIComponent(endDate)}&expand=evaluations`,
      null, token
    );
    return data;
  } catch (e) {
    console.warn("Agent evaluations failed:", e.message);
    return null;
  }
}

// Build month interval string
function monthInterval(yearMonth) {
  const [y, m] = yearMonth.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return `${start.toISOString()}/${end.toISOString()}`;
}

// Extract metric stats from Genesys aggregation response
function extractStats(results) {
  const agents = {};
  if (!results || !results.results) return agents;
  for (const group of results.results) {
    const userId = group.group?.userId;
    if (!userId) continue;
    const data = group.data?.[0];
    if (!data?.metrics) continue;
    const stats = {};
    for (const m of data.metrics) { stats[m.metric] = m.stats; }
    const answered = stats.nConnected?.count || stats.nOffered?.count || 0;
    const handleSum = stats.tHandle?.sum || 0;
    const talkSum = stats.tTalk?.sum || 0;
    const holdSum = stats.tHeld?.sum || 0;
    const acwSum = stats.tAcw?.sum || 0;
    const handleCount = Math.max(stats.tHandle?.count || 1, 1);
    const talkCount = Math.max(stats.tTalk?.count || 1, 1);
    const holdCount = Math.max(stats.tHeld?.count || 1, 1);
    const acwCount = Math.max(stats.tAcw?.count || 1, 1);
    const transfers = stats.nTransferred?.count || 0;
    agents[userId] = {
      answered, handled: handleCount,
      avgHandle: handleSum / handleCount / 1000,
      avgTalk: talkSum / talkCount / 1000,
      avgHold: holdSum / holdCount / 1000,
      avgAcw: acwSum / acwCount / 1000,
      transfers,
    };
  }
  return agents;
}

// ─── Main handler ───
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    if (!GENESYS_CLIENT_ID || !GENESYS_CLIENT_SECRET) {
      return res.status(500).json({ error: "Genesys credentials not configured", setup: "Set GENESYS_CLIENT_ID and GENESYS_CLIENT_SECRET in Vercel environment variables" });
    }

    const token = await getAccessToken();
    const { action } = req.query;

    // ─── Users: return full presence + routingStatus for live dashboard ───
    if (action === "users") {
      const users = await getAllUsers(token);
      const mapped = users.map(u => ({
        id: u.id,
        name: u.name,
        email: u.email,
        department: u.department,
        title: u.title,
        presence: {
          presenceDefinition: {
            systemPresence: u.presence?.presenceDefinition?.systemPresence || "Unknown"
          }
        },
        routingStatus: {
          status: u.routingStatus?.status || "OFF_QUEUE",
          startTime: u.routingStatus?.startTime
        },
        state: u.state,
      }));
      return res.json({ ok: true, users: mapped });
    }

    // ─── KPIs: conversation stats + quality evaluations ───
    if (action === "kpis") {
      const month = req.query.month || "2026-02";
      const interval = monthInterval(month);
      const [y, m] = month.split("-").map(Number);
      const startDate = new Date(Date.UTC(y, m - 1, 1)).toISOString();
      const endDate = new Date(Date.UTC(y, m, 1)).toISOString();

      // Parallel fetch: users + call stats + QA evaluations
      const [users, convAgg, evalData] = await Promise.all([
        getAllUsers(token),
        getConversationAggregates(token, interval),
        getAgentEvaluations(token, startDate, endDate),
      ]);

      const convStats = extractStats(convAgg);

      // Build QA score map { userId: { total, count } }
      const qaMap = {};
      if (evalData && evalData.entities) {
        for (const agentData of evalData.entities) {
          const userId = agentData.user?.id;
          if (!userId) continue;
          for (const ev of (agentData.evaluations || [])) {
            // Prefer percentage score (0-100), fall back to raw score
            const score = ev.totalScorePercent ?? ev.totalScore;
            if (score != null && score > 0) {
              if (!qaMap[userId]) qaMap[userId] = { total: 0, count: 0 };
              qaMap[userId].total += score;
              qaMap[userId].count += 1;
            }
          }
        }
      }

      const kpis = {};
      for (const user of users) {
        const conv = convStats[user.id];
        const qa = qaMap[user.id];
        // Include agent if they have calls OR quality evaluations
        if ((!conv || conv.handled === 0) && !qa) continue;
        const avgQa = qa && qa.count > 0 ? Math.round((qa.total / qa.count) * 10) / 10 : 0;
        kpis[user.name] = {
          genesysId: user.id,
          answered: conv ? conv.answered : 0,
          handled: conv ? conv.handled : 0,
          avgHandle: conv ? Math.round(conv.avgHandle) : 0,
          avgTalk: conv ? Math.round(conv.avgTalk) : 0,
          avgHold: conv ? Math.round(conv.avgHold) : 0,
          avgAcw: conv ? Math.round(conv.avgAcw) : 0,
          transfers: conv ? conv.transfers : 0,
          aht: conv ? Math.round(conv.avgHandle) : 0,
          interactions: conv ? conv.handled : 0,
          qa: avgQa,
          qaCount: qa ? qa.count : 0,
        };
      }

      return res.json({ ok: true, month, interval, region: GENESYS_REGION, agentCount: Object.keys(kpis).length, kpis });
    }

    // ─── Status: quick agent presence check ───
    if (action === "status") {
      const users = await getAllUsers(token);
      const statuses = users.map(u => ({
        id: u.id, name: u.name,
        presence: u.presence?.presenceDefinition?.systemPresence || "Unknown",
        routingStatus: u.routingStatus?.status || "OFF_QUEUE",
      }));
      return res.json({ ok: true, statuses });
    }

    // ─── Health check ───
    if (action === "health") {
      return res.json({ ok: true, region: GENESYS_REGION, tokenCached: !!cachedToken, tokenExpiresIn: Math.max(0, Math.round((tokenExpiry - Date.now()) / 1000)) });
    }

    return res.json({ ok: true, message: "Genesys Cloud KPI Proxy", region: GENESYS_REGION, actions: { health: "GET /api/genesys?action=health", users: "GET /api/genesys?action=users", kpis: "GET /api/genesys?action=kpis&month=2026-02", status: "GET /api/genesys?action=status" } });

  } catch (err) {
    console.error("Genesys proxy error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
