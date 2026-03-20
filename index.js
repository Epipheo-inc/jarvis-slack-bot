const express = require("express");
const axios = require("axios");

// ─── Configuration ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_TOKEN_CHANNEL = process.env.SLACK_TOKEN_CHANNEL || "C0AHKC2J5MK"; // #jarvis-marketing

// LinkedIn OAuth config (Epipheo Page Manager app)
const LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const LINKEDIN_CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const LINKEDIN_REDIRECT_URI =
  process.env.LINKEDIN_REDIRECT_URI ||
  "https://jarvis-slack-bot-production.up.railway.app/linkedin/callback";
const LINKEDIN_SCOPES = "w_organization_social r_organization_social";

// LinkedIn API version (YYYYMM format)
const LINKEDIN_API_VERSION = process.env.LINKEDIN_API_VERSION || "202503";
const LINKEDIN_ORG_ID = process.env.LINKEDIN_ORG_ID || "980418";

// Token marker used to find/replace the token message in Slack
const TOKEN_MARKER = "JARVIS_LINKEDIN_TOKEN_V2";

const SIGNATURE = "\n\n— Jarvis";

// ─── Slack-based Token Persistence ──────────────────────────────────────────
// Tokens are stored as a Slack message in #jarvis-marketing.
// On startup, the server reads channel history to find the token.
// On OAuth, the server deletes the old token message and posts a new one.
// This survives all Railway restarts with zero manual intervention.

let linkedinTokens = {
  access_token: process.env.LINKEDIN_ACCESS_TOKEN || null,
  refresh_token: process.env.LINKEDIN_REFRESH_TOKEN || null,
  expires_at: process.env.LINKEDIN_EXPIRES_AT
    ? parseInt(process.env.LINKEDIN_EXPIRES_AT)
    : null,
};

// Post to Slack helper
async function slackPost(channel, text) {
  try {
    const res = await axios.post(
      "https://slack.com/api/chat.postMessage",
      { channel, text },
      {
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    return res.data;
  } catch (err) {
    console.error("[Slack] Post error:", err.message);
    return null;
  }
}

// Delete a Slack message
async function slackDelete(channel, ts) {
  try {
    await axios.post(
      "https://slack.com/api/chat.delete",
      { channel, ts },
      {
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("[Slack] Delete error:", err.message);
  }
}

// Read channel history and find token message
async function findTokenInSlack() {
  try {
    let cursor;
    let pages = 0;
    // Search up to 5 pages (500 messages) to find the token
    while (pages < 5) {
      const params = new URLSearchParams({
        channel: SLACK_TOKEN_CHANNEL,
        limit: "100",
      });
      if (cursor) params.append("cursor", cursor);

      const res = await axios.get(
        `https://slack.com/api/conversations.history?${params}`,
        {
          headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
        }
      );

      if (!res.data.ok) {
        console.error("[Token] Slack history error:", res.data.error);
        return null;
      }

      for (const msg of res.data.messages || []) {
        const text = msg.text || "";
        if (text.includes(TOKEN_MARKER)) {
          // Extract JSON payload after the marker
          const idx = text.indexOf(TOKEN_MARKER);
          const jsonStr = text.substring(idx + TOKEN_MARKER.length + 1).trim();
          try {
            const tokens = JSON.parse(jsonStr);
            return { tokens, ts: msg.ts };
          } catch (parseErr) {
            console.warn("[Token] Found marker but failed to parse JSON:", parseErr.message);
          }
        }
      }

      cursor = res.data.response_metadata?.next_cursor;
      if (!cursor) break;
      pages++;
    }
    return null;
  } catch (err) {
    console.error("[Token] Error searching Slack for token:", err.message);
    return null;
  }
}

// Save token to Slack (delete old, post new)
async function saveTokenToSlack(tokens) {
  try {
    // First, find and delete any existing token message
    const existing = await findTokenInSlack();
    if (existing && existing.ts) {
      console.log("[Token] Deleting old token message from Slack...");
      await slackDelete(SLACK_TOKEN_CHANNEL, existing.ts);
    }

    // Post new token message (not visible as a normal message — it's a system record)
    const payload = JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      expires_at: tokens.expires_at || null,
      saved_at: new Date().toISOString(),
    });

    const result = await slackPost(
      SLACK_TOKEN_CHANNEL,
      `🔐 ${TOKEN_MARKER} ${payload}`
    );

    if (result && result.ok) {
      console.log("[Token] LinkedIn token saved to Slack successfully.");
    } else {
      console.error("[Token] Failed to save token to Slack:", result);
    }
  } catch (err) {
    console.error("[Token] Error saving token to Slack:", err.message);
  }
}

// Load token from Slack on startup
async function loadTokenFromSlack() {
  if (!SLACK_BOT_TOKEN) {
    console.warn("[Token] No SLACK_BOT_TOKEN — cannot load token from Slack.");
    return;
  }

  console.log("[Token] Searching Slack for persisted LinkedIn token...");
  const found = await findTokenInSlack();

  if (found && found.tokens && found.tokens.access_token) {
    linkedinTokens.access_token = found.tokens.access_token;
    linkedinTokens.refresh_token = found.tokens.refresh_token || linkedinTokens.refresh_token;
    linkedinTokens.expires_at = found.tokens.expires_at || linkedinTokens.expires_at;

    const expiresDate = linkedinTokens.expires_at
      ? new Date(linkedinTokens.expires_at).toISOString()
      : "unknown";
    const isExpired = linkedinTokens.expires_at && Date.now() > linkedinTokens.expires_at;

    console.log(`[Token] ✅ LinkedIn token restored from Slack. Expires: ${expiresDate}${isExpired ? " (EXPIRED)" : ""}`);
  } else if (linkedinTokens.access_token) {
    console.log("[Token] No token in Slack, but found one in env vars.");
  } else {
    console.warn("[Token] ⚠️ No LinkedIn token found. Visit /linkedin/auth to authorize.");
  }
}

// ─── LinkedIn helpers ───────────────────────────────────────────────────────

async function getLinkedInAccessToken() {
  if (!linkedinTokens.access_token) {
    throw new Error("Not authorized. Visit /linkedin/auth first.");
  }

  // Auto-refresh if expired and we have a refresh token
  if (
    linkedinTokens.expires_at &&
    Date.now() > linkedinTokens.expires_at &&
    linkedinTokens.refresh_token
  ) {
    try {
      const refreshRes = await axios.post(
        "https://www.linkedin.com/oauth/v2/accessToken",
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: linkedinTokens.refresh_token,
          client_id: LINKEDIN_CLIENT_ID,
          client_secret: LINKEDIN_CLIENT_SECRET,
        }).toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );
      linkedinTokens.access_token = refreshRes.data.access_token;
      linkedinTokens.expires_at = Date.now() + refreshRes.data.expires_in * 1000;
      if (refreshRes.data.refresh_token) {
        linkedinTokens.refresh_token = refreshRes.data.refresh_token;
      }
      console.log("[LinkedIn] Token refreshed successfully.");
      // Persist refreshed token to Slack
      await saveTokenToSlack(linkedinTokens);
    } catch (refreshErr) {
      console.error(
        "[LinkedIn] Token refresh failed:",
        refreshErr.response?.data || refreshErr.message
      );
      throw new Error("Token expired and refresh failed. Re-authorize at /linkedin/auth.");
    }
  }

  return linkedinTokens.access_token;
}

function linkedinRestHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "LinkedIn-Version": LINKEDIN_API_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

// ─── Classify message (for Slack approval workflow) ─────────────────────────
const APPROVAL_KEYWORDS = ["approved", "approve", "looks good", "lgtm", "go ahead", "ship it"];
const HOLD_KEYWORDS = ["hold", "skip", "wait", "pause", "not yet"];

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

// ─── Express app ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "50mb" }));

// Health check
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    bot: "Jarvis",
    uptime: process.uptime(),
    linkedin_connected: !!linkedinTokens.access_token,
    linkedin_expires: linkedinTokens.expires_at
      ? new Date(linkedinTokens.expires_at).toISOString()
      : null,
    token_storage: "slack",
  });
});

// Root route
app.get("/", (_req, res) => {
  res.json({
    message: "Jarvis Slack Bot is running.",
    version: "2.0.0",
    token_persistence: "Slack channel message",
    endpoints: {
      health: "GET /health",
      linkedin_auth: "GET /linkedin/auth",
      linkedin_callback: "GET /linkedin/callback",
      linkedin_status: "GET /linkedin/status",
      linkedin_token: "GET /linkedin/token (x-jarvis-key required)",
      linkedin_post_company: "POST /linkedin/post-company",
      linkedin_upload_image: "POST /linkedin/upload-image",
      linkedin_upload_video: "POST /linkedin/upload-video",
      linkedin_org_lookup: "GET /linkedin/org-lookup?vanityName=epipheo",
      slack_events: "POST /slack/events",
      google_ads_auth: "GET /google-ads/auth",
      google_ads_callback: "GET /google-ads/callback",
      quickbooks_auth: "GET /quickbooks/auth",
      quickbooks_callback: "GET /quickbooks/callback",
      salesforce_auth: "GET /salesforce/auth",
      salesforce_callback: "GET /salesforce/callback",
    },
  });
});

// ─── LinkedIn OAuth ─────────────────────────────────────────────────────────

// Step 1: Redirect user to LinkedIn authorization page
app.get("/linkedin/auth", (_req, res) => {
  const state = Math.random().toString(36).substring(2, 15);
  const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${LINKEDIN_CLIENT_ID}&redirect_uri=${encodeURIComponent(LINKEDIN_REDIRECT_URI)}&scope=${encodeURIComponent(LINKEDIN_SCOPES)}&state=${state}`;
  console.log("[LinkedIn] Redirecting to authorization URL.");
  res.redirect(authUrl);
});

// Step 2: Handle OAuth callback — exchange code for token and persist to Slack
app.get("/linkedin/callback", async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    console.error(`[LinkedIn] OAuth error: ${error} — ${error_description}`);
    return res.status(400).send(
      `<h1>LinkedIn Authorization Failed</h1><p>${error}: ${error_description}</p>`
    );
  }

  if (!code) {
    return res.status(400).send("<h1>Missing authorization code</h1>");
  }

  try {
    // Exchange code for access token
    const tokenResponse = await axios.post(
      "https://www.linkedin.com/oauth/v2/accessToken",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: LINKEDIN_REDIRECT_URI,
        client_id: LINKEDIN_CLIENT_ID,
        client_secret: LINKEDIN_CLIENT_SECRET,
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const { access_token, expires_in, refresh_token, refresh_token_expires_in } =
      tokenResponse.data;

    linkedinTokens = {
      access_token,
      refresh_token: refresh_token || null,
      expires_at: Date.now() + expires_in * 1000,
    };

    // ═══ PERSIST TOKEN TO SLACK ═══
    await saveTokenToSlack(linkedinTokens);

    console.log(`[LinkedIn] Authorization successful. Token expires in ${expires_in}s.`);

    // Try to verify org access
    let orgInfo = "Organization access granted";
    try {
      const orgRes = await axios.get(
        "https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR",
        { headers: linkedinRestHeaders(access_token) }
      );
      const elements = orgRes.data.elements || [];
      if (elements.length > 0) {
        orgInfo = `Admin of ${elements.length} organization(s)`;
      }
    } catch (orgErr) {
      orgInfo = "Could not verify org access (token is still valid)";
    }

    const expiresDate = new Date(linkedinTokens.expires_at).toLocaleString();

    res.send(`
      <html>
      <body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 80px auto; text-align: center;">
        <h1 style="color: #0A66C2;">✅ LinkedIn Connected!</h1>
        <p><strong>Epipheo Page Manager</strong> authorized.</p>
        <p>${orgInfo}</p>
        <p>Token expires: <strong>${expiresDate}</strong></p>
        <p>Token persisted to: <strong>Slack #jarvis-marketing</strong></p>
        ${refresh_token ? "<p>Refresh token: ✅ Auto-renewal enabled</p>" : "<p>Refresh token: ❌ Will need re-auth when token expires</p>"}
        <hr>
        <p style="color: #28a745; font-weight: bold;">✅ Token will survive all server restarts. No manual steps needed.</p>
        <p style="color: #666;">You can close this window.</p>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("[LinkedIn] Token exchange error:", err.response?.data || err.message);
    res.status(500).send(
      `<h1>Token Exchange Failed</h1><pre>${JSON.stringify(err.response?.data || err.message, null, 2)}</pre>`
    );
  }
});

// Internal token endpoint (protected by x-jarvis-key)
app.get("/linkedin/token", (req, res) => {
  const key = req.headers["x-jarvis-key"];
  if (key !== "jarvis-internal-2026") {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!linkedinTokens.access_token) {
    return res.status(404).json({ error: "No token available. Visit /linkedin/auth first." });
  }
  res.json({
    access_token: linkedinTokens.access_token,
    expires_at: linkedinTokens.expires_at,
    has_refresh_token: !!linkedinTokens.refresh_token,
  });
});

// Status check
app.get("/linkedin/status", async (_req, res) => {
  if (!linkedinTokens.access_token) {
    return res.json({
      connected: false,
      message: "Not connected. Visit /linkedin/auth to authorize.",
    });
  }

  const expired =
    linkedinTokens.expires_at && Date.now() > linkedinTokens.expires_at;
  res.json({
    connected: true,
    expired,
    expires_at: linkedinTokens.expires_at
      ? new Date(linkedinTokens.expires_at).toISOString()
      : null,
    has_refresh_token: !!linkedinTokens.refresh_token,
    scopes: LINKEDIN_SCOPES,
    api_version: LINKEDIN_API_VERSION,
    org_id: LINKEDIN_ORG_ID,
    token_storage: "slack",
  });
});

// ─── Organization Lookup ────────────────────────────────────────────────────
app.get("/linkedin/org-lookup", async (req, res) => {
  try {
    const accessToken = await getLinkedInAccessToken();
    const { vanityName } = req.query;

    if (!vanityName) {
      return res.status(400).json({
        error: "Missing 'vanityName' query parameter.",
      });
    }

    const orgRes = await axios.get(
      `https://api.linkedin.com/rest/organizations?q=vanityName&vanityName=${encodeURIComponent(vanityName)}`,
      { headers: linkedinRestHeaders(accessToken) }
    );

    const elements = orgRes.data.elements || [];
    if (elements.length === 0) {
      return res.status(404).json({
        error: `No organization found with vanityName "${vanityName}".`,
      });
    }

    const org = elements[0];
    res.json({
      success: true,
      organization: {
        id: org.id,
        urn: `urn:li:organization:${org.id}`,
        name: org.localizedName,
        vanityName: org.vanityName,
      },
    });
  } catch (err) {
    console.error("[LinkedIn] Org lookup error:", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: err.response?.data || err.message,
    });
  }
});

// ─── List Administered Organizations ────────────────────────────────────────
app.get("/linkedin/org-admin-list", async (_req, res) => {
  try {
    const accessToken = await getLinkedInAccessToken();
    const orgRes = await axios.get(
      "https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR",
      { headers: linkedinRestHeaders(accessToken) }
    );
    const elements = orgRes.data.elements || [];
    res.json({
      success: true,
      count: elements.length,
      organizations: elements.map((e) => ({
        organizationUrn: e.organization,
        role: e.role,
        state: e.state,
      })),
    });
  } catch (err) {
    console.error("[LinkedIn] Org admin list error:", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: err.response?.data || err.message,
    });
  }
});

// ─── Post to LinkedIn Company Page ──────────────────────────────────────────
app.post("/linkedin/post-company", async (req, res) => {
  try {
    const accessToken = await getLinkedInAccessToken();
    const { orgId, text, imageUrn, videoUrn } = req.body;
    const org = orgId || LINKEDIN_ORG_ID;

    if (!text && !imageUrn && !videoUrn) {
      return res.status(400).json({
        error: "Must provide at least 'text', 'imageUrn', or 'videoUrn'.",
      });
    }

    const postBody = {
      author: `urn:li:organization:${org}`,
      commentary: text || "",
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };

    if (imageUrn) {
      postBody.content = { media: { title: "Image", id: imageUrn } };
    }
    if (videoUrn) {
      postBody.content = { media: { title: "Video", id: videoUrn } };
    }

    const postRes = await axios.post(
      "https://api.linkedin.com/rest/posts",
      postBody,
      { headers: linkedinRestHeaders(accessToken) }
    );

    const postUrn = postRes.headers["x-restli-id"] || postRes.data?.id || "created";
    console.log(`[LinkedIn] Company post published. URN: ${postUrn}`);
    res.json({ success: true, post_urn: postUrn });
  } catch (err) {
    console.error("[LinkedIn] Company post error:", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: err.response?.data || err.message,
    });
  }
});

// ─── Upload Image to LinkedIn ───────────────────────────────────────────────
app.post("/linkedin/upload-image", async (req, res) => {
  try {
    const accessToken = await getLinkedInAccessToken();
    const { orgId, imageUrl } = req.body;
    const org = orgId || LINKEDIN_ORG_ID;

    if (!imageUrl) {
      return res.status(400).json({ error: "Missing 'imageUrl' in request body." });
    }

    const initRes = await axios.post(
      "https://api.linkedin.com/rest/images?action=initializeUpload",
      { initializeUploadRequest: { owner: `urn:li:organization:${org}` } },
      { headers: linkedinRestHeaders(accessToken) }
    );

    const { uploadUrl, image: imageUrn } = initRes.data.value;
    const imageResponse = await axios.get(imageUrl, { responseType: "arraybuffer" });
    const imageBuffer = Buffer.from(imageResponse.data);

    await axios.put(uploadUrl, imageBuffer, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    console.log(`[LinkedIn] Image uploaded. URN: ${imageUrn}`);
    res.json({ success: true, imageUrn });
  } catch (err) {
    console.error("[LinkedIn] Image upload error:", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: err.response?.data || err.message,
    });
  }
});

// ─── Upload Video to LinkedIn ───────────────────────────────────────────────
app.post("/linkedin/upload-video", async (req, res) => {
  try {
    const accessToken = await getLinkedInAccessToken();
    const { orgId, videoUrl, fileSizeBytes } = req.body;
    const org = orgId || LINKEDIN_ORG_ID;

    if (!videoUrl) {
      return res.status(400).json({ error: "Missing 'videoUrl' in request body." });
    }

    // Step 1: Initialize video upload
    const initRes = await axios.post(
      "https://api.linkedin.com/rest/videos?action=initializeUpload",
      {
        initializeUploadRequest: {
          owner: `urn:li:organization:${org}`,
          fileSizeBytes: fileSizeBytes || 0,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      },
      { headers: linkedinRestHeaders(accessToken) }
    );

    const { uploadInstructions, video: videoUrn } = initRes.data.value;
    console.log(`[LinkedIn] Video upload initialized. URN: ${videoUrn}`);

    // Step 2: Download video
    const videoResponse = await axios.get(videoUrl, { responseType: "arraybuffer" });
    const videoBuffer = Buffer.from(videoResponse.data);

    // Step 3: Upload chunks
    const uploadedPartIds = [];
    for (const instruction of uploadInstructions) {
      const start = instruction.firstByte || 0;
      const end =
        instruction.lastByte !== undefined
          ? instruction.lastByte
          : videoBuffer.length - 1;
      const chunk = videoBuffer.slice(start, end + 1);

      const uploadRes = await axios.put(instruction.uploadUrl, chunk, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/octet-stream",
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      const etag = (uploadRes.headers["etag"] || uploadRes.headers["ETag"] || "").replace(
        /"/g,
        ""
      );
      if (etag) uploadedPartIds.push(etag);
    }

    // Step 4: Finalize upload
    await axios.post(
      "https://api.linkedin.com/rest/videos?action=finalizeUpload",
      {
        finalizeUploadRequest: {
          video: videoUrn,
          uploadToken: "",
          uploadedPartIds,
        },
      },
      { headers: linkedinRestHeaders(accessToken) }
    );

    console.log(`[LinkedIn] Video uploaded successfully. URN: ${videoUrn}`);
    res.json({ success: true, videoUrn });
  } catch (err) {
    console.error("[LinkedIn] Video upload error:", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: err.response?.data || err.message,
    });
  }
});

// ─── Slack Events (Approval Workflow) ───────────────────────────────────────
const processedEvents = new Set();
const MAX_PROCESSED = 5000;

function markProcessed(eventId) {
  processedEvents.add(eventId);
  if (processedEvents.size > MAX_PROCESSED) {
    const first = processedEvents.values().next().value;
    processedEvents.delete(first);
  }
}

app.post("/slack/events", async (req, res) => {
  const body = req.body;

  // URL verification challenge
  if (body.type === "url_verification") {
    return res.json({ challenge: body.challenge });
  }

  // Acknowledge immediately
  res.status(200).send();

  if (body.type === "event_callback") {
    const event = body.event;
    const eventId = body.event_id || `${event.ts}-${event.channel}`;

    if (processedEvents.has(eventId)) return;
    markProcessed(eventId);

    // Skip bot messages, subtypes, and token store messages
    if (event.type !== "message" || event.subtype || event.bot_id) return;
    if ((event.text || "").includes(TOKEN_MARKER)) return;

    const text = event.text || "";
    const channel = event.channel;
    const user = event.user;

    console.log(`[Slack] Message from <${user}> in <${channel}>: ${text}`);

    const classification = classifyMessage(text);

    if (classification === "approved") {
      await slackPost(channel, `✅ Got it — this is now *Approved*.${SIGNATURE}`);
    } else if (classification === "hold") {
      await slackPost(channel, `⏸️ Understood — placing this *On Hold*.${SIGNATURE}`);
    } else {
      await slackPost(channel, `📝 Thanks <@${user}>, I've noted your feedback.${SIGNATURE}`);
    }
  }
});

// ─── Google Ads OAuth (kept for other workflows) ────────────────────────────

const GOOGLE_ADS_CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID;
const GOOGLE_ADS_CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET;
const GOOGLE_ADS_REDIRECT_URI =
  "https://jarvis-slack-bot-production.up.railway.app/google-ads/callback";
const GOOGLE_ADS_SCOPES = "https://www.googleapis.com/auth/adwords";
const GOOGLE_ADS_DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
const GOOGLE_ADS_CUSTOMER_ID = process.env.GOOGLE_ADS_CUSTOMER_ID;
const GOOGLE_ADS_MANAGER_ID = process.env.GOOGLE_ADS_MANAGER_ID;

let googleAdsTokens = { access_token: null, refresh_token: null, expires_at: null };

app.get("/google-ads/auth", (req, res) => {
  const state = Math.random().toString(36).substring(2, 15);
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${encodeURIComponent(GOOGLE_ADS_CLIENT_ID)}&redirect_uri=${encodeURIComponent(GOOGLE_ADS_REDIRECT_URI)}&scope=${encodeURIComponent(GOOGLE_ADS_SCOPES)}&access_type=offline&prompt=consent&state=${state}`;
  res.redirect(authUrl);
});

app.get("/google-ads/callback", async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) return res.status(400).send(`<h1>Google Ads Auth Failed</h1><p>${error}</p>`);
  if (!code) return res.status(400).send("<h1>Missing authorization code</h1>");

  try {
    const tokenResponse = await axios.post(
      "https://oauth2.googleapis.com/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: GOOGLE_ADS_REDIRECT_URI,
        client_id: GOOGLE_ADS_CLIENT_ID,
        client_secret: GOOGLE_ADS_CLIENT_SECRET,
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    googleAdsTokens = {
      access_token,
      refresh_token: refresh_token || null,
      expires_at: Date.now() + (expires_in || 3600) * 1000,
    };
    res.send(`<h1>✅ Google Ads Connected!</h1><p>You can close this window.</p>`);
  } catch (err) {
    res.status(500).send(`<h1>Token Exchange Failed</h1><pre>${JSON.stringify(err.response?.data || err.message)}</pre>`);
  }
});

app.get("/google-ads/tokens", (req, res) => {
  if (req.headers["x-jarvis-key"] !== "jarvis-internal-2026") return res.status(403).json({ error: "Unauthorized" });
  if (!googleAdsTokens.access_token) return res.status(404).json({ error: "No tokens. Visit /google-ads/auth." });
  res.json({ ...googleAdsTokens, developer_token: GOOGLE_ADS_DEVELOPER_TOKEN, customer_id: GOOGLE_ADS_CUSTOMER_ID, manager_id: GOOGLE_ADS_MANAGER_ID });
});

// ─── QuickBooks OAuth (kept for other workflows) ────────────────────────────

const QBO_CLIENT_ID = process.env.QBO_CLIENT_ID || "ABQ8sb9lLaLRhKqKqhZFQf8KK3lJT0vYztIUE9XqH0K193a0Ud";
const QBO_CLIENT_SECRET = process.env.QBO_CLIENT_SECRET || "CXh0T14JmvzAC5XZfN87asUp4K2DOVg2F48Lz2j5";
const QBO_REDIRECT_URI = process.env.QBO_REDIRECT_URI || "https://jarvis-slack-bot-production.up.railway.app/quickbooks/callback";
const QBO_TOKEN_ENDPOINT = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

let qboTokens = { access_token: null, refresh_token: null, expires_at: null, realm_id: null };

app.get("/quickbooks/auth", (req, res) => {
  const state = Math.random().toString(36).substring(2, 15);
  res.redirect(`https://appcenter.intuit.com/connect/oauth2?client_id=${QBO_CLIENT_ID}&response_type=code&scope=${encodeURIComponent("com.intuit.quickbooks.accounting")}&redirect_uri=${encodeURIComponent(QBO_REDIRECT_URI)}&state=${state}`);
});

app.get("/quickbooks/callback", async (req, res) => {
  const { code, realmId, error } = req.query;
  if (error) return res.status(400).send(`<h1>QBO Auth Failed</h1>`);
  if (!code) return res.status(400).send("<h1>Missing code</h1>");
  try {
    const credentials = Buffer.from(`${QBO_CLIENT_ID}:${QBO_CLIENT_SECRET}`).toString("base64");
    const tokenResponse = await axios.post(QBO_TOKEN_ENDPOINT, new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: QBO_REDIRECT_URI }).toString(), { headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" } });
    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    qboTokens = { access_token, refresh_token, expires_at: Date.now() + (expires_in || 3600) * 1000, realm_id: realmId };
    res.send(`<h1>✅ QuickBooks Connected!</h1><p>Realm: ${realmId}</p>`);
  } catch (err) {
    res.status(500).send(`<h1>Token Exchange Failed</h1>`);
  }
});

app.get("/quickbooks/tokens", (req, res) => {
  if (req.headers["x-jarvis-key"] !== "jarvis-internal-2026") return res.status(403).json({ error: "Unauthorized" });
  if (!qboTokens.access_token) return res.status(404).json({ error: "No tokens." });
  res.json(qboTokens);
});

// ─── Salesforce OAuth (kept for other workflows) ────────────────────────────

const SF_CLIENT_ID = process.env.SF_CLIENT_ID;
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET;
const SF_REDIRECT_URI = process.env.SF_REDIRECT_URI || "https://jarvis-slack-bot-production.up.railway.app/salesforce/callback";

let sfTokens = { access_token: null, refresh_token: null, instance_url: null, expires_at: null };

app.get("/salesforce/auth", (req, res) => {
  const state = Math.random().toString(36).substring(2, 15);
  res.redirect(`https://login.salesforce.com/services/oauth2/authorize?response_type=code&client_id=${SF_CLIENT_ID}&redirect_uri=${encodeURIComponent(SF_REDIRECT_URI)}&scope=${encodeURIComponent("full refresh_token offline_access")}&state=${state}`);
});

app.get("/salesforce/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`<h1>Salesforce Auth Failed</h1>`);
  if (!code) return res.status(400).send("<h1>Missing code</h1>");
  try {
    const tokenResponse = await axios.post("https://login.salesforce.com/services/oauth2/token", new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: SF_REDIRECT_URI, client_id: SF_CLIENT_ID, client_secret: SF_CLIENT_SECRET }).toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    const { access_token, refresh_token, instance_url, issued_at } = tokenResponse.data;
    sfTokens = { access_token, refresh_token, instance_url, expires_at: (issued_at ? parseInt(issued_at) : Date.now()) + 3600000 };
    res.send(`<h1>✅ Salesforce Connected!</h1><p>Instance: ${instance_url}</p>`);
  } catch (err) {
    res.status(500).send(`<h1>Token Exchange Failed</h1>`);
  }
});

app.get("/salesforce/tokens", (req, res) => {
  if (req.headers["x-jarvis-key"] !== "jarvis-internal-2026") return res.status(403).json({ error: "Unauthorized" });
  if (!sfTokens.access_token) return res.status(404).json({ error: "No tokens." });
  res.json(sfTokens);
});

// ─── Start server ───────────────────────────────────────────────────────────
async function start() {
  // Load token from Slack before starting the server
  await loadTokenFromSlack();

  app.listen(PORT, () => {
    console.log(`🤖 Jarvis v2.0 listening on port ${PORT}`);
    console.log(`   Token persistence: Slack #jarvis-marketing`);
    console.log(`   LinkedIn connected: ${!!linkedinTokens.access_token}`);
    if (linkedinTokens.expires_at) {
      console.log(`   Token expires: ${new Date(linkedinTokens.expires_at).toISOString()}`);
    }
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   LinkedIn auth: http://localhost:${PORT}/linkedin/auth`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
