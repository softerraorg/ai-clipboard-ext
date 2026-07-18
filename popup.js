// ============================================================
// AI Text Polisher - Popup Script
// ------------------------------------------------------------
// The popup is now just two things: the Winning Proposals manager (reference
// examples for the n8n proposal bot) and Settings. All chat + proposal
// generation happens in the in-page floating overlay (content.js).
// ============================================================

let proposals = []; // [{ jobPost, proposal }] — max 10, saved in chrome.storage.local
const MAX_PROPOSALS = 10;

// ---- Init ----
document.addEventListener("DOMContentLoaded", () => {
  // Load saved settings
  chrome.storage.sync.get(["customPrompt", "n8nWebhookUrl", "proposalModel"], (result) => {
    if (result.customPrompt) document.getElementById("customPrompt").value = result.customPrompt;
    if (result.n8nWebhookUrl) document.getElementById("n8nWebhookUrl").value = result.n8nWebhookUrl;
    if (result.proposalModel) document.getElementById("proposalModel").value = result.proposalModel;
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

  // ---- Winning Proposals manager ----
  chrome.storage.local.get(["winningProposals"], (result) => {
    proposals = Array.isArray(result.winningProposals) ? result.winningProposals : [];
    renderProposals();
  });

  document.getElementById("addProposalBtn").addEventListener("click", () => {
    if (proposals.length >= MAX_PROPOSALS) return;
    proposals.push({ jobPost: "", proposal: "" });
    renderProposals();
  });

  document.getElementById("saveProposalsBtn").addEventListener("click", saveProposals);
});

// ---- Save Settings ----
function saveSettings() {
  const customPrompt = document.getElementById("customPrompt").value.trim();
  const n8nWebhookUrl = document.getElementById("n8nWebhookUrl").value.trim();
  const proposalModel = document.getElementById("proposalModel").value;

  chrome.storage.sync.set({ customPrompt, n8nWebhookUrl, proposalModel }, () => {
    const status = document.getElementById("saveStatus");
    status.style.display = "block";
    setTimeout(() => { status.style.display = "none"; }, 2000);
  });
}

// ---- Winning Proposals: render, edit, delete ----
function renderProposals() {
  const list = document.getElementById("proposalsList");
  const empty = document.getElementById("proposalsEmpty");
  const count = document.getElementById("propCount");
  const addBtn = document.getElementById("addProposalBtn");

  count.textContent = `(${proposals.length}/${MAX_PROPOSALS})`;
  addBtn.disabled = proposals.length >= MAX_PROPOSALS;
  empty.style.display = proposals.length === 0 ? "block" : "none";

  list.innerHTML = "";
  proposals.forEach((p, i) => {
    const card = document.createElement("div");
    card.className = "prop-card";
    card.innerHTML = `
      <div class="prop-card-head">
        <span class="prop-card-num">Proposal ${i + 1}</span>
        <button class="prop-del-btn" data-index="${i}">✕ Remove</button>
      </div>
      <label class="prop-field-label">Job Post / Job Type</label>
      <textarea class="prop-textarea job" data-index="${i}" data-field="jobPost" placeholder="Paste the job post or describe the job type (e.g. Shopify theme customization, speed optimization)...">${escapeHtml(p.jobPost || "")}</textarea>
      <label class="prop-field-label">Winning Proposal</label>
      <textarea class="prop-textarea body" data-index="${i}" data-field="proposal" placeholder="Paste the proposal you sent that won this job...">${escapeHtml(p.proposal || "")}</textarea>
    `;
    list.appendChild(card);
  });

  // Keep in-memory state in sync as the user types
  list.querySelectorAll(".prop-textarea").forEach(ta => {
    ta.addEventListener("input", () => {
      const idx = Number(ta.dataset.index);
      const field = ta.dataset.field;
      if (proposals[idx]) proposals[idx][field] = ta.value;
    });
  });

  list.querySelectorAll(".prop-del-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.index);
      proposals.splice(idx, 1);
      renderProposals();
    });
  });
}

function saveProposals() {
  // Drop fully-empty entries before saving
  const cleaned = proposals.filter(p => (p.jobPost || "").trim() || (p.proposal || "").trim());
  proposals = cleaned;

  chrome.storage.local.set({ winningProposals: cleaned }, () => {
    renderProposals();
    const status = document.getElementById("proposalsSaveStatus");
    status.style.display = "block";
    setTimeout(() => { status.style.display = "none"; }, 2000);
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
