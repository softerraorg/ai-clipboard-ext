// ============================================================
// AI Text Polisher - Content Script (v3 with Floating Chat)
// ============================================================

let isProcessing = false;

// ============================================================
// 1. Text Polishing (existing shortcut functionality)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "toggle-chat-overlay") {
    toggleOverlay();
  }

  if (message.action === "polish-selected") {
    const selectedText = window.getSelection().toString().trim();
    if (selectedText) {
      polishText(selectedText, message.mode);
    } else {
      const active = document.activeElement;
      if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT" || active.isContentEditable)) {
        const text = getTextFromElement(active);
        if (text) {
          polishText(text, message.mode);
        } else {
          showNotification("Select some text first", "warning");
        }
      } else {
        showNotification("Select some text first", "warning");
      }
    }
  }

  if (message.action === "polish") {
    polishText(message.text, message.mode);
  }
});

function getTextFromElement(el) {
  if (el.isContentEditable) {
    const selection = window.getSelection();
    if (selection.toString().trim()) return selection.toString().trim();
    return el.innerText.trim();
  }
  if (el.selectionStart !== el.selectionEnd) {
    return el.value.substring(el.selectionStart, el.selectionEnd);
  }
  return el.value.trim();
}

async function polishText(text, mode) {
  if (isProcessing) return;
  if (!text || text.length < 2) {
    showNotification("Select some text first", "warning");
    return;
  }

  isProcessing = true;
  showNotification("Polishing...", "loading");

  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: "call-api", text, mode },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response.success) {
            resolve(response.text);
          } else {
            reject(new Error(response.error));
          }
        }
      );
    });

    const replaced = tryReplaceText(response);

    try {
      await navigator.clipboard.writeText(response);
    } catch (clipErr) {
      // Clipboard access blocked by browser — not critical
    }

    if (replaced) {
      showNotification("Text replaced!", "success");
    } else {
      showNotification("Copied! Press Ctrl+V to paste", "success");
    }
  } catch (error) {
    console.error("AI Polisher error:", error);
    const errMsg = error?.message || String(error);
    if (errMsg.includes("API key")) {
      showNotification("Set your API key — click extension icon", "error");
    } else {
      showNotification("Error: " + errMsg.substring(0, 50), "error");
    }
  } finally {
    isProcessing = false;
  }
}

function tryReplaceText(newText) {
  const active = document.activeElement;
  if (!active) return false;

  if (active.isContentEditable || active.closest('[contenteditable="true"]')) {
    const editableEl = active.isContentEditable ? active : active.closest('[contenteditable="true"]');
    const selection = window.getSelection();

    if (selection.rangeCount > 0 && selection.toString().trim()) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(newText));
      selection.collapseToEnd();
      editableEl.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    return false;
  }

  if (active.tagName === "TEXTAREA" || active.tagName === "INPUT") {
    const start = active.selectionStart;
    const end = active.selectionEnd;

    if (start !== end) {
      active.value = active.value.substring(0, start) + newText + active.value.substring(end);
      active.selectionStart = start;
      active.selectionEnd = start + newText.length;
    } else {
      active.value = newText;
    }

    active.dispatchEvent(new Event("input", { bubbles: true }));
    active.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  return false;
}

// ============================================================
// 2. Notification Toast
// ============================================================

function showNotification(message, type = "info") {
  const existing = document.getElementById("ai-polisher-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "ai-polisher-toast";
  toast.className = `ai-polisher-toast ai-polisher-${type}`;

  const icons = {
    loading: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`,
    success: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg>`,
    error: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>`,
    warning: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01"/></svg>`
  };

  toast.innerHTML = `
    <span class="ai-polisher-icon${type === 'loading' ? ' ai-polisher-spin' : ''}">${icons[type] || ''}</span>
    <span class="ai-polisher-message">${message}</span>
  `;

  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("ai-polisher-visible"));

  if (type !== "loading") {
    setTimeout(() => {
      toast.classList.remove("ai-polisher-visible");
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }
}

// ============================================================
// 3. Floating Action Button + Chat Overlay
// ============================================================

let overlayHost = null;
let shadow = null;
let overlayProcessing = false;
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
let currentTheme = "dark";

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
      <button class="aip-session-del" title="Delete chat">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
      </button>
    `;
    item.addEventListener("click", (e) => {
      if (e.target.closest(".aip-session-del")) return;
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
    item.querySelector(".aip-session-del").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSession(s.id);
      saveSessions();
      rerenderActiveChat();
      renderSessionList();
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
  for (const msg of chatHistory) {
    if (msg.role === "user") {
      const text = msg._displayText !== undefined
        ? msg._displayText
        : renderMsgContent(msg.content);
      addOverlayMsg(text, "user", { skipSave: true, attachments: msg._attachments || [] });
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

function setupCrossTabSync() {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
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
  try { chrome.storage.local.set({ aip_theme: theme }); } catch(e) {}
}

function loadTheme() {
  try {
    chrome.storage.local.get("aip_theme", (r) => {
      if (r && r.aip_theme) applyTheme(r.aip_theme);
    });
  } catch(e) {}
}

async function initFloatingUI() {
  if (overlayHost) return;

  overlayHost = document.createElement("div");
  overlayHost.id = "ai-polisher-overlay-host";
  shadow = overlayHost.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = getOverlayCSS();
  shadow.appendChild(style);

  // FAB button - minimal pill style like WhisperFlow
  const fab = document.createElement("button");
  fab.id = "aip-fab";
  fab.innerHTML = `
    <span class="aip-fab-dot"></span>
    <svg class="aip-fab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
  `;
  fab.title = "AI Chat (Alt+Shift+O)";
  fab.addEventListener("click", () => togglePanel());
  shadow.appendChild(fab);

  // Chat panel
  const panel = document.createElement("div");
  panel.id = "aip-panel";
  panel.innerHTML = getPanelHTML();
  shadow.appendChild(panel);

  document.body.appendChild(overlayHost);

  setupPanelEvents();
  makeFabDraggable(fab);

  await loadSessionsFromStorage();
  rerenderActiveChat();
  renderSessionList();
  setupCrossTabSync();
  loadTheme();
}

function togglePanel() {
  const panel = shadow.getElementById("aip-panel");
  const fab = shadow.getElementById("aip-fab");
  const isOpen = panel.classList.contains("open");

  if (isOpen) {
    panel.classList.remove("open");
    fab.classList.remove("hidden");
  } else {
    panel.classList.add("open");
    fab.classList.add("hidden");
    const input = shadow.getElementById("aip-prompt");
    setTimeout(() => input && input.focus(), 200);
  }
}

function toggleOverlay() {
  if (!overlayHost) initFloatingUI();
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
        <div class="aip-logo">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
        </div>
        <span class="aip-title">Softerra Proposal Bot</span>
      </div>
      <div class="aip-header-actions">
        <button class="aip-hdr-btn" id="aip-theme-toggle" title="Toggle light/dark mode">
          <svg class="aip-icon-sun" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          <svg class="aip-icon-moon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        </button>
        <button class="aip-hdr-btn" id="aip-clear-chat" title="Clear current chat">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
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
        <button class="aip-attach-btn" id="aip-attach" title="Attach file">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <input type="file" id="aip-file-input" accept="image/*,.pdf,.txt,.md,.json,.csv,.log" multiple style="display:none">
        <textarea class="aip-prompt" id="aip-prompt" rows="3" placeholder="Paste client message here, then hit a button below..."></textarea>
        <button class="aip-send-btn" id="aip-send">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
      <div class="aip-quick" id="aip-quick">
        <button class="aip-qbtn aip-n8n-btn" id="aip-gen-proposal">⚡ Generate Proposal</button>
        <button class="aip-qbtn aip-send-plain-btn" id="aip-send-plain">Send</button>
      </div>
    </div>
  `;
}

function setupPanelEvents() {
  shadow.getElementById("aip-close").addEventListener("click", togglePanel);

  // Clear current chat = empty active session's messages, keep session in list
  shadow.getElementById("aip-clear-chat").addEventListener("click", () => {
    const active = getActiveSession();
    if (!active) return;
    active.messages.length = 0;
    active.title = "New chat";
    active.updatedAt = Date.now();
    chatHistory = active.messages;
    saveSessions();
    rerenderActiveChat();
    renderSessionList();
  });

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

  // Generate Proposal (n8n)
  shadow.getElementById("aip-gen-proposal").addEventListener("click", () => {
    overlayN8nProposal();
  });

  // Send plain — same as arrow send button
  shadow.getElementById("aip-send-plain").addEventListener("click", overlaySendMessage);

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
      togglePanel();
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

async function overlaySendMessage() {
  if (overlayProcessing) return;

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

  addOverlayMsg(userMessage, "user", { attachments: previews });
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
        { action: "chat-api", messages: apiMessages },
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
    div.className = "aip-msg aip-msg-user";
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
    div.innerHTML = `<div class="aip-msg-label">You</div>${previewsBlock}${textBlock}`;
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

async function overlayN8nProposal() {
  if (overlayProcessing) return;

  const promptEl = shadow.getElementById("aip-prompt");
  const jobDescription = promptEl.value.trim();

  if (!jobDescription) {
    addOverlayMsg("Paste the job description in the input box first.", "error");
    return;
  }

  const userSummary = "⚡ Generate Proposal\n" + jobDescription.substring(0, 100) + (jobDescription.length > 100 ? "..." : "");
  addOverlayMsg(userSummary, "user");
  chatHistory.push({ role: "user", content: userSummary });
  promptEl.value = "";
  promptEl.style.height = "auto";

  const emptyState = shadow.getElementById("aip-empty");
  if (emptyState) emptyState.remove();

  const loadingEl = addOverlayLoading();
  overlayProcessing = true;
  shadow.getElementById("aip-send").disabled = true;

  try {
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: "n8n-proposal", text: jobDescription },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.success) {
            resolve(response.text);
          } else {
            reject(new Error(response?.error || "Unknown error"));
          }
        }
      );
    });
    loadingEl.remove();
    addOverlayMsg(result, "ai");
    chatHistory.push({ role: "assistant", content: result });
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
    /\n\*?\*?Red Flags?\*?\*?:?/i,
    /\n\*?\*?Suggested Price/i,
    /\n\*?\*?Why (these|those) portfolio/i,
  ];

  for (const pattern of cutPatterns) {
    const match = proposal.search(pattern);
    if (match !== -1) {
      proposal = proposal.substring(0, match).trim();
      break;
    }
  }

  if (proposal.startsWith('---')) proposal = proposal.substring(3).trim();
  if (proposal.endsWith('---')) proposal = proposal.substring(0, proposal.length - 3).trim();

  return stripMD(proposal);
}

function renderMD(text) {
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
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a class="aip-md-link" href="$2" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/(https?:\/\/[^\s<"]+)/g, '<a class="aip-md-link" href="$1" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/\n/g, '<br>');

  return html;
}

// ============================================================
// 4. Draggable FAB
// ============================================================

function makeFabDraggable(fab) {
  let isDragging = false;
  let wasDragged = false;
  let startX, startY, startLeft, startTop;

  fab.addEventListener("mousedown", (e) => {
    isDragging = true;
    wasDragged = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = fab.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    fab.style.transition = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) wasDragged = true;
    const rect = fab.getBoundingClientRect();
    const newLeft = Math.max(0, Math.min(window.innerWidth - rect.width, startLeft + dx));
    const newTop = Math.max(0, Math.min(window.innerHeight - rect.height, startTop + dy));
    fab.style.right = "auto";
    fab.style.bottom = "auto";
    fab.style.left = newLeft + "px";
    fab.style.top = newTop + "px";
  });

  document.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    fab.style.transition = "";
    if (wasDragged) {
      fab.addEventListener("click", preventClick, { once: true, capture: true });
    }
  });

  function preventClick(e) {
    e.stopImmediatePropagation();
    e.preventDefault();
  }
}

// ============================================================
// 5. CSS for overlay (injected into Shadow DOM)
// ============================================================

function getOverlayCSS() {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }

    /* ========== CSS VARIABLES — dark mode (default) ========== */
    #aip-panel {
      --bg:          #212121;
      --bg-raised:   #2f2f2f;
      --bg-sidebar:  #171717;
      --bg-header:   #212121;
      --bg-input:    #2f2f2f;
      --bg-hover:    #3a3a3a;
      --bg-user:     #303030;
      --border:      #3a3a3a;
      --border-med:  #4a4a4a;
      --text:        #ececec;
      --text-dim:    #c4c4c4;
      --text-muted:  #888;
      --accent:      #7c83ff;
      --accent-soft: rgba(124,131,255,0.12);
      --amber:       #f59e0b;
      --amber-soft:  rgba(245,158,11,0.12);
      --danger:      #fb7185;
      --success:     #4ade80;
    }

    /* ========== CSS VARIABLES — light mode ========== */
    #aip-panel[data-theme="light"] {
      --bg:          #ffffff;
      --bg-raised:   #f5f5f5;
      --bg-sidebar:  #efefef;
      --bg-header:   #ffffff;
      --bg-input:    #f0f0f0;
      --bg-hover:    #e4e4e4;
      --bg-user:     #e8e8fc;
      --border:      #e0e0e0;
      --border-med:  #cccccc;
      --text:        #1a1a1a;
      --text-dim:    #444444;
      --text-muted:  #888888;
      --accent:      #5a5fcf;
      --accent-soft: rgba(90,95,207,0.1);
      --amber:       #b45309;
      --amber-soft:  rgba(180,83,9,0.1);
      --danger:      #dc2626;
      --success:     #16a34a;
    }

    /* ---- Theme toggle icons ---- */
    #aip-panel .aip-icon-sun  { display: block; }
    #aip-panel .aip-icon-moon { display: none; }
    #aip-panel[data-theme="light"] .aip-icon-sun  { display: none; }
    #aip-panel[data-theme="light"] .aip-icon-moon { display: block; }

    /* ---- FAB ---- */
    #aip-fab {
      position: fixed;
      bottom: 28px;
      right: 28px;
      z-index: 2147483646;
      height: 38px;
      min-width: 38px;
      padding: 0 12px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(20,20,28,0.55);
      backdrop-filter: blur(14px) saturate(160%);
      -webkit-backdrop-filter: blur(14px) saturate(160%);
      color: rgba(255,255,255,0.85);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      box-shadow: 0 4px 18px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.06);
      transition: background 0.18s, border-color 0.18s, transform 0.18s, opacity 0.18s;
      user-select: none;
    }
    #aip-fab .aip-fab-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: #7c83ff;
      box-shadow: 0 0 8px rgba(124,131,255,0.7);
      flex-shrink: 0;
    }
    #aip-fab .aip-fab-icon { opacity: 0.85; flex-shrink: 0; }
    #aip-fab:hover { background: rgba(28,28,40,0.75); border-color: rgba(255,255,255,0.22); transform: translateY(-1px); }
    #aip-fab:active { transform: translateY(0); }
    #aip-fab.hidden { opacity: 0; pointer-events: none; transform: scale(0.85); }

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
      border-radius: 14px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 16px 56px rgba(0,0,0,0.45), 0 4px 16px rgba(0,0,0,0.25);
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
    .aip-session-del {
      width: 24px; height: 24px;
      background: transparent;
      border: none;
      border-radius: 6px;
      color: var(--text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 0.12s, background 0.12s, color 0.12s;
      flex-shrink: 0;
    }
    .aip-session-item:hover .aip-session-del { opacity: 1; }
    .aip-session-del:hover { background: rgba(251,113,133,0.15); color: var(--danger); }

    /* ---- Header ---- */
    .aip-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 11px 14px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      background: var(--bg-header);
    }
    .aip-header-left { display: flex; align-items: center; gap: 8px; }
    .aip-logo {
      width: 26px; height: 26px;
      background: var(--accent);
      border-radius: 7px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
    }
    .aip-title { font-size: 13px; font-weight: 700; color: var(--text); }
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

    /* ---- Chat area ---- */
    .aip-chat {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
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
      border: 1px solid var(--border);
      align-self: flex-end;
      color: var(--text);
      white-space: pre-wrap;
    }
    .aip-msg-ai {
      align-self: flex-start;
      padding: 4px 2px;
      background: transparent;
      border: none;
      color: var(--text);
      white-space: pre-wrap;
      max-width: 96%;
    }
    .aip-msg-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 5px;
      color: var(--text-muted);
    }
    .aip-msg-ai .aip-msg-label { color: var(--accent); }
    .aip-error-label { color: var(--danger) !important; }
    .aip-msg-text { color: var(--text-dim); }

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
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid var(--border);
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
      align-items: flex-end;
      gap: 0;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 4px 6px 4px 4px;
      transition: border-color 0.15s;
    }
    .aip-input-row:focus-within { border-color: var(--accent); }

    .aip-attach-btn {
      width: 34px; height: 34px;
      background: transparent;
      border: none;
      border-radius: 8px;
      color: var(--text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: background 0.15s, color 0.15s;
    }
    .aip-attach-btn:hover { background: var(--bg-hover); color: var(--text); }

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
      width: 34px; height: 34px;
      background: var(--accent);
      border: none;
      border-radius: 8px;
      color: #fff;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: opacity 0.15s;
    }
    .aip-send-btn:hover { opacity: 0.85; }
    .aip-send-btn:disabled { opacity: 0.35; cursor: not-allowed; }

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
      background: rgba(124,131,255,0.2);
      border-color: var(--accent);
      color: var(--accent);
      box-shadow: 0 2px 10px rgba(124,131,255,0.15);
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
