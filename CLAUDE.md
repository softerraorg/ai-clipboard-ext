# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome Manifest V3 extension ("AI Text Polisher") that does two things on any webpage:

1. **Text polishing** — select text and rewrite it via keyboard shortcut or right-click context menu (auto-polish / formal / casual / expand / shorten).
2. **Floating AI chat** — an in-page chat overlay plus a toolbar popup, both backed by an external n8n workflow, with multimodal attachments, multi-session history, ClickUp grounding, and an Upwork-proposal generator.

There is **no build system, bundler, framework, or test suite**. Everything is plain vanilla JS/HTML/CSS loaded directly by Chrome.

## Running & "building"

- **Load/reload**: `chrome://extensions` → enable Developer mode → "Load unpacked" → select this folder. After editing, click the reload icon on the extension card. Editing `content.js`/`styles.css` also requires reloading any open tabs.
- No `npm install`, no compile step, no lint config, no tests. Verification is manual in the browser.
- Text-polishing shortcuts require a user-supplied Anthropic API key. Chat, ClickUp answers, and proposals use the AI credentials stored in n8n.

## Architecture

Three execution contexts that communicate only via `chrome.runtime`/`chrome.tabs` message passing — they share no JS scope:

- **[background.js](background.js)** — service worker. The **only** place that calls the Claude API (`api.anthropic.com/v1/messages`, text polishing only) and the n8n webhook (chat, ClickUp answers, and proposals). Registers context menus + keyboard commands, and dispatches them to the active tab's content script. Message router handles actions: `call-api`, `chat-api`, `n8n-proposal`, `get-api-key`. Holds the `MODES` map of polishing system prompts.
- **[content.js](content.js)** — injected into `<all_urls>`. Owns the in-page polishing (selection replace / notifications) and the entire floating chat overlay, which is rendered inside a **Shadow DOM** (`overlayHost` + `shadow`) so page CSS can't leak in. All overlay CSS is a big template string in `getOverlayCSS()` near the end of the file.
- **[popup.js](popup.js)** + **[popup.html](popup.html)** — the toolbar popup. A second, simpler chat UI plus the Settings and Winning-Proposals tabs.

> ⚠️ **Duplicated chat logic.** The popup (`popup.js`) and the overlay (`content.js`) each implement their own copy of: chat send loop, markdown rendering (`renderMarkdown`/`renderMD`), markdown stripping (`stripMarkdownChars`/`stripMD`), proposal extraction (`extractProposalText`/`extractProposal`), and the winning-proposals manager. When changing chat behavior, **update both** or they will drift. They are not shared modules.

### Data flow for a chat message
content script / popup builds `messages[]` → `chrome.runtime.sendMessage({action:"chat-api", messages})` → `background.js` flattens recent history and POSTs `mode: "chat"` to n8n → n8n optionally adds ClickUp task context and invokes Claude or ChatGPT using its stored credential → response text returns through `sendResponse`. `proposalModel` selects the n8n provider. `chatModel` now applies only to direct text polishing.

### Storage model
- `chrome.storage.sync`: `apiKey` (text polishing only), `chatModel` (text polishing only), `customPrompt`, `n8nWebhookUrl`, `proposalModel`, `clickupContextEnabled`.
- `chrome.storage.local`:
  - `winningProposals` — array of `{jobPost, proposal}`, max 10, shared between popup and overlay proposal managers.
  - `aip_sessions_v1` (key `SESSIONS_KEY` in content.js) — chat sessions `[{id, title, createdAt, updatedAt, messages}]` + `activeSessionId`. `chatHistory` always aliases the active session's `messages` array. Sessions sync across tabs via a `chrome.storage.onChanged` listener (`setupCrossTabSync`).
  - **Important**: `saveSessions()` strips base64 image/document blocks to `[Attachment: ...]` placeholders before persisting, to stay under the ~10MB local-storage quota. Full attachment data lives only in the in-memory `chatHistory` for the current turn.

### n8n proposal integration (separate moving parts)
- **[n8n-build-prompt.js](n8n-build-prompt.js)** is **not** loaded by the extension. It is a code snippet meant to be pasted into a Code node inside the n8n workflow; it assembles the full proposal prompt from the job description, the user's portfolio/profile (n8n sources), and the `winningProposals` array sent in the webhook payload. The connected n8n MCP is read-only (see memory), so node edits are pasted manually.
- **[n8n-build-chat-prompt.js](n8n-build-chat-prompt.js)** mirrors the n8n Code node that builds normal and ClickUp-grounded chat prompts from the transcript sent by the extension.
- **[Proposal Chatbot (Postgres) - v3 - n8n Chat Credentials.json](Proposal%20Chatbot%20(Postgres)%20-%20v3%20-%20n8n%20Chat%20Credentials.json)** is the importable workflow export with the `chat` route connected to n8n's model credentials.
- **[Upwork Proposal Bot (extension-proposals).json](Upwork%20Proposal%20Bot%20(extension-proposals).json)** is the exported n8n workflow.
- Runtime path: popup/overlay "Generate Proposal" → `background.js` `callN8nProposalBot()` POSTs `{action, chatInput, winningProposals, sessionId}` to the user's `n8nWebhookUrl` → expects `{output|text}` back. Responses containing markers like `PROPOSAL:`, `Hook Options`, `Red Flags` trigger a "Copy Proposal" button that extracts just the proposal body via `extractProposal`/`extractProposalText`.
- **Loom mode**: the overlay's "Loom Proposal" button calls the same path with `loom: true`, which adds `mode: "loom"` to the webhook payload. The workflow's `Build Prompt` node branches on it and returns a three-section response (`LOOM SCRIPT:` / `EXAMPLES TO SHOW:` / `PROPOSAL:`, in that order — `PROPOSAL:` must stay last for extraction). The result card adds a "Copy Script" button (`extractLoomScript` in content.js); "Copy Proposal" still copies only the short send-with-the-Loom-link message. Loom flag persists on session entries as `_loom` so Retry/Edit regenerate in loom mode.

## Conventions

- The Anthropic API is called from the browser only for direct text-polishing shortcuts. Chat, ClickUp, and proposal generation do not read or send the extension's Anthropic key.
- All AI system prompts are tailored to one persona (Hassan, a Shopify/Upwork freelancer). The default chat persona lives in the n8n `Build Chat Prompt` node (mirrored in `n8n-build-chat-prompt.js`); polish modes live in `MODES`; proposal-writing rules live in `n8n-build-prompt.js`.
- Section banners use `// ===` comment blocks; keep that style when adding sections to the large files.
