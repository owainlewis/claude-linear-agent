# claude-linear-agent

A "Claude" agent for Linear. Assign or @mention Claude on an issue and a Claude Code cloud run does the work, replying in the issue as Claude.

## How it works

1. Linear sends an agent session event (assign, mention or follow-up reply) to this Cloudflare Worker at /webhook.
2. The Worker checks Linear's signature, posts "On it." to the session within 10 seconds, and fires a Claude scheduled task through its API trigger with the session ID, event and issue ID.
3. The Claude run reads the session, does the work, and posts its result back to the session as the Claude app.

## Endpoints

- GET /install: one-time install into the Linear workspace (actor=app)
- GET /callback: OAuth redirect URI
- POST /webhook: Linear agent session events

## Secrets (npx wrangler@3 secret put NAME)

- LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET: the Linear OAuth app (client credentials on)
- LINEAR_WEBHOOK_SECRET: the app's webhook signing secret
- CLAUDE_FIRE_URL, CLAUDE_FIRE_TOKEN: the scheduled task's API trigger

## Deploy

```bash
npx wrangler@3 deploy
```

Live at https://claude-linear-agent.owain-80f.workers.dev
