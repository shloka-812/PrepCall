# PrepCall — AI Interview Prep Agent

**What it is:** A pre-interview research agent via SMS/RCS (works on Android too). Text a company name + role 30 mins before a call and get bite-sized intel to walk in confident. **No app download needed.**

---

## How it Works

1. Text your Linq Blue number from your phone
2. Paste a job description directly in the chat — PrepCall auto-detects it
3. Run `/brief` to get a full rapid summary or individual commands for focused answers
4. ❤️ react any message to save it permanently to your intel library

---

## Features

- **Gemini Flash AI** — LLM powering all research, positioning, and Q&A
- **Auto JD Detection** — Paste a JD directly into chat; the bot detects it (length + keywords) and saves it automatically
- **Resume from Notion** — Resume is fetched from your Notion page via the Notion API — never paste your CV into a chat
- **Company Snapshot** — What the company does, HQ, funding stage, headcount, latest news
- **Talking Points** — Resume + JD comparison to generate personalized positioning strategy
- **Interview Questions** — Likely behavioral + technical questions based on the JD
- **Saved Intel** — ❤️ react any message to permanently bookmark it to `saved_intel` collection
- **Reaction Webhooks** — Full `reaction.added` / `reaction.removed` webhook handling
- **Message Cache** — MongoDB-backed message cache (24-hour TTL) so reactions resolve correctly even after server restart
- **Typing Indicators** — Shows typing while Gemini + web search runs — feels like a real researcher  *(Note: iMessage-only; not supported on RCS/SMS per Linq Blue API docs)*
- **Multi-Bubble Responses** — Replies split into short bubbles (max 4), never walls of text
- **Session Memory** — Remembers conversation context per chat (1-hour TTL)
- **Persistent User Profiles** — Stores resume cache, Notion token, job description, and user metadata

---

## Quick Start

1. **Clone and install dependencies:**
   ```bash
   git clone https://github.com/shloka-812/PrepCall.git
   cd prep-call-agent
   npm install
   ```

2. **Copy environment template:**
   ```bash
   cp .env.example .env
   # Fill in your keys (see Configuration section below)
   ```

3. **Start MongoDB with Docker:**
   ```bash
   docker-compose up -d
   ```

4. **Run the dev server:**
   ```bash
   npm run dev
   ```

5. **Expose locally with ngrok:**
   ```bash
   ngrok http 3000
   ```

6. **Set the ngrok URL as your webhook** in the Linq Blue dashboard, then text your Linq Blue number!

---

## Commands

Send these via SMS/RCS to your Linq Blue number:

| Command | Description |
|---------|-------------|
| `/brief [company] [role]` | Full intel: company snapshot + talking points + interview questions |
| `/company [name]` | Company snapshot only (funding, headcount, news) |
| `/talking points` | Resume + JD positioning: what to lead with, how to frame experience, gaps to address |
| `/questions` | Likely interview questions based on the JD |
| `/saved` | View your bookmarked intel (❤️ reacted messages) |
| `/set jd <text>` | Manually save a job description |
| `/jd` | Show the currently stored job description |
| `/update resume` | Re-fetch resume from your Notion page |
| `/clear` | Reset session (clears conversation memory) |
| `/help` | Show all available commands |

**Or just paste a JD directly** — PrepCall detects it automatically (long text + keywords like "responsibilities", "requirements") and saves it without needing any command.

---

## Configuration

Copy `.env.example` to `.env` and fill in the following:

| Variable | Required | Description |
|----------|----------|-------------|
| `LINQ_API_TOKEN` | ✅ | Linq Blue partner API bearer token |
| `LINQ_API_BASE_URL` | — | Linq API base URL (default: `https://api.linqapp.com/api/partner/v3`) |
| `GEMINI_API_KEY` | ✅ | Google Gemini API key |
| `NOTION_TOKEN` | ✅ | Notion integration token (for resume fetching) |
| `NOTION_PAGE_ID` | ✅ | Notion page ID of your resume (must be shared with the integration) |
| `MONGODB_URI` | ✅ | MongoDB connection string (e.g. `mongodb://localhost:27017/prepcall`) |
| `MONGODB_DB_NAME` | — | Optional explicit DB name (inferred from URI if omitted) |
| `MONGO_INITDB_ROOT_USERNAME` | — | Docker Compose Mongo root user |
| `MONGO_INITDB_ROOT_PASSWORD` | — | Docker Compose Mongo root password |
| `PORT` | — | Server port (default: `3000`) |
| `LINQ_AGENT_BOT_NUMBERS` | — | Linq Blue numbers this bot runs on (comma-separated) |
| `IGNORED_SENDERS` | — | Sender numbers to skip (comma-separated) |
| `ALLOWED_SENDERS` | — | If set, only respond to these senders — useful for local dev |
| `NODE_ENV` | — | Set to `production` to disable debug logging |

---

## Architecture

```
[User Phone] ──SMS/RCS──► [Linq Blue API]
                                │
                          webhook POST
                                │
                                ▼
                      [PrepCall Express Server]
                        src/index.ts (port 3000)
                                │
               ┌────────────────┼─────────────────┐
               ▼                ▼                  ▼
        [webhook/handler]  [gemini/client]   [db/mongodb]
         Parse event,       Gemini Flash,     MongoDB:
         filter senders,    Company info,     - conversations
         dispatch to        Talking points,   - user_profiles
         router             Questions,        - saved_intel
               │            Brief             - message_cache
               ▼            generation        - prep_cache
        [webhook/router]
         Command parsing,
         JD detection,
         Reaction saving,
         Intel bookmarking
               │
               ▼
        [notion/service]
         Fetch resume from
         Notion API ──────► [User's Notion Page]
               │
               ▼
        [research/cache]
         MongoDB prep cache
         (company+role, 7-day TTL)
               │
               ▼
        [linq/client]
         Send reply
         bubbles back
               │
               ▼
        [Linq Blue API] ──SMS/RCS──► [User Phone]
```

---

## File Structure

```
prep-call-agent/
├── src/
│   ├── index.ts                 # Express app entry point, server setup, ngrok detection
│   ├── db/
│   │   ├── mongodb.ts           # MongoDB connection, collections, helpers
│   │   │                        #   Collections: conversations, user_profiles,
│   │   │                        #   saved_intel, message_cache, prep_cache
│   │   └── mongodb.spec.ts      # Unit tests for DB helpers
│   ├── gemini/
│   │   ├── client.ts            # Gemini Flash integration: classifyIntent,
│   │   │                        #   generateCompanyInfo, generateTalkingPoints,
│   │   │                        #   generateInterviewQuestions, generateBrief
│   │   └── client.spec.ts       # Unit tests for Gemini client
│   ├── linq/
│   │   ├── client.ts            # Linq Blue API: sendMessage, markAsRead,
│   │   │                        #   startTyping, stopTyping, sendReaction
│   │   └── index.ts             # Re-export barrel
│   ├── notion/
│   │   ├── resume.ts            # Fetch + parse Notion page blocks → plain text
│   │   ├── service.ts           # High-level: refreshResumeForHandle,
│   │   │                        #   setJobDescriptionForHandle
│   │   └── resume.spec.ts       # Unit tests for Notion resume parsing
│   ├── research/
│   │   └── cache.ts             # Prep cache helpers (getPrepCache, updatePrepCache)
│   ├── state/
│   │   ├── conversation.ts      # Legacy conversation state (session memory)
│   │   └── index.ts             # Re-export barrel
│   └── webhook/
│       ├── handler.ts           # createWebhookHandler: validates events,
│       │                        #   filters senders, dispatches to router
│       ├── router.ts            # createWebhookMessageHandler: command parsing,
│       │                        #   JD detection, createReactionHandler
│       ├── types.ts             # TypeScript types for all Linq webhook events
│       ├── index.ts             # Re-export barrel
│       └── router.spec.ts       # Unit tests for command routing
├── docker-compose.yml           # MongoDB + app services
├── Dockerfile                   # Production Docker image
├── mongo-init/                  # MongoDB init scripts (run on first container start)
├── prep_cache_schema.md         # PrepCache MongoDB schema documentation
├── todo.md                      # Project notes and roadmap
├── tsconfig.json                # TypeScript config
├── vitest.config.ts             # Vitest test config
├── package.json                 # Dependencies and scripts
├── .env.example                 # Environment variable template
└── .gitignore
```

---

## MongoDB Collections

| Collection | TTL | Purpose |
|------------|-----|---------|
| `conversations` | 1 hour | Session memory per chat |
| `user_profiles` | Permanent | Resume cache, Notion token, job description, user metadata |
| `saved_intel` | Permanent | ❤️ reacted messages bookmarked by user |
| `message_cache` | 24 hours | Sent/received message text for reaction resolution (survives server restarts) |
| `prep_cache` | 7 days | Cached company info, talking points, and questions per company+role |

---

## Linq Blue API Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `POST /v3/chats/{chatId}/messages` | Send a message |
| `POST /v3/chats/{chatId}/read` | Mark chat as read |
| `POST /v3/chats/{chatId}/typing` | Start typing indicator |
| `DELETE /v3/chats/{chatId}/typing` | Stop typing indicator |
| `POST /v3/messages/{messageId}/reactions` | Add/remove reaction |
| `GET /v3/chats/{chatId}` | Get chat info |

## Webhook Events Handled

| Event | Description |
|-------|-------------|
| `message.received` | Incoming message from user |
| `reaction.added` | User reacted with ❤️ → save to `saved_intel` |
| `reaction.removed` | User removed a reaction |

---

## Scripts

| Script | Command |
|--------|---------|
| Dev server (hot reload) | `npm run dev` |
| Run tests | `npm test` |
| Production build | `npm run build` |
| Start production | `npm start` |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Express.js + TypeScript |
| LLM | Google Gemini Flash (`gemini-2.0-flash-latest`) |
| Database | MongoDB (Docker) |
| Resume Source | Notion API |
| Messaging | Linq Blue API (SMS/RCS) |
| Local Tunnel | ngrok |
| Containerization | Docker + Docker Compose |
| Testing | Vitest |

---

## Deployment

```bash
# Build Docker image
docker build -t prep-call-agent .

# Run with env file
docker run -p 3000:3000 --env-file .env prep-call-agent
```

Or use Docker Compose to run both MongoDB and the app together:

```bash
docker-compose up --build
```

---

## API Documentation

Full Linq Blue API reference: **https://apidocs.linqapp.com**

## Credits

- **Original Infrastructure**: Based on a messaging agent template by [George McCain](https://github.com/georgemccain).
- **Core Transformation**: Fully refactored and transformed into PrepCall (Google Gemini, MongoDB, Notion integration, and Interview Research logic) by **Shloka Pandya**.

---

## License

MIT
