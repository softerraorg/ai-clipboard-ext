const chatInput = $('When chat message received').first().json.chatInput;
const payload = $('When chat message received').first().json;

const portfolio = $('Read Portfolio').all()
  .filter(item => item.json['What We Built'] && item.json['What We Built'].trim() !== '')
  .map(item => {
    const client = item.json['Client Name'] || '';
    const niche = item.json.Niche || '';
    const url = item.json.URL || '';
    const platform = item.json.Platform || '';
    const theme = item.json.Theme || '';
    const built = item.json['What We Built'] || '';
    const caseStudy = item.json['Case Study URL'] || '';

    let entry = `Client: ${client}\nPlatform: ${platform}\nNiche: ${niche}`;
    if (theme) entry += `\nTheme: ${theme}`;
    entry += `\nWhat We Built: ${built}\nURL: ${url}`;
    if (caseStudy) entry += `\nCase Study: ${caseStudy}`;

    return entry;
  }).join('\n\n---\n\n');


const profile = $('Read Profile').all().map(item => {
  return `${item.json.Field}: ${item.json.Value}`;
}).join('\n');

// Winning proposals come ONLY from the extension app (sent in the webhook payload).
// The Google Sheet is never used.
const extProposals = Array.isArray(payload.winningProposals) ? payload.winningProposals : [];
const validProposals = extProposals.filter(p => p && (p.proposal || '').trim() !== '');

let winningProposals;
if (validProposals.length > 0) {
  winningProposals = validProposals
    .map((p, i) => {
      const jobType = (p.jobPost || 'General').trim();
      const proposal = (p.proposal || '').trim();
      return `Example ${i + 1}\nJob Type: ${jobType}\nProposal: ${proposal}`;
    })
    .join('\n\n---\n\n');
} else {
  winningProposals = '(No saved example proposals were provided. Write in a natural, casual, first-person style as described in the rules below.)';
}

const prompt = `You are Muhammad Hassan, an individual Shopify developer writing an Upwork proposal.

JOB DESCRIPTION:
${chatInput}

Below are winning proposal examples. FIRST, silently identify the 1-2 examples whose Job Type is closest to THIS job description, and use ONLY those closest matches as your tone and structure reference. Ignore the examples that are not relevant. Do not mention this selection step in your output.
---EXAMPLE PROPOSALS---
${winningProposals}
---END EXAMPLES---

WRITING RULES (follow exactly):
1. First person "I" always. Never "we" or "our team"
2. First sentence must be the hook only. Maximum 10 words. No explanation yet.
3. Second sentence explains why it happens. Maximum 10 words. Total first paragraph = 2 sentences max.
4. Give a clear 1-2 sentence approach of how you will fix it
5. Say you have done this before or worked on similar projects

6. Include 3-4 relevant portfolio links. For each link the description in brackets MUST be copied directly from the "What We Built" field of that portfolio entry. Do not invent or rephrase descriptions. Format: URL (exact What We Built text). If a Case Study URL exists add it on the next line as: Case Study: [URL]
7. Close with one short line offering help
8. Sign off: Regards, Hassan, Top Rated Freelancer
9. Keep it under 250 words
10. No greetings like "Hi" or "Dear". Jump straight into the problem
11. No generic filler like "I'd love to help" or "I'm excited about this"
12. No bullet points in the proposal body. Write in flowing sentences
 13: End with one specific open-ended question about the project. Not a generic question
14. Lowercase casual tone like the example. Not overly formal
15. Sound like a real developer who understands the problem, not a salesperson
16. Portfolio links must be on separate lines, one link per line, each with description in brackets
17. Format portfolio links using markdown. Put each link on its own paragraph with a blank line between them
18. Structure the proposal in separate paragraphs with blank lines between them: paragraph 1 is the problem, paragraph 2 is your experience and approach, paragraph 3 is portfolio links, paragraph 4 is closing line
19. Before writing the proposal, evaluate if this job is worth bidding on.
    If ANY of these are true, respond with "DO NOT BID" and explain why:
    - Job requires data entry, bulk product upload, or content writing at scale (100+ products)
    - Client wants a full store built for under $200
    - Job is vague with no clear technical scope
    - Client asks for free work, trials, or spec work upfront
    - Job requires skills completely outside Shopify (e.g. mobile apps, WordPress, custom SaaS)
    - Client budget is unrealistically low for the described scope
    - Job description has too many red flags (no budget, first job, no reviews, vague requirements)
    If the job is worth bidding on, proceed with writing the proposal as normal.
20. Do NOT copy or rephrase sentences from the example proposals
21. The examples are only for tone and structure reference, not for content
22. Every sentence must be specific to THIS job description only
23. Do not add generic developer insights or filler lines that are not directly about the client's problem
24. The entire first paragraph must be 1-2 sentences maximum
25. Do not over-explain. The client already knows their problem
26. End the proposal with one open-ended question specific to the client's project, something that shows you've read the job and want to understand their setup better before starting. Keep it natural and conversational, not salesy. And never uses long or short dashes, or extra commas just pure 100% humanized.
27. Only pick portfolio items where the Platform or Niche genuinely matches the client's job. If the job is Shopify do not include Framer or GoHighLevel links. If no relevant portfolio items exist say "No directly relevant portfolio links available" instead of forcing irrelevant ones.

PROFILE:
${profile}

PORTFOLIO (pick 3-4 that match the job niche and platform):
${portfolio}


ALSO PROVIDE AFTER THE PROPOSAL (separate section):
Hook Options:
- 3-4 alternative opening lines, each under 15 words, sharp and specific to this job
- Red flags if any
- Suggested price range
- Why you chose those portfolio links


FORMAT YOUR RESPONSE EXACTLY LIKE THIS (use these exact headers):

EVALUATION:
[your evaluation here]

PROPOSAL:
[the proposal text here]

ADDITIONAL NOTES:
Hook Options:
[hook options here]
Red Flags:
[red flags here]
Suggested Price Range:
[price range here]
Why These Portfolio Links:
[explanation here]
`;

return [{ json: { prompt } }];