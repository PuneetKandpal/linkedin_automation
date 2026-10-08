import { accessSync, constants, renameSync, unlinkSync } from 'fs';
import { basename, dirname, join } from 'path';
import * as XLSX from 'xlsx';

export type FollowStatus = 'Followed' | 'Already following' | 'Failed';

export interface FollowRow {
  /** 1-based sheet row number (the header row is row 1). */
  rowIndex: number;
  name: string;
  url: string;
  normalizedUrl: string | null;
  status: FollowStatus | '';
  note: string;
  /** The user's cell holds text this tool did not write (typed by hand); the row is left untouched. */
  custom: boolean;
}

const COMPANY_PATH = /^(\/company\/[^/]+)/i;

/** "Already following (Duplicate of row 87)" -> status + note. */
const STATUS_CELL = /^(Followed|Already following|Failed)\s*(?:\(([\s\S]*)\))?$/i;
const CANONICAL_STATUS: Record<string, FollowStatus> = {
  'followed': 'Followed',
  'already following': 'Already following',
  'failed': 'Failed',
};

/** Reads a status cell. Blank is pending; text this tool would not have written is flagged custom. */
export function parseStatusCell(text: string): { status: FollowStatus | ''; note: string; custom: boolean } {
  const value = (text || '').trim();
  if (value.length === 0) return { status: '', note: '', custom: false };
  const match = value.match(STATUS_CELL);
  if (!match) return { status: '', note: '', custom: true };
  return { status: CANONICAL_STATUS[match[1].toLowerCase()], note: (match[2] || '').trim(), custom: false };
}

/** Writes a status cell: the status, then any note in parentheses, e.g. "Failed (Page not found)". */
export function formatStatusCell(status: FollowStatus, note?: string): string {
  const clean = (note || '').replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return status;
  return `${status} (${clean.charAt(0).toUpperCase()}${clean.slice(1)})`;
}

/**
 * Normalizes a company page URL to https://www.linkedin.com/company/<slug>.
 * Tolerates missing schemes (linkedin.com/...), http://, viewAsMember params
 * (including typos like "truee"), and sub-pages such as /about, /posts, /jobs
 * (everything from the first sub-page segment onward is dropped). The slug
 * keeps its original case. Returns null when no /company/<slug> path exists.
 */
export function normalizeCompanyFollowUrl(raw: string): string | null {
  let value = (raw || '').trim();
  if (value.length === 0) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const match = parsed.pathname.match(COMPANY_PATH);
  if (!match) return null;
  return `https://www.linkedin.com${match[1]}`;
}

/**
 * The follow list. Column A/B hold the page name and URL; every user gets one
 * column further right, headed by their userid, holding that user's status for
 * each page. A user without a column gets one appended, so N users means N
 * extra columns and one user's run never touches another user's cells.
 */
export class FollowWorkbook {
  private filePath: string;
  private workbook: XLSX.WorkBook;
  private sheetName: string;
  private aoa: string[][];
  private nameCol: number;
  private urlCol: number;
  /** Column of the current user, or -1 when the workbook was opened without a user (read-only use). */
  private userCol: number;
  /** True when this load had to append the user's column. */
  readonly createdUserColumn: boolean;
  readonly rows: FollowRow[];

  private constructor(filePath: string, workbook: XLSX.WorkBook, sheetName: string, aoa: string[][], userId?: string) {
    this.filePath = filePath;
    this.workbook = workbook;
    this.sheetName = sheetName;
    this.aoa = aoa;

    const header = aoa[0] || [];
    this.nameCol = header.findIndex(h => /name/i.test(h));
    this.urlCol = header.findIndex(h => /url/i.test(h));
    if (this.nameCol < 0 || this.urlCol < 0) {
      throw new Error(`Follow workbook must have 'Page Name' and 'URL' header columns: ${filePath}`);
    }

    const user = (userId || '').trim();
    let created = false;
    this.userCol = -1;
    if (user.length > 0) {
      const existing = header.findIndex(h => h.trim().toLowerCase() === user.toLowerCase());
      if (existing === this.nameCol || existing === this.urlCol) {
        throw new Error(`User '${user}' is the name of the page name / URL column; use a different account id`);
      }
      if (existing >= 0) {
        this.userCol = existing;
      } else {
        header.push(user);
        this.userCol = header.length - 1;
        created = true;
      }
    }
    this.createdUserColumn = created;

    this.rows = [];
    for (let i = 1; i < aoa.length; i++) {
      const name = (aoa[i][this.nameCol] || '').trim();
      const url = (aoa[i][this.urlCol] || '').trim();
      if (!name && !url) continue;
      const cell = this.userCol >= 0 ? aoa[i][this.userCol] || '' : '';
      const parsed = parseStatusCell(cell);
      this.rows.push({
        rowIndex: i + 1,
        name,
        url,
        normalizedUrl: normalizeCompanyFollowUrl(url),
        status: parsed.status,
        note: parsed.note,
        custom: parsed.custom,
      });
    }
  }

  /** `userId` selects (or creates) that user's column; leave it out to only read the list. */
  static load(filePath: string, userId?: string): FollowWorkbook {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error(`Follow workbook has no sheets: ${filePath}`);
    const sheet = workbook.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' });
    const aoa = raw.map(row => row.map(cell => String(cell ?? '')));
    return new FollowWorkbook(filePath, workbook, sheetName, aoa, userId);
  }

  /** Rows that still need work: Followed / Already following rows are skipped, Failed rows are retried. */
  get pendingRows(): FollowRow[] {
    return this.rows.filter(row => !row.custom && row.status !== 'Followed' && row.status !== 'Already following');
  }

  /** Rows whose cell holds text typed by hand. They are never overwritten. */
  get customRows(): FollowRow[] {
    return this.rows.filter(row => row.custom);
  }

  /** Records this user's result for a row and writes the workbook back to disk immediately (crash-safe). */
  markStatus(row: FollowRow, status: FollowStatus, note?: string): void {
    if (this.userCol < 0) throw new Error('Open the workbook with a user id to record results');
    row.status = status;
    row.note = (note || '').replace(/\s+/g, ' ').trim();
    row.custom = false;
    const sheetRow = this.aoa[row.rowIndex - 1];
    sheetRow[this.userCol] = formatStatusCell(status, row.note);
    this.saveWorkbook();
  }

  /**
   * Writes to a temp file next to the workbook and renames it over the original, so a crash mid-write
   * cannot leave a half-written file. A read-only or locked workbook throws before anything is changed.
   */
  saveWorkbook(): void {
    const sheet = XLSX.utils.aoa_to_sheet(this.aoa);
    sheet['!cols'] = this.aoa[0].map((_, col) => {
      const longest = this.aoa.reduce((max, row) => Math.max(max, String(row[col] ?? '').length), 0);
      return { wch: Math.min(70, Math.max(12, longest + 2)) };
    });
    this.workbook.Sheets[this.sheetName] = sheet;

    accessSync(this.filePath, constants.W_OK);
    const temp = join(dirname(this.filePath), `.~${basename(this.filePath)}`);
    try {
      XLSX.writeFile(this.workbook, temp);
      renameSync(temp, this.filePath);
    } catch (err) {
      try {
        unlinkSync(temp);
      } catch {
        // nothing to clean up
      }
      throw err;
    }
  }
}

export function loadFollowWorkbook(filePath: string, userId?: string): FollowWorkbook {
  return FollowWorkbook.load(filePath, userId);
}
