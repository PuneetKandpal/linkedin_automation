import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import type { ApiError } from '../../api/http';
import { AccountsApi, type CreateAccountInput } from '../../api/accounts';
import { ArticlesApi, type CreateArticleInput } from '../../api/articles';
import { JobsApi, type BulkJobItem } from '../../api/jobs';
import { Badge, Button, Card, Field, InlineError, InlineSuccess, Note } from '../../components/ui';

type Mode = 'accounts' | 'articles' | 'schedule';

type RowError = {
  row: number;
  message: string;
};

type ParsedResult<T> = {
  items: T[];
  errors: RowError[];
};

function normHeader(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function isIsoDate(value: string): boolean {
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

function readFirstSheetRows(file: File): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.onload = () => {
      try {
        const data = reader.result;
        if (!(data instanceof ArrayBuffer)) throw new Error('Unexpected file data');
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        if (!firstSheetName) throw new Error('No sheets found');
        const sheet = workbook.Sheets[firstSheetName];
        const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
          defval: '',
        });
        resolve(raw);
      } catch (e) {
        reject(e);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

function parseAccounts(rows: Record<string, unknown>[]): ParsedResult<CreateAccountInput> {
  const items: CreateAccountInput[] = [];
  const errors: RowError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    const r = rows[i];

    const accountId = asString(r.accountId ?? r['account id'] ?? r['accountid']);
    const displayName = asString(r.displayName ?? r['display name']);
    const email = asString(r.email);
    const timezone = asString(r.timezone);
    const statusRaw = asString(r.status || 'active').toLowerCase();

    const status = statusRaw === 'disabled' ? 'disabled' : statusRaw === 'active' || statusRaw === '' ? 'active' : null;

    if (!accountId) errors.push({ row: rowNum, message: 'Missing accountId' });
    if (!displayName) errors.push({ row: rowNum, message: 'Missing displayName' });
    if (!email) errors.push({ row: rowNum, message: 'Missing email' });
    if (!timezone) errors.push({ row: rowNum, message: 'Missing timezone' });
    if (!status) errors.push({ row: rowNum, message: "status must be 'active' or 'disabled'" });

    if (accountId && displayName && email && timezone && status) {
      items.push({ accountId, displayName, email, timezone, status });
    }
  }

  return { items, errors };
}

function parseArticles(rows: Record<string, unknown>[]): ParsedResult<CreateArticleInput> {
  const items: CreateArticleInput[] = [];
  const errors: RowError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    const r = rows[i];

    const articleId = asString(r.articleId ?? r['article id'] ?? r['articleid']);
    const language = asString(r.language || 'en');
    const title = asString(r.title);
    const markdownContent = asString(r.markdownContent ?? r['markdown content'] ?? r.content ?? r.markdown);
    const coverImagePath = asString(r.coverImagePath ?? r['cover image url'] ?? r.coverImageUrl);
    const communityPostText = asString(r.communityPostText ?? r['community post text']);

    if (!articleId) errors.push({ row: rowNum, message: 'Missing articleId' });
    if (!language) errors.push({ row: rowNum, message: 'Missing language' });
    if (!title) errors.push({ row: rowNum, message: 'Missing title' });
    if (!markdownContent) errors.push({ row: rowNum, message: 'Missing markdownContent' });

    if (articleId && language && title && markdownContent) {
      items.push({
        articleId,
        language,
        title,
        markdownContent,
        coverImagePath: coverImagePath || undefined,
        communityPostText: communityPostText || undefined,
      });
    }
  }

  return { items, errors };
}

function parseSchedule(rows: Record<string, unknown>[]): ParsedResult<BulkJobItem> {
  const items: BulkJobItem[] = [];
  const errors: RowError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    const r = rows[i];

    const jobId = asString(r.jobId ?? r['job id'] ?? r['jobid']);
    const accountId = asString(r.accountId ?? r['account id'] ?? r['accountid']);
    const articleId = asString(r.articleId ?? r['article id'] ?? r['articleid']);
    const runAt = asString(r.runAt ?? r['run at'] ?? r['runat']);
    const companyPageUrl = asString(r.companyPageUrl ?? r['company page url'] ?? r['companypageurl']);
    const delayProfile = asString(r.delayProfile ?? r['delay profile'] ?? 'default');
    const typingProfile = asString(r.typingProfile ?? r['typing profile'] ?? 'medium');

    if (!accountId) errors.push({ row: rowNum, message: 'Missing accountId' });
    if (!articleId) errors.push({ row: rowNum, message: 'Missing articleId' });
    if (!runAt) errors.push({ row: rowNum, message: 'Missing runAt (ISO timestamp)' });
    if (runAt && !isIsoDate(runAt)) errors.push({ row: rowNum, message: 'runAt must be a valid date/time' });
    if (!companyPageUrl) errors.push({ row: rowNum, message: 'Missing companyPageUrl' });

    if (accountId && articleId && runAt && isIsoDate(runAt) && companyPageUrl) {
      items.push({
        jobId: jobId || undefined,
        accountId,
        articleId,
        runAt: new Date(runAt).toISOString(),
        companyPageUrl,
        delayProfile: delayProfile || undefined,
        typingProfile: typingProfile || undefined,
      });
    }
  }

  return { items, errors };
}

function canonicalizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(r => {
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      next[normHeader(k)] = v;
    }
    return next;
  });
}

export function BulkPage() {
  const [mode, setMode] = useState<Mode>('accounts');
  const [file, setFile] = useState<File | null>(null);

  const [minGapAccount, setMinGapAccount] = useState(20);
  const [minGapCompany, setMinGapCompany] = useState(60);

  const [markReady, setMarkReady] = useState(true);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [previewRows, setPreviewRows] = useState<Record<string, unknown>[]>([]);
  const [parsedCount, setParsedCount] = useState(0);
  const [rowErrors, setRowErrors] = useState<RowError[]>([]);

  const help = useMemo(() => {
    if (mode === 'accounts') {
      return 'Excel columns: accountId, displayName, email, timezone, status (active|disabled).';
    }
    if (mode === 'articles') {
      return 'Excel columns: articleId, language, title, markdownContent, coverImagePath (optional), communityPostText (optional).';
    }
    return 'Excel columns: jobId (optional), accountId, articleId, runAt (ISO), companyPageUrl, delayProfile (optional), typingProfile (optional).';
  }, [mode]);

  async function loadPreview(nextFile: File) {
    setError(null);
    setSuccess(null);
    setFile(nextFile);
    setLoading(true);
    try {
      const raw = await readFirstSheetRows(nextFile);
      const rows = canonicalizeRows(raw);
      setPreviewRows(rows.slice(0, 20));

      const result = mode === 'accounts' ? parseAccounts(rows) : mode === 'articles' ? parseArticles(rows) : parseSchedule(rows);
      setRowErrors(result.errors);
      setParsedCount(result.items.length);
    } catch (e) {
      setError((e as Error).message || String(e));
      setPreviewRows([]);
      setRowErrors([]);
      setParsedCount(0);
    } finally {
      setLoading(false);
    }
  }

  async function submit() {
    if (!file) return;
    setError(null);
    setSuccess(null);
    setLoading(true);
    try {
      const raw = await readFirstSheetRows(file);
      const rows = canonicalizeRows(raw);

      if (mode === 'accounts') {
        const result = parseAccounts(rows);
        setRowErrors(result.errors);
        setParsedCount(result.items.length);
        if (result.errors.length > 0) {
          setError('Fix validation errors before submitting.');
          return;
        }
        const resp = await AccountsApi.bulkCreate(result.items);
        setSuccess(`Created ${resp.accountIds.length} accounts`);
        return;
      }

      if (mode === 'articles') {
        const result = parseArticles(rows);
        setRowErrors(result.errors);
        setParsedCount(result.items.length);
        if (result.errors.length > 0) {
          setError('Fix validation errors before submitting.');
          return;
        }
        const resp = await ArticlesApi.bulkCreate(result.items);
        if (markReady && resp.articleIds.length > 0) {
          await ArticlesApi.bulkMarkReady(resp.articleIds);
        }
        setSuccess(`Created ${resp.articleIds.length} articles${markReady ? ' and marked ready' : ''}`);
        return;
      }

      const result = parseSchedule(rows);
      setRowErrors(result.errors);
      setParsedCount(result.items.length);
      if (result.errors.length > 0) {
        setError('Fix validation errors before submitting.');
        return;
      }

      const resp = await JobsApi.bulk({
        schedulePolicy: {
          minGapMinutesPerAccount: minGapAccount,
          minGapMinutesPerCompanyPage: minGapCompany,
        },
        items: result.items,
      });

      setSuccess(`Scheduled ${resp.jobIds.length} jobs`);
    } catch (e) {
      setError((e as ApiError).message || String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid">
      <Card title="Bulk (Excel Upload)">
        {success ? <InlineSuccess message={success} /> : null}
        {error ? <InlineError message={error} /> : null}

        <div className="form">
          <Field label="Template">
            <select
              value={mode}
              onChange={e => {
                setMode(e.target.value as Mode);
                setPreviewRows([]);
                setRowErrors([]);
                setParsedCount(0);
                setFile(null);
              }}
            >
              <option value="accounts">Bulk Accounts</option>
              <option value="articles">Bulk Articles</option>
              <option value="schedule">Bulk Scheduling</option>
            </select>
          </Field>

          <Note text={help} />

          {mode === 'articles' ? (
            <Field label="After import">
              <label className="row" style={{ gap: 8 }}>
                <input type="checkbox" checked={markReady} onChange={e => setMarkReady(e.target.checked)} />
                Mark imported articles as ready
              </label>
            </Field>
          ) : null}

          {mode === 'schedule' ? (
            <div className="form twoCols">
              <Field label="Min gap minutes per account">
                <input type="number" value={minGapAccount} onChange={e => setMinGapAccount(Number(e.target.value))} />
              </Field>
              <Field label="Min gap minutes per company page">
                <input type="number" value={minGapCompany} onChange={e => setMinGapCompany(Number(e.target.value))} />
              </Field>
            </div>
          ) : null}

          <Field label="Excel file (.xlsx)">
            <input
              type="file"
              accept=".xlsx"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) void loadPreview(f);
              }}
            />
          </Field>

          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="row" style={{ gap: 8 }}>
              <Badge tone={rowErrors.length > 0 ? 'danger' : 'ok'} text={`${parsedCount} valid rows`} />
              {rowErrors.length > 0 ? <Badge tone="warn" text={`${rowErrors.length} errors`} /> : null}
            </div>
            <Button variant="primary" onClick={() => void submit()} disabled={!file || loading || rowErrors.length > 0}>
              Import
            </Button>
          </div>
        </div>
      </Card>

      {rowErrors.length > 0 ? (
        <Card title="Validation errors">
          <div className="tableWrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {rowErrors.slice(0, 50).map((e, idx) => (
                  <tr key={idx}>
                    <td className="muted">{e.row}</td>
                    <td>{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Note text="Only the first 50 errors are shown." />
        </Card>
      ) : null}

      {previewRows.length > 0 ? (
        <Card title="Preview (first 20 rows)">
          <div className="tableWrap">
            <table className="table">
              <thead>
                <tr>
                  {Object.keys(previewRows[0] || {}).slice(0, 8).map(k => (
                    <th key={k}>{k}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((r, idx) => (
                  <tr key={idx}>
                    {Object.keys(previewRows[0] || {}).slice(0, 8).map(k => (
                      <td key={k} className="muted">{asString(r[k])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Note text="If you have more than 8 columns, only the first 8 are shown in preview." />
        </Card>
      ) : null}
    </div>
  );
}
