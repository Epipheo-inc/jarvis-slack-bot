# Jarvis Slack Bot

Epipheo's Slack bot for the **#jarvis-marketing** channel. Jarvis listens for approval/hold/feedback messages and updates a linked Google Doc automatically.

## Features

- **Approval workflow** — detects keywords like "approved", "lgtm", "ship it" and marks the Google Doc as *Approved*
- **Hold workflow** — detects keywords like "hold", "wait", "pause" and marks the Google Doc as *On Hold*
- **Feedback capture** — any other message is acknowledged as feedback
- **Google Doc sync** — automatically updates the Status line in the linked Google Doc
- **Health check** — `GET /health` returns uptime and status

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (Railway sets this automatically) |
| `SLACK_BOT_TOKEN` | Yes | Slack Bot User OAuth Token (`xoxb-…`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | No | Full JSON string of a Google service account key (for Doc updates) |

## Deployment (Railway)

1. Connect this GitHub repo to a new Railway project
2. Set the environment variables above in Railway's dashboard
3. Railway will auto-detect the Dockerfile and deploy
4. Use the generated Railway URL as your Slack Event Subscriptions Request URL: `https://<your-app>.up.railway.app/slack/events`

## Local Development

```bash
npm install
SLACK_BOT_TOKEN=xoxb-... PORT=3000 node index.js
```

---

*All bot messages are signed* **— Jarvis**
