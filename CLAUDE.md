# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome Manifest V3 extension ("AI Text Polisher") that does two things on any webpage:

1. **Text polishing** — select text and rewrite it via keyboard shortcut or right-click context menu (auto-polish / formal / casual / expand / shorten).
2. **Floating AI chat** — an in-page chat overlay plus a toolbar popup, both backed by the Claude API, with multimodal attachments, multi-session history, and an Upwork-proposal generator wired to an external n8n webhook.

There is **no build system, bundler, framework, or test suite**. Everything is plain vanilla JS/HTML/CSS loaded directly by Chrome.

## Running & "building"

- **Load/reload**: `chrome://extensions` → enable Developer mode → "Load unpacked" → select this folder. After editing, click the reload icon on the extension card. Editing `content.js`/`styles.css` also requires reloading any open tabs.
- No `npm install`, no compile step, no lint config, no tests. Verification is manual in the browser.
- Requires a user-supplied Anthropic API key (set in the popup's Settings tab, stored in `chrome.storage.sync`).

## Architecture

Three execution contexts that communicate only via `chrome.runtime`/`chrome.tabs` message passing — they share no JS scope:

- **[background.js](background.js)** — service worker. The **only** place that calls the Claude API (`api.anthropic.com/v1/messages`) and the n8n webhook. Registers context menus + keyboard commands, and dispatches them to the active tab's content script. Message router handles actions: `call-api` (mode polish), `chat-api` (multi-turn chat), `n8n-proposal`, `get-api-key`. Holds the `MODES` map of polishing system prompts.
- **[content.js](content.js)** — injected into `<all_urls>`. Owns the in-page polishing (selection replace / notifications) and the entire floating chat overlay, which is rendered inside a **Shadow DOM** (`overlayHost` + `shadow`) so page CSS can't leak in. All overlay CSS is a big template string in `getOverlayCSS()` near the end of the file.
- **[popup.js](popup.js)** + **[popup.html](popup.html)** — the toolbar popup. A second, simpler chat UI plus the Settings and Winning-Proposals tabs.

> ⚠️ **Duplicated chat logic.** The popup (`popup.js`) and the overlay (`content.js`) each implement their own copy of: chat send loop, markdown rendering (`renderMarkdown`/`renderMD`), markdown stripping (`stripMarkdownChars`/`stripMD`), proposal extraction (`extractProposalText`/`extractProposal`), and the winning-proposals manager. When changing chat behavior, **update both** or they will drift. They are not shared modules.

### Data flow for a chat message
content script / popup builds `messages[]` → `chrome.runtime.sendMessage({action:"chat-api", messages})` → `background.js` `callChatAPI()` reads `apiKey` + `customPrompt` from storage, POSTs to Claude → response text returned via `sendResponse`. The model is **hardcoded** as `claude-sonnet-5` in `background.js` (two call sites: `callChatAPI` and `callClaudeAPI`).

### Storage model
- `chrome.storage.sync`: `apiKey`, `customPrompt` (overrides the default chat system prompt), `n8nWebhookUrl`.
- `chrome.storage.local`:
  - `winningProposals` — array of `{jobPost, proposal}`, max 10, shared between popup and overlay proposal managers.
  - `aip_sessions_v1` (key `SESSIONS_KEY` in content.js) — chat sessions `[{id, title, createdAt, updatedAt, messages}]` + `activeSessionId`. `chatHistory` always aliases the active session's `messages` array. Sessions sync across tabs via a `chrome.storage.onChanged` listener (`setupCrossTabSync`).
  - **Important**: `saveSessions()` strips base64 image/document blocks to `[Attachment: ...]` placeholders before persisting, to stay under the ~10MB local-storage quota. Full attachment data lives only in the in-memory `chatHistory` for the current turn.

### n8n proposal integration (separate moving parts)
- **[n8n-build-prompt.js](n8n-build-prompt.js)** is **not** loaded by the extension. It is a code snippet meant to be pasted into a Code node inside the n8n workflow; it assembles the full proposal prompt from the job description, the user's portfolio/profile (n8n sources), and the `winningProposals` array sent in the webhook payload. The connected n8n MCP is read-only (see memory), so node edits are pasted manually.
- **[Upwork Proposal Bot (extension-proposals).json](Upwork%20Proposal%20Bot%20(extension-proposals).json)** is the exported n8n workflow.
- Runtime path: popup/overlay "Generate Proposal" → `background.js` `callN8nProposalBot()` POSTs `{action, chatInput, winningProposals, sessionId}` to the user's `n8nWebhookUrl` → expects `{output|text}` back. Responses containing markers like `PROPOSAL:`, `Hook Options`, `Red Flags` trigger a "Copy Proposal" button that extracts just the proposal body via `extractProposal`/`extractProposalText`.

## Conventions

- The Anthropic API is called from the browser using the `anthropic-dangerous-direct-browser-access: true` header — this is intentional for a personal extension; the key never leaves the user's machine.
- All AI system prompts are tailored to one persona (Hassan, a Shopify/Upwork freelancer). The default chat persona lives in `callChatAPI`; polish modes live in `MODES`; the proposal-writing rules live in `n8n-build-prompt.js`.
- Section banners use `// ===` comment blocks; keep that style when adding sections to the large files.
