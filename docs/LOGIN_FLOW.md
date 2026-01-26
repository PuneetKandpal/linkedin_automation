# Initial Login Flow (Multiple LinkedIn Accounts)

## Goal

This tool never stores LinkedIn passwords. Instead it persists a Playwright session (`storageState`) per LinkedIn account.

That session is:

- captured once via manual login
- encrypted with `STORAGE_STATE_SECRET`
- stored in MongoDB under the `Account` record

No Playwright profile/session data is persisted on disk.

## Step-by-step

### 1) Create an account record (API)

Create the account metadata in MongoDB (accountId, timezone, optional proxy).

Then run the bootstrap script to login.

### 2) Run bootstrap for that account

```bash
MONGODB_URI=... STORAGE_STATE_SECRET=... npm run bootstrap -- \
  --account acct_01 \
  --display-name "Account 01" \
  --email "acct01@example.com" \
  --timezone "Asia/Kolkata"
```

Bootstrap is interactive by default; you can also run `npm run bootstrap` and it will prompt for any missing fields.

Optional proxy flags:

- `--proxy-server`
- `--proxy-username`
- `--proxy-password`

What happens:

- A real Chromium window opens (ephemeral browser context)
- You log in manually (OTP/2FA if required)
- Press ENTER in the terminal
- The script saves encrypted `storageStateEnc` into MongoDB

### 3) Verify account is ready

Check `GET /accounts` and confirm:

- `authStatus` is `valid`
- `storageStateEnc` is not returned by the API (kept server-side)

### 4) Repeat for multiple accounts

Repeat steps for `acct_02`, `acct_03`, etc.

## Re-authentication

If LinkedIn triggers OTP/CAPTCHA/login redirect during publishing:

- a new `AccountIssue` is created
- account `authStatus` is set to `needs_reauth`

Fix by running bootstrap again for that account.
