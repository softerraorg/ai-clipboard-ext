// ============================================================
// AI Text Polisher - Content Script (v3 with Floating Chat)
// ============================================================

// ============================================================
// 1. Message router — chat overlay toggle (keyboard command Alt+Shift+O)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "toggle-chat-overlay") {
    toggleOverlay();
  }
});

// ============================================================
// 2. Floating Action Button + Chat Overlay
// ============================================================

let overlayHost = null;
let shadow = null;
let overlayProcessing = false;
let overlayProposals = []; // [{ jobPost, proposal }] — shared with popup via chrome.storage.local
let overlayPropActive = -1; // index of the proposal shown in the editor pane (-1 = none)
const OVERLAY_MAX_PROPOSALS = 10;
let pendingAttachments = []; // {name, mediaType, data (base64), kind: 'image'|'document'|'text', textContent?}

// --- Session storage model ---
// sessions: [{ id, title, createdAt, updatedAt, messages: [{role, content}] }]
// activeSessionId: id of the session currently displayed in this tab.
//
// chatHistory always points to the active session's messages array so the
// existing push/pop semantics still work.

const SESSIONS_KEY = "aip_sessions_v1";
const LEGACY_CHAT_KEY = "aip_chat_history_v1";

let sessions = [];
let activeSessionId = null;
let chatHistory = [];
let currentTheme = "light";
let stealthMode = false; // Alt+Shift+H — hide the whole extension UI (for screen recordings)

function newSessionId() {
  return "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function getActiveSession() {
  return sessions.find((s) => s.id === activeSessionId) || null;
}

function deriveTitle(messages) {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "New chat";
  const textContent = typeof firstUser.content === "string"
    ? firstUser.content
    : renderMsgContent(firstUser.content);
  return textContent.replace(/\s+/g, " ").trim().slice(0, 48) || "New chat";
}

function touchActiveSession() {
  const s = getActiveSession();
  if (!s) return;
  s.updatedAt = Date.now();
  if (!s.title || s.title === "New chat") s.title = deriveTitle(s.messages);
}

function saveSessions() {
  try {
    // Strip base64 file data from saved history (image/document blocks)
    // so chrome.storage.local quota (10MB) doesn't fill up. The in-memory
    // chatHistory still has the full data for the current turn.
    const slim = sessions.map((s) => ({
      ...s,
      messages: s.messages.map((m) => {
        if (typeof m.content === "string") return m;
        if (!Array.isArray(m.content)) return m;
        return {
          ...m,
          content: m.content.map((block) => {
            if (block && (block.type === "image" || block.type === "document")) {
              const label = block.type === "image" ? "image" : "document";
              return { type: "text", text: `[Attachment: ${label}]` };
            }
            return block;
          })
        };
      })
    }));
    chrome.storage.local.set({ [SESSIONS_KEY]: { sessions: slim, activeSessionId } });
  } catch (e) {
    // ignore
  }
}

function createNewSession({ activate = true } = {}) {
  const id = newSessionId();
  const session = {
    id,
    title: "New chat",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: []
  };
  sessions.unshift(session);
  if (activate) {
    activeSessionId = id;
    chatHistory = session.messages;
  }
  return session;
}

function setActiveSession(id) {
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  activeSessionId = id;
  chatHistory = s.messages;
}

function deleteSession(id) {
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx === -1) return;
  sessions.splice(idx, 1);
  if (id === activeSessionId) {
    if (sessions.length) {
      setActiveSession(sessions[0].id);
    } else {
      createNewSession();
    }
  }
}

function loadSessionsFromStorage() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([SESSIONS_KEY, LEGACY_CHAT_KEY], (result) => {
        const data = result && result[SESSIONS_KEY];
        if (data && Array.isArray(data.sessions)) {
          sessions = data.sessions;
          activeSessionId = data.activeSessionId || (sessions[0] && sessions[0].id);
        }

        // Migrate legacy single-chat history into a session, once.
        const legacy = result && result[LEGACY_CHAT_KEY];
        if (Array.isArray(legacy) && legacy.length && !sessions.some((s) => s.__migrated)) {
          const id = newSessionId();
          sessions.unshift({
            id,
            title: deriveTitle(legacy),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: legacy,
            __migrated: true
          });
          activeSessionId = activeSessionId || id;
          chrome.storage.local.remove([LEGACY_CHAT_KEY]);
        }

        if (!sessions.length) {
          createNewSession();
        } else {
          const active = sessions.find((s) => s.id === activeSessionId);
          if (active) {
            chatHistory = active.messages;
          } else {
            setActiveSession(sessions[0].id);
          }
        }
        resolve();
      });
    } catch (e) {
      if (!sessions.length) createNewSession();
      resolve();
    }
  });
}

function renderSessionList() {
  const list = shadow.getElementById("aip-session-list");
  if (!list) return;
  list.innerHTML = "";

  if (!sessions.length) {
    const empty = document.createElement("div");
    empty.className = "aip-session-empty";
    empty.textContent = "No chats yet";
    list.appendChild(empty);
    return;
  }

  const sorted = [...sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const s of sorted) {
    const item = document.createElement("div");
    item.className = "aip-session-item" + (s.id === activeSessionId ? " active" : "");
    item.dataset.sid = s.id;
    item.innerHTML = `
      <div class="aip-session-meta">
        <div class="aip-session-title">${escHTML(s.title || "New chat")}</div>
        <div class="aip-session-time">${formatRelativeTime(s.updatedAt)}</div>
      </div>
    `;
    item.addEventListener("click", (e) => {
      if (s.id === activeSessionId) {
        closeSidebar();
        return;
      }
      setActiveSession(s.id);
      saveSessions();
      rerenderActiveChat();
      renderSessionList();
      closeSidebar();
    });
    list.appendChild(item);
  }
}

function formatRelativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const min = 60 * 1000, hr = 60 * min, day = 24 * hr;
  if (diff < min) return "just now";
  if (diff < hr) return Math.floor(diff / min) + "m ago";
  if (diff < day) return Math.floor(diff / hr) + "h ago";
  if (diff < 7 * day) return Math.floor(diff / day) + "d ago";
  return new Date(ts).toLocaleDateString();
}

function rerenderActiveChat() {
  const chat = shadow.getElementById("aip-chat");
  if (!chat) return;
  chat.innerHTML = "";
  if (!chatHistory.length) {
    const empty = document.createElement("div");
    empty.className = "aip-empty";
    empty.id = "aip-empty";
    empty.innerHTML = `
      <div class="aip-empty-icon">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/></svg>
      </div>
      <div class="aip-empty-title">AI Assistant</div>
      <div class="aip-empty-desc">Ask anything, draft messages, brainstorm, debug code.</div>
    `;
    chat.appendChild(empty);
    return;
  }
  for (let i = 0; i < chatHistory.length; i++) {
    const msg = chatHistory[i];
    if (msg._kind === "proposal-compare") {
      renderProposalCompare(msg);
      continue;
    }
    if (msg.role === "user") {
      const text = msg._displayText !== undefined
        ? msg._displayText
        : renderMsgContent(msg.content);
      addOverlayMsg(text, "user", { skipSave: true, attachments: msg._attachments || [], fullText: msg._fullText, kind: msg._kind, loom: msg._loom === true, histIndex: i });
    } else if (msg.role === "assistant") {
      const text = renderMsgContent(msg.content);
      addOverlayMsg(text, "ai", { skipSave: true });
    }
  }
}

function renderMsgContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "image") {
      parts.push("📎 [image]");
    } else if (block.type === "document") {
      parts.push("📎 [document]");
    }
  }
  return parts.join("\n");
}

function openSidebar() {
  const sb = shadow.getElementById("aip-sidebar");
  if (!sb) return;
  renderSessionList();
  sb.classList.add("open");
}

function closeSidebar() {
  const sb = shadow.getElementById("aip-sidebar");
  if (sb) sb.classList.remove("open");
}

// ---- Stealth mode (hide the extension UI for Loom / screen recordings) ----

// Hide or show the entire overlay host. `opts.toast` shows a brief confirmation
// pill (used for live toggles, skipped when applying the saved state on load).
function applyStealth(on, opts = {}) {
  const changed = stealthMode !== !!on;
  stealthMode = !!on;
  if (overlayHost) {
    if (stealthMode) {
      // Close the panel first so un-hiding brings back just the edge-tab
      const panel = shadow && shadow.getElementById("aip-panel");
      if (panel) panel.classList.remove("open");
      updateLauncherVisibility();
      overlayHost.style.display = "none";
    } else {
      overlayHost.style.display = "";
      updateLauncherVisibility();
    }
  }
  if (opts.toast && changed) {
    showStealthToast(stealthMode
      ? "AI Polisher hidden on all pages · Alt+Shift+H to show again"
      : "AI Polisher visible again");
  }
}

// Tiny self-removing toast. Lives OUTSIDE the overlay host (which may be
// hidden), fully inline-styled so page CSS can't break it.
function showStealthToast(msg) {
  try {
    const old = document.getElementById("aip-stealth-toast");
    if (old) old.remove();
    const t = document.createElement("div");
    t.id = "aip-stealth-toast";
    t.textContent = msg;
    t.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);" +
      "z-index:2147483647;background:rgba(20,20,28,0.92);color:#fff;" +
      "font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;" +
      "padding:8px 16px;border-radius:999px;box-shadow:0 4px 18px rgba(0,0,0,0.35);" +
      "pointer-events:none;opacity:0;transition:opacity 0.25s ease;";
    document.body.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = "1"; });
    setTimeout(() => {
      t.style.opacity = "0";
      setTimeout(() => t.remove(), 300);
    }, 2400);
  } catch (e) { /* ignore */ }
}

function loadStealth() {
  try {
    chrome.storage.local.get("aip_stealth", (r) => {
      applyStealth(!!(r && r.aip_stealth));
    });
  } catch (e) { /* ignore */ }
}

function setupCrossTabSync() {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      // Stealth toggled (from any tab or the keyboard command) — apply here too
      if (changes.aip_stealth) {
        applyStealth(!!changes.aip_stealth.newValue, { toast: true });
      }
      if (!changes[SESSIONS_KEY]) return;
      const next = changes[SESSIONS_KEY].newValue;
      if (!next || !Array.isArray(next.sessions)) return;
      sessions = next.sessions;
      const stillActive = sessions.find((s) => s.id === activeSessionId);
      if (stillActive) {
        chatHistory = stillActive.messages;
      } else if (sessions.length) {
        setActiveSession(sessions[0].id);
      } else {
        createNewSession();
      }
      rerenderActiveChat();
      renderSessionList();
    });
  } catch (e) {
    // ignore — chrome.storage.onChanged may not exist in some contexts
  }
}

function applyTheme(theme) {
  currentTheme = theme;
  const panel = shadow && shadow.getElementById("aip-panel");
  if (panel) panel.setAttribute("data-theme", theme);
  try { chrome.storage.local.set({ aip_theme_v2: theme }); } catch(e) {}
}

function loadTheme() {
  // Apply the saved theme if the user has picked one; otherwise fall back to the
  // default (currentTheme = "light") so the panel always gets a data-theme set.
  try {
    chrome.storage.local.get("aip_theme_v2", (r) => {
      applyTheme(r && r.aip_theme_v2 ? r.aip_theme_v2 : currentTheme);
    });
  } catch(e) {
    applyTheme(currentTheme);
  }
}

async function initFloatingUI() {
  if (overlayHost) return;

  overlayHost = document.createElement("div");
  overlayHost.id = "ai-polisher-overlay-host";
  shadow = overlayHost.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = getOverlayCSS();
  shadow.appendChild(style);

  // Micro launcher — tiny edge-tab, the ONLY launcher (the old bottom-right
  // FAB pill was removed; this tab is always visible while the panel is closed)
  const micro = document.createElement("button");
  micro.id = "aip-micro";
  micro.title = "Open Proposal Bot (Alt+Shift+O)";
  micro.setAttribute("aria-label", "Open Proposal Bot");
  micro.innerHTML = `
    <span class="aip-micro-glyph"><svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2 Q12 12 22 12 Q12 12 12 22 Q12 12 2 12 Q12 12 12 2 Z"/></svg></span>
    <span class="aip-micro-label">✦ Proposal Bot</span>
  `;
  micro.addEventListener("click", restoreLauncher);
  shadow.appendChild(micro);

  // Chat panel
  const panel = document.createElement("div");
  panel.id = "aip-panel";
  panel.innerHTML = getPanelHTML();
  shadow.appendChild(panel);

  document.body.appendChild(overlayHost);

  setupPanelEvents();
  updateLauncherVisibility();
  loadStealth();

  await loadSessionsFromStorage();
  rerenderActiveChat();
  renderSessionList();
  setupCrossTabSync();
  loadTheme();
}

// The micro edge-tab is the only launcher: visible while the panel is closed,
// hidden while it's open.
function updateLauncherVisibility() {
  const panel = shadow.getElementById("aip-panel");
  const micro = shadow.getElementById("aip-micro");
  if (!panel || !micro) return;
  micro.classList.toggle("hidden", panel.classList.contains("open"));
}

function togglePanel() {
  const panel = shadow.getElementById("aip-panel");
  const isOpen = panel.classList.contains("open");
  if (isOpen) {
    panel.classList.remove("open");
  } else {
    panel.classList.add("open");
    const input = shadow.getElementById("aip-prompt");
    setTimeout(() => input && input.focus(), 200);
  }
  updateLauncherVisibility();
}

// Close (×) → close the panel; the micro edge-tab reappears.
function closeToMicro() {
  const panel = shadow.getElementById("aip-panel");
  if (panel) panel.classList.remove("open");
  updateLauncherVisibility();
}

// Micro click → open the chat.
function restoreLauncher() {
  const panel = shadow.getElementById("aip-panel");
  if (panel && !panel.classList.contains("open")) {
    panel.classList.add("open");
    const input = shadow.getElementById("aip-prompt");
    setTimeout(() => input && input.focus(), 200);
  }
  updateLauncherVisibility();
}

function toggleOverlay() {
  if (!overlayHost) initFloatingUI();
  // Explicitly opening the chat overrides stealth mode (everywhere)
  if (stealthMode) {
    applyStealth(false);
    try { chrome.storage.local.set({ aip_stealth: false }); } catch (e) {}
  }
  togglePanel();
}

function getPanelHTML() {
  return `
    <div class="aip-sidebar" id="aip-sidebar">
      <div class="aip-sidebar-header">
        <span class="aip-sidebar-title">Chats</span>
        <button class="aip-hdr-btn" id="aip-sidebar-close" title="Close history">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <button class="aip-new-chat-btn" id="aip-new-chat">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        New chat
      </button>
      <div class="aip-session-list" id="aip-session-list"></div>
    </div>
    <div class="aip-sidebar-scrim" id="aip-sidebar-scrim"></div>

    <div class="aip-header">
      <div class="aip-header-left">
        <button class="aip-hdr-btn" id="aip-history" title="Chat history">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
        </button>
      </div>
      <div class="aip-header-actions">
        <button class="aip-hdr-btn" id="aip-proposals-btn" title="Manage winning proposals">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/></svg>
        </button>
        <button class="aip-hdr-btn" id="aip-theme-toggle" title="Toggle light/dark mode">
          <svg class="aip-icon-sun" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          <svg class="aip-icon-moon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        </button>
        <button class="aip-hdr-btn" id="aip-new-chat-top" title="New chat">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="aip-hdr-btn" id="aip-maximize" title="Maximize / restore">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2.5"/></svg>
        </button>
        <button class="aip-hdr-btn" id="aip-close" title="Close (Alt+Shift+O)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>

    <div class="aip-chat" id="aip-chat">
      <div class="aip-empty" id="aip-empty">
        <div class="aip-empty-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/></svg>
        </div>
        <div class="aip-empty-title">AI Assistant</div>
        <div class="aip-empty-desc">Ask anything, draft messages, brainstorm, debug code.</div>
      </div>
    </div>

    <div class="aip-input-area">
      <div class="aip-attachments" id="aip-attachments"></div>
      <div class="aip-input-row">
        <input type="file" id="aip-file-input" accept="image/*,.pdf,.txt,.md,.json,.csv,.log" multiple style="display:none">
        <textarea class="aip-prompt" id="aip-prompt" rows="3" placeholder="Paste client message here, then hit a button below..."></textarea>
        <div class="aip-input-controls">
          <div class="aip-input-left">
            <button class="aip-attach-btn" id="aip-attach" title="Attach file">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <select class="aip-model-select" id="aip-model-select" title="Model for proposals (chat & ClickUp use Claude/ChatGPT; Both = compare)" aria-label="n8n AI model">
              <option value="claude">Claude</option>
              <option value="chatgpt">ChatGPT</option>
              <option value="both">Both (compare)</option>
            </select>
          </div>
          <div class="aip-input-right">
            <button class="aip-hist-btn" id="aip-gen-history" title="Generate a reply grounded in your ClickUp task history">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l3 2.5"/></svg>
              <span>Generate from History</span>
            </button>
            <button class="aip-gen-btn" id="aip-gen-proposal" title="Generate an Upwork proposal from the job text">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
              <span>Generate Proposal</span>
            </button>
            <button class="aip-gen-btn aip-loom-btn" id="aip-gen-loom" title="Generate a Loom video script, examples to show, and a short proposal to send with the Loom link">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="1" y="6" rx="2" ry="2"/></svg>
              <span>Loom Proposal</span>
            </button>
            <button class="aip-send-btn" id="aip-send" title="Send">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <div class="aip-prop-modal" id="aip-prop-modal">
      <div class="aip-prop-box">
        <div class="aip-prop-head">
          <span class="aip-prop-title">Winning Proposals <span id="aip-prop-count">(0/10)</span></span>
          <button class="aip-hdr-btn" id="aip-prop-close" title="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="aip-prop-body">
          <div class="aip-prop-sidebar">
            <div class="aip-prop-list" id="aip-prop-list"></div>
            <button class="aip-prop-add" id="aip-prop-add">+ New</button>
          </div>
          <div class="aip-prop-editor" id="aip-prop-editor"></div>
        </div>
      </div>
    </div>
  `;
}

function setupPanelEvents() {
  shadow.getElementById("aip-close").addEventListener("click", closeToMicro);

  // History sidebar toggle
  shadow.getElementById("aip-history").addEventListener("click", openSidebar);
  shadow.getElementById("aip-sidebar-close").addEventListener("click", closeSidebar);
  shadow.getElementById("aip-sidebar-scrim").addEventListener("click", closeSidebar);

  // New chat
  shadow.getElementById("aip-new-chat").addEventListener("click", () => {
    // Reuse the existing empty active session if it has no messages
    const active = getActiveSession();
    if (active && active.messages.length === 0) {
      // Already on an empty chat, just close the sidebar
      closeSidebar();
      return;
    }
    createNewSession();
    saveSessions();
    rerenderActiveChat();
    renderSessionList();
    closeSidebar();
    const input = shadow.getElementById("aip-prompt");
    setTimeout(() => input && input.focus(), 100);
  });

  // Send
  shadow.getElementById("aip-send").addEventListener("click", overlaySendMessage);

  // "Generate from History" — one-shot send that grounds this single reply in the
  // user's ClickUp task history (passes useClickup:true for this message only).
  const histBtn = shadow.getElementById("aip-gen-history");
  if (histBtn) histBtn.addEventListener("click", () => overlaySendMessage({ useClickup: true }));

  // n8n model picker (Claude / ChatGPT) — shared by chat, ClickUp, and proposals.
  const modelSelect = shadow.getElementById("aip-model-select");
  if (modelSelect) {
    chrome.storage.sync.get(["proposalModel"], (r) => {
      if (r && r.proposalModel) modelSelect.value = r.proposalModel;
    });
    modelSelect.addEventListener("change", () => {
      chrome.storage.sync.set({ proposalModel: modelSelect.value });
    });
  }

  // Generate Proposal (n8n)
  shadow.getElementById("aip-gen-proposal").addEventListener("click", () => {
    overlayN8nProposal();
  });

  // Loom Proposal (n8n, mode:"loom") — script + examples to show + short proposal
  shadow.getElementById("aip-gen-loom").addEventListener("click", () => {
    overlayN8nProposal({ loom: true });
  });

  // Winning Proposals manager
  shadow.getElementById("aip-proposals-btn").addEventListener("click", openProposalsModal);
  shadow.getElementById("aip-prop-close").addEventListener("click", closeProposalsModal);
  shadow.getElementById("aip-prop-add").addEventListener("click", () => {
    if (overlayProposals.length >= OVERLAY_MAX_PROPOSALS) return;
    overlayProposals.push({ jobPost: "", proposal: "" });
    overlayPropActive = overlayProposals.length - 1;
    renderProposalsModal();
    const jobEl = shadow.getElementById("aip-prop-jobtype");
    if (jobEl) jobEl.focus();
  });

  // New chat (header + button, in the actions cluster) — reuse the sidebar handler
  const newChatTop = shadow.getElementById("aip-new-chat-top");
  if (newChatTop) newChatTop.addEventListener("click", () => {
    const sidebarNew = shadow.getElementById("aip-new-chat");
    if (sidebarNew) sidebarNew.click();
  });

  // Maximize / restore the panel size
  const maxBtn = shadow.getElementById("aip-maximize");
  if (maxBtn) maxBtn.addEventListener("click", () => {
    const p = shadow.getElementById("aip-panel");
    if (p) p.classList.toggle("maximized");
  });

  // Theme toggle
  shadow.getElementById("aip-theme-toggle").addEventListener("click", () => {
    applyTheme(currentTheme === "dark" ? "light" : "dark");
  });

  // Auto-resize prompt
  shadow.getElementById("aip-prompt").addEventListener("input", function() {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 150) + "px";
  });

  // Capture-phase handler: Enter to send, Escape to close, block host page from stealing keys
  shadow.getElementById("aip-panel").addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      // If the proposals modal is open, close just the modal first
      const propModal = shadow.getElementById("aip-prop-modal");
      if (propModal && propModal.classList.contains("open")) {
        closeProposalsModal();
      } else {
        togglePanel();
      }
    } else if (e.key === "Enter" && !e.shiftKey && e.target.id === "aip-prompt") {
      e.preventDefault();
      overlaySendMessage();
    }
    e.stopPropagation();
  }, true);
  shadow.getElementById("aip-panel").addEventListener("keyup", (e) => e.stopPropagation(), true);
  shadow.getElementById("aip-panel").addEventListener("keypress", (e) => e.stopPropagation(), true);

  // Attach file button
  shadow.getElementById("aip-attach").addEventListener("click", () => {
    shadow.getElementById("aip-file-input").click();
  });

  // File input change
  shadow.getElementById("aip-file-input").addEventListener("change", async (e) => {
    for (const file of e.target.files) {
      await addAttachment(file);
    }
    e.target.value = ""; // allow picking the same file again later
    renderAttachments();
  });
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const base64 = result.split(",")[1]; // strip "data:...;base64,"
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function generateThumbnail(base64, mediaType, maxDim = 240) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const ratio = Math.min(maxDim / img.width, maxDim / img.height, 1);
      const w = Math.max(1, Math.round(img.width * ratio));
      const h = Math.max(1, Math.round(img.height * ratio));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      try {
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      } catch (e) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = `data:${mediaType};base64,${base64}`;
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

async function addAttachment(file) {
  const MAX_SIZE = 10 * 1024 * 1024; // 10MB
  if (file.size > MAX_SIZE) {
    addOverlayMsg(`File "${file.name}" is too large (max 10MB).`, "error", { skipSave: true });
    return;
  }
  try {
    if (file.type.startsWith("image/")) {
      const data = await readFileAsBase64(file);
      const thumb = await generateThumbnail(data, file.type);
      pendingAttachments.push({ name: file.name, mediaType: file.type, data, thumb, kind: "image" });
    } else if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
      const data = await readFileAsBase64(file);
      pendingAttachments.push({ name: file.name, mediaType: "application/pdf", data, kind: "document" });
    } else {
      const textContent = await readFileAsText(file);
      pendingAttachments.push({ name: file.name, kind: "text", textContent });
    }
  } catch (err) {
    addOverlayMsg(`Could not read "${file.name}": ${err.message || err}`, "error", { skipSave: true });
  }
}

function renderAttachments() {
  const container = shadow.getElementById("aip-attachments");
  if (!container) return;
  container.innerHTML = "";
  pendingAttachments.forEach((att, idx) => {
    const chip = document.createElement("div");
    if (att.kind === "image") {
      chip.className = "aip-attachment-chip aip-chip-image-preview";
      const imgSrc = att.thumb
        ? `data:image/jpeg;base64,${att.thumb}`
        : `data:${att.mediaType};base64,${att.data}`;
      chip.innerHTML = `
        <img class="aip-chip-preview-img" src="${imgSrc}" alt="${escHTML(att.name)}">
        <button class="aip-chip-remove aip-chip-remove-overlay" title="Remove">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
        <span class="aip-chip-preview-name">${escHTML(att.name)}</span>
      `;
    } else {
      chip.className = "aip-attachment-chip";
      chip.innerHTML = `
        <span class="aip-chip-icon">${att.kind === "document" ? "📄" : "📎"}</span>
        <span class="aip-chip-name">${escHTML(att.name)}</span>
        <button class="aip-chip-remove" title="Remove">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      `;
    }
    chip.querySelector(".aip-chip-remove").addEventListener("click", () => {
      pendingAttachments.splice(idx, 1);
      renderAttachments();
    });
    container.appendChild(chip);
  });
}

async function overlaySendMessage(opts = {}) {
  if (overlayProcessing) return;
  // One-shot ClickUp grounding (from the "Generate from History" button).
  const useClickup = opts && opts.useClickup === true;

  const promptEl = shadow.getElementById("aip-prompt");
  const userMessage = promptEl.value.trim();

  if (!userMessage && pendingAttachments.length === 0) return;

  // Snapshot attachments for this send so we can clear pending immediately
  const attachments = pendingAttachments.slice();
  pendingAttachments = [];
  renderAttachments();

  // Build lightweight preview objects (small thumbnails survive saveSessions)
  const previews = attachments.map((a) => ({
    name: a.name,
    kind: a.kind,
    thumb: a.thumb || null
  }));

  addOverlayMsg(userMessage, "user", { attachments: previews, histIndex: chatHistory.length });
  promptEl.value = "";
  promptEl.style.height = "auto";

  const emptyState = shadow.getElementById("aip-empty");
  if (emptyState) emptyState.remove();

  const loadingEl = addOverlayLoading();
  overlayProcessing = true;
  shadow.getElementById("aip-send").disabled = true;

  try {
    // Build user content — string if no attachments, structured array otherwise
    let userContent;
    if (attachments.length === 0) {
      userContent = userMessage;
    } else {
      userContent = [];
      for (const att of attachments) {
        if (att.kind === "image") {
          userContent.push({ type: "image", source: { type: "base64", media_type: att.mediaType, data: att.data }});
        } else if (att.kind === "document") {
          userContent.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: att.data }});
        } else if (att.kind === "text") {
          userContent.push({ type: "text", text: `[File: ${att.name}]\n${att.textContent}` });
        }
      }
      if (userMessage) {
        userContent.push({ type: "text", text: userMessage });
      }
    }

    chatHistory.push({
      role: "user",
      content: userContent,
      // display-only metadata (preserved by saveSessions via spread, ignored by API)
      _displayText: userMessage,
      _attachments: previews
    });

    // For the API call, strip our private display fields so we don't leak them
    const apiMessages = chatHistory.map(({ role, content }) => ({ role, content }));

    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: "chat-api", messages: apiMessages, useClickup },
        (response) => {
          if (chrome.runtime.lastError) {
            chatHistory.pop();
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.success) {
            chatHistory.push({ role: "assistant", content: response.text });
            resolve(response.text);
          } else {
            chatHistory.pop();
            reject(new Error(response?.error || "Unknown error"));
          }
        }
      );
    });

    loadingEl.remove();
    addOverlayMsg(result, "ai");
    touchActiveSession();
    saveSessions();
    renderSessionList();
  } catch (error) {
    loadingEl.remove();
    addOverlayMsg("Error: " + error.message, "error", { skipSave: true });
    touchActiveSession();
    saveSessions();
    renderSessionList();
  } finally {
    overlayProcessing = false;
    shadow.getElementById("aip-send").disabled = false;
  }
}

function addOverlayMsg(text, type, opts = {}) {
  const chat = shadow.getElementById("aip-chat");
  const div = document.createElement("div");

  if (type === "user") {
    div.className = "aip-msg-user-wrap";
    const attachments = opts.attachments || [];
    const attHTML = attachments.map((a) => {
      if (a.kind === "image" && a.thumb) {
        return `<img class="aip-msg-preview-img" src="${a.thumb}" alt="${escHTML(a.name)}" title="${escHTML(a.name)}">`;
      }
      const icon = a.kind === "document" ? "📄" : "📎";
      return `<div class="aip-msg-preview-file">${icon} ${escHTML(a.name)}</div>`;
    }).join("");
    const previewsBlock = attHTML ? `<div class="aip-msg-previews">${attHTML}</div>` : "";
    const hasText = text && String(text).trim();
    const textBlock = hasText ? `<div class="aip-msg-text">${escHTML(text)}</div>` : "";
    div.innerHTML = `
      <div class="aip-msg aip-msg-user">
        <div class="aip-msg-label">You</div>${previewsBlock}${textBlock}
      </div>
      <div class="aip-user-actions">
        <button class="aip-uaction-btn aip-u-retry" title="Retry — send this again">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg>
        </button>
        <button class="aip-uaction-btn aip-u-edit" title="Edit — load back into the input box">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
        </button>
        <button class="aip-uaction-btn aip-u-copy" title="Copy">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
        </button>
      </div>
    `;

    // Use the full text (for proposals the bubble only shows a short preview)
    const fullText = (opts.fullText !== undefined && opts.fullText !== null) ? opts.fullText : text;
    const isProposal = opts.kind === "proposal";
    const isLoom = opts.loom === true;
    const setInput = (val) => {
      const input = shadow.getElementById("aip-prompt");
      input.value = val;
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 150) + "px";
      return input;
    };

    div.querySelector(".aip-u-copy").addEventListener("click", function() {
      navigator.clipboard.writeText(fullText).then(() => {
        const prev = this.innerHTML;
        this.classList.add("copied");
        this.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>';
        setTimeout(() => { this.innerHTML = prev; this.classList.remove("copied"); }, 1500);
      });
    });

    div.querySelector(".aip-u-edit").addEventListener("click", () => {
      enterEditMode(div, fullText, isProposal, opts.histIndex, isLoom);
    });

    div.querySelector(".aip-u-retry").addEventListener("click", () => {
      if (overlayProcessing) return;
      setInput(fullText);
      if (isProposal) {
        overlayN8nProposal(isLoom ? { loom: true } : {});
      } else {
        overlaySendMessage();
      }
    });
  } else if (type === "ai") {
    const hasProposal = /PROPOSAL:|Hook Options|Suggested Price|Red Flag|ADDITIONAL NOTES/i.test(text);
    div.className = "aip-msg aip-msg-ai";
    div.innerHTML = `
      <div class="aip-msg-label">AI</div>
      <div class="aip-msg-text aip-md">${renderMD(text)}</div>
      <div class="aip-msg-actions">
        ${hasProposal ? '<button class="aip-action-btn aip-copy-proposal-btn"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg> Copy Proposal</button>' : ''}
        <button class="aip-action-btn aip-copy-btn"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy All</button>
        <button class="aip-action-btn aip-retry-btn"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg> Retry</button>
      </div>
    `;
    if (hasProposal) {
      div.querySelector(".aip-copy-proposal-btn").addEventListener("click", function() {
        const proposalOnly = extractProposal(text);
        navigator.clipboard.writeText(proposalOnly).then(() => {
          this.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg> Copied!';
          this.classList.add("copied");
          setTimeout(() => {
            this.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg> Copy Proposal';
            this.classList.remove("copied");
          }, 2000);
        });
      });
    }
    div.querySelector(".aip-copy-btn").addEventListener("click", function() {
      navigator.clipboard.writeText(stripMD(text)).then(() => {
        this.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg> Copied!';
        this.classList.add("copied");
        setTimeout(() => {
          this.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy All';
          this.classList.remove("copied");
        }, 2000);
      });
    });
    div.querySelector(".aip-retry-btn").addEventListener("click", () => {
      if (chatHistory.length >= 2) {
        chatHistory.pop();
        const lastUser = chatHistory.pop();
        shadow.getElementById("aip-prompt").value = "";
        retryOverlayMsg(lastUser.content);
      }
    });
  } else {
    div.className = "aip-msg aip-msg-ai";
    div.innerHTML = `<div class="aip-msg-label aip-error-label">Error</div><div class="aip-msg-text">${escHTML(text)}</div>`;
  }

  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function addOverlayLoading() {
  const chat = shadow.getElementById("aip-chat");
  const div = document.createElement("div");
  div.className = "aip-loading";
  div.innerHTML = '<div class="aip-dot"></div><div class="aip-dot"></div><div class="aip-dot"></div>';
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

async function retryOverlayMsg(userMessage) {
  const loadingEl = addOverlayLoading();
  overlayProcessing = true;
  shadow.getElementById("aip-send").disabled = true;

  try {
    chatHistory.push({ role: "user", content: userMessage });
    const apiMessages = chatHistory.map(({ role, content }) => ({ role, content }));
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: "chat-api", messages: apiMessages },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.success) {
            chatHistory.push({ role: "assistant", content: response.text });
            resolve(response.text);
          } else {
            reject(new Error(response?.error || "Unknown error"));
          }
        }
      );
    });
    loadingEl.remove();
    addOverlayMsg(result, "ai");
    touchActiveSession();
    saveSessions();
    renderSessionList();
  } catch (error) {
    loadingEl.remove();
    addOverlayMsg("Error: " + error.message, "error", { skipSave: true });
  } finally {
    overlayProcessing = false;
    shadow.getElementById("aip-send").disabled = false;
  }
}

// ---- Inline edit of a sent message (Claude-style) ----
function enterEditMode(wrapDiv, fullText, isProposal, histIndex, isLoom) {
  if (overlayProcessing) return;

  // If we don't know the message's position, fall back to loading it into the input
  if (histIndex === undefined || histIndex === null) {
    const input = shadow.getElementById("aip-prompt");
    input.value = fullText;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 150) + "px";
    input.focus();
    return;
  }

  const bubble = wrapDiv.querySelector(".aip-msg-user");
  const actions = wrapDiv.querySelector(".aip-user-actions");
  if (!bubble) return;

  wrapDiv.classList.add("editing-wrap");
  if (actions) actions.style.display = "none";
  bubble.classList.add("editing");
  bubble.innerHTML = `
    <textarea class="aip-edit-ta"></textarea>
    <div class="aip-edit-note">Saving will regenerate the answer from this message.</div>
    <div class="aip-edit-actions">
      <button class="aip-edit-cancel">Cancel</button>
      <button class="aip-edit-save">Save</button>
    </div>
  `;
  const ta = bubble.querySelector(".aip-edit-ta");
  ta.value = fullText;
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
  ta.focus();
  // keep keystrokes inside the overlay; allow newlines with Enter
  ta.addEventListener("keydown", (e) => { e.stopPropagation(); });

  bubble.querySelector(".aip-edit-cancel").addEventListener("click", () => {
    rerenderActiveChat();
  });
  bubble.querySelector(".aip-edit-save").addEventListener("click", () => {
    const newText = ta.value.trim();
    if (!newText) return;
    saveEdit(histIndex, newText, isProposal, isLoom);
  });
}

function saveEdit(histIndex, newText, isProposal, isLoom) {
  if (overlayProcessing) return;
  // Drop the edited message and everything after it, then regenerate
  chatHistory.length = Math.max(0, histIndex);

  const input = shadow.getElementById("aip-prompt");
  input.value = newText;
  input.style.height = "auto";
  pendingAttachments = [];
  renderAttachments();
  rerenderActiveChat();

  if (isProposal) {
    overlayN8nProposal(isLoom ? { loom: true } : {});
  } else {
    overlaySendMessage();
  }
}

// ---- Winning Proposals manager (overlay) ----
function openProposalsModal() {
  // Always load the latest saved set so edits made in the popup show up here too
  chrome.storage.local.get(["winningProposals"], (result) => {
    overlayProposals = Array.isArray(result.winningProposals) ? result.winningProposals : [];
    overlayPropActive = overlayProposals.length ? 0 : -1;
    renderProposalsModal();
    shadow.getElementById("aip-prop-modal").classList.add("open");
  });
}

function closeProposalsModal() {
  shadow.getElementById("aip-prop-modal").classList.remove("open");
}

// Short label for a proposal in the sidebar list (first non-empty line of the
// job type, else a fallback).
function proposalTitle(p) {
  const line = (p.jobPost || "").split("\n").map(s => s.trim()).find(Boolean) || "";
  if (!line) return "Untitled proposal";
  return line.length > 34 ? line.slice(0, 34) + "…" : line;
}

function renderProposalsModal() {
  const list = shadow.getElementById("aip-prop-list");
  const editor = shadow.getElementById("aip-prop-editor");
  const count = shadow.getElementById("aip-prop-count");
  const addBtn = shadow.getElementById("aip-prop-add");
  if (!list || !editor) return;

  count.textContent = `(${overlayProposals.length}/${OVERLAY_MAX_PROPOSALS})`;
  if (addBtn) addBtn.disabled = overlayProposals.length >= OVERLAY_MAX_PROPOSALS;

  // Keep the active index in range.
  if (overlayPropActive >= overlayProposals.length) overlayPropActive = overlayProposals.length - 1;
  if (overlayProposals.length === 0) overlayPropActive = -1;

  // --- Sidebar list ---
  list.innerHTML = "";
  overlayProposals.forEach((p, i) => {
    const item = document.createElement("button");
    item.className = "aip-prop-item" + (i === overlayPropActive ? " active" : "");
    item.dataset.index = i;
    item.innerHTML = `<span class="aip-prop-item-title">${escHTML(proposalTitle(p))}</span>`;
    item.addEventListener("click", () => {
      overlayPropActive = i;
      renderProposalsModal();
    });
    list.appendChild(item);
  });

  // --- Editor pane ---
  if (overlayPropActive < 0) {
    editor.innerHTML = `
      <div class="aip-prop-editor-empty">
        <div class="aip-prop-empty-icon">📝</div>
        <p>No proposal selected.</p>
        <p class="aip-prop-hint">Click <strong>+ New</strong> to save a winning proposal. When you hit Generate Proposal, the AI picks the closest saved ones as style references. Saved on this device and shared with the popup.</p>
      </div>`;
    return;
  }

  const p = overlayProposals[overlayPropActive];
  editor.innerHTML = `
    <label class="aip-prop-flabel">Job Type</label>
    <input class="aip-prop-input" id="aip-prop-jobtype" placeholder="e.g. Shopify Store Creation" spellcheck="false">
    <label class="aip-prop-flabel">Winning Proposal</label>
    <textarea class="aip-prop-ta body" id="aip-prop-bodytext" placeholder="Paste the winning proposal you sent that won this job..."></textarea>
    <div class="aip-prop-editor-foot">
      <button class="aip-prop-save" id="aip-prop-save">Save</button>
      <button class="aip-prop-delete" id="aip-prop-delete" title="Delete this proposal">Delete</button>
      <span class="aip-prop-saved" id="aip-prop-saved">✓ Saved</span>
    </div>`;

  const jobEl = shadow.getElementById("aip-prop-jobtype");
  const bodyEl = shadow.getElementById("aip-prop-bodytext");
  // Set values via .value (not HTML) so no escaping / injection concerns.
  jobEl.value = p.jobPost || "";
  bodyEl.value = p.proposal || "";

  jobEl.addEventListener("input", () => {
    p.jobPost = jobEl.value;
    // Live-update this row's label in the sidebar without a full re-render.
    const titleEl = list.querySelector(`.aip-prop-item[data-index="${overlayPropActive}"] .aip-prop-item-title`);
    if (titleEl) titleEl.textContent = proposalTitle(p);
  });
  bodyEl.addEventListener("input", () => { p.proposal = bodyEl.value; });

  shadow.getElementById("aip-prop-save").addEventListener("click", saveProposalsFromModal);
  shadow.getElementById("aip-prop-delete").addEventListener("click", () => {
    overlayProposals.splice(overlayPropActive, 1);
    if (overlayPropActive >= overlayProposals.length) overlayPropActive = overlayProposals.length - 1;
    renderProposalsModal();
    saveProposalsFromModal(); // persist the deletion immediately
  });
}

function saveProposalsFromModal() {
  // Drop fully-empty entries, but keep the editor pointed at the same proposal.
  const activeRef = overlayProposals[overlayPropActive];
  const cleaned = overlayProposals.filter(p => (p.jobPost || "").trim() || (p.proposal || "").trim());
  overlayProposals = cleaned;
  overlayPropActive = activeRef ? cleaned.indexOf(activeRef) : (cleaned.length ? 0 : -1);

  chrome.storage.local.set({ winningProposals: cleaned }, () => {
    renderProposalsModal();
    const saved = shadow.getElementById("aip-prop-saved");
    if (saved) {
      saved.classList.add("show");
      setTimeout(() => saved.classList.remove("show"), 2000);
    }
  });
}

// ============================================================
// Proposal generation + side-by-side comparison (ChatGPT / Claude / Both)
// ------------------------------------------------------------
// A proposal lives in one chatHistory entry:
//   { role:"assistant", _kind:"proposal-compare", _job, _props:{chatgpt, claude} }
// _props[model] is null (not generated), a proposal string, or "__error__:msg".
// Loading is transient UI state passed to the painter, never stored — so cards
// survive reopen (saveSessions spreads the entry) and Retry / Generate-from
// still work because _job is persisted.
// ============================================================

const PROP_LABELS = { chatgpt: "ChatGPT", claude: "Claude" };

function isRealProposal(v) {
  return typeof v === "string" && v && !v.startsWith("__error__");
}

// The text handed to the chat model on a later follow-up (so it has context).
function proposalEntryText(entry) {
  const parts = [];
  ["chatgpt", "claude"].forEach((m) => {
    if (isRealProposal(entry._props[m])) parts.push(`${PROP_LABELS[m]} Proposal:\n${entry._props[m]}`);
  });
  return parts.join("\n\n---\n\n");
}

async function overlayN8nProposal(genOpts = {}) {
  if (overlayProcessing) return;
  const isLoom = genOpts.loom === true;

  const promptEl = shadow.getElementById("aip-prompt");
  const jobDescription = promptEl.value.trim();
  if (!jobDescription) {
    addOverlayMsg("Paste the job description in the input box first.", "error");
    return;
  }

  const jobClean = jobDescription.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  const userSummary = (isLoom ? "🎥 Loom Proposal\n" : "⚡ Generate Proposal\n") + jobClean;
  addOverlayMsg(userSummary, "user", { fullText: jobDescription, kind: "proposal", loom: isLoom, histIndex: chatHistory.length });
  chatHistory.push({ role: "user", content: userSummary, _displayText: userSummary, _fullText: jobDescription, _kind: "proposal", _loom: isLoom });
  promptEl.value = "";
  promptEl.style.height = "auto";

  const emptyState = shadow.getElementById("aip-empty");
  if (emptyState) emptyState.remove();

  const modelSelect = shadow.getElementById("aip-model-select");
  const sel = modelSelect ? modelSelect.value : "claude";
  const models = sel === "both" ? ["chatgpt", "claude"] : [sel === "chatgpt" ? "chatgpt" : "claude"];

  const entry = {
    role: "assistant",
    content: "",
    _kind: "proposal-compare",
    _loom: isLoom,
    _job: jobDescription,
    _props: { chatgpt: null, claude: null }
  };
  chatHistory.push(entry);

  const block = renderProposalCompare(entry);
  await runProposalGen(block, entry, models);
}

// Create the DOM block for a comparison entry and append it to the chat.
function renderProposalCompare(entry) {
  const chat = shadow.getElementById("aip-chat");
  const block = document.createElement("div");
  block.className = "aip-pc-block";
  chat.appendChild(block);
  paintProposalBlock(block, entry, {});
  chat.scrollTop = chat.scrollHeight;
  return block;
}

// Ask n8n (via background) for one model's proposal; store result or error.
function generateProposalFor(entry, model) {
  return chrome.storage.local.get(["winningProposals"]).then(({ winningProposals }) => {
    const savedProposals = Array.isArray(winningProposals) ? winningProposals : [];
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: "n8n-proposal", text: entry._job, winningProposals: savedProposals, model, loom: entry._loom === true },
        (response) => {
          if (chrome.runtime.lastError) {
            entry._props[model] = "__error__:" + chrome.runtime.lastError.message;
          } else if (response && response.success) {
            entry._props[model] = response.text;
          } else {
            entry._props[model] = "__error__:" + ((response && response.error) || "Unknown error");
          }
          resolve();
        }
      );
    });
  });
}

// Shared loading → generate → repaint → persist flow. Used by initial generate,
// Retry (same model), and Generate-from-other (the other model).
async function runProposalGen(block, entry, models) {
  overlayProcessing = true;
  const sendBtn = shadow.getElementById("aip-send");
  if (sendBtn) sendBtn.disabled = true;

  const loading = new Set(models);
  paintProposalBlock(block, entry, { loading });

  await Promise.allSettled(models.map(async (m) => {
    await generateProposalFor(entry, m);
    loading.delete(m);
    paintProposalBlock(block, entry, { loading, enter: m });
  }));

  entry.content = proposalEntryText(entry);
  touchActiveSession();
  saveSessions();
  renderSessionList();

  overlayProcessing = false;
  if (sendBtn) sendBtn.disabled = false;
}

// Build the 1- or 2-column card layout for an entry. `loading` (a Set of model
// names) and `enter` (a model to slide-in) are transient view state only.
function paintProposalBlock(block, entry, opts = {}) {
  const loading = opts.loading || new Set();
  const shown = ["chatgpt", "claude"].filter((m) => entry._props[m] !== null || loading.has(m));

  const row = document.createElement("div");
  row.className = "aip-pc-row" + (shown.length === 2 ? " two" : " one");

  shown.forEach((m) => {
    const other = m === "chatgpt" ? "claude" : "chatgpt";
    const val = entry._props[m];
    const card = document.createElement("div");
    card.className = "aip-pc-card";
    if (opts.enter === m) card.classList.add("aip-pc-enter");

    let bodyHTML = "";
    let toolbarHTML = "";
    if (loading.has(m)) {
      bodyHTML = `<div class="aip-pc-loading"><span class="aip-pc-dot"></span><span class="aip-pc-dot"></span><span class="aip-pc-dot"></span>Writing ${PROP_LABELS[m]} proposal…</div>`;
    } else if (typeof val === "string" && val.startsWith("__error__")) {
      bodyHTML = `<div class="aip-pc-error">⚠ Couldn't generate. ${escHTML(val.replace("__error__:", ""))}</div>`;
      toolbarHTML = `<button class="aip-pc-btn" data-act="retry" data-model="${m}">↻ Retry</button>`;
    } else {
      bodyHTML = `<div class="aip-pc-body">${renderMD(val)}</div>`;
      const genOther = (entry._props[other] === null && !loading.has(other))
        ? `<button class="aip-pc-btn aip-pc-gen" data-act="genother" data-model="${other}">✨ Generate from ${PROP_LABELS[other]}</button>`
        : "";
      const scriptBtn = entry._loom
        ? `<button class="aip-pc-btn" data-act="copyscript" data-model="${m}">🎬 Copy Script</button>`
        : "";
      toolbarHTML =
        `<button class="aip-pc-btn" data-act="copy" data-model="${m}">📋 Copy</button>` +
        scriptBtn +
        `<button class="aip-pc-btn" data-act="copyprop" data-model="${m}">📄 Copy Proposal</button>` +
        `<button class="aip-pc-btn" data-act="retry" data-model="${m}">↻ Retry</button>` +
        genOther;
    }

    card.innerHTML =
      `<div class="aip-pc-head">${PROP_LABELS[m]} ${entry._loom ? "Loom Package" : "Proposal"}</div>` +
      `<div class="aip-pc-toolbar">${toolbarHTML}</div>` +
      bodyHTML;
    row.appendChild(card);
  });

  block.innerHTML = "";
  block.appendChild(row);

  row.querySelectorAll(".aip-pc-btn").forEach((btn) => {
    btn.addEventListener("click", () => handleProposalAction(block, entry, btn.dataset.act, btn.dataset.model, btn));
  });
}

async function handleProposalAction(block, entry, act, model, btn) {
  if (act === "copy" || act === "copyprop" || act === "copyscript") {
    const val = entry._props[model];
    if (!isRealProposal(val)) return;
    const out = act === "copyprop" ? extractProposal(val)
      : act === "copyscript" ? extractLoomScript(val)
      : stripMD(val);
    try {
      await navigator.clipboard.writeText(out);
      const old = btn.innerHTML;
      btn.innerHTML = "✓ Copied";
      btn.classList.add("copied");
      setTimeout(() => { btn.innerHTML = old; btn.classList.remove("copied"); }, 1500);
    } catch (e) { /* clipboard blocked — ignore */ }
    return;
  }
  // retry (this model) or genother (the other model) — both just (re)generate `model`
  if (overlayProcessing) return;
  await runProposalGen(block, entry, [model]);
}

function escHTML(text) {
  const d = document.createElement("div");
  d.textContent = text;
  return d.innerHTML;
}

function stripMD(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '$1')
    .replace(/`([^`]+?)`/g, '$1')
    .replace(/^#{1,4}\s*/gm, '')
    .replace(/^---$/gm, '')
    .trim();
}

function extractProposal(text) {
  let proposal = text;

  const proposalMatch = text.search(/^PROPOSAL:?\s*$/mi);
  if (proposalMatch !== -1) {
    proposal = proposal.substring(proposalMatch).replace(/^PROPOSAL:?\s*/i, '').trim();
  } else {
    const evalEnd = text.search(/^---$/m);
    if (evalEnd !== -1) {
      proposal = proposal.substring(evalEnd + 3).trim();
    }
  }

  const cutPatterns = [
    /\nADDITIONAL NOTES:?\s*$/mi,
    /\nHook Options:?\s*$/mi,
    /\n\*?\*?Hook Options\*?\*?:?/i,
    /\n\*?\*?Opening Question Options\*?\*?:?/i,
    /\n\*?\*?Red Flags?\*?\*?:?/i,
    /\n\*?\*?Suggested Price/i,
    /\n\*?\*?Why (these|those) portfolio/i,
    /\n\*?\*?LOOM SCRIPT\*?\*?:?/i,
    /\n\*?\*?EXAMPLES TO SHOW\*?\*?:?/i,
  ];

  // Cut at the EARLIEST matching section header, not the first pattern that hits
  let cutAt = -1;
  for (const pattern of cutPatterns) {
    const match = proposal.search(pattern);
    if (match !== -1 && (cutAt === -1 || match < cutAt)) cutAt = match;
  }
  if (cutAt !== -1) proposal = proposal.substring(0, cutAt).trim();

  if (proposal.startsWith('---')) proposal = proposal.substring(3).trim();
  if (proposal.endsWith('---')) proposal = proposal.substring(0, proposal.length - 3).trim();

  return stripMD(proposal);
}

// Pull just the spoken script out of a Loom package response
// (LOOM SCRIPT: ... / EXAMPLES TO SHOW: ... / PROPOSAL: ...).
function extractLoomScript(text) {
  let script = text;

  const start = script.search(/^#{0,4}\s*\*{0,2}LOOM SCRIPT\*{0,2}:?\s*$/mi);
  if (start !== -1) {
    script = script.substring(start).replace(/^#{0,4}\s*\*{0,2}LOOM SCRIPT\*{0,2}:?\s*/i, '').trim();
  }

  const endPatterns = [
    /\n#{0,4}\s*\*{0,2}EXAMPLES TO SHOW\*{0,2}:?/i,
    /\n#{0,4}\s*\*{0,2}PROPOSAL\*{0,2}:?/i,
  ];
  let cutAt = -1;
  for (const pattern of endPatterns) {
    const match = script.search(pattern);
    if (match !== -1 && (cutAt === -1 || match < cutAt)) cutAt = match;
  }
  if (cutAt !== -1) script = script.substring(0, cutAt).trim();

  return stripMD(script);
}

function renderMD(text) {
  // Some AI outputs raw <a href="URL">label</a> tags. Convert them to markdown
  // link syntax BEFORE escaping, otherwise the escaped tag leaks out as visible
  // text (e.g. '...com/" target="_blank">label').
  text = text.replace(/<a\b[^>]*\bhref=["']?(https?:\/\/[^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  let html = escHTML(text);

  html = html.replace(/^### (.+)$/gm, '<h4 class="aip-md-h">$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3 class="aip-md-h">$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h3 class="aip-md-h">$1</h3>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
  html = html.replace(/`([^`]+?)`/g, '<code class="aip-md-code">$1</code>');
  html = html.replace(/^---$/gm, '<hr class="aip-md-hr">');
  html = html.replace(/^- \[x\] (.+)$/gm, '<div class="aip-md-check done">$1</div>');
  html = html.replace(/^- \[ \] (.+)$/gm, '<div class="aip-md-check">$1</div>');
  html = html.replace(/^- (.+)$/gm, '<div class="aip-md-li">$1</div>');
  html = html.replace(/^\d+\.[ ]?(.+)$/gm, '<div class="aip-md-li aip-md-ol">$1</div>');
  // Render markdown links first and tokenize them, so the bare-URL linkifier
  // below can't re-match the URL inside the href and double-wrap the anchor.
  const linkTokens = [];
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) => {
    linkTokens.push('<a class="aip-md-link" href="' + url + '" target="_blank" rel="noopener">' + label + '</a>');
    return " L" + (linkTokens.length - 1) + " ";
  });
  html = html.replace(/(https?:\/\/[^\s<"]+)/g, '<a class="aip-md-link" href="$1" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/ L(\d+) /g, (m, i) => linkTokens[Number(i)]);
  html = html.replace(/\n/g, '<br>');

  return html;
}

// ============================================================
// 4. Launcher is the micro edge-tab, fixed to the right edge (see CSS #aip-micro)
// ============================================================

// ============================================================
// 5. CSS for overlay (injected into Shadow DOM)
// ============================================================

function getOverlayCSS() {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }

    /* ========== CSS VARIABLES — light mode (default) ========== */
    #aip-panel {
      --bg:          #ffffff;
      --bg-raised:   #f7f7f9;
      --bg-sidebar:  #fafafa;
      --bg-header:   #ffffff;
      --bg-input:    #f7f7f9;
      --bg-hover:    #f0f0f3;
      --bg-user:     #eef0fe;
      --border:      #ececef;
      --border-med:  #dedee3;
      --text:        #1c1c22;
      --text-dim:    #55555f;
      --text-muted:  #9a9aa5;
      --accent:      #3b82f6;
      --accent-soft: rgba(59,130,246,0.08);
      --amber:       #d97706;
      --amber-soft:  rgba(217,119,6,0.10);
      --danger:      #ef4444;
      --success:     #22c55e;
    }

    /* ========== CSS VARIABLES — dark mode (opt-in via toggle) ========== */
    #aip-panel[data-theme="dark"] {
      --bg:          #1c1c1f;
      --bg-raised:   #26262b;
      --bg-sidebar:  #161618;
      --bg-header:   #1c1c1f;
      --bg-input:    #26262b;
      --bg-hover:    #2e2e34;
      --bg-user:     #2a2a30;
      --border:      #2b2b31;
      --border-med:  #3a3a42;
      --text:        #ececed;
      --text-dim:    #b8b8c0;
      --text-muted:  #7d7d87;
      --accent:      #3b82f6;
      --accent-soft: rgba(59,130,246,0.14);
      --amber:       #f59e0b;
      --amber-soft:  rgba(245,158,11,0.12);
      --danger:      #fb7185;
      --success:     #4ade80;
    }

    /* ---- Theme toggle icons ---- */
    #aip-panel .aip-icon-sun  { display: none; }
    #aip-panel .aip-icon-moon { display: block; }
    #aip-panel[data-theme="dark"] .aip-icon-sun  { display: block; }
    #aip-panel[data-theme="dark"] .aip-icon-moon { display: none; }

    /* ---- Micro launcher (tiny edge-tab, the only launcher) ---- */
    #aip-micro {
      position: fixed;
      right: 4px;
      top: 50%;
      transform: translateY(-50%);
      z-index: 2147483646;
      width: 16px;
      height: 16px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: #3b82f6;
      color: #fff;
      opacity: 0.35;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: none;
      transition: opacity 0.18s ease, transform 0.18s ease, box-shadow 0.18s ease;
      -webkit-appearance: none;
      appearance: none;
    }
    #aip-micro.hidden { opacity: 0; pointer-events: none; transform: translateY(-50%) scale(0.6); }
    #aip-micro:hover, #aip-micro:focus-visible {
      opacity: 1;
      outline: none;
      transform: translateY(-50%) scale(1.12);
      box-shadow: 0 0 14px rgba(59, 130, 246, 0.6);
    }
    #aip-micro .aip-micro-glyph { display: flex; }
    /* Optional pill that slides out on hover/focus */
    #aip-micro .aip-micro-label {
      position: absolute;
      right: 24px;
      top: 50%;
      transform: translateY(-50%) translateX(6px);
      background: #3b82f6;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 11px;
      border-radius: 9px;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      box-shadow: 0 2px 12px rgba(59, 130, 246, 0.4);
      transition: opacity 0.18s ease, transform 0.2s ease;
    }
    #aip-micro:hover .aip-micro-label, #aip-micro:focus-visible .aip-micro-label {
      opacity: 1;
      transform: translateY(-50%) translateX(0);
    }

    /* ---- Panel shell ---- */
    #aip-panel {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
      width: 90%;
      max-width: 860px;
      height: 90%;
      max-height: 700px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 10px 40px rgba(20,20,40,0.14), 0 2px 8px rgba(20,20,40,0.06);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      color: var(--text);
      transform: scale(0.85) translateY(16px);
      opacity: 0;
      pointer-events: none;
      transition: transform 0.25s cubic-bezier(0.16,1,0.3,1), opacity 0.2s, background 0.2s, color 0.2s;
      transform-origin: bottom right;
    }
    #aip-panel.open { transform: scale(1) translateY(0); opacity: 1; pointer-events: auto; }

    /* ---- Sidebar ---- */
    .aip-sidebar {
      position: absolute;
      top: 0; left: 0; bottom: 0;
      width: 256px;
      background: var(--bg-sidebar);
      border-right: 1px solid var(--border);
      z-index: 5;
      display: flex;
      flex-direction: column;
      transform: translateX(-100%);
      transition: transform 0.22s cubic-bezier(0.16,1,0.3,1);
      box-shadow: 4px 0 20px rgba(0,0,0,0.25);
    }
    .aip-sidebar.open { transform: translateX(0); }
    .aip-sidebar-scrim {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.3);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s;
      z-index: 4;
    }
    .aip-sidebar.open ~ .aip-sidebar-scrim { opacity: 1; pointer-events: auto; }
    .aip-sidebar-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .aip-sidebar-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.7px;
      color: var(--text-muted);
    }
    .aip-new-chat-btn {
      margin: 10px 12px;
      padding: 9px 12px;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: opacity 0.15s, transform 0.15s;
    }
    .aip-new-chat-btn:hover { opacity: 0.88; transform: translateY(-1px); }
    .aip-new-chat-btn:active { transform: translateY(0); }

    .aip-session-list {
      flex: 1;
      overflow-y: auto;
      padding: 4px 8px 12px;
    }
    .aip-session-list::-webkit-scrollbar { width: 3px; }
    .aip-session-list::-webkit-scrollbar-thumb { background: var(--border-med); border-radius: 3px; }

    .aip-session-empty {
      padding: 24px 12px;
      color: var(--text-muted);
      font-size: 12px;
      text-align: center;
    }
    .aip-session-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      margin: 2px 0;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.12s;
      color: var(--text-dim);
    }
    .aip-session-item:hover { background: var(--bg-hover); }
    .aip-session-item.active { background: var(--accent-soft); }
    .aip-session-meta { flex: 1; min-width: 0; }
    .aip-session-title {
      font-size: 13px;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.3;
    }
    .aip-session-time {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 2px;
    }
    /* ---- Header ---- */
    .aip-header {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 11px 14px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      background: var(--bg-header);
    }
    .aip-header-left { display: flex; align-items: center; gap: 8px; }
    /* Maximize / restore */
    #aip-panel.maximized {
      width: calc(100vw - 40px);
      max-width: none;
      height: calc(100vh - 40px);
      max-height: none;
    }
    .aip-header-actions { display: flex; gap: 2px; }
    .aip-hdr-btn {
      width: 30px; height: 30px;
      border: none;
      background: transparent;
      color: var(--text-muted);
      border-radius: 7px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s, color 0.15s;
    }
    .aip-hdr-btn:hover { background: var(--bg-hover); color: var(--text); }

    /* ---- Proposals modal ---- */
    .aip-prop-modal {
      position: absolute;
      inset: 0;
      z-index: 8;
      background: rgba(0,0,0,0.45);
      display: none;
      align-items: stretch;
      justify-content: center;
      padding: 0;
    }
    .aip-prop-modal.open { display: flex; }
    .aip-prop-box {
      width: 100%;
      background: var(--bg);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .aip-prop-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    .aip-prop-title { font-size: 14px; font-weight: 700; color: var(--text); }
    #aip-prop-count { color: var(--text-muted); font-weight: 600; font-size: 12px; }

    /* Two-pane body: proposal list (left) + editor (right) */
    .aip-prop-body { flex: 1; display: flex; min-height: 0; }
    .aip-prop-sidebar {
      width: 136px;
      flex-shrink: 0;
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .aip-prop-list { flex: 1; overflow-y: auto; padding: 8px; min-height: 0; }
    .aip-prop-list::-webkit-scrollbar { width: 4px; }
    .aip-prop-list::-webkit-scrollbar-thumb { background: var(--border-med); border-radius: 4px; }
    .aip-prop-item {
      display: block;
      width: 100%;
      text-align: left;
      background: transparent;
      border: none;
      border-radius: 8px;
      padding: 8px 10px;
      margin-bottom: 2px;
      color: var(--text-muted);
      font-family: inherit;
      font-size: 12.5px;
      cursor: pointer;
      transition: background 0.12s, color 0.12s;
    }
    .aip-prop-item:hover { background: var(--bg-hover); color: var(--text); }
    .aip-prop-item.active { background: var(--accent-soft); color: var(--text); font-weight: 600; }
    .aip-prop-item-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .aip-prop-add {
      margin: 8px;
      flex-shrink: 0;
      background: var(--amber-soft);
      border: 1px solid var(--amber);
      color: var(--amber);
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      font-family: inherit;
      padding: 8px;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .aip-prop-add:hover { opacity: 0.82; }
    .aip-prop-add:disabled { opacity: 0.4; cursor: not-allowed; }

    /* Editor pane */
    .aip-prop-editor {
      flex: 1;
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      padding: 14px 16px;
    }
    .aip-prop-editor-empty { margin: auto; text-align: center; color: var(--text-muted); max-width: 260px; }
    .aip-prop-empty-icon { font-size: 26px; margin-bottom: 6px; }
    .aip-prop-editor-empty p { margin: 0 0 6px; font-size: 13px; }
    .aip-prop-hint { font-size: 12px; color: var(--text-muted); line-height: 1.6; margin-top: 8px; }
    .aip-prop-flabel {
      display: block;
      font-size: 10px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin: 0 0 5px;
    }
    .aip-prop-input {
      width: 100%;
      padding: 9px 11px;
      margin-bottom: 14px;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 13px;
      font-family: inherit;
      outline: none;
    }
    .aip-prop-input:focus { border-color: var(--accent); }
    .aip-prop-ta {
      width: 100%;
      padding: 9px 11px;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-size: 13px;
      font-family: inherit;
      outline: none;
      resize: none;
      line-height: 1.55;
    }
    .aip-prop-ta:focus { border-color: var(--accent); }
    .aip-prop-ta.body { flex: 1; min-height: 120px; }
    .aip-prop-editor-foot {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 12px;
      flex-shrink: 0;
    }
    .aip-prop-save {
      flex: 1;
      padding: 10px;
      background: var(--accent);
      border: none;
      border-radius: 8px;
      color: #fff;
      font-size: 14px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .aip-prop-save:hover { opacity: 0.88; }
    .aip-prop-delete {
      padding: 10px 14px;
      background: transparent;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text-muted);
      font-size: 13px;
      font-family: inherit;
      cursor: pointer;
      transition: background 0.12s, color 0.12s, border-color 0.12s;
    }
    .aip-prop-delete:hover { background: rgba(251,113,133,0.12); color: var(--danger); border-color: var(--danger); }
    .aip-prop-saved { font-size: 13px; color: var(--success); font-weight: 600; opacity: 0; transition: opacity 0.2s; }
    .aip-prop-saved.show { opacity: 1; }

    /* ---- Chat area ---- */
    .aip-chat {
      flex: 1;
      overflow-y: auto;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .aip-chat::-webkit-scrollbar { width: 4px; }
    .aip-chat::-webkit-scrollbar-track { background: transparent; }
    .aip-chat::-webkit-scrollbar-thumb { background: var(--border-med); border-radius: 4px; }

    .aip-empty {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      text-align: center;
    }
    .aip-empty-icon { color: var(--text-muted); }
    .aip-empty-title { font-size: 14px; font-weight: 600; color: var(--text-muted); }
    .aip-empty-desc { font-size: 12px; color: var(--text-muted); line-height: 1.5; }

    /* ---- Messages ---- */
    .aip-msg {
      font-size: 14px;
      line-height: 1.6;
      max-width: 88%;
      word-wrap: break-word;
    }
    .aip-msg-user {
      padding: 10px 14px;
      border-radius: 18px;
      border-bottom-right-radius: 4px;
      background: var(--bg-user);
      align-self: flex-end;
      color: var(--text);
    }
    .aip-msg-ai {
      align-self: flex-start;
      padding: 4px 2px;
      background: transparent;
      border: none;
      color: var(--text);
      max-width: 96%;
    }
    .aip-msg-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 2px;
      color: var(--text-muted);
    }
    .aip-msg-ai .aip-msg-label { color: var(--accent); }
    .aip-error-label { color: var(--danger) !important; }
    .aip-msg-text { color: var(--text-dim); }

    /* ---- User message + actions (Retry / Edit / Copy) ---- */
    .aip-msg-user-wrap {
      align-self: flex-end;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      max-width: 88%;
      gap: 3px;
    }
    .aip-msg-user-wrap .aip-msg-user { max-width: 100%; }
    .aip-user-actions {
      display: flex;
      gap: 1px;
      padding-right: 2px;
      opacity: 0.55;
      transition: opacity 0.15s;
    }
    .aip-msg-user-wrap:hover .aip-user-actions { opacity: 1; }
    .aip-uaction-btn {
      width: 32px; height: 32px;
      background: rgba(128, 128, 128, 0.08);
      border: none;
      color: var(--text-muted);
      opacity: 0.5;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
      padding: 0;
      -webkit-appearance: none;
      appearance: none;
    }
    .aip-uaction-btn:hover {
      background: rgba(128, 128, 128, 0.2);
      color: var(--text);
      opacity: 1;
      transform: scale(1.1);
    }
    .aip-uaction-btn:active { transform: scale(0.92); }
    .aip-uaction-btn.copied { color: var(--success); opacity: 1; background: rgba(34, 197, 94, 0.15); }

    /* Inline edit mode */
    .aip-msg-user-wrap.editing-wrap { width: 100%; align-items: stretch; }
    .aip-msg-user.editing { max-width: 100%; padding: 10px; }
    .aip-edit-ta {
      width: 100%;
      background: var(--bg-input);
      border: 1px solid var(--accent);
      border-radius: 8px;
      color: var(--text);
      font-size: 14px;
      font-family: inherit;
      padding: 8px 10px;
      resize: none;
      outline: none;
      line-height: 1.5;
      min-height: 56px;
      max-height: 240px;
      overflow-y: auto;
    }
    .aip-edit-note { font-size: 11px; color: var(--text-muted); margin: 7px 2px 0; }
    .aip-edit-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
    .aip-edit-cancel, .aip-edit-save {
      border-radius: 7px;
      font-size: 12px;
      font-weight: 600;
      padding: 6px 16px;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s, opacity 0.15s;
    }
    .aip-edit-cancel { background: transparent; border: 1px solid var(--border-med); color: var(--text-dim); }
    .aip-edit-cancel:hover { background: var(--bg-hover); color: var(--text); }
    .aip-edit-save { background: var(--accent); border: 1px solid var(--accent); color: #fff; }
    .aip-edit-save:hover { opacity: 0.88; }

    .aip-msg-previews {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 6px;
    }
    .aip-msg-preview-img {
      max-width: 200px;
      max-height: 200px;
      border-radius: 10px;
      object-fit: cover;
      cursor: pointer;
      display: block;
      border: 1px solid var(--border);
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .aip-msg-preview-img:hover { transform: scale(1.02); box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
    .aip-msg-preview-file {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: var(--bg-raised);
      border: 1px solid var(--border);
      padding: 5px 12px;
      border-radius: 8px;
      font-size: 12px;
      color: var(--text-dim);
    }

    .aip-msg-actions {
      display: flex;
      gap: 6px;
      margin-top: 12px;
      padding-top: 2px;
    }
    .aip-action-btn {
      background: var(--bg-raised);
      border: 1px solid var(--border);
      border-radius: 7px;
      color: var(--text-muted);
      font-size: 12px;
      padding: 6px 12px;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.18s;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .aip-action-btn:hover { background: var(--bg-hover); border-color: var(--accent); color: var(--text); transform: translateY(-1px); }
    .aip-action-btn:active { transform: translateY(0); }
    .aip-action-btn.copied { background: rgba(74,222,128,0.1); border-color: var(--success); color: var(--success); }
    .aip-copy-proposal-btn {
      background: var(--amber-soft);
      border-color: var(--amber);
      color: var(--amber);
      font-weight: 600;
    }
    .aip-copy-proposal-btn:hover {
      background: rgba(245,158,11,0.2);
      border-color: var(--amber);
      color: var(--amber);
      box-shadow: 0 2px 10px rgba(245,158,11,0.15);
    }
    .aip-copy-proposal-btn.copied { background: rgba(74,222,128,0.1); border-color: var(--success); color: var(--success); }

    /* ---- Loading indicator ---- */
    .aip-loading {
      align-self: flex-start;
      display: flex;
      gap: 5px;
      padding: 12px 16px;
    }
    .aip-dot {
      width: 6px; height: 6px;
      background: var(--accent);
      border-radius: 50%;
      animation: aip-bounce 1.4s infinite;
    }
    .aip-dot:nth-child(2) { animation-delay: 0.2s; }
    .aip-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes aip-bounce {
      0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
      40% { transform: scale(1); opacity: 1; }
    }

    /* ---- Input area ---- */
    .aip-input-area {
      padding: 10px 12px 12px;
      border-top: 1px solid var(--border);
      flex-shrink: 0;
      background: var(--bg-header);
    }
    .aip-attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 8px;
    }
    .aip-attachments:empty { display: none; }

    /* File chip (non-image) */
    .aip-attachment-chip {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px 4px 10px;
      background: var(--bg-raised);
      border: 1px solid var(--border);
      border-radius: 14px;
      font-size: 12px;
      color: var(--text-dim);
      max-width: 220px;
    }
    .aip-attachment-chip .aip-chip-icon { font-size: 14px; line-height: 1; flex-shrink: 0; }
    .aip-attachment-chip .aip-chip-name {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .aip-attachment-chip .aip-chip-remove {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      padding: 2px;
      display: flex;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .aip-attachment-chip .aip-chip-remove:hover { background: rgba(251,113,133,0.15); color: var(--danger); }

    /* Image preview chip */
    .aip-chip-image-preview {
      position: relative;
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      border-radius: 10px;
      overflow: hidden;
      border: 1px solid var(--border);
      background: var(--bg-raised);
      width: 100px;
    }
    .aip-chip-preview-img {
      width: 100px;
      height: 80px;
      object-fit: cover;
      display: block;
    }
    .aip-chip-preview-name {
      font-size: 10px;
      color: var(--text-muted);
      padding: 2px 6px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      width: 100%;
      text-align: center;
    }
    .aip-chip-remove-overlay {
      position: absolute;
      top: 4px;
      right: 4px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: rgba(0,0,0,0.55);
      border: none;
      color: #fff;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }
    .aip-chip-remove-overlay:hover { background: rgba(220,38,38,0.75); }

    /* Unified input row */
    .aip-input-row {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 2px;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 6px 8px;
      transition: border-color 0.15s;
    }
    .aip-input-row:focus-within { border-color: var(--accent); }
    .aip-input-controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .aip-attach-btn {
      width: 36px; height: 36px;
      background: rgba(128, 128, 128, 0.12);
      border: none;
      border-radius: 50%;
      color: var(--text-muted);
      opacity: 0.55;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: all 0.2s ease;
      padding: 0;
      -webkit-appearance: none;
      appearance: none;
    }
    .aip-attach-btn:hover {
      background: rgba(128, 128, 128, 0.25);
      color: var(--text);
      opacity: 1;
      transform: scale(1.08);
    }
    .aip-attach-btn:active { transform: scale(0.92); }

    /* Attach + model-picker group (bottom-left of the input) */
    .aip-input-left { display: flex; align-items: center; gap: 6px; }
    .aip-model-select {
      height: 30px;
      padding: 0 6px;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text-dim);
      font-size: 12px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      outline: none;
      transition: border-color 0.15s, color 0.15s;
    }
    .aip-model-select:hover { border-color: var(--accent); color: var(--text); }
    .aip-model-select:focus { border-color: var(--accent); }

    /* ---- Proposal comparison cards (ChatGPT / Claude / Both) ---- */
    .aip-pc-block { padding: 4px 14px 14px; }
    .aip-pc-row { display: flex; gap: 10px; align-items: stretch; }
    .aip-pc-card {
      flex: 1 1 0;
      min-width: 0;
      background: var(--bg-raised);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
    }
    .aip-pc-head { font-size: 12px; font-weight: 700; color: var(--accent); margin-bottom: 8px; }
    .aip-pc-toolbar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
    .aip-pc-btn {
      background: var(--bg-input);
      border: 1px solid var(--border);
      color: var(--text-muted);
      border-radius: 7px;
      font-size: 11px;
      font-family: inherit;
      padding: 4px 9px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.12s, color 0.12s, border-color 0.12s;
    }
    .aip-pc-btn:hover { background: var(--bg-hover); color: var(--text); }
    .aip-pc-btn.copied { color: var(--success); border-color: var(--success); }
    .aip-pc-gen { color: var(--accent); border-color: var(--accent); }
    .aip-pc-gen:hover { background: var(--accent-soft); color: var(--accent); }
    .aip-pc-body { font-size: 13px; line-height: 1.55; color: var(--text); overflow-wrap: anywhere; }
    .aip-pc-loading { display: flex; align-items: center; gap: 6px; color: var(--text-muted); font-size: 12px; padding: 14px 0; }
    .aip-pc-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); display: inline-block; animation: aip-pc-blink 1.2s infinite; }
    .aip-pc-dot:nth-child(2) { animation-delay: 0.2s; }
    .aip-pc-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes aip-pc-blink { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }
    .aip-pc-error { color: var(--danger); font-size: 12px; padding: 8px 0; line-height: 1.5; }
    .aip-pc-enter { animation: aip-pc-enter 0.32s ease; }
    @keyframes aip-pc-enter { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: none; } }

    .aip-prompt {
      flex: 1;
      padding: 7px 8px;
      background: transparent;
      border: none;
      color: var(--text);
      font-size: 14px;
      font-family: inherit;
      resize: none;
      outline: none;
      min-height: 36px;
      max-height: 140px;
      overflow-y: auto;
      line-height: 1.5;
    }
    .aip-prompt::placeholder { color: var(--text-muted); }

    .aip-send-btn {
      width: 36px; height: 36px;
      background: var(--accent);
      border: none;
      border-radius: 50%;
      color: #fff;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: all 0.2s ease;
      padding: 0;
      -webkit-appearance: none;
      appearance: none;
    }
    .aip-send-btn:hover {
      opacity: 0.85;
      transform: scale(1.08);
    }
    .aip-send-btn:active { transform: scale(0.92); }
    .aip-send-btn:disabled { opacity: 0.35; cursor: not-allowed; }

    /* Right-side cluster: ClickUp toggle + send */
    .aip-input-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
    .aip-cu-toggle {
      display: flex;
      align-items: center;
      gap: 5px;
      height: 30px;
      padding: 0 11px;
      background: rgba(128, 128, 128, 0.12);
      border: 1px solid var(--border);
      border-radius: 16px;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.18s ease;
      -webkit-appearance: none;
      appearance: none;
    }
    .aip-cu-toggle:hover { color: var(--text); border-color: var(--accent); }
    .aip-cu-toggle:active { transform: scale(0.95); }
    .aip-cu-toggle.active {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    .aip-cu-toggle svg { flex-shrink: 0; }

    /* Generate Proposal pill (lives in the input's bottom-right) */
    .aip-gen-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 30px;
      padding: 0 13px;
      background: var(--accent-soft);
      border: 1px solid var(--accent);
      border-radius: 16px;
      color: var(--accent);
      font-size: 12px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.18s ease;
      -webkit-appearance: none;
      appearance: none;
    }
    .aip-gen-btn:hover { background: var(--accent); color: #fff; }
    .aip-gen-btn:active { transform: scale(0.97); }
    .aip-gen-btn svg { flex-shrink: 0; }

    /* Loom Proposal pill — Loom purple so it reads as a different action */
    .aip-loom-btn {
      background: rgba(98, 93, 245, 0.12);
      border-color: #625df5;
      color: #625df5;
    }
    .aip-loom-btn:hover { background: #625df5; color: #fff; }

    /* "Generate from History" pill (was the ClickUp toggle) */
    .aip-hist-btn {
      display: flex;
      align-items: center;
      gap: 5px;
      height: 30px;
      padding: 0 11px;
      background: rgba(128, 128, 128, 0.10);
      border: 1px solid var(--border);
      border-radius: 16px;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.18s ease;
      -webkit-appearance: none;
      appearance: none;
    }
    .aip-hist-btn:hover { color: var(--text); border-color: var(--accent); }
    .aip-hist-btn:active { transform: scale(0.97); }
    .aip-hist-btn svg { flex-shrink: 0; }

    /* ---- Quick actions ---- */
    .aip-quick {
      display: flex;
      gap: 6px;
      margin-top: 8px;
      flex-wrap: wrap;
    }
    .aip-qbtn {
      background: var(--bg-raised);
      border: 1px solid var(--border);
      border-radius: 20px;
      color: var(--text-muted);
      font-size: 12px;
      padding: 5px 14px;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.18s;
    }
    .aip-qbtn:hover { border-color: var(--accent); color: var(--text); transform: translateY(-1px); }
    .aip-qbtn:active { transform: translateY(0); }

    .aip-n8n-btn {
      background: var(--amber-soft);
      border-color: var(--amber);
      color: var(--amber);
      font-weight: 600;
    }
    .aip-n8n-btn:hover {
      background: rgba(245,158,11,0.2);
      border-color: var(--amber);
      color: var(--amber);
      box-shadow: 0 2px 10px rgba(245,158,11,0.15);
    }
    .aip-send-plain-btn {
      background: var(--accent-soft);
      border-color: var(--accent);
      color: var(--accent);
      font-weight: 600;
    }
    .aip-send-plain-btn:hover {
      background: rgba(59,130,246,0.2);
      border-color: var(--accent);
      color: var(--accent);
      box-shadow: 0 2px 10px rgba(59,130,246,0.15);
    }

    /* ---- Markdown ---- */
    .aip-md { white-space: normal; }
    .aip-md-h { font-size: 14px; font-weight: 700; color: var(--text); margin: 10px 0 5px; }
    .aip-md-code {
      background: var(--bg-raised);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 1px 5px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 12px;
      color: var(--amber);
    }
    .aip-md-hr { border: none; border-top: 1px solid var(--border); margin: 10px 0; }
    .aip-md-li { padding-left: 14px; position: relative; margin: 2px 0; }
    .aip-md-li::before { content: "•"; position: absolute; left: 2px; color: var(--accent); }
    .aip-md-ol::before { content: counter(ol-counter) "."; counter-increment: ol-counter; color: var(--accent); }
    .aip-md-check { padding-left: 20px; position: relative; margin: 2px 0; }
    .aip-md-check::before { content: "☐"; position: absolute; left: 2px; color: var(--text-muted); }
    .aip-md-check.done::before { content: "☑"; color: var(--success); }
    .aip-md-link { color: var(--accent); text-decoration: none; word-break: break-all; }
    .aip-md-link:hover { text-decoration: underline; }
    .aip-md strong { color: var(--text); font-weight: 600; }
    .aip-md em { color: var(--text-dim); font-style: italic; }
  `;
}

// ============================================================
// 6. Initialize on page load
// ============================================================

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initFloatingUI);
} else {
  initFloatingUI();
}
