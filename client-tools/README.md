# LinkedIn Company Follow – Quick Start

This tool follows a list of LinkedIn company pages from your LinkedIn account.
Everything is already set up – you just double-click two files.

## Before you start (one time)

1. **Install Node.js** – go to https://nodejs.org, download the **LTS** version, and install it
   (click Next/Continue through the installer).
2. **Have Google Chrome installed** (the normal Chrome browser).

## Step 1 – Unzip

Double-click the zip file. You get a folder called **`linkedin-follow-client`**.
Keep everything inside this folder together.

## Step 2 – Put in your list of companies

Open **`follow-list.xlsx`** in the folder and replace the example rows with your companies.

- Keep the two headers in row 1 exactly as they are: **Page Name** and **URL**.
- One company per row. The URL is the company's LinkedIn page, e.g.
  `https://www.linkedin.com/company/some-company/`.
- Save it with the **same name in the same folder**, then **close Excel**.

## Step 3 – Connect your LinkedIn account (one time)

Double-click **`1-Connect-LinkedIn`**
(Mac: `1-Connect-LinkedIn.command` · Windows: `1-Connect-LinkedIn.bat`).

A window opens and asks a few questions – type the answer and press **Enter**:

| Question | What to type |
|---|---|
| Account ID | A short name for yourself, e.g. `john` |
| Display name | Just press Enter |
| Email | The email you log in to LinkedIn with |
| Timezone | Just press Enter |
| Use proxy? | Just press Enter |

Then a Chrome window opens. **Log in to LinkedIn** there (enter any verification code LinkedIn asks for).
When your LinkedIn feed is showing, go back to the black window and press **Enter**.
You see **"SUCCESS! Your account is now connected."** Press Enter to close the window.

## Step 4 – Run the follow automation

Double-click **`2-Run-Follow`**
(Mac: `2-Run-Follow.command` · Windows: `2-Run-Follow.bat`).

That's it. It visits each company in your list and follows it. Chrome works in the background,
so you will mostly see lines of progress in the window. **Leave the computer on and the lid open**
until it says it is finished. One run handles up to 300 companies (this can take a few hours).

When it finishes you see a summary like:

```
Follow run summary:
  Processed:          300
  Followed:           250
  Already following:  50
  Failed:             0
```

If your list has more than 300 companies, or the run was interrupted, just double-click
**`2-Run-Follow`** again – it continues where it stopped and never repeats companies that are done.

## Where are the results?

In **`follow-list.xlsx`**. A new column named after your Account ID shows, for each company:

| Result | Meaning |
|---|---|
| `Followed` | Followed now |
| `Already following` | You were already following it |
| `Already following (Duplicate of row N)` | The same company is in the list twice |
| `Failed (...)` | Could not follow – the reason is in brackets. It is tried again on the next run. |

## Mac: "cannot be opened" / "Apple could not verify" message

The first time you double-click a file, your Mac may block it because it was downloaded.

- **Right-click** (or Control-click) the file → **Open** → **Open**.
- If there is no "Open" button: open **System Settings → Privacy & Security**, scroll down,
  click **Open Anyway** next to the file's name, then double-click the file again.

You only need to do this once per file.

## Windows: "Windows protected your PC" message

Click **More info** → **Run anyway**.

## More than one LinkedIn account on this computer

Do Step 3 once for each account, each with its own Account ID (e.g. `john`, then `mary`),
logging in with the matching LinkedIn account each time.

When you run Step 4 with several accounts connected, it asks which one to use:

```
Several LinkedIn accounts are connected on this computer:
  1) john
  2) mary
Type the number (or name) of the account to use, then press Enter:
```

Type `1` or `2` and press Enter. Run the accounts **one after another**, not at the same time.
Each account gets its own column in `follow-list.xlsx`.
To remove an account from this computer, delete its folder inside the `profiles` folder.

## If something goes wrong

| Message | What to do |
|---|---|
| `Node.js is not installed` | Install Node.js (see *Before you start*), then double-click again. |
| `No workbook found` | Make sure `follow-list.xlsx` is in the folder (Step 2). |
| `No LinkedIn account is connected` | Do Step 3 first. |
| `Cannot read and write the workbook` | Close `follow-list.xlsx` in Excel, then run again. |
| `Authentication problem` or `signed the account out` | LinkedIn logged you out. Do Step 3 again (same Account ID), then Step 4. |
| `LinkedIn showed a verification wall` | Open LinkedIn in Chrome, complete the check, wait a few hours, then run again. |
| `Chrome was closed during the run` | Run Step 4 again – finished companies are kept. |
| `Stopped after 4 pages in a row failed` | Check your internet connection and run again. If it keeps happening, contact your admin. |

For anything else, send your admin a screenshot of the window and the newest file in the `output/logs` folder.

---
Please do not share this folder with anyone: it contains the connection settings for your account.

<details><summary>For technical users (optional)</summary>

You can also run the tools from a terminal opened in this folder:

- `node cli/li-connect.js` – connect an account
- `node cli/li-follow.js` – run the automation
- `node cli/li-follow.js --accountId john` – pick an account without the question
- `node cli/li-follow.js --headed` – show the Chrome window
- `node cli/li-follow.js --dry-run` – preview the companies without opening LinkedIn
- `node cli/li-follow.js --file other.xlsx` – use a different workbook
- `node cli/li-follow.js --max-per-run 100` – limit how many companies one run handles

</details>
