# Content Generator

Writes an article for each row of an Excel file of input records, and saves the articles in a new Excel file next to
yours. Website rows become HTML articles, written by Claude. LinkedIn rows become Markdown articles, written by Gemini.

## Before the first run

1. Install **Node.js**, the LTS version, from https://nodejs.org (version 22 or newer). This is needed once per
   computer.
2. Unzip this folder somewhere you keep documents, for example in Documents.
3. On a Mac, the first time only: right-click **Generate Articles.command**, choose **Open**, then **Open** again. Mac
   asks this once for files that came from the internet. Do the same once for **Change API Keys.command**.
4. Have your two API keys ready, one for Claude and one for Gemini:
   - Claude: https://console.anthropic.com/settings/keys (starts with `sk-ant-`)
   - Gemini: https://aistudio.google.com/apikey (starts with `AIza`)

   Open the **config** folder, then **api-keys.txt** (it opens in TextEdit or Notepad). Paste each key right after
   its `=`, with no spaces or quotes, and save the file:

   ```
   ANTHROPIC_API_KEY=sk-ant-...
   GEMINI_API_KEY=AIza...
   ```

   Or leave the file as it is: the first time you open **Generate Articles**, the tool asks for each key, checks it
   with Claude or Gemini, and saves it in that file for you.

## Change the API keys

Double-click **Change API Keys** (`Change API Keys.command` on a Mac, `Change API Keys.bat` on Windows). For each key
it shows the start and end of the one in use. Paste the new key and press Enter, or just press Enter to keep the
current one. The tool checks the new key before saving it.

You can also edit **config/api-keys.txt** directly, as above. Do not share that file, or a copy of the folder
containing it.

## Make articles

1. Double-click **Generate Articles** (`Generate Articles.command` on a Mac, `Generate Articles.bat` on Windows).
2. **Drag your Excel file** into the window and press **Enter**. (Or press Enter on its own to choose the file in a
   window.)
3. Answer the questions. Each one has the usual answer typed in already, so **Enter** accepts it; to choose another,
   delete it and type the number of your choice:
   - **Format**: Markdown (LinkedIn articles) or HTML (website articles). The answer typed in is the one your
     templates ask for.
   - **Model**: which AI writes the articles, with the cost of each per article.
   - **How many articles**: all the rows, or only the first few (try 1 or 2 first with a new kind of file).
   - **Live or batch queue**: now at full price, or half price with the articles back usually within an hour.
   - **Missing values**: if the templates use values such as `{{base_year}}` that your Excel file has no column
     for, let the AI estimate them, or type one value used for every row.
4. Read the summary (how many articles, which model, the estimated cost) and press **Enter** to start.
5. The articles are saved in `<your file> - Output (date and time).xlsx`, in the same folder as your file, each one as
   soon as it is ready.

An article marked **⚠ check before publishing** has something to look at in its row, such as a missing link.

If some rows are still empty at the end (for example after a network problem), run the tool again and choose the
**output** file: only the empty rows are written.

## Small and large runs

Fewer than 10 articles are written straight away. With 10 or more, the tool sends them to Claude's and Gemini's batch
queue instead, which costs **half as much**. The articles then come back after a few minutes, and larger runs can take
up to an hour or more. The tool waits for them and saves them as they arrive.

## If your laptop sleeps, restarts, or you close the window

With the batch queue, the articles are written on Claude's and Gemini's computers, not on your laptop. Once the tool
shows **"Waiting for the results"**, you can close the lid, close the window or restart: nothing is lost.

When you next open the tool, it first checks the runs still waiting. It saves the articles that are ready, offers to
wait for the rest, and only then asks for a new Excel file. Nothing is ever sent or paid for twice.

The only moment to avoid is the few seconds while the tool shows "Sending ... to the batch queue". If the connection
drops then, the tool says the batch was not sent, and nothing is charged: just run it again.

## Three rules

1. Once **"Waiting for the results"** appears, you can close the lid.
2. To collect later, **open the tool again**, with an internet connection.
3. **Do not rename or delete the output file** until its articles have arrived. If you moved it to another folder,
   choose it in the tool from its new place, and the articles are saved into it.

## Batch Monitor.xlsx

This file in the tool's folder keeps the history of every run:

- **Runs**: one line per run, with the file, the number of articles written and failed, and **what it cost**.
- **Batches**: each batch sent to Claude or Gemini, and its status.
- **Errors**: every article that failed, with the exact reply from Claude or Gemini.

The tool reads this file to know which batches are still waiting, so do not edit it or save changes in it. You can
open it to look at any time. If it is open while the tool runs, the tool asks you to close it at the end, so the run
can be recorded.

## If something goes wrong

- **"Node.js is not installed"**, or a version too old: install the LTS version from https://nodejs.org.
- **Mac says the file cannot be opened**: right-click **Generate Articles.command**, choose **Open**, then **Open** again.
- **"not accepted"** when you paste a key, or a run stops with an error about the API key: the key is wrong,
  revoked, or out of credit. Create a new one (links above) and enter it with **Change API Keys**.
- **Anything else**: send `Batch Monitor.xlsx` and `output/logs/latest_generate.log` from the tool's folder with your
  question.

## The input file

- Every row needs a **Report Title** and a **Prompt Template**.
- A template that asks for a link, such as "(Paste Discount link here)", needs that link in the row's **Sample
  Download Link**, **Discount Link** or **Customization Link** column.
- Other columns are kept in the output.
