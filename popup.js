// ============================================================
// AI Text Polisher - Popup Script (v2 with General AI Chat)
// ============================================================

let chatHistory = [];
let isProcessing = false;

// ---- Init ----
document.addEventListener("DOMContentLoaded", () => {
  // Load saved settings
  chrome.storage.sync.get(["apiKey", "customPrompt"], (result) => {
    if (result.apiKey) document.getElementById("apiKey").value = result.apiKey;
    if (result.customPrompt) document.getElementById("customPrompt").value = result.customPrompt;
  });

  // Tab switching
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
    });
  });

  // Save settings
  document.getElementById("saveBtn").addEventListener("click", saveSettings);

  // Send message
  document.getElementById("sendBtn").addEventListener("click", sendMessage);

  // Enter to send (Shift+Enter for newline)
  document.getElementById("promptInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Context toggle (📎 button)
  const contextToggle = document.getElementById("contextToggle");
  const contextBox = document.getElementById("contextBox");
  const contextInput = document.getElementById("contextInput");
  const clearBtn = document.getElementById("clearContext");

  contextToggle.addEventListener("click", () => {
    const isVisible = contextBox.style.display !== "none";
    if (isVisible) {
      contextBox.style.display = "none";
      contextToggle.classList.remove("active");
    } else {
      contextBox.style.display = "block";
      contextToggle.classList.add("active");
      contextInput.focus();
    }
  });

  clearBtn.addEventListener("click", () => {
    contextInput.value = "";
    contextBox.style.display = "none";
    contextToggle.classList.remove("active");
  });

  // Quick action buttons
  document.querySelectorAll(".quick-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.getElementById("promptInput").value = btn.dataset.prompt;
      sendMessage();
    });
  });

  // Auto-resize textareas
  document.querySelectorAll(".prompt-input, .context-input").forEach(el => {
    el.addEventListener("input", () => {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 80) + "px";
    });
  });
});

// ---- Save Settings ----
function saveSettings() {
  const apiKey = document.getElementById("apiKey").value.trim();
  const customPrompt = document.getElementById("customPrompt").value.trim();

  chrome.storage.sync.set({ apiKey, customPrompt }, () => {
    const status = document.getElementById("saveStatus");
    status.style.display = "block";
    setTimeout(() => { status.style.display = "none"; }, 2000);
  });
}

// ---- Send Message ----
async function sendMessage() {
  if (isProcessing) return;

  const promptInput = document.getElementById("promptInput");
  const contextInput = document.getElementById("contextInput");
  const prompt = promptInput.value.trim();
  const context = contextInput.value.trim();

  if (!prompt && !context) return;

  // Build the user message
  let userMessage = "";
  if (context && prompt) {
    userMessage = `Reference/context:\n"""\n${context}\n"""\n\n${prompt}`;
  } else if (context) {
    userMessage = `Reference/context:\n"""\n${context}\n"""\n\nHelp me with the above.`;
  } else {
    userMessage = prompt;
  }

  // Display what user typed
  const displayText = context && prompt
    ? `📎 ${context.substring(0, 80)}${context.length > 80 ? '...' : ''}\n\n${prompt}`
    : context
    ? `📎 ${context.substring(0, 120)}${context.length > 120 ? '...' : ''}`
    : prompt;

  addMessage(displayText, "user");
  promptInput.value = "";
  promptInput.style.height = "auto";

  // Hide empty state
  const emptyState = document.getElementById("emptyState");
  if (emptyState) emptyState.style.display = "none";

  // Show loading
  const loadingEl = addLoading();
  isProcessing = true;
  document.getElementById("sendBtn").disabled = true;

  try {
    const result = await callAPI(userMessage);
    loadingEl.remove();
    addMessage(result, "ai");
  } catch (error) {
    loadingEl.remove();
    addMessage(`Error: ${error.message}`, "error");
  } finally {
    isProcessing = false;
    document.getElementById("sendBtn").disabled = false;
  }
}

// ---- API Call ----
async function callAPI(userMessage) {
  return new Promise((resolve, reject) => {
    // Add to history for multi-turn
    chatHistory.push({ role: "user", content: userMessage });

    chrome.runtime.sendMessage(
      { action: "chat-api", messages: chatHistory },
      (response) => {
        if (chrome.runtime.lastError) {
          chatHistory.pop(); // Remove failed message
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
}

// ---- UI Helpers ----
function addMessage(text, type) {
  const chatArea = document.getElementById("chatArea");

  const msgDiv = document.createElement("div");

  if (type === "user") {
    msgDiv.className = "msg msg-user";
    msgDiv.innerHTML = `<div class="msg-label">You</div>${escapeHtml(text)}`;
  } else if (type === "ai") {
    msgDiv.className = "msg msg-ai";
    msgDiv.innerHTML = `
      <div class="msg-label">AI Response</div>
      ${escapeHtml(text)}
      <div class="msg-actions">
        <button class="msg-action-btn copy-btn">📋 Copy</button>
        <button class="msg-action-btn retry-btn">🔄 Retry</button>
      </div>
    `;

    // Copy button
    msgDiv.querySelector(".copy-btn").addEventListener("click", function() {
      navigator.clipboard.writeText(text).then(() => {
        this.textContent = "✓ Copied!";
        this.classList.add("copied");
        setTimeout(() => {
          this.textContent = "📋 Copy";
          this.classList.remove("copied");
        }, 2000);
      });
    });

    // Retry button
    msgDiv.querySelector(".retry-btn").addEventListener("click", () => {
      // Remove last AI response from history
      if (chatHistory.length >= 2) {
        chatHistory.pop(); // Remove assistant
        const lastUser = chatHistory.pop(); // Remove user
        // Re-send
        document.getElementById("promptInput").value = "";
        resendMessage(lastUser.content);
      }
    });
  } else {
    msgDiv.className = "msg msg-ai";
    msgDiv.innerHTML = `<div class="msg-label" style="color:#fb7185">Error</div>${escapeHtml(text)}`;
  }

  chatArea.appendChild(msgDiv);
  chatArea.scrollTop = chatArea.scrollHeight;
  return msgDiv;
}

function addLoading() {
  const chatArea = document.getElementById("chatArea");
  const loadingDiv = document.createElement("div");
  loadingDiv.className = "msg-loading";
  loadingDiv.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
  chatArea.appendChild(loadingDiv);
  chatArea.scrollTop = chatArea.scrollHeight;
  return loadingDiv;
}

async function resendMessage(userMessage) {
  const emptyState = document.getElementById("emptyState");
  if (emptyState) emptyState.style.display = "none";

  addMessage("🔄 Retrying...", "user");
  const loadingEl = addLoading();
  isProcessing = true;
  document.getElementById("sendBtn").disabled = true;

  try {
    chatHistory.push({ role: "user", content: userMessage });
    const result = await callAPI_direct(userMessage);
    loadingEl.remove();
    chatHistory.push({ role: "assistant", content: result });
    addMessage(result, "ai");
  } catch (error) {
    loadingEl.remove();
    addMessage(`Error: ${error.message}`, "error");
  } finally {
    isProcessing = false;
    document.getElementById("sendBtn").disabled = false;
  }
}

function callAPI_direct(userMessage) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: "chat-api", messages: chatHistory },
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
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
