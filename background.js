// ============================================================
// AI Text Polisher - Background Service Worker
// ============================================================

const MODES = {
  "auto-polish": {
    label: "Auto-polish",
    prompt: `You are a writing assistant for a freelance Shopify developer who communicates with clients on Upwork, Slack, and WhatsApp.
Your job: Take the user's rough draft message and polish it.
Rules:
- Keep it concise and professional but not overly formal
- Preserve the original meaning and intent exactly
- Fix grammar, spelling, and punctuation
- Keep the tone friendly and confident
- Don't add fluff or unnecessary words
- Don't add greetings or sign-offs unless the original has them
- If the message is already good, return it with minimal changes
- Return ONLY the polished message, nothing else. No explanations, no quotes, no labels.`
  },
  "formal": {
    label: "Formal",
    prompt: `You are a writing assistant. Take the user's rough draft and rewrite it in a professional, formal tone suitable for business emails or proposals.
Rules:
- Use professional language
- Be clear and structured
- Keep the core message intact
- Return ONLY the polished message, nothing else.`
  },
  "casual": {
    label: "Casual",
    prompt: `You are a writing assistant. Take the user's rough draft and rewrite it in a casual, friendly tone suitable for WhatsApp or Slack messages.
Rules:
- Keep it short and conversational
- Use lowercase where natural
- Be friendly but still clear
- No emojis unless the original has them
- Return ONLY the polished message, nothing else.`
  },
  "expand": {
    label: "Expand",
    prompt: `You are a writing assistant. Take the user's rough draft and expand it with more detail and clarity while keeping the same tone.
Rules:
- Add helpful detail and context
- Keep the same tone as the original
- Don't over-expand — just make it more complete
- Return ONLY the expanded message, nothing else.`
  },
  "shorten": {
    label: "Shorten",
    prompt: `You are a writing assistant. Take the user's rough draft and make it shorter and more concise.
Rules:
- Cut unnecessary words
- Keep the core message and intent
- Aim for roughly 50% of the original length
- Return ONLY the shortened message, nothing else.`
  }
};

// Create context menu items on install
chrome.runtime.onInstalled.addListener(() => {
  // Parent menu
  chrome.contextMenus.create({
    id: "ai-polisher",
    title: "AI Text Polisher",
    contexts: ["selection"]
  });

  // Sub-menus for each mode
  for (const [id, mode] of Object.entries(MODES)) {
    chrome.contextMenus.create({
      id: id,
      parentId: "ai-polisher",
      title: mode.label,
      contexts: ["selection"]
    });
  }
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (MODES[info.menuItemId]) {
    chrome.tabs.sendMessage(tab.id, {
      action: "polish",
      mode: info.menuItemId,
      text: info.selectionText
    });
  }
});

// Handle keyboard shortcuts
chrome.commands.onCommand.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      if (command === "toggle-chat") {
        chrome.tabs.sendMessage(tabs[0].id, { action: "toggle-chat-overlay" });
      } else {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: "polish-selected",
          mode: command
        });
      }
    }
  });
});

// Handle API calls from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "call-api") {
    callClaudeAPI(message.text, message.mode)
      .then(result => sendResponse({ success: true, text: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  } 

  if (message.action === "chat-api") {
    callChatAPI(message.messages)
      .then(result => sendResponse({ success: true, text: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === "n8n-proposal") {
    callN8nProposalBot(message.text, message.winningProposals)
      .then(result => sendResponse({ success: true, text: result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === "get-api-key") {
    chrome.storage.sync.get(["apiKey"], (result) => {
      sendResponse({ apiKey: result.apiKey || "" });
    });
    return true;
  }
});

// Invalidate the ClickUp context cache when its settings change, so toggling
// the feature or updating the webhook URL takes effect on the next message.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && (changes.clickupContextEnabled || changes.n8nWebhookUrl)) {
    clickupContextCache = { text: null, fetchedAt: 0 };
  }
});

// ClickUp context cache — avoids re-fetching tasks on every message in a
// conversation. The context is injected into the system prompt, so it rides
// along every turn anyway; we only need to refresh it occasionally.
const CLICKUP_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
let clickupContextCache = { text: null, fetchedAt: 0 };

// Fetch ClickUp tasks as a plain-text context block via the same n8n webhook
// used for proposals. The "mode: clickup" flag routes the request down the
// ClickUp branch of the workflow, which returns { context: "..." }.
async function getClickUpContext({ forceRefresh = false } = {}) {
  const { n8nWebhookUrl } = await chrome.storage.sync.get(["n8nWebhookUrl"]);
  if (!n8nWebhookUrl) {
    throw new Error("ClickUp context is on, but no n8n Proposal Bot webhook URL is set in Settings.");
  }

  const now = Date.now();
  if (!forceRefresh && clickupContextCache.text && now - clickupContextCache.fetchedAt < CLICKUP_CACHE_TTL_MS) {
    return clickupContextCache.text;
  }

  // Give up after 15s so a slow/hanging n8n can never freeze the chat.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  let response;
  try {
    response = await fetch(n8nWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "sendMessage",
        mode: "clickup",
        chatInput: "Return my current ClickUp tasks.",
        sessionId: "ext-" + now
      }),
      signal: controller.signal
    });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error("ClickUp webhook timed out after 15s.");
    }
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`ClickUp webhook error: ${response.status}`);
  }

  const data = await response.json().catch(() => ({}));
  const text = (data.context || data.output || data.text || "").toString().trim();
  clickupContextCache = { text, fetchedAt: now };
  return text;
}

// Chat API - multi-turn conversation with custom system prompt
async function callChatAPI(messages) {
  const { apiKey, customPrompt, clickupContextEnabled, chatModel } = await chrome.storage.sync.get([
    "apiKey", "customPrompt", "clickupContextEnabled", "chatModel"
  ]);

  if (!apiKey) {
    throw new Error("API key not set. Go to Settings tab to set it.");
  }

  let systemPrompt = customPrompt || `You are Hassan's communication assistant. Hassan is a Top Rated Plus Shopify developer and freelancer on Upwork who also works with clients on Slack, ClickUp, and other platforms.

Rules:
- Keep replies short and direct. 2-4 sentences max unless more detail is genuinely needed.
- Sound human. No corporate speak, no filler phrases like "I hope this message finds you well" or "I'd be happy to assist."
- Start with "Hi [name]" or "Hey [name]" when the client name is known.
- Acknowledge what they said, give a clear answer or update, then add a next step or question if needed.
- Never use emojis except occasionally a wave.
- Never sound like AI. No "Absolutely!", "Great question!", "I'd love to help!", or "Let me know if you need anything else!"
- Match the tone of the client — if they are casual, be casual. If formal, be slightly more polished.
- When improving text, keep the original meaning and just clean up grammar and flow. Do not add new content.
- When writing follow-ups, be brief and action-oriented. One nudge, not a paragraph.
- When analyzing a client message, break down what they actually want, what is clear, what is unclear, and what to ask them.
- Write like a real person texting a colleague, not like a customer service bot.`;

  // Context mode: when ON, pull the user's ClickUp tasks and append them to the
  // system prompt. When OFF, the only context is the chat messages themselves.
  if (clickupContextEnabled) {
    try {
      const clickupContext = await getClickUpContext();
      if (clickupContext) {
        systemPrompt += `\n\n# Live ClickUp context\nThe following are the user's current ClickUp tasks. Use them to ground your answers (status updates, what's in progress, follow-ups). Only reference tasks relevant to the user's message; do not dump the whole list.\n\n${clickupContext}`;
      }
    } catch (e) {
      // Don't break chat if ClickUp is unreachable — answer without the context.
      systemPrompt += `\n\n(Note: ClickUp context was requested but could not be loaded: ${e.message})`;
    }
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: chatModel || "claude-sonnet-5",
      max_tokens: 2048,
      thinking: { type: "disabled" },
      system: systemPrompt,
      messages: messages
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error: ${response.status}`);
  }

  const data = await response.json();
  // Sonnet 5 may prepend a "thinking" block — find the text block, don't assume [0]
  const textBlock = (data.content || []).find(b => b.type === "text");
  return textBlock ? textBlock.text : "";
}

async function callClaudeAPI(text, mode) {
  const { apiKey, chatModel } = await chrome.storage.sync.get(["apiKey", "chatModel"]);

  if (!apiKey) {
    throw new Error("API key not set. Click the extension icon to set it.");
  }

  const modeConfig = MODES[mode] || MODES["auto-polish"];

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: chatModel || "claude-sonnet-5",
      max_tokens: 2048,
      thinking: { type: "disabled" },
      system: modeConfig.prompt,
      messages: [{ role: "user", content: text }]
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error: ${response.status}`);
  }

  const data = await response.json();
  // Sonnet 5 may prepend a "thinking" block — find the text block, don't assume [0]
  const textBlock = (data.content || []).find(b => b.type === "text");
  return textBlock ? textBlock.text : "";
}
// n8n Proposal Bot API
async function callN8nProposalBot(jobDescription, winningProposals) {
  const { n8nWebhookUrl } = await chrome.storage.sync.get(["n8nWebhookUrl"]);

  if (!n8nWebhookUrl) {
    throw new Error("n8n webhook URL not set. Go to Settings tab.");
  }

  const response = await fetch(n8nWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "sendMessage",
      chatInput: jobDescription,
      winningProposals: Array.isArray(winningProposals) ? winningProposals : [],
      sessionId: "ext-" + Date.now()
    })
  });

  if (!response.ok) {
    throw new Error(`n8n error: ${response.status}`);
  }

  const data = await response.json();
  return data.output || data.text || JSON.stringify(data);
}
