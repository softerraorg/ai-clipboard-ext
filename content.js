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
let chatHistory = [];
let overlayProcessing = false;

function initFloatingUI() {
  if (overlayHost) return;

  overlayHost = document.createElement("div");
  overlayHost.id = "ai-polisher-overlay-host";
  shadow = overlayHost.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = getOverlayCSS();
  shadow.appendChild(style);

  // FAB button
  const fab = document.createElement("button");
  fab.id = "aip-fab";
  fab.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>`;
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
    <div class="aip-header">
      <div class="aip-header-left">
        <div class="aip-logo">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
        </div>
        <span class="aip-title">Softerra Proposal Bot</span>
      </div>
      <div class="aip-header-actions">
        <button class="aip-hdr-btn" id="aip-clear-chat" title="Clear chat">
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
      <div class="aip-ctx-box" id="aip-ctx-box">
        <textarea class="aip-ctx-input" id="aip-ctx-input" rows="2" placeholder="Paste reference text (client message, code, error...)"></textarea>
        <button class="aip-ctx-close" id="aip-ctx-close">&times;</button>
      </div>
      <div class="aip-input-row">
        <button class="aip-icon-btn" id="aip-ctx-toggle" title="Attach context">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <textarea class="aip-prompt" id="aip-prompt" rows="1" placeholder="Ask anything..."></textarea>
        <button class="aip-send-btn" id="aip-send">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
      <div class="aip-quick" id="aip-quick">
        <button class="aip-qbtn aip-n8n-btn" id="aip-gen-proposal">⚡ Generate Proposal</button>
        <button class="aip-qbtn" data-p="Write a professional reply to the context above">Reply pro</button>
      </div>
    </div>
  `;
}

function setupPanelEvents() {
  shadow.getElementById("aip-close").addEventListener("click", togglePanel);

  shadow.getElementById("aip-clear-chat").addEventListener("click", () => {
    chatHistory = [];
    const chat = shadow.getElementById("aip-chat");
    chat.innerHTML = "";
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
  });

  // Context toggle
  const ctxBox = shadow.getElementById("aip-ctx-box");
  const ctxToggle = shadow.getElementById("aip-ctx-toggle");
  const ctxInput = shadow.getElementById("aip-ctx-input");
  const ctxClose = shadow.getElementById("aip-ctx-close");

  ctxToggle.addEventListener("click", () => {
    const isVisible = ctxBox.classList.contains("visible");
    if (isVisible) {
      ctxBox.classList.remove("visible");
      ctxToggle.classList.remove("active");
    } else {
      ctxBox.classList.add("visible");
      ctxToggle.classList.add("active");
      ctxInput.focus();
    }
  });

  ctxClose.addEventListener("click", () => {
    ctxInput.value = "";
    ctxBox.classList.remove("visible");
    ctxToggle.classList.remove("active");
  });

  // Send
  shadow.getElementById("aip-send").addEventListener("click", overlaySendMessage);

  // Generate Proposal (n8n)
  shadow.getElementById("aip-gen-proposal").addEventListener("click", () => {
    overlayN8nProposal();
  });

  // Quick actions
  shadow.querySelectorAll(".aip-qbtn:not(.aip-n8n-btn)").forEach(btn => {
    btn.addEventListener("click", () => {
      shadow.getElementById("aip-prompt").value = btn.dataset.p;
      overlaySendMessage();
    });
  });

  // Auto-resize prompt
  shadow.getElementById("aip-prompt").addEventListener("input", function() {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 100) + "px";
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
}

async function overlaySendMessage() {
  if (overlayProcessing) return;

  const promptEl = shadow.getElementById("aip-prompt");
  const ctxEl = shadow.getElementById("aip-ctx-input");
  const prompt = promptEl.value.trim();
  const context = ctxEl.value.trim();

  if (!prompt && !context) return;

  let userMessage = "";
  if (context && prompt) {
    userMessage = `Reference/context:\n"""\n${context}\n"""\n\n${prompt}`;
  } else if (context) {
    userMessage = `Reference/context:\n"""\n${context}\n"""\n\nHelp me with the above.`;
  } else {
    userMessage = prompt;
  }

  const displayText = context && prompt
    ? `[context attached]\n${prompt}`
    : context ? `[context attached]` : prompt;

  addOverlayMsg(displayText, "user");
  promptEl.value = "";
  promptEl.style.height = "auto";

  const emptyState = shadow.getElementById("aip-empty");
  if (emptyState) emptyState.remove();

  const loadingEl = addOverlayLoading();
  overlayProcessing = true;
  shadow.getElementById("aip-send").disabled = true;

  try {
    chatHistory.push({ role: "user", content: userMessage });

    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: "chat-api", messages: chatHistory },
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
  } catch (error) {
    loadingEl.remove();
    addOverlayMsg("Error: " + error.message, "error");
  } finally {
    overlayProcessing = false;
    shadow.getElementById("aip-send").disabled = false;
  }
}

function addOverlayMsg(text, type) {
  const chat = shadow.getElementById("aip-chat");
  const div = document.createElement("div");

  if (type === "user") {
    div.className = "aip-msg aip-msg-user";
    div.innerHTML = `<div class="aip-msg-label">You</div><div class="aip-msg-text">${escHTML(text)}</div>`;
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
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: "chat-api", messages: chatHistory },
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
  } catch (error) {
    loadingEl.remove();
    addOverlayMsg("Error: " + error.message, "error");
  } finally {
    overlayProcessing = false;
    shadow.getElementById("aip-send").disabled = false;
  }
}

async function overlayN8nProposal() {
  if (overlayProcessing) return;

  const promptEl = shadow.getElementById("aip-prompt");
  const ctxEl = shadow.getElementById("aip-ctx-input");
  const jobDescription = ctxEl.value.trim() || promptEl.value.trim();

  if (!jobDescription) {
    addOverlayMsg("Paste the job description first — use the paperclip button or type it in the input.", "error");
    return;
  }

  addOverlayMsg("⚡ Generate Proposal\n" + jobDescription.substring(0, 100) + (jobDescription.length > 100 ? "..." : ""), "user");
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
  } catch (error) {
    loadingEl.remove();
    addOverlayMsg("Error: " + error.message, "error");
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
  html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a class="aip-md-link" href="$1" target="_blank" rel="noopener">$1</a>');
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
    const newLeft = Math.max(0, Math.min(window.innerWidth - 56, startLeft + dx));
    const newTop = Math.max(0, Math.min(window.innerHeight - 56, startTop + dy));
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

    /* ---- FAB ---- */
    #aip-fab {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483646;
      width: 75px;
      height: 75px;
      border-radius: 50%;
      border: none;
      background: linear-gradient(135deg, #7c83ff, #6a5aff);
      color: #fff;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 20px rgba(108, 99, 255, 0.4), 0 2px 8px rgba(0,0,0,0.3);
      transition: transform 0.2s, box-shadow 0.2s, opacity 0.2s;
    }
    #aip-fab:hover {
      transform: scale(1.1);
      box-shadow: 0 6px 28px rgba(108, 99, 255, 0.5), 0 3px 12px rgba(0,0,0,0.3);
    }
    #aip-fab.hidden {
      opacity: 0;
      pointer-events: none;
      transform: scale(0.5);
    }

    /* ---- Panel ---- */
    #aip-panel {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
      width: 90%;
      max-width: 900px;
      height: 90%;
      max-height: 700px;
      background: #0c0c18;
      border: 1px solid #1f1f3a;
      border-radius: 16px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 12px 48px rgba(0,0,0,0.5), 0 4px 16px rgba(0,0,0,0.3);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      color: #e2e2ef;
      transform: scale(0.8) translateY(20px);
      opacity: 0;
      pointer-events: none;
      transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s;
      transform-origin: bottom right;
    }
    #aip-panel.open {
      transform: scale(1) translateY(0);
      opacity: 1;
      pointer-events: auto;
    }

    /* ---- Header ---- */
    .aip-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px;
      border-bottom: 1px solid #1f1f3a;
      flex-shrink: 0;
      background: #0e0e1c;
    }
    .aip-header-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .aip-logo {
      width: 28px; height: 28px;
      background: linear-gradient(135deg, #7c83ff, #b44aff);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
    }
    .aip-title {
      font-size: 14px;
      font-weight: 700;
      color: #fff;
    }
    .aip-header-actions {
      display: flex;
      gap: 4px;
    }
    .aip-hdr-btn {
      width: 30px; height: 30px;
      border: none;
      background: transparent;
      color: #666;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
    }
    .aip-hdr-btn:hover { background: #1a1a2e; color: #ccc; }

    /* ---- Chat area ---- */
    .aip-chat {
      flex: 1;
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .aip-chat::-webkit-scrollbar { width: 4px; }
    .aip-chat::-webkit-scrollbar-track { background: transparent; }
    .aip-chat::-webkit-scrollbar-thumb { background: #2a2a4a; border-radius: 4px; }

    .aip-empty {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      color: #444;
      text-align: center;
    }
    .aip-empty-icon { color: #555; }
    .aip-empty-title { font-size: 14px; font-weight: 600; color: #777; }
    .aip-empty-desc { font-size: 12px; color: #555; line-height: 1.5; }

    /* ---- Messages ---- */
    .aip-msg {
      padding: 10px 13px;
      border-radius: 12px;
      font-size: 18px;
      line-height: 1.55;
      max-width: 90%;
      word-wrap: break-word;
      white-space: pre-wrap;
    }
    .aip-msg-user {
      background: #1e1e3a;
      border: 1px solid #2a2a50;
      align-self: flex-end;
      border-bottom-right-radius: 4px;
    }
    .aip-msg-ai {
      background: #12122a;
      border: 1px solid #1f1f3a;
      align-self: flex-start;
      border-bottom-left-radius: 4px;
    }
    .aip-msg-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
      color: #555;
    }
    .aip-msg-ai .aip-msg-label { color: #7c83ff; }
    .aip-error-label { color: #fb7185 !important; }
    .aip-msg-text { color: #ddd; }

    .aip-msg-actions {
      display: flex;
      gap: 8px;
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid #1f1f3a;
    }
    .aip-action-btn {
      background: #14142a;
      border: 1px solid #2a2a4a;
      border-radius: 8px;
      color: #999;
      font-size: 12px;
      padding: 7px 14px;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .aip-action-btn:hover { background: #1e1e3a; border-color: #7c83ff; color: #fff; transform: translateY(-1px); }
    .aip-action-btn:active { transform: translateY(0); }
    .aip-action-btn.copied { background: #0d3320; border-color: #166534; color: #4ade80; }
    .aip-copy-proposal-btn {
      background: linear-gradient(135deg, #2a1a00, #1a1a2e);
      border-color: #f59e0b;
      color: #f59e0b;
      font-weight: 600;
    }
    .aip-copy-proposal-btn:hover {
      background: linear-gradient(135deg, #3a2500, #2a2a4a);
      border-color: #fbbf24;
      color: #fbbf24;
      box-shadow: 0 2px 12px rgba(245, 158, 11, 0.15);
    }
    .aip-copy-proposal-btn.copied { background: #0d3320; border-color: #166534; color: #4ade80; }

    /* ---- Loading ---- */
    .aip-loading {
      background: #12122a;
      border: 1px solid #1f1f3a;
      align-self: flex-start;
      border-radius: 12px;
      display: flex;
      gap: 6px;
      padding: 13px 18px;
    }
    .aip-dot {
      width: 7px; height: 7px;
      background: #7c83ff;
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
      padding: 10px 12px;
      border-top: 1px solid #1f1f3a;
      flex-shrink: 0;
      background: #0e0e1c;
    }

    .aip-ctx-box {
      position: relative;
      margin-bottom: 8px;
      display: none;
    }
    .aip-ctx-box.visible { display: block; }

    .aip-ctx-input {
      width: 100%;
      padding: 8px 28px 8px 10px;
      background: #14142a;
      border: 1px solid #2a2a4a;
      border-radius: 8px;
      color: #ccc;
      font-size: 12px;
      font-family: inherit;
      resize: none;
      outline: none;
      max-height: 70px;
      overflow-y: auto;
      transition: border-color 0.15s;
    }
    .aip-ctx-input:focus { border-color: #7c83ff; }
    .aip-ctx-input::placeholder { color: #444; }

    .aip-ctx-close {
      position: absolute;
      top: 5px; right: 7px;
      background: none;
      border: none;
      color: #555;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
    }
    .aip-ctx-close:hover { color: #fb7185; }

    .aip-input-row {
      display: flex;
      gap: 7px;
      align-items: flex-end;
    }

    .aip-icon-btn {
      width: 38px; height: 38px;
      background: #14142a;
      border: 1px solid #2a2a4a;
      border-radius: 10px;
      color: #888;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: all 0.15s;
    }
    .aip-icon-btn:hover { border-color: #7c83ff; color: #fff; }
    .aip-icon-btn.active { border-color: #7c83ff; background: #1a1a3a; color: #7c83ff; }

    .aip-prompt {
      flex: 1;
      padding: 9px 12px;
      background: #1a1a2e;
      border: 1px solid #2a2a4a;
      border-radius: 10px;
      color: #fff;
      font-size: 13px;
      font-family: inherit;
      resize: none;
      outline: none;
      min-height: 38px;
      max-height: 100px;
      transition: border-color 0.15s;
    }
    .aip-prompt:focus { border-color: #7c83ff; }
    .aip-prompt::placeholder { color: #555; }

    .aip-send-btn {
      width: 38px; height: 38px;
      background: linear-gradient(135deg, #7c83ff, #6a5aff);
      border: none;
      border-radius: 10px;
      color: #fff;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: opacity 0.15s;
    }
    .aip-send-btn:hover { opacity: 0.85; }
    .aip-send-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    .aip-quick {
      display: flex;
      gap: 5px;
      margin-top: 8px;
      flex-wrap: wrap;
    }
    .aip-qbtn {
      background: #14142a;
      border: 1px solid #1f1f3a;
      border-radius: 20px;
      color: #888;
      font-size: 16px;
      padding: 3px 10px;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.15s;
    }
    .aip-qbtn:hover { border-color: #7c83ff; color: #ccc; }
    .aip-n8n-btn { background: #1a1a3a; border-color: #f59e0b; color: #f59e0b; font-weight: 600; }
    .aip-n8n-btn:hover { background: #2a2a4a; border-color: #fbbf24; color: #fbbf24; }

    /* Markdown rendering */
    .aip-md { white-space: normal; }
    .aip-md-h { font-size: 14px; font-weight: 700; color: #fff; margin: 10px 0 6px; }
    .aip-md h4.aip-md-h { font-size: 13px; }
    .aip-md-code { background: #1a1a3a; border: 1px solid #2a2a4a; border-radius: 4px; padding: 1px 5px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; color: #f59e0b; }
    .aip-md-hr { border: none; border-top: 1px solid #2a2a4a; margin: 10px 0; }
    .aip-md-li { padding-left: 14px; position: relative; margin: 2px 0; }
    .aip-md-li::before { content: "•"; position: absolute; left: 2px; color: #7c83ff; }
    .aip-md-ol::before { content: counter(ol-counter) "."; counter-increment: ol-counter; color: #7c83ff; }
    .aip-md-check { padding-left: 20px; position: relative; margin: 2px 0; }
    .aip-md-check::before { content: "☐"; position: absolute; left: 2px; color: #666; }
    .aip-md-check.done::before { content: "☑"; color: #4ade80; }
    .aip-md-link { color: #7c83ff; text-decoration: none; word-break: break-all; }
    .aip-md-link:hover { text-decoration: underline; color: #9da3ff; }
    .aip-md strong { color: #fff; }
    .aip-md em { color: #ccc; font-style: italic; }
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
