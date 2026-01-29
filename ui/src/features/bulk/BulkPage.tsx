import { useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import type { ApiError } from '../../api/http';
import { AccountsApi, type CreateAccountInput } from '../../api/accounts';
import { ArticlesApi, type CreateArticleInput } from '../../api/articles';
import { JobsApi, type BulkJobItem } from '../../api/jobs';
import { Badge, Button, Card, Field, InlineError, InlineSuccess, Modal, Note } from '../../components/ui';

type Mode = 'accounts' | 'articles' | 'schedule';

type RowError = {
  row: number;
  message: string;
};

type ParsedResult<T> = {
  items: T[];
  errors: RowError[];
};

type RowPreview = {
  row: number;
  data: Record<string, unknown>;
};

function pickCell(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in row) return row[key];
  }
  return undefined;
}

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

function isCsvFile(file: File): boolean {
  return file.type === 'text/csv' || /\.csv$/i.test(file.name);
}

function readFirstSheetRows(file: File): Promise<Record<string, unknown>[]> {
  const csv = isCsvFile(file);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.onload = () => {
      try {
        const data = reader.result;
        const workbook = csv
          ? (() => {
              if (typeof data !== 'string') throw new Error('Unexpected CSV data');
              return XLSX.read(data, { type: 'string' });
            })()
          : (() => {
              if (!(data instanceof ArrayBuffer)) throw new Error('Unexpected file data');
              return XLSX.read(data, { type: 'array' });
            })();
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
    if (csv) {
      reader.readAsText(file);
    } else {
      reader.readAsArrayBuffer(file);
    }
  });
}

function parseAccounts(rows: Record<string, unknown>[]): ParsedResult<CreateAccountInput> {
  const items: CreateAccountInput[] = [];
  const errors: RowError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    const r = rows[i];

    const accountId = asString(pickCell(r, 'accountid', 'accountId', 'account id'));
    const displayName = asString(pickCell(r, 'displayname', 'displayName', 'display name'));
    const email = asString(pickCell(r, 'email'));
    const timezone = asString(pickCell(r, 'timezone'));
    const statusRaw = asString(pickCell(r, 'status') ?? 'active').toLowerCase();

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

    const articleId = asString(pickCell(r, 'articleid', 'articleId', 'article id'));
    const language = asString(pickCell(r, 'language') ?? 'en');
    const title = asString(pickCell(r, 'title'));
    const markdownContent = asString(
      pickCell(r, 'markdowncontent', 'markdownContent', 'markdown content', 'content', 'markdown')
    );
    const coverImagePath = asString(pickCell(r, 'coverimagepath', 'coverImagePath', 'cover image url', 'coverImageUrl'));
    const communityPostText = asString(
      pickCell(r, 'communityposttext', 'communityPostText', 'community post text')
    );

    if (!articleId) errors.push({ row: rowNum, message: 'Missing articleId' });
    if (!language) errors.push({ row: rowNum, message: 'Missing language' });
    if (!title) errors.push({ row: rowNum, message: 'Missing title' });
    if (!markdownContent) errors.push({ row: rowNum, message: 'Missing markdownContent' });
    if (!coverImagePath) errors.push({ row: rowNum, message: 'Missing coverImagePath' });
    if (!communityPostText) errors.push({ row: rowNum, message: 'Missing communityPostText' });

    if (articleId && language && title && markdownContent && coverImagePath && communityPostText) {
      items.push({
        articleId,
        language,
        title,
        markdownContent,
        coverImagePath,
        communityPostText,
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

    const jobId = asString(pickCell(r, 'jobid', 'jobId', 'job id'));
    const accountId = asString(pickCell(r, 'accountid', 'accountId', 'account id'));
    const articleId = asString(pickCell(r, 'articleid', 'articleId', 'article id'));
    const runAt = asString(pickCell(r, 'runat', 'runAt', 'run at'));
    const companyPageUrl = asString(pickCell(r, 'companypageurl', 'companyPageUrl', 'company page url'));
    const delayProfile = asString(pickCell(r, 'delayprofile', 'delayProfile') ?? 'default');
    const typingProfile = asString(pickCell(r, 'typingprofile', 'typingProfile') ?? 'medium');

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

  const [previewRows, setPreviewRows] = useState<RowPreview[]>([]);
  const [parsedCount, setParsedCount] = useState(0);
  const [rowErrors, setRowErrors] = useState<RowError[]>([]);
  const [hasImported, setHasImported] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [errorModalOpen, setErrorModalOpen] = useState(false);
  const [errorModalRow, setErrorModalRow] = useState<number | null>(null);
  const [errorModalMessages, setErrorModalMessages] = useState<string[]>([]);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [confirmHasErrors, setConfirmHasErrors] = useState(false);

  const help = useMemo(() => {
    if (mode === 'accounts') {
      return 'Excel columns: accountId, displayName, email, timezone, status (active|disabled).';
    }
    if (mode === 'articles') {
      return 'Excel columns: articleId, language, title, markdownContent, coverImagePath, communityPostText.';
    }
    return 'Excel columns: jobId (optional), accountId, articleId, runAt (ISO), companyPageUrl, delayProfile (optional), typingProfile (optional).';
  }, [mode]);

  const errorMap = useMemo(() => {
    const map: Record<number, string[]> = {};
    for (const e of rowErrors) {
      if (!map[e.row]) map[e.row] = [];
      map[e.row].push(e.message);
    }
    return map;
  }, [rowErrors]);

  const errorRowCount = useMemo(() => Object.keys(errorMap).length, [errorMap]);

  const previewColumns = useMemo(() => {
    const cols = new Set<string>();
    for (const r of previewRows) {
      for (const k of Object.keys(r.data)) cols.add(k);
    }
    return Array.from(cols);
  }, [previewRows]);

  const hasAnyErrors = errorRowCount > 0;

  function resetPreviewState() {
    setPreviewRows([]);
    setRowErrors([]);
    setParsedCount(0);
    setHasImported(false);
  }

  function clearFileSelection() {
    setFile(null);
    resetPreviewState();
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  async function loadPreview(nextFile: File) {
    setError(null);
    setSuccess(null);
    setFile(nextFile);
    setLoading(true);
    setHasImported(false);
    try {
      const raw = await readFirstSheetRows(nextFile);
      const rows = canonicalizeRows(raw);

      setPreviewRows(rows.map((data, idx) => ({ row: idx + 2, data })));

      const result = mode === 'accounts' ? parseAccounts(rows) : mode === 'articles' ? parseArticles(rows) : parseSchedule(rows);
      setRowErrors(result.errors);
      setParsedCount(result.items.length);
      setHasImported(true);
    } catch (e) {
      setError((e as Error).message || String(e));
      setPreviewRows([]);
      setRowErrors([]);
      setParsedCount(0);
      setHasImported(false);
    } finally {
      setLoading(false);
    }
  }

  async function submit({ skipErrors }: { skipErrors: boolean }) {
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
        if (result.errors.length > 0 && !skipErrors) {
          setError('Fix validation errors before submitting or choose to skip error rows.');
          return;
        }
        const resp = await AccountsApi.bulkCreate(result.items);
        setSuccess(`Created ${resp.accountIds.length} accounts`);
        clearFileSelection();
        return;
      }

      if (mode === 'articles') {
        const result = parseArticles(rows);
        setRowErrors(result.errors);
        setParsedCount(result.items.length);
        if (result.errors.length > 0 && !skipErrors) {
          setError('Fix validation errors before submitting or choose to skip error rows.');
          return;
        }
        const resp = await ArticlesApi.bulkCreate(result.items);
        if (markReady && resp.articleIds.length > 0) {
          await ArticlesApi.bulkMarkReady(resp.articleIds);
        }
        setSuccess(`Created ${resp.articleIds.length} articles${markReady ? ' and marked ready' : ''}`);
        clearFileSelection();
        return;
      }

      const result = parseSchedule(rows);
      setRowErrors(result.errors);
      setParsedCount(result.items.length);
      if (result.errors.length > 0 && !skipErrors) {
        setError('Fix validation errors before submitting or choose to skip error rows.');
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
      clearFileSelection();
    } catch (e) {
      setError((e as ApiError).message || String(e));
    } finally {
      setLoading(false);
    }
  }

  function handleUploadRequest() {
    if (!file || !hasImported) return;
    setConfirmHasErrors(hasAnyErrors);
    setConfirmModalOpen(true);
  }

  async function handleConfirmUpload(skip: boolean) {
    if (!file) return;
    setConfirmModalOpen(false);
    await submit({ skipErrors: skip });
  }

  function openRowErrors(row: number) {
    const msgs = errorMap[row] || [];
    if (msgs.length === 0) return;
    setErrorModalRow(row);
    setErrorModalMessages(msgs);
    setErrorModalOpen(true);
  }

  return (
    <div className="bulkLayout">
      <Card title="Bulk (Excel Upload)">
        {success ? <InlineSuccess message={success} /> : null}
        {error ? <InlineError message={error} /> : null}

        <div className="form">
          <Field label="Template">
            <select
              className="selectFancy"
              value={mode}
              onChange={e => {
                setMode(e.target.value as Mode);
                resetPreviewState();
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
              <div className="toggleSwitch">
                <button
                  type="button"
                  className={`toggleButton${markReady ? ' active' : ''}`}
                  aria-pressed={markReady}
                  onClick={() => setMarkReady(prev => !prev)}
                >
                  <span className="srOnly">Toggle mark ready</span>
                </button>
                <span className="toggleLabel">Mark imported articles as ready</span>
              </div>
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

          <Field label="Spreadsheet file (.xlsx or .csv)">
            <div className="filePicker">
              <button type="button" className="filePickerButton" onClick={() => fileInputRef.current?.click()}>
                Choose file
              </button>
              <span className="filePickerName">{file ? file.name : 'No file selected'}</span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.csv"
              style={{ display: 'none' }}
              onChange={e => {
                const f = e.target.files?.[0] ?? null;
                if (!f) {
                  clearFileSelection();
                  return;
                }
                void loadPreview(f);
              }}
            />
          </Field>

          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Badge tone={hasAnyErrors ? 'danger' : 'ok'} text={`${parsedCount} valid rows`} />
              {hasAnyErrors ? <Badge tone="warn" text={`${errorRowCount} row${errorRowCount === 1 ? '' : 's'} with errors`} /> : null}
            </div>
            <div className="row" style={{ gap: 8 }}>
              <Button
                variant="primary"
                onClick={handleUploadRequest}
                disabled={!file || !hasImported || loading}
              >
                Upload Data
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {previewRows.length > 0 ? (
        <Card title="Preview">
          <div className="tableWrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Row</th>
                  {previewColumns.map(k => (
                    <th key={k}>{k}</th>
                  ))}
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {previewRows.map(r => {
                  const errs = errorMap[r.row] || [];
                  return (
                    <tr key={r.row}>
                      <td className="muted">{r.row}</td>
                      {previewColumns.map(k => (
                        <td key={k} className="muted">{asString(r.data[k])}</td>
                      ))}
                      <td>
                        {errs.length > 0 ? (
                          <Button variant="ghost" onClick={() => openRowErrors(r.row)}>
                            {errs.length} error{errs.length === 1 ? '' : 's'}
                          </Button>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Note text={`Preview shows all ${previewRows.length} row${previewRows.length === 1 ? '' : 's'}.`} />
        </Card>
      ) : null}

      <Modal
        open={errorModalOpen}
        title={errorModalRow ? `Row ${errorModalRow} errors` : 'Row errors'}
        onClose={() => setErrorModalOpen(false)}
        footer={
          <Button variant="ghost" onClick={() => setErrorModalOpen(false)}>
            Close
          </Button>
        }
      >
        <div className="form">
          {errorModalMessages.map((m, idx) => (
            <div key={idx} className="error">
              {m}
            </div>
          ))}
        </div>
      </Modal>

      <Modal
        open={confirmModalOpen}
        title={confirmHasErrors ? 'Skip error rows?' : 'Confirm upload'}
        onClose={() => setConfirmModalOpen(false)}
        footer={
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="ghost" onClick={() => setConfirmModalOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleConfirmUpload(confirmHasErrors)}
              disabled={loading}
            >
              {confirmHasErrors ? 'Skip & Upload' : 'Upload'}
            </Button>
          </div>
        }
      >
        {confirmHasErrors ? (
          <div className="form">
            <p>
              There are {errorRowCount} row{errorRowCount === 1 ? '' : 's'} with validation errors. Skip them and upload
              the remaining {parsedCount} valid row{parsedCount === 1 ? '' : 's'}?
            </p>
          </div>
        ) : (
          <div className="form">
            <p>Upload {parsedCount} row{parsedCount === 1 ? '' : 's'} now?</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
