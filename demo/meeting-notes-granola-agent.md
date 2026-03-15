George McCain <> Midhun | Granola Agent Build Planning
March 13, 2026 — 10:00 AM ET

Participants: George McCain (Milo Labs), Midhun

---

George kicked off by demoing the working prototype — texted a query from his phone and got back a summary of his KemTec meeting from yesterday. Midhun was impressed by how fast it was.

George explained the architecture: Linq Blue webhook receives iMessage, routes to Claude with Granola MCP tools connected. Claude queries the user's meeting notes via MCP and sends a synthesized answer back through iMessage. No custom API integration needed — Granola handles auth via OAuth and the MCP gives Claude direct access to notes, transcripts, and summaries.

Midhun asked about multi-user support. George said the plan is to store per-user Granola OAuth tokens encrypted in DynamoDB using AES-256-GCM, same pattern as the Resy agent he built. When a new user texts the agent for the first time, it sends them the Granola OAuth link via iMessage. They tap it, authorize in browser, and they're connected. No custom auth pages needed.

Discussed deployment: going with AWS Lambda using the two-Lambda pattern from the Resy agent — a fast Receiver function (webhook to SQS, 10s timeout) and a Processor function (Claude + Granola MCP, 60s timeout). FIFO SQS for per-chat message ordering. SAM template for infra.

Midhun suggested adding a daily briefing feature — every morning at 8am, the agent texts you a summary of your meetings for the day. George liked it, said it could poll Granola's list_meetings tool with a time range filter. Would need a scheduled Lambda or EventBridge cron.

Action items:
- George: Get new Linq Blue number leased for the granola-agent project
- George: Set up DynamoDB table and SAM template based on resy agent infra
- George: Wire up the OAuth flow so new users get the magic link on first text
- Midhun: Test the CLI chat tool and stress test with different query types
- Both: Reconvene Friday to review progress and plan the daily briefing feature

Key decisions:
- MCP-first approach (not Enterprise API) — cleaner auth, Granola actively supports it
- Same encryption and single-table DynamoDB pattern as resy agent
- Ship MVP with query-only, add daily briefing as v2

Timeline: MVP by end of next week (March 20), daily briefing by March 27
