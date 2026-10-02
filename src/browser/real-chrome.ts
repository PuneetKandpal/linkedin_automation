import { execFile, spawn, ChildProcess } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { createServer } from 'net';
import { chromium, Browser, BrowserContext, Page } from 'playwright';

/**
 * Opens the user's installed Google Chrome as a normal app (not Playwright's bundled Chromium)
 * and attaches over CDP. Playwright-launched browsers carry automation flags that LinkedIn's
 * Cloudflare blocks; a plain Chrome process does not.
 *
 * Chrome 136+ refuses remote debugging on the default profile, so each account gets its own
 * persistent profile directory instead of the user's everyday one.
 *
 * Works on macOS and Windows (and Linux). Two modes:
 * - visible (bootstrap): a normal Chrome window the user logs in with.
 * - background (worker): Chrome starts with no window, then one working window is created
 *   off-screen. Nothing is shown and nothing takes keyboard focus. It is still a real, windowed
 *   Chrome — headless Chrome identifies itself and LinkedIn rejects the session.
 */

/** Where the background working window ended up. */
export type WindowPlacement = 'offscreen' | 'minimized' | 'visible';

export type RealChromeSession = {
  browser: Browser;
  context: BrowserContext;
  /** The tab most likely showing LinkedIn (falls back to any open tab). */
  currentPage(): Page | undefined;
  /** Background mode only. */
  windowPlacement?: WindowPlacement;
  /** Chrome processes that were still running on this profile and had to be closed first. */
  closedLeftovers: number;
  close(): Promise<void>;
};

const WINDOW_WIDTH = 1920;
const WINDOW_HEIGHT = 1080;
// Far beyond any real monitor layout (multi-monitor setups can have negative coordinates).
const OFFSCREEN_POS = -32000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function findChromePath(): string | undefined {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const candidates =
    process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : process.platform === 'win32'
        ? [
            `${process.env['PROGRAMFILES'] || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
            `${process.env['LOCALAPPDATA'] || ''}\\Google\\Chrome\\Application\\chrome.exe`,
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

  return candidates.find(p => p && existsSync(p));
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

async function connectWithRetry(endpoint: string, exitCode: () => number | null, timeoutMs: number): Promise<Browser> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    const code = exitCode();
    if (code !== null) {
      throw new Error(
        `Chrome exited immediately (code ${code}). Close any other Chrome window using this account's profile and retry.`
      );
    }
    try {
      return await chromium.connectOverCDP(endpoint);
    } catch (err) {
      lastErr = err;
      await sleep(500);
    }
  }
  throw new Error(
    `Could not connect to Chrome at ${endpoint}: ${String(lastErr)}. ` +
      `If another Chrome window is using this account's profile, close it and retry.`
  );
}

function execFileText(cmd: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
      err ? rej(err) : res(String(stdout))
    );
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Main Chrome processes (not helpers/renderers) running with this exact --user-data-dir. */
async function findChromeOnProfile(userDataDir: string): Promise<Array<{ pid: number; port?: number }>> {
  const listing =
    process.platform === 'win32'
      ? await execFileText('powershell', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
        ])
      : await execFileText('ps', ['-axo', 'pid=,command=']);

  const caseFold = (v: string) => (process.platform === 'win32' ? v.toLowerCase() : v);
  const needle = caseFold(`--user-data-dir=${userDataDir}`);
  const found: Array<{ pid: number; port?: number }> = [];

  for (const rawLine of listing.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = line.match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const command = m[2];
    if (pid === process.pid || command.includes('--type=')) continue;

    const at = caseFold(command).indexOf(needle);
    if (at === -1) continue;
    // Exact profile match: "profiles/sumit" must not match "profiles/sumit2".
    const next = command.charAt(at + needle.length);
    if (next !== '' && next !== ' ' && next !== '"') continue;

    const port = command.match(/--remote-debugging-port=(\d+)/);
    found.push({ pid, port: port ? Number(port[1]) : undefined });
  }
  return found;
}

/**
 * A Chrome still running on this profile (e.g. a worker stopped with Ctrl+C mid-job, or a login
 * window left open) holds the profile lock: every new launch hands over to it and exits, so the
 * debugging connection is refused. Quit it cleanly over CDP, and force-kill it if it hangs.
 * Returns how many were closed.
 */
export async function closeLeftoverChrome(userDataDir: string): Promise<number> {
  let leftovers: Array<{ pid: number; port?: number }>;
  try {
    leftovers = await findChromeOnProfile(userDataDir);
  } catch {
    return 0; // could not list processes; the launch error message still explains what to do
  }
  if (leftovers.length === 0) return 0;

  for (const { port } of leftovers) {
    if (!port) continue;
    try {
      const leftover = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 3000 });
      try {
        const cdp = await leftover.newBrowserCDPSession();
        await cdp.send('Browser.close');
      } catch {
        // ignore
      }
      await leftover.close().catch(() => undefined);
    } catch {
      // not reachable; force-killed below
    }
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && leftovers.some(p => isAlive(p.pid))) {
    await sleep(250);
  }

  for (const { pid } of leftovers) {
    if (!isAlive(pid)) continue;
    try {
      if (process.platform === 'win32') {
        await execFileText('taskkill', ['/PID', String(pid), '/T', '/F']);
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      // ignore
    }
  }

  await sleep(1000); // let Chrome release the profile lock
  return leftovers.length;
}

/** True if the page is painting frames. Playwright waits on animation frames before clicking. */
async function isPainting(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(
      () =>
        new Promise<boolean>(res => {
          const timer = setTimeout(() => res(false), 2000);
          (globalThis as any).requestAnimationFrame(() => {
            clearTimeout(timer);
            res(true);
          });
        })
    );
  } catch {
    return false;
  }
}

/**
 * Creates the worker's single window off-screen. If Chrome pulls it back on-screen, or it does not
 * paint there, falls back to minimized, and as a last resort to a normal visible window.
 */
async function createBackgroundWindow(
  browser: Browser,
  context: BrowserContext
): Promise<{ page: Page; placement: WindowPlacement }> {
  const pagePromise = context.waitForEvent('page', { timeout: 15000 });
  const browserCdp = await browser.newBrowserCDPSession();
  await browserCdp.send('Target.createTarget', {
    url: 'about:blank',
    newWindow: true,
    background: true,
    left: OFFSCREEN_POS,
    top: OFFSCREEN_POS,
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
  });
  const page = await pagePromise;

  const session = await context.newCDPSession(page);
  try {
    const { windowId, bounds } = await session.send('Browser.getWindowForTarget');
    const offscreen = (bounds.left ?? 0) <= OFFSCREEN_POS / 2 || (bounds.top ?? 0) <= OFFSCREEN_POS / 2;
    if (offscreen && (await isPainting(page))) {
      return { page, placement: 'offscreen' };
    }

    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    if (await isPainting(page)) {
      return { page, placement: 'minimized' };
    }

    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: 0, top: 0, width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
    });
    return { page, placement: 'visible' };
  } finally {
    await session.detach().catch(() => undefined);
  }
}

export async function openRealChrome(params: {
  userDataDir: string;
  /** Page to open in visible mode. Background mode always starts on about:blank. */
  url: string;
  proxyServer?: string;
  extraArgs?: string[];
  /** Run without showing a window or taking focus (worker). Default: visible (bootstrap). */
  background?: boolean;
}): Promise<RealChromeSession> {
  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error('Google Chrome not found. Install Chrome or set CHROME_PATH to its executable.');
  }

  mkdirSync(params.userDataDir, { recursive: true });
  const closedLeftovers = await closeLeftoverChrome(params.userDataDir);
  const port = await getFreePort();

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${params.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (params.background) {
    args.push(
      // No window at startup; the working window is created off-screen over CDP.
      '--no-startup-window',
      // Chrome throttles windows it thinks are hidden; ours must keep running at full speed.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling'
    );
  }
  if (params.proxyServer) args.push(`--proxy-server=${params.proxyServer}`);
  if (params.extraArgs) args.push(...params.extraArgs);
  if (!params.background) args.push(params.url);

  // macOS: `open -g` starts the app without activating it (-n = separate instance), so Chrome
  // does not take over the menu bar or keyboard focus. Windows/Linux: Chrome has no window, so
  // there is nothing to bring to the front.
  const appBundle = chromePath.includes('.app/') ? chromePath.slice(0, chromePath.indexOf('.app/') + 4) : undefined;
  const launchedViaOpen = Boolean(params.background && process.platform === 'darwin' && appBundle);

  let child: ChildProcess | null = null;
  if (launchedViaOpen) {
    spawn('open', ['-n', '-g', '-a', appBundle as string, '--args', ...args], { stdio: 'ignore' });
  } else {
    child = spawn(chromePath, args, { stdio: 'ignore' });
  }

  const browser = await connectWithRetry(`http://127.0.0.1:${port}`, () => child?.exitCode ?? null, 20000);
  const context = browser.contexts()[0];

  const quit = async () => {
    // Quit Chrome cleanly so the profile (and its cookies) are flushed to disk.
    try {
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send('Browser.close');
    } catch {
      // ignore
    }
    try {
      await browser.close();
    } catch {
      // ignore
    }
    if (child && child.exitCode === null) child.kill();
  };

  if (!context) {
    await quit();
    throw new Error('Chrome started without a browser context');
  }

  let windowPlacement: WindowPlacement | undefined;
  if (params.background) {
    try {
      ({ placement: windowPlacement } = await createBackgroundWindow(browser, context));
    } catch (err) {
      await quit();
      throw err;
    }
  }

  return {
    browser,
    context,
    windowPlacement,
    closedLeftovers,
    currentPage() {
      const pages = context.pages();
      return pages.find(p => p.url().includes('linkedin.com')) || pages[0];
    },
    close: quit,
  };
}

export async function hasLinkedInAuthCookie(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies('https://www.linkedin.com');
  return cookies.some(c => c.name === 'li_at' && c.value.length > 0);
}
