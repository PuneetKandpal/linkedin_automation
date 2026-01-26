# Setup (MongoDB + API + Worker)

## Requirements

- Node.js >= 18
- MongoDB (local or Atlas)
- Playwright Chromium browser

## Install

```bash
npm install
npx playwright install chromium
```

## Environment variables

- `MONGODB_URI` (required)
- If your cluster URI does not include a database name, MongoDB will default to the `test` database.
  Include a db name in the URI path, e.g. `...mongodb.net/LINKEDIN-AUTOMATION?...`
- `STORAGE_STATE_SECRET` (required) 32-byte secret (used to encrypt Playwright storageState)
- `PORT` (optional, default `3000`)
- `CONFIG_DIR` (optional, default `./config`)\
  Only **static config** is read from disk (selectors, delays, typing profiles).
- `WORKER_POLL_MS` (optional, default `5000`)
- `LOG_RETENTION_DAYS` (optional, default `15`)
- `LOG_LEVEL` (optional, default `info`)

## Commands (API / Worker / Bootstrap)

Important:

- `npm run dev` runs the **CLI runner** (`src/index.ts`) which executes a config-driven run.
- To run the Express API, use `npm run dev:server`.
- To run the DB-driven worker, use `npm run dev:worker`.

### Start API server (Express)

Terminal 1:

```bash
MONGODB_URI=... STORAGE_STATE_SECRET=... npm run dev:server
```

This starts Express on `PORT` (default `3000`).

### Start Worker

Terminal 2:

```bash
MONGODB_URI=... STORAGE_STATE_SECRET=... npm run dev:worker
```

### Bootstrap (manual login per account)

In a separate terminal, run bootstrap for each account you want to publish from.
Bootstrap is interactive by default and will prompt for any missing fields.

```bash
npm run bootstrap
```

You can still provide flags (they override prompts):

```bash
npm run bootstrap -- \
  --account acct_01 \
  --display-name "Account 01" \
  --email "acct01@example.com" \
  --timezone "Asia/Kolkata"
```

Bootstrap will open a Chromium window. Log in, then press ENTER in the terminal.
It stores encrypted `storageStateEnc` in MongoDB.

## Logging

- Logs are stored in `./output/logs/`
- Daily rotated file: `app-YYYY-MM-DD.log`
- API latest pointer: `latest_api.log`
- Worker latest pointer: `latest_worker.log`
- Per-job worker log: `worker_<jobId>_<timestamp>.log`

Retention is **15 days** by default.
