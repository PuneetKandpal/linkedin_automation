# Excel Templates

This project supports bulk operations via the UI **Bulk (Excel)** tab. The UI reads the **first sheet** of an `.xlsx` file and maps rows to the existing bulk JSON APIs.

Important:

- Column headers are **case-insensitive**.
- Spaces are ignored (e.g. `Account ID` == `accountId`).
- Validation is done client-side (Excel import preview) and server-side (API).

---

## 1) Bulk Accounts template

### Required columns (Accounts)

- `accountId`
- `displayName`
- `email`
- `timezone`

### Optional columns (Accounts)

- `status` (defaults to `active`) — allowed values:
  - `active`
  - `disabled`

### API mapping (Accounts)

- `POST /accounts/bulk`

Payload:
- `{ "items": [ { "accountId": "...", "displayName": "...", "email": "...", "timezone": "...", "status": "active" } ] }`

---

## 2) Bulk Articles template

### Required columns (Articles)

- `articleId`
- `language`
- `title`
- `markdownContent`

### Optional columns (Articles)

- `coverImagePath` (http/https URL)
- `communityPostText`

### API mapping (Articles)

- `POST /articles/bulk`
- optional follow-up: `POST /articles/ready/bulk`

---

## 3) Bulk Scheduling template

### Required columns (Scheduling)

- `accountId`
- `articleId`
- `runAt` (ISO timestamp; the UI will convert to `.toISOString()`)
- `companyPageUrl` (must already be added to the account)

### Optional columns (Scheduling)

- `jobId` (auto-generated if omitted)
- `delayProfile` (defaults to `default`)
- `typingProfile` (defaults to `medium`)

### Scheduling policy (UI fields)

- `minGapMinutesPerAccount`
- `minGapMinutesPerCompanyPage`

### API mapping (Scheduling)

- `POST /publish-jobs/bulk`

Payload:
- `{ "schedulePolicy": { "minGapMinutesPerAccount": 20, "minGapMinutesPerCompanyPage": 60 }, "items": [ ... ] }`
