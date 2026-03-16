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
      chrome.tabs.sendMessage(tabs[0].id, {
        action: "polish-selected",
        mode: command
      });
sage.action === "call-api") {
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

  if (message.action === "get-api-key") {
    chrome.storage.sync.get(["apiKey"], (result) => {
      sendResponse({ apiKey: result.apiKey || "" });
    });
    return true;
  }
});

// Chat API - multi-turn conversation with custom system prompt
async function callChatAPI(messages) {
  const { apiKey, customPrompt } = await chrome.storage.sync.get(["apiKey", "customPrompt"]);

  if (!apiKey) {
    throw new Error("API key not set. Go to Settings tab to set it.");
  }

  const systemPrompt = customPrompt || `You are a helpful AI assistant embedded in a browser extension. You can help with anything — writing, coding, brainstorming, planning, debugging, drafting messages, answering questions, etc.

Rules:
- Be concise and direct
- If the user provides context (like a client message), use it to inform your response
- Format code with backticks when relevant
- Keep responses practical and actionable
- You can help with any topic — not limited to just writing`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: systemPrompt,
      messages: messages
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error: ${response.status}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

async function callClaudeAPI(text, mode) {
  const { apiKey } = await chrome.storage.sync.get(["apiKey"]);

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
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: modeConfig.prompt,
      messages: [{ role: "user", content: text }]
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error: ${response.status}`);
  }

  const data = await response.json();
  return data.content[0].text;
}
