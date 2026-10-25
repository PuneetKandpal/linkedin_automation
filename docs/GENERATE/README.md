# Content generation (`li-generate`)

`li-generate` is the n8n workflow "GenAI Content Automation" as a terminal tool. It reads an Excel workbook of input
records, writes one article per row, and saves the articles to an output workbook with the workflow's output columns.
The four workbooks in this folder are sample input and output records.

Each row is written in the format its template asks for, by the model chosen for that format:

| Template asks for | Example | Written by (default) | Cost per article, live | In the batch queue |
|---|---|---|---|---|
| HTML (`Output: Clean HTML`) | Website records | Claude Haiku 5.5 (`claude-haiku-5-5`) | about $0.006–0.015 | about $0.003–0.004 |
| Markdown (`FORMAT: Markdown`) | LinkedIn records | Gemini 3.1 Flash-Lite (`gemini-3.1-flash-lite`) | about $0.005 | about $0.0024 |

Runs of 10 or more articles go through the providers' batch queue, which bills half price and returns the articles
later instead of one by one. Smaller runs, such as a quick test, are written live.

## Setup (once)

1. Node.js 22 or newer. In the repository root: `npm install`, then `npm run build`.
2. Put the API keys in the `.env` file (see `.env.example`): `ANTHROPIC_API_KEY` for Claude and `GEMINI_API_KEY` for Gemini.

## Run

Double-click `scripts/client/3-Generate-Articles.command` (Mac) or `3-Generate-Articles.bat` (Windows), or run
`node cli/li-generate.js`. Then:

1. Drag the Excel file into the terminal window and press Enter (an empty Enter opens a file chooser: Finder on a
   Mac, Explorer on Windows). If earlier batch runs are still waiting to be collected, the tool shows and collects
   them first; see "Batch queue" below.
2. Answer the questions. Each has its default typed in, so Enter accepts it:
   - format: Markdown or HTML, preset to what the templates ask for (`FORMAT: Markdown` / `Output: Clean HTML`), with
     "as each row's template asks" when the rows differ;
   - model for each format, with the estimated cost per article, preset to `config/generate.json`'s;
   - how many articles (the first rows that still need one);
   - live or batch queue, preset to the batch queue from `batchMinArticles` articles;
   - values for template placeholders the workbook has no column for: left to the model, or one value for every row.

   An option given on the command line (`--format`, `--html-model`/`--markdown-model`, `--limit`,
   `--batch`/`--live`) answers its question instead; `--yes` skips all of them and the confirmation.
3. Read the plan (how many articles, which model, estimated cost) and press Enter to start.
4. Each article is saved as soon as it is ready. The output is `<input name> - Output (DD_MM_YY_HHMMSS).xlsx`, next to
   the input file.

To check a workbook first and read the exact prompts, without sending anything: `node cli/li-generate.js --dry-run`.

Closing the window stops a live run. Finished articles are kept. To fill in the rows still without an article (failed
or stopped), run the tool again on the output file: rows that already have an article are skipped and the file is
updated in place. For a batch run, closing the window loses nothing at all; see below.

### Batch queue (10 or more articles)

With the batch queue, the articles are written on Anthropic's and Google's computers, not on your laptop. Once they
have been sent, your laptop can sleep, restart or be switched off: nothing is lost, and the articles arrive in the
Excel file the next time the tool can collect them.

How a batch run goes:

1. **Send** (a few seconds). Website rows go to Claude, LinkedIn rows to Gemini, each tagged with its row.
2. **Record.** Before waiting, the tool writes down what it sent: in a hidden file next to the output, and in the
   batch monitor (see below).
3. **Wait.** Every 30 seconds the tool asks the provider whether the batch is finished. In tests, Claude returned
   5 Website articles in under 4 minutes and Gemini 5 LinkedIn articles in about 2 minutes. Larger batches take
   longer; Anthropic says most finish within an hour.
4. **Collect.** The tool downloads the articles, puts each in its row, checks it and saves the Excel file.

#### If your laptop sleeps, restarts, or you close the window

| When | What happens |
|---|---|
| While sending (the first seconds, before "Waiting for the results" appears) | The only moment to avoid. If the connection drops, the tool says the batch was not sent, and nothing is charged: run it again. |
| While waiting | Nothing is lost. The articles are still being written at the provider; the tool pauses with the laptop and carries on checking when it wakes. |
| Hours later, after a restart, or after closing the window | Open the tool again. It lists the runs not collected yet, collects the ones that are ready, and offers to wait for the rest. Nothing is sent or charged twice. |

Anthropic keeps finished articles for 29 days and Google for 6 weeks, so there is plenty of time to collect them.
A batch must finish being written within 24 hours (Anthropic) or 48 hours (Google); rows of a batch that does not
come back empty and can simply be run again.

#### Three rules

1. Once **"Waiting for the results"** appears, you can close the lid.
2. To collect later, **open the tool again** (with an internet connection).
3. **Do not rename or delete the output file** until its articles have arrived. If you moved it to another folder,
   choose it in the tool from its new place and the articles are collected into it.

#### Batch Monitor.xlsx and checking on runs

`Batch Monitor.xlsx`, at the top of the tool's folder, is the tool's record of every run, and what it reads after a
sleep, a closed window or a restart to find the batches still waiting:

- **Runs**: one line per run, live or batch, with its input and output files, articles written and failed, and its
  **cost** (batch runs at batch prices, failed attempts included).
- **Batches**: each batch sent to a provider, with its status, the provider's last reported state, its cost, the
  provider's batch id (to look it up in the Anthropic or Google console) and its recovery file.
- **Errors**: every failed article or batch, with the provider's raw reply.

The tool reads the sheets back by their column headers, so look at it freely but do not edit it. If it is open in
Excel when a run ends, the tool asks to close it; changes it still cannot save wait in a hidden file next to it and
are added the next time it can be written. The hidden recovery file next to each output is a second record, so a
batch can always be collected.

- `--status` lists the runs still waiting (checked with the providers at that moment), the latest finished runs with
  their costs, and the total spent so far.
- `--collect` collects every run still waiting, without asking anything (it waits for those still being written).

`--live` writes a run live instead (full price, immediate); `--batch` uses the queue for a run of any size. The
threshold is `batchMinArticles` in `config/generate.json`. The batch queue needs a Gemini key with billing enabled;
the key tested here has it.

## Client package

`scripts/package-generate-client.sh [version] [--with-keys]` builds `content-generator-client-v<version>.zip` in the
repository root: a "Content Generator" folder that runs on its own, with the "Generate Articles" and "Change API Keys"
launchers, an empty `Batch Monitor.xlsx`, the client guide ([CLIENT_README.md](CLIENT_README.md)) as its README, and
the compiled tool with its dependencies. The client needs Node.js 22 or newer, installs it once, unzips the folder and
double-clicks "Generate Articles".

The package ships without API keys, and without a `.env`. The keys live in `config/api-keys.txt`, a plain
`NAME=key` text file shipped with empty `ANTHROPIC_API_KEY=` and `GEMINI_API_KEY=` lines to paste into after unzipping.
A key left empty is asked for on the first run, checked with the provider (a free model lookup) and saved to that
file. "Change API Keys" (`--keys`) replaces them later: it shows the start and end of each current key, and Enter
keeps it. When a run stops because a key was refused, the tool says how to replace it. `--with-keys` fills the file
with the API keys from the repository `.env` instead (only those, not the MongoDB settings); such a zip must be
shared privately. `.gitignore` keeps the zips and `config/api-keys.txt` out of git.

A key in `config/api-keys.txt` wins over one in `.env` or the environment; in the repository, without that file, the
tool uses `.env` as before.

## Options

| Option | What it does |
|---|---|
| `--file "<input.xlsx>"` | The workbook, instead of being asked for it |
| `--batch` / `--live` | Use the half-price batch queue, or write live now at full price, whatever the run's size |
| `--status` | Show the batch runs still waiting (checked with the providers now) and the latest finished |
| `--collect` | Collect every batch run still waiting, without asking anything |
| `--html-model <model>` / `--markdown-model <model>` | Another model for this run, e.g. `claude-sonnet-5-5`, `claude-haiku-5-5`, `gemini:gemini-2.5-flash` |
| `--format html\|markdown` | Write every row in this format, whatever its template asks for |
| `--parallel N` | Live runs: articles written at the same time (default 4) |
| `--limit N` | Only the first N rows that still need an article (try one before a large batch) |
| `--var name=value` | Value for `{{name}}` in every template, e.g. `--var base_year=2025` |
| `--max-tokens N` | Longest reply allowed per article, thinking included |
| `--retries N` | Live runs: extra attempts after a rate limit, overload or empty reply (default 3, a minute apart) |
| `--dry-run` | Check the workbook and show the prompts; nothing is sent or written |
| `--keys` | Enter or replace the API keys; each is checked with its provider and saved to `config/api-keys.txt` |
| `--yes` | Start without asking for confirmation |

The defaults (models, parallel articles, retries, the batch threshold, and the price table used for cost figures) are
in `config/generate.json`. Change a model there to change it for every run.

## Input columns

- `Report Title` and `Prompt Template` are required in every row.
- `Sample Download Link`, `Discount Link` and `Customization Link` are needed when the template has the matching
  `(Paste ... link here)` placeholder. The Website records have none.
- Other columns are copied to the output, and the template can use them as `{{column_name}}` (the header in lower
  case, spaces as underscores).

Headers match ignoring case, spaces and underscores, so a Supabase export of `Excel_outputs` loads as well.

## Placeholders

| In the template | Becomes |
|---|---|
| `{{industry_name}}` | the Report Title without its final "Market" (templates write `{{industry_name}} Market`) |
| `[XYZ]` | the Report Title; "[XYZ] market" does not turn into "... Market market" |
| `(Paste Sample Download link here)`, and the Discount and Customization versions | the row's link |
| `{{current_year}}` | this year |
| any other `{{name}}` | the row's `name` column, else `--var name=...` |

If a template asks for a link the row does not have, the tool lists the row and sends nothing.

## Checks on every article

The tool removes a ```` ```html ```` fence, notes such as "Word Count: 1,398 words", and an `<html>`/`<body>` page
wrapper. It marks an article "check before publishing" when a CTA link is missing or repeated, a raw `{{placeholder}}`
is printed, or the title heading is missing. The summary shows word counts against what the templates ask for, and
the cost of the run.

## Test results on the sample records (October 2026)

| Model | Format | Cost per article | Result |
|---|---|---|---|
| Claude Haiku 4.5 (the workflow's) | HTML | $0.022–0.026 | 1,793–2,295 words against 1,350–1,450; in the workflow's outputs every article was wrapped in a code fence and 4 of 5 ended with a wrong "Word Count" note |
| **Claude Haiku 5.5** | HTML | $0.006–0.015 | follows every template section, table and FAQ format; 1,106–1,402 words |
| Claude Sonnet 5.5 | HTML | $0.037–0.055 | similar quality to Haiku 5.5, about 7 times the cost |
| Claude Opus 5.5 | HTML | $0.13 | the richest analysis; about 20 times the cost |
| Gemini 2.5 Flash (the workflow's) | Markdown | $0.013 | all headings and CTAs right; 1,984–2,132 words |
| **Gemini 3.1 Flash-Lite** | Markdown | $0.005 | all headings and CTAs right; 2,201–2,389 words, over the 2,000-word cap |
| Claude Haiku 5.5 | Markdown | $0.006–0.007 | all headings and CTAs right; 1,705–1,809 words, within the cap |

Through the batch queue the same 5 Website articles cost $0.0178 in total (Claude Haiku 5.5) and the 5 LinkedIn
articles $0.0119 (Gemini 3.1 Flash-Lite), and passed the same checks as the live ones.

The workflow also spent a second Gemini 2.5 Flash call per row (about $0.009) to fill in placeholders, which the
tool does in code.

Two things in the templates are worth fixing at the source:

- **Website templates ask for "Exactly 1,400 words", but their section budgets (`~120w`, `~160w`, ...) add up to
  1,120–1,320 words.** Current models follow the section budgets, so articles come out under 1,400. Raise the
  section budgets to total 1,400 to get 1,400-word articles.
- **LinkedIn templates use `{{base_year}}`, `{{forecast_year}}`, `{{cagr}}`, `{{market_size_base}}`,
  `{{market_size_forecast}}`, `{{key_players_list}}`, `{{segments_list}}` and `{{regions_list}}`, which the input
  records never supply.** The models then estimate the figures (the workflow's first sample output printed
  `{{forecast_year}}` in its title instead). To publish real figures, add a column for each, or pass `--var`.

For LinkedIn articles that stay under the 2,000-word cap, use Claude Haiku 5.5 for Markdown too
(`"markdown": { "provider": "claude", "model": "claude-haiku-5-5", "maxTokens": 64000 }` in `config/generate.json`):
about $0.0015 more per article, and only an Anthropic key is needed.

## Differences from the workflow

- Placeholders are replaced in code, not by a second Gemini call. The template is never reworded, links are never
  invented, and each row costs one model call instead of two.
- The closing instructions each provider received are kept word for word, plus two rules: return only the article,
  and never print an unfilled `{{placeholder}}`.
- Articles are written several at a time, and a failed call is retried up to 3 times a minute apart (the workflow
  retried every 5 minutes without limit). A wrong API key or model stops the run at once.
- The OpenAI option works (`--html-model gpt-4o`). In the workflow, the OpenAI branch ended without saving the article
  or continuing the loop.
- Results go to an Excel file instead of the Supabase table `Excel_outputs`.
