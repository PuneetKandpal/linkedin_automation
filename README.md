# LinkedIn Article Publisher

Config-driven, human-behavior LinkedIn Article Publisher using Playwright with Page Object Model architecture.

## 🎯 What This System Does

- Publishes LinkedIn articles using **persistent browser sessions** (no auto-login)
- Simulates **human typing behavior** with randomized delays and typos
- Uses **Page Object Model** for maintainable, testable code
- **Config-driven** - all behavior controlled via JSON files
- Designed to be **safe** - stops on CAPTCHA/OTP instead of aggressive retries

## 📁 Project Structure

```
linkedin-publisher/
├── config/               # All configuration files
│   ├── global.json      # Browser and execution settings
│   ├── accounts.json    # LinkedIn account definitions
│   ├── articles.json    # Article content storage
│   ├── publish-plan.json # Jobs to execute
│   ├── delays.json      # Behavioral delay profiles
│   ├── typing-profiles.json # Human typing simulation
│   └── selectors/       # LinkedIn DOM selectors
├── profiles/            # Browser profile storage (gitignored)
├── output/              # Execution results (gitignored)
├── screenshots/         # Debug screenshots (gitignored)
└── src/
    ├── config/          # Config loader
    ├── engine/          # Delay, typing, logging
    ├── browser/         # Context factory
    ├── pages/           # Page Object Model classes
    ├── errors/          # Custom error types
    ├── runner.ts        # Main execution logic
    └── index.ts         # Entry point
```

## 🚀 Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Install Playwright Browsers

```bash
npx playwright install chromium
```

### 3. Configure Your Account

Edit `config/accounts.json`:

```json
[
  {
    "accountId": "acct_01",
    "displayName": "Your Name",
    "email": "your-email@example.com",
    "profileDir": "./profiles/acct_01",
    "proxy": {
      "server": "http://proxy-server:port",
      "username": "proxy-user",
      "password": "proxy-pass"
    },
    "timezone": "Asia/Kolkata",
    "status": "active"
  }
]
```

### 4. Create Your Article

Edit `config/articles.json`:

```json
[
  {
    "articleId": "art_001",
    "language": "en",
    "title": "Your Article Title",
    "content": [
      {
        "type": "paragraph",
        "text": "First paragraph content..."
      },
      {
        "type": "paragraph",
        "text": "Second paragraph content..."
      }
    ]
  }
]
```

### 5. Create Publish Job

Edit `config/publish-plan.json`:

```json
[
  {
    "jobId": "job_001",
    "accountId": "acct_01",
    "articleId": "art_001",
    "delayProfile": "default",
    "typingProfile": "medium"
  }
]
```

## 🔐 First-Time Session Setup

**IMPORTANT**: Login is manual, but the session is persisted and reused automatically.

### Bootstrap (Manual login once, then reuse forever)

Run:

```bash
npm run bootstrap -- --account acct_01
```

What happens:

1. A real Chromium window opens using `profiles/acct_01`.
2. You log in manually (including OTP/2FA if needed).
3. After login completes, come back to the terminal and press **ENTER**.
4. The tool saves `profiles/acct_01/storageState.json` and closes the browser.

From the next run onwards, the publisher reuses the persisted session.

## ▶️ Running the Publisher

### Development Mode (TypeScript)

```bash
npm run dev
```

### Server logs

Every run writes detailed logs to:

- `output/logs/run_<timestamp>.log`
- `output/logs/latest.log`

These logs include the same structured messages printed to the console.

### Production Mode (Compiled)

```bash
npm run build
npm start
```

## 🧠 How It Works

### Execution Flow

1. **Load Configuration** - Read all JSON configs
2. **Resolve Job** - Pick first job from publish plan
3. **Launch Browser** - Use persistent profile (session preserved)
4. **Validate Session** - Check for login/CAPTCHA/OTP
5. **Open Editor** - Navigate to LinkedIn article editor
6. **Type Title** - Human-like character-by-character typing
7. **Type Content** - Paragraph-by-paragraph with delays
8. **Publish** - Click publish with natural mouse behavior
9. **Verify** - Confirm article URL
10. **Close** - Clean shutdown

### Key Design Principles

- **One job per run** (MVP constraint)
- **Fail-safe** - Stops on errors, no aggressive retries
- **Observable** - Visible browser, detailed logging
- **Config-driven** - No hardcoded behavior
- **Session preservation** - Each account has isolated browser profile

## 🔧 Configuration Guide

### Delay Profiles (`delays.json`)

Control timing between actions:

```json
{
  "default": {
    "preLaunch": [3000, 8000],          // Before browser launch
    "beforeEditorFocus": [1000, 3000],   // Before clicking editor
    "betweenParagraphs": [800, 2500],    // Between content blocks
    "beforePublish": [3000, 7000],       // Before clicking publish
    "afterPublish": [6000, 12000]        // After publish completes
  }
}
```

### Typing Profiles (`typing-profiles.json`)

Control human typing simulation:

```json
{
  "medium": {
    "minDelay": 40,              // Min ms between keystrokes
    "maxDelay": 160,             // Max ms between keystrokes
    "typoChance": 0.02,          // 2% chance of typo
    "thinkingPauseChance": 0.03  // 3% chance of pause
  }
}
```

### Selectors (`selectors/*.json`)

LinkedIn DOM selectors (update if LinkedIn UI changes):

```json
{
  "titleInput": "div[contenteditable='true'][data-placeholder*='Title']",
  "editor": "div[contenteditable='true'][role='textbox']"
}
```

## 📊 Output

Results saved to `./output/results.json`:

```json
{
  "runTimestamp": "2026-01-24T13:54:00.000Z",
  "results": [
    {
      "success": true,
      "jobId": "job_001",
      "accountId": "acct_01",
      "articleId": "art_001",
      "articleUrl": "https://www.linkedin.com/posts/...",
      "timestamp": "2026-01-24T13:54:30.000Z"
    }
  ],
  "logs": [...]
}
```

## ⚠️ Error Handling

The system will **stop immediately** if:

- ❌ Login redirect detected
- ❌ CAPTCHA challenge appears
- ❌ OTP verification required
- ❌ Editor fails to load
- ❌ Publish button disabled

This is **intentional** for account safety. Resolve the issue manually before retrying.

## 🧪 MVP Scope

### ✅ Included

- Single job execution
- Human behavior simulation
- Session validation
- Article publishing
- Result logging
- Config-driven everything

### ❌ Out of Scope (For Now)

- Auto-login
- CAPTCHA solving (basic detection only)
- Concurrent publishing
- Scheduling/orchestration
- Database storage
- Account warm-up logic

## 🛠️ Troubleshooting

## 🧰 Selector Debugging Toolkit (recommended)

When the automation “can’t find an element”, the fastest path is:

1. Use **Codegen** to generate robust selectors interactively.
2. Use **Tracing** to inspect the exact DOM state, screenshots, and steps at failure.

### 1) Interactive selector discovery (Codegen)

This opens a browser with your persisted profile and shows a live inspector.

```bash
npm run codegen
```

Copy the selector you discover into the relevant file:

- `config/selectors/article-editor.json`
- `config/selectors/publish.json`
- `config/selectors/login.json`

### 2) Record a trace when running the publisher

Run the publisher with tracing enabled:

```bash
PW_TRACE=1 PW_SCREENSHOT_ON_ERROR=1 npm run dev
```

This produces:

- `output/traces/<jobId>.zip`
- `output/traces/latest.zip`

### 3) View the trace

```bash
npm run trace:show
```

In Trace Viewer you can inspect:

- every Playwright action
- DOM snapshots
- screenshots
- timing
- console/network

This is usually enough to see if LinkedIn changed the UI, the page is not fully loaded, or a dialog is blocking clicks.

### "Session Invalid" Error

- Re-run manual login process
- Check if LinkedIn logged you out
- Verify profile directory exists

### "Editor Not Ready" Error

- LinkedIn UI may have changed
- Update selectors in `config/selectors/article-editor.json`
- Check network connectivity

### Publish Fails

- Verify article content is not empty
- Check for LinkedIn rate limits
- Screenshot will be saved in `./screenshots/`

## 🏗️ Architecture

### Page Object Model (POM)

Each LinkedIn screen = One class:

- **BasePage** - Common actions (wait, click, scroll)
- **SessionPage** - Login state validation
- **ArticleEditorPage** - Title and content typing
- **PublishConfirmPage** - Publish flow
- **ProfilePage** - Verification

### Engine Layer

- **DelayEngine** - Randomized timing
- **HumanEngine** - Mouse/keyboard simulation
- **Logger** - Structured logging

### Browser Management

- **BrowserContextFactory** - Persistent context creation
- One context per account
- Proxy support built-in

## 📝 License

ISC

---

**Built for controlled, observable, human-like LinkedIn article automation.**
# linkedin_automation
