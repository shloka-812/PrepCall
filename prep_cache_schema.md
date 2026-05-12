# PrepCall Cache Schema

## Purpose
Avoid redundant web searches and LLM calls by caching company research, talking points, and interview questions per user session.

## MongoDB Collection: `prep_cache`

```typescript
{
  userId: string,              // user's phone number / senderHandle
  company: string,             // "stripe", "google", etc. (lowercase)
  role: string | null,         // "senior swe", "product manager", etc.
  
  companyInfo: {
    dateFounded: string,
    location: string,
    peopleSize: string,
    webLink: string,
    currentStage: string,
    totalFunding: string,
    keyInvestors: string,
    news: string[]
  } | null,
  
  talkingPoints: {
    leadWith: string,
    howToFrame: string,
    gapToAddress: string
  } | null,
  
  interviewQuestions: string[] | null,
  
  resumeHash: string,          // SHA-256 hash of user's resume
  cachedAt: Date,
  expiresAt: Date              // 24 hours from cachedAt
}
```

## Indexes

- **Lookup index:** `{ userId: 1, company: 1, role: 1 }` — fast cache queries
- **TTL index:** `{ expiresAt: 1 }` with `expireAfterSeconds: 0` — auto-delete after 24hrs

## Cache Logic

### Lookup Priority

1. **`/brief [company] [role]`** → find by `{ userId, company, role }`
2. **`/company [company]`** → find by `{ userId, company }` (role can be null)
3. **`/talking points`** (no args) → use `currentCompany` + `currentRole` from `user_profiles`

### Partial Cache Hits

Example: User asks `/company stripe` first, then `/brief stripe senior swe` later.

```
First request (/company stripe):
{
  company: "stripe",
  role: null,
  companyInfo: { ... },         // ✅ generated
  talkingPoints: null,          // not asked yet
  interviewQuestions: null
}

Second request (/brief stripe senior swe):
- Find existing cache for { userId, company: "stripe" }
- Update role to "senior swe"
- Reuse companyInfo (already exists)
- Generate talkingPoints + interviewQuestions
- Update cache document
```

### Cache Invalidation

When user runs `/update resume`:
1. Delete all `prep_cache` documents for that `userId`
2. Reason: Old talking points are based on old resume — now invalid

## Session Tracking in `user_profiles`

Add these fields to track the active prep session:

```typescript
user_profiles: {
  resume: string,
  notionPageId: string,
  jobDescription: string,
  jdSetAt: Date,
  
  // New fields for session tracking:
  currentCompany: string | null,
  currentRole: string | null
}
```

When user runs `/brief stripe senior swe`:
- Set `currentCompany = "stripe"`
- Set `currentRole = "senior swe"`

When user runs `/talking points` (no args):
- Look up `currentCompany` + `currentRole` from profile
- Use those to find the right cache document
