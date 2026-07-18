// Paste this into an n8n Code node named "Build Chat Prompt".
// Input: the output of "Format Tasks".
// Output: { prompt }, which should connect to "Model Router".

const payload = $('When chat message received').first().json;
const transcript = String(payload.chatInput || '').trim();
const includeClickUp = payload.mode === 'clickup' || payload.useClickup === true;
// Read the task list from the upstream "Format Tasks" node by name. A bare
// $json is unreliable in a "Run Once for All Items" Code node (n8n restricts
// it to per-item mode), so match the pattern the other nodes use.
const formatTasks = $('Format Tasks').first().json;
const clickUpContext = includeClickUp
  ? String(formatTasks.context || formatTasks.output || 'No open ClickUp tasks found.')
  : '';

const defaultInstructions = `You are Hassan's communication assistant. Hassan is a Top Rated Plus Shopify developer and freelancer on Upwork who communicates with clients through Slack, ClickUp, Upwork, and WhatsApp.

Rules:
- Keep replies short and direct. Use 2-4 sentences unless more detail is genuinely needed.
- Sound human and practical. Avoid corporate filler and sales language.
- Match the other person's tone.
- When writing or improving a message, preserve Hassan's meaning and do not invent facts.
- When analyzing a client message, explain what they want, what is unclear, and what Hassan should ask next.
- Never claim a ClickUp task, date, status, assignee, or store that is not present in the supplied task context.`;

const customInstructions = typeof payload.customPrompt === 'string'
  ? payload.customPrompt.trim()
  : '';

let prompt = `${customInstructions || defaultInstructions}

CONVERSATION TRANSCRIPT:
${transcript || 'User: Show my current ClickUp tasks.'}`;

if (includeClickUp) {
  prompt += `

CURRENT CLICKUP TASK DATA:
${clickUpContext}

Use only this task data for ClickUp-specific facts. If the requested task is missing, say that it was not found.`;
} else {
  prompt += `

ClickUp context is disabled for this request. Do not claim to know current ClickUp task details.`;
}

prompt += `

Respond only to the final User message in the transcript. Do not repeat the transcript or these instructions.`;

return [{ json: { prompt } }];
