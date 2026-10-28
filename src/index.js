// Claude agent for Linear.
// Linear sends agent session events here when someone assigns or @mentions "Claude".
// The Worker acknowledges in Linear within 10 seconds, then fires the Claude scheduled task,
// which starts a thread in the Alpha project that does the work and replies as Claude.
//
// Secrets (wrangler secret put ...):
//   LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET   from the Linear OAuth app
//   LINEAR_WEBHOOK_SECRET                    the app's webhook signing secret
//   CLAUDE_FIRE_URL, CLAUDE_FIRE_TOKEN       from the scheduled task's API trigger

const SCOPES = "read,write,app:assignable,app:mentionable";
const LINEAR_API = "https://api.linear.app/graphql";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/install") return install(url, env);
    if (req.method === "GET" && url.pathname === "/callback") return callback(url, env);
    if (req.method === "POST" && url.pathname === "/webhook") return webhook(req, env, ctx);
    return new Response("Claude agent for Linear is running.");
  },
};

// One-time install of the app into the workspace, as an app actor.
function install(url, env) {
  const auth = new URL("https://linear.app/oauth/authorize");
  auth.search = new URLSearchParams({
    client_id: env.LINEAR_CLIENT_ID,
    redirect_uri: `${url.origin}/callback`,
    response_type: "code",
    scope: SCOPES,
    actor: "app",
    prompt: "consent",
  });
  return Response.redirect(auth.toString(), 302);
}

async function callback(url, env) {
  const code = url.searchParams.get("code");
  if (!code) return new Response("Install was cancelled.", { status: 400 });
  const r = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${url.origin}/callback`,
      client_id: env.LINEAR_CLIENT_ID,
      client_secret: env.LINEAR_CLIENT_SECRET,
    }),
  });
  if (!r.ok) return new Response(`Install failed: ${await r.text()}`, { status: 502 });
  return new Response("Claude is installed in Linear. You can close this tab.");
}

async function webhook(req, env, ctx) {
  const body = await req.text();
  if (!(await signed(body, req.headers.get("linear-signature"), env.LINEAR_WEBHOOK_SECRET)))
    return new Response("bad signature", { status: 401 });

  const e = JSON.parse(body);
  if (Math.abs(Date.now() - e.webhookTimestamp) > 60_000) return new Response("stale", { status: 401 });
  if (e.type !== "AgentSessionEvent" || !["created", "prompted"].includes(e.action))
    return new Response("ignored");

  const sessionId = e.agentSession?.id;
  const issue = e.agentSession?.issue?.identifier ?? "unknown";
  if (!sessionId) return new Response("no session", { status: 400 });

  // Linear wants a reply within 5 seconds and an activity within 10, so do the work after responding.
  ctx.waitUntil(handle(env, e.action, sessionId, issue));
  return new Response("ok");
}

async function handle(env, action, sessionId, issue) {
  const token = await appToken(env);
  const ack = action === "created" ? "On it. Starting a Claude thread for this issue." : "Got it. Picking this up.";
  await activity(token, sessionId, { type: "thought", body: ack });

  const r = await fetch(env.CLAUDE_FIRE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLAUDE_FIRE_TOKEN}`,
      "anthropic-beta": "experimental-cc-routine-2026-04-01",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: `session: ${sessionId}\nevent: ${action}\nissue: ${issue}` }),
  });
  if (!r.ok) {
    await activity(token, sessionId, {
      type: "error",
      body: `Couldn't start Claude (HTTP ${r.status}). Check the Worker's CLAUDE_FIRE_URL and CLAUDE_FIRE_TOKEN.`,
    });
  }
}

// Client credentials tokens last 30 days. Cache per isolate; a cold start just mints another.
let cached = null;
async function appToken(env) {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const r = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${env.LINEAR_CLIENT_ID}:${env.LINEAR_CLIENT_SECRET}`),
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: SCOPES }),
  });
  if (!r.ok) throw new Error(`Linear token request failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  cached = { token: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

async function activity(token, agentSessionId, content) {
  const r = await fetch(LINEAR_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      query: "mutation($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }",
      variables: { input: { agentSessionId, content } },
    }),
  });
  if (!r.ok) console.log("activity failed", r.status, await r.text());
}

async function signed(body, sig, secret) {
  if (!sig || !secret) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === sig;
}
