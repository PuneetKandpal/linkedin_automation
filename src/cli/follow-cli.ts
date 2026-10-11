#!/usr/bin/env node
import '../env';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { createInterface } from 'readline/promises';
import mongoose from 'mongoose';
import { connectMongo } from '../db/mongo';
import { decryptJson } from '../db/crypto';
import { AccountModel } from '../db/models/AccountModel';
import { StaticConfigLoader } from '../config/static-loader';
import { Logger } from '../engine/logger';
import { DelayEngine } from '../engine/delay.engine';
import { HumanEngine } from '../engine/human.engine';
import { BrowserContextFactory } from '../browser/context.factory';
import { FollowRunner, FollowRunSummary, shuffle } from '../services/follow-runner';
import { loadFollowWorkbook } from '../services/follow-excel';
import { ErrorCode, PublisherError } from '../errors/error.types';

const DEFAULT_MAX_PER_RUN = 300;
const DEFAULT_WORKBOOK = 'follow-list.xlsx';

/** Accounts connected on this computer: li-connect leaves one Chrome profile folder per account. */
function connectedAccounts(): string[] {
  try {
    return readdirSync(resolve('./profiles'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

async function chooseAccount(accounts: string[]): Promise<string | undefined> {
  console.log('Several LinkedIn accounts are connected on this computer:');
  accounts.forEach((id, i) => console.log(`  ${i + 1}) ${id}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Type the number (or name) of the account to use, then press Enter: ')).trim();
    const byNumber = accounts[Number(answer) - 1];
    return byNumber || accounts.find(id => id.toLowerCase() === answer.toLowerCase());
  } finally {
    rl.close();
  }
}

/** Without --file: follow-list.xlsx in the folder the tool is run from, else next to the tool itself. */
function defaultWorkbook(): string | undefined {
  return [resolve(process.cwd(), DEFAULT_WORKBOOK), resolve(__dirname, '../..', DEFAULT_WORKBOOK)].find(existsSync);
}

// CLI banner
console.log(`
╔═══════════════════════════════════════════════════════════════╗
║          LinkedIn Company Follow CLI v1.0.0                   ║
║                                                               ║
║  Follows company pages from an Excel workbook using your      ║
║  authenticated LinkedIn browser session. One-shot per run.    ║
╚═══════════════════════════════════════════════════════════════╝
`);

function getArgValue(flag: string): string | undefined {
  const idx = process.argv.findIndex(a => a === flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function printUsage(): void {
  console.log('Usage:');
  console.log('  li-follow [--accountId "<accountId>"] [--file "<workbook.xlsx>"] [--max-per-run N] [--headed] [--config-dir ./config]');
  console.log('');
  console.log('MongoDB URI and storage secret come from client-config.json or .env. To override them, add:');
  console.log('  --mongodb-uri "<uri>" --secret "<secret>"');
  console.log('');
  console.log('Without --accountId the account connected on this computer is used (when there is only one).');
  console.log(`Without --file the list is read from ${DEFAULT_WORKBOOK}: just replace that file with yours.`);
  console.log('Results go in a column named after the account id (created if missing), one column per user.');
  console.log('');
  console.log('Pre-flight check (no MongoDB, no browser):');
  console.log('  li-follow --dry-run --file "<workbook.xlsx>" [--accountId "<accountId>"] [--max-per-run N]');
  console.log('');
  console.log('Or set environment variables:');
  console.log('  MONGODB_URI="<uri>" STORAGE_STATE_SECRET="<secret>" li-follow --accountId "<accountId>" --file "<workbook.xlsx>"');
  console.log('');
}

const AUTH_ERROR_CODES = new Set<string>([
  ErrorCode.CAPTCHA_DETECTED,
  ErrorCode.OTP_REQUIRED,
  ErrorCode.LOGIN_REDIRECT,
  ErrorCode.SESSION_INVALID,
]);

async function runDryRun(file: string, maxPerRun: number, accountId?: string): Promise<void> {
  const workbook = loadFollowWorkbook(file, accountId);
  const pending = shuffle(workbook.pendingRows);
  const batch = pending.slice(0, maxPerRun);

  console.log(`Workbook: ${file}`);
  console.log(`Total rows: ${workbook.rows.length}`);
  if (accountId) {
    console.log(`User column '${accountId}': ${workbook.createdUserColumn ? 'not in the workbook yet (a run would add it)' : 'found'}`);
    console.log(`Pending rows (not yet Followed / Already following for ${accountId}): ${pending.length}`);
  } else {
    console.log(`Pending rows (no --accountId given, so every row counts): ${pending.length}`);
  }
  if (workbook.customRows.length > 0) {
    console.log(`Rows with hand-typed text that would be left alone: ${workbook.customRows.length}`);
  }
  console.log(`Would process this run (max ${maxPerRun}):`);
  for (const row of batch) {
    const target = row.normalizedUrl || `(invalid URL: ${row.url})`;
    console.log(`  [row ${row.rowIndex}] ${row.name} → ${target}`);
  }
}

function printSummary(summary: FollowRunSummary): void {
  console.log('');
  console.log('Follow run summary:');
  console.log(`  Processed:          ${summary.processed}`);
  console.log(`  Followed:           ${summary.followed}`);
  console.log(`  Already following:  ${summary.alreadyFollowing}`);
  console.log(`  Failed:             ${summary.failed}`);
  console.log(`  Challenge halt:     ${summary.challengeHalt}`);
}

async function main(): Promise<number> {
  const mongodbUri = getArgValue('--mongodb-uri') || process.env.MONGODB_URI;
  const secret = getArgValue('--secret') || process.env.STORAGE_STATE_SECRET;
  const connected = connectedAccounts();
  // Without --accountId: the account connected on this computer, when there is exactly one.
  let accountId = getArgValue('--accountId') || getArgValue('--account-id') || (connected.length === 1 ? connected[0] : undefined);
  const file = getArgValue('--file') || defaultWorkbook();
  const maxPerRunValue = Number(getArgValue('--max-per-run'));
  const maxPerRun = Number.isFinite(maxPerRunValue) && maxPerRunValue > 0 ? Math.floor(maxPerRunValue) : DEFAULT_MAX_PER_RUN;
  const configDir = getArgValue('--config-dir') || process.env.CONFIG_DIR || './config';
  const dryRun = hasFlag('--dry-run');
  const headed = hasFlag('--headed');

  if (!file) {
    console.error(`❌ No workbook found. Put your list in ${DEFAULT_WORKBOOK} next to this tool, or pass --file "<workbook.xlsx>".`);
    printUsage();
    return 1;
  }

  if (dryRun) {
    await runDryRun(file, maxPerRun, accountId);
    return 0;
  }

  // Several accounts and someone at the keyboard: ask which one instead of failing.
  if (!accountId && connected.length > 1 && process.stdin.isTTY && !dryRun) {
    accountId = await chooseAccount(connected);
    if (!accountId) {
      console.error('❌ That is not one of the accounts listed. Run again and type one of the numbers shown.');
      return 1;
    }
  }

  if (!accountId) {
    console.error(
      connected.length > 1
        ? `❌ Several accounts are connected on this computer (${connected.join(', ')}). Choose one with --accountId "<accountId>".`
        : '❌ No LinkedIn account is connected on this computer. Run "node cli/li-connect.js" first, or pass --accountId "<accountId>".'
    );
    return 1;
  }

  if (!mongodbUri || !secret) {
    console.error('❌ Missing required configuration.');
    printUsage();
    return 1;
  }

  // Fail now, not after a browser launch and a follow, if progress could not be saved (e.g. open in Excel).
  try {
    loadFollowWorkbook(file, accountId).saveWorkbook();
  } catch (err) {
    console.error(`❌ Cannot read and write the workbook "${file}": ${String(err)}`);
    console.error('   Close it in Excel if it is open, check it has Page Name and URL columns, then retry.');
    return 1;
  }

  process.env.MONGODB_URI = mongodbUri;
  process.env.STORAGE_STATE_SECRET = secret;

  // A sleeping Mac kills the browser mid-run. caffeinate exits by itself when this process does.
  if (process.platform === 'darwin') {
    try {
      spawn('caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore', detached: true }).unref();
    } catch {
      // keep-awake is a courtesy; the run works without it
    }
  }

  const runTs = new Date().toISOString().replace(/[:.]/g, '-');
  const logDir = resolve('./output/logs');
  mkdirSync(logDir, { recursive: true });

  const logger = new Logger({
    logFilePath: resolve(logDir, `follow_${accountId}_${runTs}.log`),
    latestLogPath: resolve(logDir, 'latest_follow.log'),
  });

  logger.info('Follow CLI → starting', { accountId, file, maxPerRun, configDir });

  let contextFactory: BrowserContextFactory | null = null;

  try {
    await connectMongo();

    const account = await AccountModel.findOne({ accountId }).lean();
    if (!account) {
      console.error(`❌ Account not found: ${accountId}. Connect the account first (li-connect).`);
      logger.error('Follow CLI → account not found', { accountId });
      return 1;
    }
    if (account.status !== 'active') {
      console.error(`❌ Account is not active: ${accountId}`);
      logger.error('Follow CLI → account not active', { accountId, status: account.status });
      return 1;
    }
    if (!account.storageStateEnc) {
      console.error(`❌ Account has no stored session: ${accountId}. Connect the account first (li-connect).`);
      logger.error('Follow CLI → account has no storage state', { accountId });
      return 1;
    }

    const storageState = decryptJson<unknown>(account.storageStateEnc);

    const loader = new StaticConfigLoader(configDir);
    const cfg = loader.loadAll();
    if (headed) {
      // Show the browser window for this run only; config/global.json stays as the worker expects it.
      cfg.global.browser.headless = false;
      cfg.global.browser.chromeWindow = 'visible';
    }

    const delayProfile = cfg.delays['follow'] ?? cfg.delays['default'];
    if (!delayProfile) {
      throw new Error('No delay profile found in delays.json (expected "follow" or "default")');
    }
    const typingProfile = cfg.typingProfiles['medium'] ?? cfg.typingProfiles[Object.keys(cfg.typingProfiles)[0]];
    if (!typingProfile) {
      throw new Error('No typing profile found in typing-profiles.json');
    }

    const delayEngine = new DelayEngine(delayProfile, logger);
    contextFactory = new BrowserContextFactory(cfg.global, logger);

    const context = await contextFactory.createContext({
      accountId: account.accountId,
      proxy: account.proxy,
      timezone: account.timezone,
      status: account.status,
      displayName: account.displayName,
      email: account.email,
      storageState,
    });

    const page = context.pages()[0] || (await context.newPage());
    const humanEngine = new HumanEngine(page, typingProfile, logger);

    const runner = new FollowRunner({
      account: { accountId: account.accountId, profileSlug: account.profileSlug },
      excelPath: file,
      maxPerRun,
      logger,
      delayEngine,
      humanEngine,
      selectors: cfg.selectors,
      page,
    });

    let summary: FollowRunSummary;
    try {
      summary = await runner.run();
    } catch (err) {
      if (err instanceof PublisherError) {
        logger.error('Follow CLI → run failed with typed error', { code: err.code, error: err.message });
        if (AUTH_ERROR_CODES.has(err.code)) {
          await AccountModel.updateOne(
            { accountId },
            { $set: { authStatus: 'needs_reauth', lastAuthError: err.message } }
          );
          console.error(`⚠️  Authentication problem (${err.code}): ${err.message}`);
          console.error('   The account was marked needs_reauth. Reconnect it with li-connect, then re-run.');
          return 2;
        }
        console.error(`❌ Follow run failed: [${err.code}] ${err.message}`);
        return 1;
      }
      logger.error('Follow CLI → run failed', { error: String(err) });
      console.error(`❌ Follow run failed: ${String(err)}`);
      return 1;
    }

    printSummary(summary);

    if (summary.challengeHalt) {
      console.log('⚠️  LinkedIn showed a verification wall. The run stopped early; remaining rows stay blank for the next run.');
      return 2;
    }
    return 0;
  } catch (err) {
    logger.error('Follow CLI → fatal error', { error: String(err) });
    console.error(`❌ Fatal error: ${String(err)}`);
    return 1;
  } finally {
    if (contextFactory) {
      await contextFactory.closeContext();
    }
    await mongoose.disconnect();
  }
}

main()
  .then(code => {
    process.exitCode = code;
  })
  .catch(err => {
    // eslint-disable-next-line no-console
    console.error('❌ Fatal:', err);
    process.exitCode = 1;
  });
