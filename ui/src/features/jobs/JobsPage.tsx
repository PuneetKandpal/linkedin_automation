import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiError } from '../../api/http';
import { AccountsApi } from '../../api/accounts';
import { ArticlesApi } from '../../api/articles';
import { JobsApi } from '../../api/jobs';
import { ConfigApi } from '../../api/config';
import type { Account, Article, PublishJob } from '../../api/types';
import { Card, Field, InlineError, Button, Badge, Modal, InlineSuccess, Note, Drawer, Loader } from '../../components/ui';
import { generateJobId } from '../../utils/id';
import { TabContext } from '../../context/TabContext';
import { NAVIGATE_ACCOUNT_KEY, NAVIGATE_ARTICLE_KEY } from '../../constants/navigation';

function toIsoFromLocal(value: string): string {
  const d = new Date(value);
  return d.toISOString();
}

function normalizeCompanyPageUrl(url?: string): string | null {
  if (!url) return null;
  const raw = url.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.origin.toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return raw.toLowerCase().replace(/\/+$/, '');
  }
}

function companyKeyFrom(input: { companyPageUrl?: string; companyPageName?: string }): string | null {
  const urlKey = normalizeCompanyPageUrl(input.companyPageUrl);
  if (urlKey) return `url:${urlKey}`;
  const name = (input.companyPageName || '').trim().toLowerCase();
  if (name) return `name:${name}`;
  return null;
}

type SearchOption = {
  value: string;
  label: string;
  note?: string;
  disabled?: boolean;
};

function defaultLocalDateTime(minutesFromNow: number): string {
  const d = new Date(Date.now() + minutesFromNow * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function SearchSelect(
  props: {
    value: string;
    placeholder?: string;
    options: SearchOption[];
    onChange: (value: string) => void;
    onBlur?: () => void;
    disabled?: boolean;
  }
) {
  const { value, options, onChange, onBlur, placeholder, disabled } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);

  const selected = useMemo(() => options.find(o => o.value === value) || null, [options, value]);

  useEffect(() => {
    function handlePointerDown(event: Event) {
      if (!containerRef.current) return;
      const target = event.target as Node | null;
      if (!target || !containerRef.current.contains(target)) {
        setOpen(false);
        setQuery('');
        onBlur?.();
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        setQuery('');
        onBlur?.();
      }
    }
    const opts: AddEventListenerOptions = { capture: true };
    document.addEventListener('pointerdown', handlePointerDown, opts);
    window.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, opts);
      window.removeEventListener('keydown', handleKey);
    };
  }, [onBlur]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(o => o.label.toLowerCase().includes(q));
  }, [options, query]);

  function selectOption(opt: SearchOption) {
    if (opt.disabled) return;
    onChange(opt.value);
    setQuery('');
    setOpen(false);
    onBlur?.();
  }

  return (
    <div className="searchSelect" ref={containerRef}>
      <input
        className="searchSelectInput"
        disabled={disabled}
        value={open ? query : selected?.label ?? ''}
        placeholder={placeholder}
        onFocus={() => {
          if (disabled) return;
          setOpen(true);
          setQuery('');
        }}
        onChange={e => {
          if (disabled) return;
          setQuery(e.target.value);
          setOpen(true);
        }}
        onBlur={() => {
          if (!open) onBlur?.();
        }}
      />
      {open ? (
        <div className="searchSelectList">
          {filtered.length === 0 ? (
            <div className="searchSelectEmpty">No matches</div>
          ) : (
            filtered.map(opt => (
              <button
                key={opt.value}
                type="button"
                className={`searchSelectOption${opt.disabled ? ' disabled' : ''}${opt.value === value ? ' selected' : ''}`}
                onMouseDown={e => {
                  e.preventDefault();
                  selectOption(opt);
                }}
                disabled={opt.disabled}
              >
                <span>{opt.label}</span>
                {opt.note ? <span className="searchSelectBadge">{opt.note}</span> : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

export function JobsPage() {
  const tabCtx = useContext(TabContext);
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
  const sortedJobs = useMemo(() => {
    return [...jobs].sort((a, b) => new Date(b.runAt).getTime() - new Date(a.runAt).getTime());
  }, [jobs]);

  const [jobId, setJobId] = useState(generateJobId());
  const [accountId, setAccountId] = useState('');
  const [articleId, setArticleId] = useState('');
  const [runAtLocal, setRunAtLocal] = useState(() => defaultLocalDateTime(10));
  const [delayProfile, setDelayProfile] = useState('default');
  const [typingProfile, setTypingProfile] = useState('medium');
  const [companyPageUrl, setCompanyPageUrl] = useState('');

  const [delayProfiles, setDelayProfiles] = useState<string[]>([]);
  const [typingProfiles, setTypingProfiles] = useState<string[]>([]);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkJson, setBulkJson] = useState('');
  const [bulkMinGapAccount, setBulkMinGapAccount] = useState(20);
  const [bulkMinGapCompany, setBulkMinGapCompany] = useState(60);

  const [republishConfirmOpen, setRepublishConfirmOpen] = useState(false);
  const [republishConfirmMessage, setRepublishConfirmMessage] = useState<string>('');
  const [republishConfirmDetail, setRepublishConfirmDetail] = useState<string>('');
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [cancelJobId, setCancelJobId] = useState<string>('');

  const [touched, setTouched] = useState<{ [k: string]: boolean }>({});

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const [j, a, art, cfg] = await Promise.all([JobsApi.list(), AccountsApi.list(), ArticlesApi.list(), ConfigApi.profiles()]);
      setJobs(j);
      setAccounts(a);
      setArticles(art);
      setDelayProfiles(cfg.delayProfiles);
      setTypingProfiles(cfg.typingProfiles);
      if (cfg.delayProfiles.length > 0) {
        setDelayProfile(prev => (cfg.delayProfiles.includes(prev) ? prev : cfg.delayProfiles[0]));
      } else {
        setDelayProfile('');
      }
      if (cfg.typingProfiles.length > 0) {
        setTypingProfile(prev => (cfg.typingProfiles.includes(prev) ? prev : cfg.typingProfiles[0]));
      } else {
        setTypingProfile('');
      }
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
      const parsed: unknown = JSON.parse(bulkJson || '{}');
      const obj = (parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null);
      const items = obj && Array.isArray(obj.items)
        ? obj.items
        : obj && Array.isArray(obj.jobs)
          ? obj.jobs
          : null;
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

  const accountOptions = useMemo(() =>
    accounts
      .filter(a => a.status === 'active')
      .map(a => ({
        value: a.accountId,
        label: `${a.displayName} (${a.accountId})`,
        disabled: a.linkStatus !== 'linked',
        note: a.linkStatus !== 'linked' ? 'Unlinked' : undefined,
      })),
  [accounts]);

  const selectedAccount = useMemo(
    () => accounts.find(a => a.accountId === accountId) || null,
    [accounts, accountId]
  );

  const accountsMap = useMemo(() => {
    const map = new Map<string, Account>();
    accounts.forEach(a => map.set(a.accountId, a));
    return map;
  }, [accounts]);

  const articlesMap = useMemo(() => {
    const map = new Map<string, Article>();
    articles.forEach(a => map.set(a.articleId, a));
    return map;
  }, [articles]);

  const companyPageOptions = useMemo(() => {
    const pages = selectedAccount?.companyPages || [];
    return pages;
  }, [selectedAccount]);

  const selectedCompanyPageName = useMemo(() => {
    const norm = normalizeCompanyPageUrl(companyPageUrl);
    if (!norm) return undefined;
    return companyPageOptions.find(p => normalizeCompanyPageUrl(p.url) === norm)?.name;
  }, [companyPageOptions, companyPageUrl]);

  const articleOptions = useMemo(() => {
    const selectedCompanyKey = companyKeyFrom({ companyPageUrl, companyPageName: selectedCompanyPageName });
    return articles.map(a => {
      const publishedCompanyKey = companyKeyFrom({
        companyPageUrl: a.publishedFromCompanyPageUrl,
        companyPageName: a.publishedFromCompanyPageName,
      });
      const isPublishedHere =
        a.status === 'published' &&
        Boolean(selectedCompanyKey && publishedCompanyKey && selectedCompanyKey === publishedCompanyKey);

      return {
        value: a.articleId,
        label: `${a.title} (${a.articleId})`,
        disabled: a.status === 'draft',
        note: a.status === 'draft' ? 'Draft' : isPublishedHere ? 'Published here' : undefined,
      };
    });
  }, [articles, companyPageUrl, selectedCompanyPageName]);

  const formErrors = useMemo(() => {
    const e: Record<string, string> = {};
    if (!jobId.trim()) e.jobId = 'Job ID is required';
    if (!accountId) e.accountId = 'Select an account';
    if (!articleId) e.articleId = 'Select an article';
    if (!runAtLocal) e.runAtLocal = 'Run At is required';
    if (!companyPageUrl) e.companyPageUrl = 'Select a company page';
    if (!delayProfile) e.delayProfile = 'Select a delay profile';
    if (!typingProfile) e.typingProfile = 'Select a typing profile';
    return e;
  }, [accountId, articleId, jobId, runAtLocal, companyPageUrl, delayProfile, typingProfile]);

  const canSubmit = Object.keys(formErrors).length === 0;

  const selectedArticle = useMemo(() => articlesMap.get(articleId) || null, [articlesMap, articleId]);

  const publishedHere = useMemo(() => {
    const art = selectedArticle;
    if (!art || art.status !== 'published') return false;
    const selectedCompanyKey = companyKeyFrom({ companyPageUrl, companyPageName: selectedCompanyPageName });
    const publishedCompanyKey = companyKeyFrom({
      companyPageUrl: art.publishedFromCompanyPageUrl,
      companyPageName: art.publishedFromCompanyPageName,
    });
    return Boolean(selectedCompanyKey && publishedCompanyKey && selectedCompanyKey === publishedCompanyKey);
  }, [companyPageUrl, selectedArticle, selectedCompanyPageName]);

  const goToAccount = useCallback(
    (targetAccountId: string) => {
      if (!targetAccountId) return;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(NAVIGATE_ACCOUNT_KEY, targetAccountId);
        window.dispatchEvent(
          new CustomEvent(NAVIGATE_ACCOUNT_KEY, { detail: { accountId: targetAccountId } })
        );
      }
      tabCtx?.setTab('accounts');
    },
    [tabCtx]
  );

  const goToArticle = useCallback(
    (targetArticleId: string) => {
      if (!targetArticleId) return;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(NAVIGATE_ARTICLE_KEY, targetArticleId);
        window.dispatchEvent(
          new CustomEvent(NAVIGATE_ARTICLE_KEY, { detail: { articleId: targetArticleId } })
        );
      }
      tabCtx?.setTab('articles');
    },
    [tabCtx]
  );

  function openSchedule() {
    setJobId(generateJobId());
    setRunAtLocal(defaultLocalDateTime(10));
    setDelayProfile(delayProfiles.includes('default') ? 'default' : delayProfiles[0] ?? '');
    setTypingProfile(typingProfiles.includes('medium') ? 'medium' : typingProfiles[0] ?? '');
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

  async function doCreateJob() {
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
        companyPageName: selectedCompanyPageName,
      });
      setJobId(generateJobId());
      await refreshAll();
      setScheduleOpen(false);
      setSuccess('Publish job scheduled');
    } catch (e) {
      setError((e as ApiError).message || String(e));
    }
  }

  async function createJob() {
    const art = selectedArticle;
    if (art?.status === 'published') {
      const selectedCompanyKey = companyKeyFrom({ companyPageUrl, companyPageName: selectedCompanyPageName });
      const publishedCompanyKey = companyKeyFrom({
        companyPageUrl: art.publishedFromCompanyPageUrl,
        companyPageName: art.publishedFromCompanyPageName,
      });

      const publishedOn = art.publishedFromCompanyPageName || art.publishedFromCompanyPageUrl || 'a company page';
      const targetOn = companyPageOptions.find(p => normalizeCompanyPageUrl(p.url) === normalizeCompanyPageUrl(companyPageUrl))?.name
        || companyPageUrl
        || 'the selected company page';

      if (selectedCompanyKey && publishedCompanyKey && selectedCompanyKey === publishedCompanyKey) {
        setRepublishConfirmMessage(`This article is already published on ${publishedOn}.`);
        setRepublishConfirmDetail(`Do you want to re-publish it again on ${targetOn}?`);
      } else {
        setRepublishConfirmMessage('This article is already published.');
        setRepublishConfirmDetail('Do you want to schedule it again for publishing?');
      }

      setRepublishConfirmOpen(true);
      return;
    }

    await doCreateJob();
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

  function requestCancel(job: PublishJob) {
    setCancelJobId(job.jobId);
    setCancelConfirmOpen(true);
  }

  function openFailure(job: PublishJob) {
    setFailureJobId(job.jobId);
    setFailureOpen(true);
  }

  return (
    <div className="jobsLayout">
      <Card
        title="Publish Jobs"
        right={
          <div className="row">
            <Button variant="primary" onClick={openSchedule}>
              Schedule
            </Button>
            <Button variant="ghost" onClick={openBulk}>
              Bulk schedule (JSON)
            </Button>
            <Button variant="ghost" onClick={() => void refreshAll()} disabled={loading}>
              Refresh
            </Button>
          </div>
        }
      >
        <Note text="Scheduling requires the selected account to be linked (bootstrap) and the company page to be added under that account." />
        {success ? <InlineSuccess message={success} /> : null}
        {error ? <InlineError message={error} /> : null}
        {loading ? <Loader label="Refreshing…" /> : null}
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Account</th>
                <th>Company page</th>
                <th>Article</th>
                <th>Run At</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedJobs.map(j => (
                <tr key={j.jobId}>
                  <td>
                    <div className="strong">{j.jobId}</div>
                  </td>
                  <td>
                    <button type="button" className="linkButton" onClick={() => goToAccount(j.accountId)}>
                      {accountsMap.get(j.accountId)?.displayName || j.accountId}
                    </button>
                    <div className="muted">{j.accountId}</div>
                  </td>
                  <td>
                    {j.companyPageUrl ? (
                      <a className="linkButton" href={j.companyPageUrl} target="_blank" rel="noreferrer">
                        {j.companyPageName || j.companyPageUrl}
                      </a>
                    ) : (
                      <div className="strong">{j.companyPageName || '—'}</div>
                    )}
                  </td>
                  <td>
                    <button type="button" className="linkButton" onClick={() => goToArticle(j.articleId)}>
                      {articlesMap.get(j.articleId)?.title || j.articleId}
                    </button>
                    <div className="muted">{j.articleId}</div>
                  </td>
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
                  <td>
                    <div className="row">
                      {j.status === 'failed' ? (
                        <Button variant="ghost" onClick={() => openFailure(j)}>
                          View
                        </Button>
                      ) : null}
                      {j.status === 'pending' ? (
                        <Button variant="ghost" onClick={() => requestCancel(j)}>
                          Cancel
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Drawer
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
        <div className="form">
          <Field label="Account" error={touched.accountId ? formErrors.accountId : undefined}>
            <SearchSelect
              value={accountId}
              options={accountOptions}
              placeholder="Search account…"
              onChange={value => {
                setAccountId(value);
                setCompanyPageUrl('');
                setArticleId('');
              }}
              onBlur={() => setTouched(t => ({ ...t, accountId: true }))}
            />
          </Field>

          <Field label="Company page" error={touched.companyPageUrl ? formErrors.companyPageUrl : undefined}>
            <select
              value={companyPageUrl}
              onChange={e => {
                setCompanyPageUrl(e.target.value);
                setArticleId('');
              }}
              onBlur={() => setTouched(t => ({ ...t, companyPageUrl: true }))}
              disabled={!accountId}
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
            <SearchSelect
              value={articleId}
              options={companyPageUrl ? articleOptions : []}
              placeholder={!companyPageUrl ? 'Select company page first…' : 'Search article…'}
              onChange={setArticleId}
              onBlur={() => setTouched(t => ({ ...t, articleId: true }))}
              disabled={!companyPageUrl}
            />
            {publishedHere ? <div style={{ marginTop: 8 }}><span className="chip">Published here</span></div> : null}
          </Field>

          <Field label="Run At" error={touched.runAtLocal ? formErrors.runAtLocal : undefined}>
            <input
              type="datetime-local"
              value={runAtLocal}
              onChange={e => setRunAtLocal(e.target.value)}
              onBlur={() => setTouched(t => ({ ...t, runAtLocal: true }))}
              disabled={!articleId}
            />
          </Field>

          <Field label="Delay Profile" error={touched.delayProfile ? formErrors.delayProfile : undefined}>
            <select
              value={delayProfile}
              onChange={e => setDelayProfile(e.target.value)}
              onBlur={() => setTouched(t => ({ ...t, delayProfile: true }))}
              disabled={delayProfiles.length === 0 || !articleId}
            >
              <option value="" disabled>
                {delayProfiles.length === 0 ? 'No profiles' : 'Select delay profile'}
              </option>
              {delayProfiles.map(profile => (
                <option key={profile} value={profile}>
                  {profile}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Typing Profile" error={touched.typingProfile ? formErrors.typingProfile : undefined}>
            <select
              value={typingProfile}
              onChange={e => setTypingProfile(e.target.value)}
              onBlur={() => setTouched(t => ({ ...t, typingProfile: true }))}
              disabled={typingProfiles.length === 0 || !articleId}
            >
              <option value="" disabled>
                {typingProfiles.length === 0 ? 'No profiles' : 'Select typing profile'}
              </option>
              {typingProfiles.map(profile => (
                <option key={profile} value={profile}>
                  {profile}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Job ID" error={touched.jobId ? formErrors.jobId : undefined}>
            <div className="inputWithButton">
              <input
                value={jobId}
                onChange={e => setJobId(e.target.value)}
                onBlur={() => setTouched(t => ({ ...t, jobId: true }))}
                disabled={!articleId}
              />
              <Button variant="ghost" onClick={() => setJobId(generateJobId())} disabled={!articleId}>
                Generate
              </Button>
            </div>
          </Field>
        </div>
      </Drawer>

      <Modal
        open={republishConfirmOpen}
        title="Confirm re-publish"
        onClose={() => setRepublishConfirmOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRepublishConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setRepublishConfirmOpen(false);
                void doCreateJob();
              }}
            >
              Re-publish
            </Button>
          </>
        }
      >
        <Note text={republishConfirmMessage} />
        <div className="muted" style={{ marginTop: 8 }}>
          {republishConfirmDetail}
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
        open={cancelConfirmOpen}
        title="Cancel publish job?"
        onClose={() => setCancelConfirmOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCancelConfirmOpen(false)}>
              Keep job
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setCancelConfirmOpen(false);
                if (cancelJobId) void cancelJob(cancelJobId);
              }}
            >
              Cancel job
            </Button>
          </>
        }
      >
        <p className="strong">Job ID: {cancelJobId}</p>
        <p className="muted" style={{ marginTop: 8 }}>This job will no longer run. This cannot be undone.</p>
      </Modal>

      <Modal
        open={failureOpen}
        title={failureJob ? `Failure: ${failureJob.jobId}` : 'Job failure'}
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
