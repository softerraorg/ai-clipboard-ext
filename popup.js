// ============================================================
// AI Text Polisher - Popup Script (v2 with General AI Chat)
// ============================================================

let chatHistory = [];
let isProcessing = false;

// ---- Init ----
document.addEventListener("DOMContentLoaded", () => {
  // Load saved settings
  chrome.storage.sync.get(["apiKey", "customPrompt", "n8nWebhookUrl"], (result) => {
    if (result.apiKey) document.getElementById("apiKey").value = result.apiKey;
    if (result.customPrompt) document.getElementById("customPrompt").value = result.customPrompt;
    if (result.n8nWebhookUrl) document.getElementById("n8nWebhookUrl").value = result.n8nWebhookUrl;
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

  // Generate Proposal button (n8n)
  document.getElementById("generateProposal").addEventListener("click", () => {
    sendN8nProposal();
  });

  // Quick action buttons — prepend instruction to whatever's in the input
  document.querySelectorAll(".quick-btn:not(.n8n-btn)").forEach(btn => {
    btn.addEventListener("click", () => {
      const promptEl = document.getElementById("promptInput");
      const content = promptEl.value.trim();
      if (content) {
        promptEl.value = btn.dataset.prompt + "\n\n" + content;
      } else {
        promptEl.value = btn.dataset.prompt;
      }
      sendMessage();
    });
  });

  // Auto-resize textarea
  document.querySelector(".prompt-input").addEventListener("input", function() {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 120) + "px";
  });
});

// ---- Save Settings ----
function saveSettings() {
  const apiKey = document.getElementById("apiKey").value.trim();
  const customPrompt = document.getElementById("customPrompt").value.trim();
  const n8nWebhookUrl = document.getElementById("n8nWebhookUrl").value.trim();

  chrome.storage.sync.set({ apiKey, customPrompt, n8nWebhookUrl }, () => {
    const status = document.getElementById("saveStatus");
    status.style.display = "block";
    setTimeout(() => { status.style.display = "none"; }, 2000);
  });
}

// ---- Send Message ----
async function sendMessage() {
  if (isProcessing) return;

  const promptInput = document.getElementById("promptInput");
  const userMessage = promptInput.value.trim();

  if (!userMessage) return;

  addMessage(userMessage, "user");
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
    const hasProposal = /PROPOSAL:|Hook Options|Suggested Price|Red Flag|ADDITIONAL NOTES/i.test(text);
    msgDiv.className = "msg msg-ai";
    msgDiv.innerHTML = `
      <div class="msg-label">AI Response</div>
      <div class="md-content">${renderMarkdown(text)}</div>
      <div class="msg-actions">
        ${hasProposal ? '<button class="msg-action-btn copy-proposal-btn"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg> Copy Proposal</button>' : ''}
        <button class="msg-action-btn copy-btn"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy All</button>
        <button class="msg-action-btn retry-btn"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></svg> Retry</button>
      </div>
    `;

    if (hasProposal) {
      msgDiv.querySelector(".copy-proposal-btn").addEventListener("click", function() {
        const proposalOnly = extractProposalText(text);
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

    msgDiv.querySelector(".copy-btn").addEventListener("click", function() {
      navigator.clipboard.writeText(stripMarkdownChars(text)).then(() => {
        this.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg> Copied!';
        this.classList.add("copied");
        setTimeout(() => {
          this.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy All';
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

// ---- n8n Proposal Bot ----
async function sendN8nProposal() {
  if (isProcessing) return;

  const promptInput = document.getElementById("promptInput");
  const jobDescription = promptInput.value.trim();

  if (!jobDescription) {
    addMessage("Paste the job description in the input box first.", "error");
    return;
  }

  addMessage("⚡ Generate Proposal\n" + jobDescription.substring(0, 100) + (jobDescription.length > 100 ? "..." : ""), "user");
  promptInput.value = "";
  promptInput.style.height = "auto";

  const emptyState = document.getElementById("emptyState");
  if (emptyState) emptyState.style.display = "none";

  const loadingEl = addLoading();
  isProcessing = true;
  document.getElementById("sendBtn").disabled = true;

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
    addMessage(result, "ai");
  } catch (error) {
    loadingEl.remove();
    addMessage("Error: " + error.message, "error");
  } finally {
    isProcessing = false;
    document.getElementById("sendBtn").disabled = false;
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function stripMarkdownChars(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '$1')
    .replace(/`([^`]+?)`/g, '$1')
    .replace(/^#{1,4}\s*/gm, '')
    .replace(/^---$/gm, '')
    .trim();
}

function extractProposalText(text) {
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

  return stripMarkdownChars(proposal);
}

function renderMarkdown(text) {
  let html = escapeHtml(text);

  html = html.replace(/^### (.+)$/gm, '<h4 class="md-h">$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3 class="md-h">$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h3 class="md-h">$1</h3>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
  html = html.replace(/`([^`]+?)`/g, '<code class="md-code">$1</code>');
  html = html.replace(/^---$/gm, '<hr class="md-hr">');
  html = html.replace(/^- \[x\] (.+)$/gm, '<div class="md-check done">$1</div>');
  html = html.replace(/^- \[ \] (.+)$/gm, '<div class="md-check">$1</div>');
  html = html.replace(/^- (.+)$/gm, '<div class="md-li">$1</div>');
  html = html.replace(/^\d+\.[ ]?(.+)$/gm, '<div class="md-li md-ol">$1</div>');
  html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a class="md-link" href="$1" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/\n/g, '<br>');

  return html;
}
