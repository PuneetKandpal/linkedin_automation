import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiError } from '../../api/http';
import { AccountsApi } from '../../api/accounts';
import { ArticlesApi } from '../../api/articles';
import { JobsApi } from '../../api/jobs';
import type { Account, Article, PublishJob } from '../../api/types';
import { Card, Field, InlineError, Button, Badge, Modal, InlineSuccess, Note } from '../../components/ui';
import { generateJobId } from '../../utils/id';

function toIsoFromLocal(value: string): string {
  const d = new Date(value);
  return d.toISOString();
}

function defaultLocalDateTime(minutesFromNow: number): string {
  const d = new Date(Date.now() + minutesFromNow * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function JobsPage() {
  const [jobs, setJobs] = useState<PublishJob[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [failureOpen, setFailureOpen] = useState(false);
  const [failureJobId, setFailureJobId] = useState<string>('');
  const failureJob = useMemo(() => jobs.find(j => j.jobId === failureJobId) || null, [jobs, failureJobId]);

  const [jobId, setJobId] = useState(generateJobId());
  const [accountId, setAccountId] = useState('');
  const [articleId, setArticleId] = useState('');
  const [runAtLocal, setRunAtLocal] = useState(() => defaultLocalDateTime(10));
  const [delayProfile, setDelayProfile] = useState('default');
  const [typingProfile, setTypingProfile] = useState('medium');
  const [companyPageUrl, setCompanyPageUrl] = useState('');

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkJson, setBulkJson] = useState('');
  const [bulkMinGapAccount, setBulkMinGapAccount] = useState(20);
  const [bulkMinGapCompany, setBulkMinGapCompany] = useState(60);

  const [touched, setTouched] = useState<{ [k: string]: boolean }>({});

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const [j, a, art] = await Promise.all([JobsApi.list(), AccountsApi.list(), ArticlesApi.list()]);
      setJobs(j);
      setAccounts(a);
      setArticles(art);
      setAccountId(prev => prev || (a[0]?.accountId ?? ''));
      setArticleId(prev => prev || (art[0]?.articleId ?? ''));
    } catch (e) {
      setError((e as ApiError).message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  async function submitBulk() {
    setError(null);
    setSuccess(null);
    try {
      const parsed = JSON.parse(bulkJson || '{}') as any;
      const items = Array.isArray(parsed.items) ? parsed.items : (Array.isArray(parsed.jobs) ? parsed.jobs : null);
      if (!items) {
        setError('Bulk JSON must include items: []');
        return;
      }

      await JobsApi.bulk({
        schedulePolicy: {
          minGapMinutesPerAccount: bulkMinGapAccount,
          minGapMinutesPerCompanyPage: bulkMinGapCompany,
        },
        items,
      });
      await refreshAll();
      setBulkOpen(false);
      setSuccess('Bulk jobs scheduled');
    } catch (e) {
      setError((e as ApiError).message || String(e));
    }
  }

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const accountOptions = useMemo(() => accounts.filter(a => a.status === 'active'), [accounts]);

  const selectedAccount = useMemo(
    () => accounts.find(a => a.accountId === accountId) || null,
    [accounts, accountId]
  );

  const companyPageOptions = useMemo(() => {
    const pages = selectedAccount?.companyPages || [];
    return pages;
  }, [selectedAccount]);

  const articleOptions = useMemo(
    () => articles.filter(a => a.status !== 'published'),
    [articles]
  );

  const formErrors = useMemo(() => {
    const e: Record<string, string> = {};
    if (!jobId.trim()) e.jobId = 'Job ID is required';
    if (!accountId) e.accountId = 'Select an account';
    if (!articleId) e.articleId = 'Select an article';
    if (!runAtLocal) e.runAtLocal = 'Run At is required';
    if (!companyPageUrl) e.companyPageUrl = 'Select a company page';
    return e;
  }, [accountId, articleId, jobId, runAtLocal, companyPageUrl]);

  const canSubmit = Object.keys(formErrors).length === 0;

  function openSchedule() {
    setJobId(generateJobId());
    setRunAtLocal(defaultLocalDateTime(10));
    setDelayProfile('default');
    setTypingProfile('medium');
    setCompanyPageUrl('');
    setTouched({});
    setError(null);
    setSuccess(null);
    setScheduleOpen(true);
  }

  function openBulk() {
    setError(null);
    setSuccess(null);
    setBulkJson('');
    setBulkMinGapAccount(20);
    setBulkMinGapCompany(60);
    setBulkOpen(true);
  }

  async function createJob() {
    setError(null);
    setSuccess(null);
    setTouched({ jobId: true, accountId: true, articleId: true, runAtLocal: true, delayProfile: true, typingProfile: true });
    if (!canSubmit) return;
    try {
      await JobsApi.create({
        jobId,
        accountId,
        articleId,
        runAt: toIsoFromLocal(runAtLocal),
        delayProfile,
        typingProfile,
        companyPageUrl,
      });
      setJobId(generateJobId());
      await refreshAll();
      setScheduleOpen(false);
      setSuccess('Publish job scheduled');
    } catch (e) {
      setError((e as ApiError).message || String(e));
    }
  }

  async function cancelJob(id: string) {
    setError(null);
    setSuccess(null);
    try {
      await JobsApi.cancel(id);
      await refreshAll();
      setSuccess('Publish job canceled');
    } catch (e) {
      setError((e as ApiError).message || String(e));
    }
  }

  function openFailure(job: PublishJob) {
    setFailureJobId(job.jobId);
    setFailureOpen(true);
  }

  return (
    <div className="grid">
      <Card
        title="Publish Jobs"
        right={
          <Button variant="ghost" onClick={() => void refreshAll()} disabled={loading}>
            Refresh
          </Button>
        }
      >
        {success ? <InlineSuccess message={success} /> : null}
        {error ? <InlineError message={error} /> : null}
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Account</th>
                <th>Article</th>
                <th>Run At</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {jobs.map(j => (
                <tr key={j.jobId}>
                  <td>
                    <div className="strong">{j.jobId}</div>
                  </td>
                  <td className="muted">{j.accountId}</td>
                  <td className="muted">{j.articleId}</td>
                  <td>{new Date(j.runAt).toLocaleString()}</td>
                  <td>
                    <Badge
                      tone={
                        j.status === 'success'
                          ? 'ok'
                          : j.status === 'failed'
                            ? 'danger'
                            : j.status === 'running'
                              ? 'warn'
                              : 'neutral'
                      }
                      text={j.status}
                    />
                  </td>
                  <td className="row">
                    {j.status === 'failed' ? (
                      <Button variant="ghost" onClick={() => openFailure(j)}>
                        View
                      </Button>
                    ) : null}
                    {j.status === 'pending' ? (
                      <Button variant="ghost" onClick={() => void cancelJob(j.jobId)}>
                        Cancel
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="Schedule"
        right={
          <div className="row">
            <Button variant="primary" onClick={openSchedule}>
              Schedule
            </Button>
            <Button variant="ghost" onClick={openBulk}>
              Bulk schedule (JSON)
            </Button>
          </div>
        }
      >
        <Note text="Scheduling requires the selected account to be linked (bootstrap) and the company page to be added under that account." />
      </Card>

      <Modal
        open={scheduleOpen}
        title="Schedule Publish Job"
        onClose={() => setScheduleOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setScheduleOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void createJob()} disabled={!canSubmit}>
              Schedule
            </Button>
          </>
        }
      >
        {error ? <InlineError message={error} /> : null}
        <div className="form twoCols">
          <Field label="Job ID" error={touched.jobId ? formErrors.jobId : undefined}>
            <div className="inputWithButton">
              <input
                value={jobId}
                onChange={e => setJobId(e.target.value)}
                onBlur={() => setTouched(t => ({ ...t, jobId: true }))}
              />
              <Button variant="ghost" onClick={() => setJobId(generateJobId())}>
                Generate
              </Button>
            </div>
          </Field>

          <Field label="Account" error={touched.accountId ? formErrors.accountId : undefined}>
            <select
              value={accountId}
              onChange={e => setAccountId(e.target.value)}
              onBlur={() => setTouched(t => ({ ...t, accountId: true }))}
            >
              <option value="">Select…</option>
              {accountOptions.map(a => (
                <option key={a.accountId} value={a.accountId}>
                  {a.displayName} ({a.accountId})
                </option>
              ))}
            </select>
          </Field>

          <Field label="Company page" error={touched.companyPageUrl ? formErrors.companyPageUrl : undefined}>
            <select
              value={companyPageUrl}
              onChange={e => setCompanyPageUrl(e.target.value)}
              onBlur={() => setTouched(t => ({ ...t, companyPageUrl: true }))}
            >
              <option value="">Select…</option>
              {companyPageOptions.map(p => (
                <option key={p.pageId} value={p.url}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Article" error={touched.articleId ? formErrors.articleId : undefined}>
            <select
              value={articleId}
              onChange={e => setArticleId(e.target.value)}
              onBlur={() => setTouched(t => ({ ...t, articleId: true }))}
            >
              <option value="">Select article…</option>
              {articleOptions.map(a => (
                <option key={a.articleId} value={a.articleId}>
                  {a.title} ({a.articleId})
                </option>
              ))}
            </select>
          </Field>

          <Field label="Run At" error={touched.runAtLocal ? formErrors.runAtLocal : undefined}>
            <input
              type="datetime-local"
              value={runAtLocal}
              onChange={e => setRunAtLocal(e.target.value)}
              onBlur={() => setTouched(t => ({ ...t, runAtLocal: true }))}
            />
          </Field>

          <Field label="Delay Profile">
            <input value={delayProfile} onChange={e => setDelayProfile(e.target.value)} />
          </Field>
          <Field label="Typing Profile">
            <input value={typingProfile} onChange={e => setTypingProfile(e.target.value)} />
          </Field>
        </div>
      </Modal>

      <Modal
        open={bulkOpen}
        title="Bulk Schedule (JSON)"
        onClose={() => setBulkOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setBulkOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void submitBulk()}>
              Schedule jobs
            </Button>
          </>
        }
      >
        {error ? <InlineError message={error} /> : null}
        <div className="form">
          <Field label="Min gap minutes per account">
            <input
              type="number"
              value={bulkMinGapAccount}
              onChange={e => setBulkMinGapAccount(Number(e.target.value))}
            />
          </Field>
          <Field label="Min gap minutes per company page">
            <input
              type="number"
              value={bulkMinGapCompany}
              onChange={e => setBulkMinGapCompany(Number(e.target.value))}
            />
          </Field>
          <Field label="JSON payload (must include items: [])">
            <textarea
              value={bulkJson}
              onChange={e => setBulkJson(e.target.value)}
              rows={10}
              placeholder='{"items": [{"accountId":"acct_004","articleId":"art_0010","runAt":"2026-01-01T10:00:00.000Z","companyPageUrl":"https://www.linkedin.com/company/the-growth-signals/"}]}'
            />
          </Field>
          <Note text="Excel upload will be added later by converting rows into this same JSON format." />
        </div>
      </Modal>

      <Modal
        open={failureOpen}
        title={failureJob ? `Failure: ${failureJob.jobId}` : 'Failure'}
        onClose={() => setFailureOpen(false)}
        footer={
          <Button variant="ghost" onClick={() => setFailureOpen(false)}>
            Close
          </Button>
        }
      >
        {failureJob ? (
          <div className="form">
            <Field label="Error Step">
              <input value={failureJob.errorStep || ''} readOnly />
            </Field>
            <Field label="Error Code">
              <input value={failureJob.errorCode || ''} readOnly />
            </Field>
            <Field label="Error">
              <textarea value={failureJob.error || ''} readOnly rows={6} />
            </Field>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
