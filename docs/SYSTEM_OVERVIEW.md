# System Overview

## Single-tenant model

This is a **single-tenant** tool (one operator) that can manage **multiple LinkedIn accounts**.

You explicitly choose:

- which account publishes
- which article is published
- when it runs (`runAt`)

## Components

- **API server** (`src/server.ts`)
  - CRUD for `Account` and `Article`
  - create/cancel/list `PublishJob`
  - list `AccountIssue`

- **Worker** (`src/worker.ts`)
  - polls MongoDB for due jobs
  - runs Playwright publishing
  - updates job/article state and creates issues

- **Bootstrap** (`src/bootstrap.ts`)
  - manual login once per account
  - stores encrypted `storageState` in MongoDB

## How to run

- API server: `npm run dev:server`
- Worker: `npm run dev:worker`
- Manual login bootstrap: `npm run bootstrap -- --account <id> --display-name ... --email ... --timezone ...`

## Data flow

1) Create account (API)
2) Bootstrap login for account (CLI)
3) Create article (API)
4) Mark article ready (API)
5) Create publish job (API)
6) Worker picks job and publishes
7) Worker writes:
   - `PublishJob.status`
   - `Article.status`, `publishedUrl`
   - `AccountIssue` + `Account.authStatus` if needed

## Cover images

`coverImagePath` must always be an **http(s) URL**.
The worker will skip cover upload if it is not a URL.
