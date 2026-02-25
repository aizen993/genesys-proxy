// ═══════════════════════════════════════════════════════════════════
// ElevenLabs Conversational AI — Tool Webhook Handler
// This endpoint is called by ElevenLabs when the AI agent invokes
// a server-side tool during conversation with an agent/supervisor.
//
// Connected Systems:
//   ✅ Genesys Cloud  — agent status, queue info, call data
//   🔲 Salesforce CRM  — customer lookup, case creation
//   🔲 DARB Platform   — internal backend operations
// ═══════════════════════════════════════════════════════════════════

// ─── Environment Variables ───
const GC_REGION = process.env.GENESYS_REGION || "mec1.pure.cloud";
const GC_CLIENT_ID = process.env.GENESYS_CLIENT_ID;
const GC_CLIENT_SECRET = process.env.GENESYS_CLIENT_SECRET;

const SF_DOMAIN = process.env.SALESFORCE_DOMAIN || ""; // e.g. "yourorg.my.salesforce.com"
const SF_CLIENT_ID = process.env.SALESFORCE_CLIENT_ID || "";
const SF_CLIENT_SECRET = process.env.SALESFORCE_CLIENT_SECRET || "";
const SF_USERNAME = process.env.SALESFORCE_USERNAME || "";
const SF_PASSWORD = process.env.SALESFORCE_PASSWORD || ""; // password + security token

const DARB_BASE_URL = process.env.DARB_BASE_URL || ""; // e.g. "https://darb-api.example.com"
const DARB_API_KEY = process.env.DARB_API_KEY || "";

// ─── Token Caches ───
let gcToken = null, gcTokenExp = 0;
let sfToken = null, sfTokenExp = 0, sfInstanceUrl = "";

// ═══════════════════════════════════════════════════════
// GENESYS CLOUD CONNECTOR
// ═══════════════════════════════════════════════════════
async function gcAuth() {
  if (gcToken && Date.now() < gcTokenExp - 60000) return gcToken;
  const r = await fetch(`https://login.${GC_REGION}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${GC_CLIENT_ID}:${GC_CLIENT_SECRET}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`Genesys auth failed: ${r.status}`);
  const d = await r.json();
  gcToken = d.access_token;
  gcTokenExp = Date.now() + d.expires_in * 1000;
  return gcToken;
}

async function gcAPI(method, path, body) {
  const token = await gcAuth();
  const r = await fetch(`https://api.${GC_REGION}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const e = await r.text();
    throw new Error(`Genesys ${path}: ${r.status} — ${e.slice(0, 200)}`);
  }
  return r.json();
}

// ── Genesys Tools ──

async function gc_get_queue_status({ queueName }) {
  // Search for queue by name
  const queues = await gcAPI("GET", `/api/v2/routing/queues?name=${encodeURIComponent(queueName || "")}&pageSize=5`);
  if (!queues.entities?.length) return { error: `Queue "${queueName}" not found` };

  const q = queues.entities[0];
  // Get observation data for the queue
  const obs = await gcAPI("POST", "/api/v2/analytics/queues/observations/query", {
    filter: { type: "or", predicates: [{ dimension: "queueId", value: q.id }] },
    metrics: ["oWaiting", "oInteracting", "oOnQueueUsers"],
  });

  const data = obs.results?.[0]?.data?.[0]?.metrics || [];
  const metrics = {};
  data.forEach(m => { metrics[m.metric] = m.stats?.count || 0; });

  return {
    queue: q.name,
    id: q.id,
    waitingCalls: metrics.oWaiting || 0,
    agentsInteracting: metrics.oInteracting || 0,
    agentsOnQueue: metrics.oOnQueueUsers || 0,
  };
}

async function gc_get_agent_status({ agentName }) {
  // Search for user
  const users = await gcAPI("GET", `/api/v2/users/search?q=${encodeURIComponent(agentName)}&expand=presence,routingStatus`);
  if (!users.results?.length) return { error: `Agent "${agentName}" not found` };

  const u = users.results[0];
  return {
    name: u.name,
    email: u.email,
    presence: u.presence?.presenceDefinition?.systemPresence || "Unknown",
    routingStatus: u.routingStatus?.status || "Unknown",
    department: u.department || "",
  };
}

async function gc_get_agent_stats({ agentName, period }) {
  // Find user
  const users = await gcAPI("GET", `/api/v2/users/search?q=${encodeURIComponent(agentName)}`);
  if (!users.results?.length) return { error: `Agent "${agentName}" not found` };
  const userId = users.results[0].id;

  // Build interval
  const now = new Date();
  let start;
  if (period === "today") {
    start = new Date(now); start.setHours(0, 0, 0, 0);
  } else if (period === "week") {
    start = new Date(now); start.setDate(now.getDate() - 7);
  } else {
    start = new Date(now); start.setDate(1); // Current month
  }
  const interval = `${start.toISOString()}/${now.toISOString()}`;

  const agg = await gcAPI("POST", "/api/v2/analytics/conversations/aggregates/query", {
    interval,
    granularity: "PT720H",
    groupBy: ["userId"],
    filter: {
      type: "and",
      clauses: [
        { type: "or", predicates: [{ dimension: "userId", value: userId }] },
        { type: "or", predicates: [{ dimension: "mediaType", value: "voice" }] },
      ],
    },
    metrics: ["nOffered", "nConnected", "tHandle", "tTalk", "tHeld", "tAcw", "nTransferred"],
  });

  const r = agg.results?.[0]?.data?.[0]?.metrics || [];
  const s = {};
  r.forEach(m => { s[m.metric] = m.stats; });

  const hCount = s.tHandle?.count || 1;
  return {
    agent: users.results[0].name,
    period,
    offered: s.nOffered?.count || 0,
    handled: s.nConnected?.count || 0,
    avgHandleTime: Math.round((s.tHandle?.sum || 0) / hCount / 1000) + "s",
    avgTalkTime: Math.round((s.tTalk?.sum || 0) / (s.tTalk?.count || 1) / 1000) + "s",
    avgHoldTime: Math.round((s.tHeld?.sum || 0) / (s.tHeld?.count || 1) / 1000) + "s",
    avgAcw: Math.round((s.tAcw?.sum || 0) / (s.tAcw?.count || 1) / 1000) + "s",
    transfers: s.nTransferred?.count || 0,
  };
}

async function gc_get_active_calls() {
  const obs = await gcAPI("POST", "/api/v2/analytics/conversations/aggregates/query", {
    interval: `${new Date(Date.now() - 3600000).toISOString()}/${new Date().toISOString()}`,
    granularity: "PT1H",
    groupBy: ["mediaType"],
    metrics: ["nConnected", "nOffered"],
    filter: { type: "or", predicates: [{ dimension: "mediaType", value: "voice" }] },
  });

  const r = obs.results?.[0]?.data?.[0]?.metrics || [];
  const s = {};
  r.forEach(m => { s[m.metric] = m.stats?.count || 0; });

  return {
    callsOfferedLastHour: s.nOffered || 0,
    callsHandledLastHour: s.nConnected || 0,
  };
}

// ═══════════════════════════════════════════════════════
// SALESFORCE CRM CONNECTOR
// ═══════════════════════════════════════════════════════
async function sfAuth() {
  if (sfToken && Date.now() < sfTokenExp - 60000) return { token: sfToken, url: sfInstanceUrl };
  if (!SF_DOMAIN || !SF_CLIENT_ID) throw new Error("Salesforce not configured. Set SALESFORCE_DOMAIN, SALESFORCE_CLIENT_ID, SALESFORCE_CLIENT_SECRET, SALESFORCE_USERNAME, SALESFORCE_PASSWORD in environment variables.");

  const r = await fetch(`https://${SF_DOMAIN}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: SF_CLIENT_ID,
      client_secret: SF_CLIENT_SECRET,
      username: SF_USERNAME,
      password: SF_PASSWORD,
    }),
  });
  if (!r.ok) throw new Error(`Salesforce auth failed: ${r.status} — ${await r.text()}`);
  const d = await r.json();
  sfToken = d.access_token;
  sfInstanceUrl = d.instance_url;
  sfTokenExp = Date.now() + 7200000; // 2 hours
  return { token: sfToken, url: sfInstanceUrl };
}

async function sfAPI(method, path, body) {
  const { token, url } = await sfAuth();
  const r = await fetch(`${url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const e = await r.text();
    throw new Error(`Salesforce ${path}: ${r.status} — ${e.slice(0, 200)}`);
  }
  if (method === "DELETE" || r.status === 204) return { success: true };
  return r.json();
}

// ── Salesforce Tools ──

async function sf_lookup_customer({ searchTerm }) {
  // SOSL search across Contact and Account
  const query = encodeURIComponent(`FIND {${searchTerm}} IN ALL FIELDS RETURNING Contact(Id, Name, Email, Phone, AccountId, Account.Name), Account(Id, Name, Phone, Website)`);
  const data = await sfAPI("GET", `/services/data/v59.0/search/?q=${query}`);

  const contacts = (data.searchRecords || []).filter(r => r.attributes.type === "Contact").slice(0, 5).map(c => ({
    type: "Contact", id: c.Id, name: c.Name, email: c.Email, phone: c.Phone, account: c.Account?.Name || "",
  }));
  const accounts = (data.searchRecords || []).filter(r => r.attributes.type === "Account").slice(0, 3).map(a => ({
    type: "Account", id: a.Id, name: a.Name, phone: a.Phone, website: a.Website,
  }));

  return { results: [...contacts, ...accounts], total: contacts.length + accounts.length };
}

async function sf_get_customer_cases({ customerId }) {
  const data = await sfAPI("GET", `/services/data/v59.0/query/?q=${encodeURIComponent(`SELECT Id, CaseNumber, Subject, Status, Priority, CreatedDate, Description FROM Case WHERE ContactId='${customerId}' OR AccountId='${customerId}' ORDER BY CreatedDate DESC LIMIT 10`)}`);
  return {
    cases: (data.records || []).map(c => ({
      caseNumber: c.CaseNumber, subject: c.Subject, status: c.Status,
      priority: c.Priority, created: c.CreatedDate?.split("T")[0],
    })),
    total: data.totalSize || 0,
  };
}

async function sf_create_case({ contactId, subject, description, priority }) {
  const data = await sfAPI("POST", "/services/data/v59.0/sobjects/Case/", {
    ContactId: contactId || undefined,
    Subject: subject,
    Description: description || "",
    Priority: priority || "Medium",
    Status: "New",
    Origin: "AI Agent",
  });
  return { success: true, caseId: data.id, message: `Case created successfully with ID ${data.id}` };
}

async function sf_update_case({ caseId, status, description }) {
  const updates = {};
  if (status) updates.Status = status;
  if (description) updates.Description = description;
  await sfAPI("PATCH", `/services/data/v59.0/sobjects/Case/${caseId}`, updates);
  return { success: true, message: `Case ${caseId} updated` };
}

async function sf_log_call({ contactId, subject, description, duration }) {
  const data = await sfAPI("POST", "/services/data/v59.0/sobjects/Task/", {
    WhoId: contactId || undefined,
    Subject: subject || "Call logged by AI Agent",
    Description: description || "",
    Status: "Completed",
    Priority: "Normal",
    Type: "Call",
    CallDurationInSeconds: duration || 0,
    ActivityDate: new Date().toISOString().split("T")[0],
  });
  return { success: true, taskId: data.id, message: "Call logged successfully" };
}

// ═══════════════════════════════════════════════════════
// DARB PLATFORM CONNECTOR
// ═══════════════════════════════════════════════════════
async function darbAPI(method, path, body) {
  if (!DARB_BASE_URL) throw new Error("DARB Platform not configured. Set DARB_BASE_URL and DARB_API_KEY in environment variables.");
  const r = await fetch(`${DARB_BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(DARB_API_KEY ? { Authorization: `Bearer ${DARB_API_KEY}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`DARB ${path}: ${r.status} — ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ── DARB Tools ──
// These are placeholder implementations. Update the paths and request
// shapes to match your actual DARB API endpoints.

async function darb_lookup_customer({ searchTerm }) {
  // Adjust the endpoint to match your DARB API
  const data = await darbAPI("GET", `/api/customers/search?q=${encodeURIComponent(searchTerm)}`);
  return { customers: data.results || data.data || data, total: data.total || (data.results || data.data || data).length };
}

async function darb_get_account({ accountId }) {
  const data = await darbAPI("GET", `/api/accounts/${accountId}`);
  return data;
}

async function darb_create_ticket({ customerId, subject, description, category }) {
  const data = await darbAPI("POST", "/api/tickets", {
    customer_id: customerId,
    subject,
    description: description || "",
    category: category || "General",
    status: "Open",
    source: "AI Agent",
    created_at: new Date().toISOString(),
  });
  return { success: true, ticketId: data.id || data.ticket_id, message: "Ticket created in DARB" };
}

async function darb_update_record({ recordType, recordId, updates }) {
  const data = await darbAPI("PATCH", `/api/${recordType}/${recordId}`, updates);
  return { success: true, message: `${recordType} ${recordId} updated`, data };
}

async function darb_get_service_info({ serviceType }) {
  // Lookup service/product information from DARB
  const data = await darbAPI("GET", `/api/services?type=${encodeURIComponent(serviceType || "")}`);
  return { services: data.results || data.data || data };
}

// ═══════════════════════════════════════════════════════
// TOOL REGISTRY — Maps tool names to handlers
// ═══════════════════════════════════════════════════════
const TOOLS = {
  // Genesys Cloud
  get_queue_status: { handler: gc_get_queue_status, system: "Genesys" },
  get_agent_status: { handler: gc_get_agent_status, system: "Genesys" },
  get_agent_stats: { handler: gc_get_agent_stats, system: "Genesys" },
  get_active_calls: { handler: gc_get_active_calls, system: "Genesys" },

  // Salesforce
  lookup_customer: { handler: sf_lookup_customer, system: "Salesforce" },
  get_customer_cases: { handler: sf_get_customer_cases, system: "Salesforce" },
  create_case: { handler: sf_create_case, system: "Salesforce" },
  update_case: { handler: sf_update_case, system: "Salesforce" },
  log_call: { handler: sf_log_call, system: "Salesforce" },

  // DARB
  darb_lookup_customer: { handler: darb_lookup_customer, system: "DARB" },
  darb_get_account: { handler: darb_get_account, system: "DARB" },
  darb_create_ticket: { handler: darb_create_ticket, system: "DARB" },
  darb_update_record: { handler: darb_update_record, system: "DARB" },
  darb_get_service_info: { handler: darb_get_service_info, system: "DARB" },
};

// ═══════════════════════════════════════════════════════
// MAIN HANDLER — ElevenLabs calls this endpoint
// ═══════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  // GET = health/info check
  if (req.method === "GET") {
    return res.json({
      ok: true,
      service: "ElevenLabs Tool Webhook",
      tools: Object.keys(TOOLS),
      systems: {
        genesys: { configured: !!(GC_CLIENT_ID && GC_CLIENT_SECRET), region: GC_REGION },
        salesforce: { configured: !!(SF_CLIENT_ID && SF_DOMAIN) },
        darb: { configured: !!DARB_BASE_URL },
      },
    });
  }

  // POST = tool invocation from ElevenLabs
  try {
    const body = req.body;

    // ElevenLabs sends: { tool_call_id, tool_name, parameters }
    // or the webhook format: { type: "tool_call", tool: { name, parameters } }
    let toolName, params, toolCallId;

    if (body.tool_name) {
      // Direct format
      toolName = body.tool_name;
      params = body.parameters || {};
      toolCallId = body.tool_call_id;
    } else if (body.tool) {
      // Nested format
      toolName = body.tool.name;
      params = body.tool.parameters || {};
      toolCallId = body.tool_call_id;
    } else if (body.name) {
      // Simple format
      toolName = body.name;
      params = body.parameters || body.args || {};
      toolCallId = body.id;
    } else {
      return res.status(400).json({ error: "Invalid request format. Expected tool_name or tool.name" });
    }

    console.log(`[Tool Call] ${toolName}`, JSON.stringify(params).slice(0, 200));

    const tool = TOOLS[toolName];
    if (!tool) {
      return res.json({
        tool_call_id: toolCallId,
        result: JSON.stringify({ error: `Unknown tool: ${toolName}. Available: ${Object.keys(TOOLS).join(", ")}` }),
      });
    }

    const result = await tool.handler(params);

    console.log(`[Tool Result] ${toolName}:`, JSON.stringify(result).slice(0, 200));

    // Return in ElevenLabs expected format
    return res.json({
      tool_call_id: toolCallId,
      result: typeof result === "string" ? result : JSON.stringify(result),
    });
  } catch (err) {
    console.error("[Tool Error]", err);
    return res.json({
      tool_call_id: req.body?.tool_call_id,
      result: JSON.stringify({ error: err.message }),
    });
  }
}
