const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

// ─── Configuration ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON; // JSON string
const GOOGLE_DOC_ID = "1QDR2OwIg5vKWy0mKthaOi0pJo46dY_4eMRhVEujhpUk";

// Approval / hold keyword lists (lowercase)
const APPROVAL_KEYWORDS = ["approved", "approve", "looks good", "lgtm", "go ahead", "ship it"];
const HOLD_KEYWORDS = ["hold", "skip", "wait", "pause", "not yet"];

const SIGNATURE = "\n\n— Jarvis";

// ─── Google Docs helper ──────────────────────────────────────────────────────
let docsClient = null;

function getDocsClient() {
  if (docsClient) return docsClient;
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.warn("⚠️  GOOGLE_SERVICE_ACCOUNT_JSON not set – Google Doc updates disabled.");
    return null;
  }
  try {
    const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/documents"],
    });
    docsClient = google.docs({ version: "v1", auth });
    return docsClient;
  } catch (err) {
    console.error("Failed to initialize Google Docs client:", err.message);
    return null;
  }
}

async function updateDocStatus(newStatus) {
  const docs = getDocsClient();
  if (!docs) {
    console.log(`[Google Doc] Would set status to "${newStatus}" but Docs client is unavailable.`);
    return;
  }

  try {
    // Read the document to find the status line
    const doc = await docs.documents.get({ documentId: GOOGLE_DOC_ID });
    const body = doc.data.body.content;

    let statusStart = null;
    let statusEnd = null;

    // Walk through all structural elements looking for "Status:" text
    for (const element of body) {
      if (element.paragraph && element.paragraph.elements) {
        for (const el of element.paragraph.elements) {
          if (el.textRun && el.textRun.content) {
            const text = el.textRun.content;
            const idx = text.toLowerCase().indexOf("status:");
            if (idx !== -1) {
              // Found the status line – replace from "Status:" to end of that text run
              statusStart = el.startIndex + idx;
              statusEnd = el.endIndex;
              break;
            }
          }
        }
      }
      if (statusStart !== null) break;
    }

    if (statusStart !== null && statusEnd !== null) {
      // Replace the existing status line
      const replacement = `Status: ${newStatus}\n`;
      await docs.documents.batchUpdate({
        documentId: GOOGLE_DOC_ID,
        requestBody: {
          requests: [
            { deleteContentRange: { range: { startIndex: statusStart, endIndex: statusEnd } } },
            { insertText: { location: { index: statusStart }, text: replacement } },
          ],
        },
      });
      console.log(`[Google Doc] Status updated to "${newStatus}".`);
    } else {
      // No status line found – append one at the end of the document
      const endIndex = doc.data.body.content[doc.data.body.content.length - 1].endIndex - 1;
      await docs.documents.batchUpdate({
        documentId: GOOGLE_DOC_ID,
        requestBody: {
          requests: [
            { insertText: { location: { index: endIndex }, text: `\nStatus: ${newStatus}\n` } },
          ],
        },
      });
      console.log(`[Google Doc] Appended status "${newStatus}" (no existing status line found).`);
    }
  } catch (err) {
    console.error("[Google Doc] Error updating status:", err.message);
  }
}

// ─── Slack helper ────────────────────────────────────────────────────────────
async function postSlackMessage(channel, text) {
  try {
    await axios.post(
      "https://slack.com/api/chat.postMessage",
      { channel, text: text + SIGNATURE },
      { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[Slack] Error posting message:", err.message);
  }
}

// ─── Classify message ────────────────────────────────────────────────────────
function classifyMessage(text) {
  const lower = text.toLowerCase();
  for (const kw of APPROVAL_KEYWORDS) {
    if (lower.includes(kw)) return "approved";
  }
  for (const kw of HOLD_KEYWORDS) {
    if (lower.includes(kw)) return "hold";
  }
  return "feedback";
}

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", bot: "Jarvis", uptime: process.uptime() });
});

// Root route
app.get("/", (_req, res) => {
  res.json({ message: "Jarvis Slack Bot is running. POST to /slack/events for Slack payloads." });
});

// Deduplicate events (Slack may retry)
const processedEvents = new Set();
const MAX_PROCESSED = 5000;

function markProcessed(eventId) {
  processedEvents.add(eventId);
  if (processedEvents.size > MAX_PROCESSED) {
    const first = processedEvents.values().next().value;
    processedEvents.delete(first);
  }
}

// Slack Events endpoint
app.post("/slack/events", async (req, res) => {
  const body = req.body;

  // 1. URL verification challenge
  if (body.type === "url_verification") {
    console.log("[Slack] URL verification challenge received.");
    return res.json({ challenge: body.challenge });
  }

  // 2. Acknowledge immediately (Slack wants a 200 within 3 s)
  res.status(200).send();

  // 3. Process event_callback
  if (body.type === "event_callback") {
    const event = body.event;
    const eventId = body.event_id || `${event.ts}-${event.channel}`;

    // Skip duplicates
    if (processedEvents.has(eventId)) return;
    markProcessed(eventId);

    // Only handle messages (not bot messages, not subtypes like joins)
    if (event.type !== "message" || event.subtype || event.bot_id) return;

    const text = event.text || "";
    const channel = event.channel;
    const user = event.user;

    console.log(`[Slack] Message from <${user}> in <${channel}>: ${text}`);

    const classification = classifyMessage(text);

    if (classification === "approved") {
      await postSlackMessage(channel, `✅ Got it — this is now *Approved*. I've updated the Google Doc.`);
      await updateDocStatus("Approved");
    } else if (classification === "hold") {
      await postSlackMessage(channel, `⏸️ Understood — placing this *On Hold*. I've updated the Google Doc.`);
      await updateDocStatus("On Hold");
    } else {
      await postSlackMessage(channel, `📝 Thanks <@${user}>, I've noted your feedback.`);
    }
  }
});

// ─── Start server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🤖 Jarvis Slack Bot listening on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   Slack events: http://localhost:${PORT}/slack/events`);
});
