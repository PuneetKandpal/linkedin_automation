import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import type { ApiError } from '../../api/http';
import { AccountsApi } from '../../api/accounts';
import { ArticlesApi } from '../../api/articles';
import { JobsApi } from '../../api/jobs';
import { ConfigApi } from '../../api/config';
import type { Account, Article, PublishJob, PublishJobStatus } from '../../api/types';
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

const JOB_STATUSES: PublishJobStatus[] = ['pending', 'running', 'success', 'failed', 'canceled'];

function statusTone(status: PublishJobStatus): 'ok' | 'warn' | 'danger' | 'neutral' {
  if (status === 'success') return 'ok';
  if (status === 'failed') return 'danger';
  if (status === 'running') return 'warn';
  return 'neutral';
}

/** "in 3 h" / "5 min ago" — a quick sense of when a job runs without doing date math in your head. */
function formatRelative(iso: string): string {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return '';
  const diffMs = target - Date.now();
  const future = diffMs >= 0;
  const minutes = Math.round(Math.abs(diffMs) / 60_000);
  let value: string;
  if (minutes < 1) value = 'less than a minute';
  else if (minutes < 60) value = `${minutes} min`;
  else if (minutes < 60 * 24) {
    const h = Math.round(minutes / 60);
    value = `${h} h`;
  } else {
    const d = Math.round(minutes / (60 * 24));
    value = `${d} day${d === 1 ? '' : 's'}`;
  }
  if (minutes < 1) return future ? 'in less than a minute' : 'just now';
  return future ? `in ${value}` : `${value} ago`;
}

function CopyButton(props: { value: string; label?: string; title?: string }) {
  const { value, label = 'Copy', title } = props;
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className="copyButton"
      title={title || `Copy ${value}`}
      onClick={async e => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          // clipboard unavailable (insecure origin) — silently ignore
        }
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

/** "YYYY-MM-DD" in local time, the format <input type="date"> expects. */
function toDateInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function daysAgoDateInput(days: number): string {
  return toDateInputValue(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
}

/** Start of the given local day, or null when the bound is left empty. */
function startOfDay(value: string): number | null {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** End of the given local day, inclusive. */
function endOfDay(value: string): number | null {
  if (!value) return null;
  const d = new Date(`${value}T23:59:59.999`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** First two meaningful lines of the article body, with light markdown stripped. */
function articleExcerpt(markdown?: string): string {
  if (!markdown) return '';
  const lines = markdown
    .split(/\r?\n/)
    .map(line =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')          // headings
        .replace(/^\s{0,3}>\s?/, '')               // blockquotes
        .replace(/^\s{0,3}[-*+]\s+/, '')           // bullets
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')      // images
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')   // links -> their text
        .replace(/[*_`~]/g, '')                   // emphasis marks
        .trim()
    )
    .filter(line => line.length > 0);
  return lines.slice(0, 2).join('\n');
}

/** Excel keeps real dates sortable; anything unparseable is left blank. */
function toExcelDate(iso?: string): Date | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

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

  const [filterAccountId, setFilterAccountId] = useState<string>('');

  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(() => new Set());

  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [failureOpen, setFailureOpen] = useState(false);
  const [failureJobId, setFailureJobId] = useState<string>('');
  const failureJob = useMemo(() => jobs.find(j => j.jobId === failureJobId) || null, [jobs, failureJobId]);

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

  const [statusFilter, setStatusFilter] = useState<'all' | PublishJobStatus>('all');
  const [search, setSearch] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { all: jobs.length };
    JOB_STATUSES.forEach(st => (counts[st] = 0));
    jobs.forEach(j => {
      counts[j.status] = (counts[j.status] || 0) + 1;
    });
    return counts;
  }, [jobs]);

  const filteredJobs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return jobs.filter(j => {
      if (statusFilter !== 'all' && j.status !== statusFilter) return false;
      if (!q) return true;
      const haystack = [
        j.jobId,
        j.articleId,
        j.accountId,
        j.companyPageName,
        j.companyPageUrl,
        articlesMap.get(j.articleId)?.title,
        accountsMap.get(j.accountId)?.displayName,
      ];
      return haystack.some(v => v && v.toLowerCase().includes(q));
    });
  }, [jobs, statusFilter, search, articlesMap, accountsMap]);

  const sortedJobs = useMemo(() => {
    const dir = sortDir === 'desc' ? -1 : 1;
    return [...filteredJobs].sort(
      (a, b) => dir * (new Date(a.runAt).getTime() - new Date(b.runAt).getTime())
    );
  }, [filteredJobs, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedJobs.length / pageSize));
  const currentPage = Math.min(page, totalPages);

  const pagedJobs = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return sortedJobs.slice(start, start + pageSize);
  }, [sortedJobs, currentPage, pageSize]);

  // Any change to what is being listed sends you back to the first page.
  useEffect(() => {
    setPage(1);
  }, [statusFilter, search, filterAccountId, pageSize, sortDir]);

  const allSelected = useMemo(() => {
    if (pagedJobs.length === 0) return false;
    return pagedJobs.every(j => selectedJobIds.has(j.jobId));
  }, [pagedJobs, selectedJobIds]);

  const someSelected = useMemo(
    () => pagedJobs.some(j => selectedJobIds.has(j.jobId)),
    [pagedJobs, selectedJobIds]
  );

  const selectedCount = selectedJobIds.size;

  // Bulk actions resolve against every loaded job, so a selection stays intact
  // when you change page or narrow the filters.
  const selectedJobs = useMemo(
    () => jobs.filter(j => selectedJobIds.has(j.jobId)),
    [jobs, selectedJobIds]
  );

  const [bulkStatus, setBulkStatus] = useState<string>('');

  const statusOptions = useMemo(
    () => [
      { value: '', label: 'Set status…' },
      { value: 'pending', label: 'pending' },
      { value: 'running', label: 'running' },
      { value: 'success', label: 'success' },
      { value: 'failed', label: 'failed' },
      { value: 'canceled', label: 'canceled' },
    ],
    []
  );

  async function bulkSetStatusSelected() {
    const ids = selectedJobs.map(j => j.jobId);
    if (ids.length === 0) return;
    if (!bulkStatus) {
      window.alert('Select a status first.');
      return;
    }
    const ok = window.confirm(`Set status to "${bulkStatus}" for ${ids.length} job${ids.length === 1 ? '' : 's'}?`);
    if (!ok) return;
    setError(null);
    setSuccess(null);
    try {
      await JobsApi.bulkSetStatus(ids, bulkStatus);
      setSelectedJobIds(new Set());
      setBulkStatus('');
      await refreshAll();
      setSuccess(`Updated ${ids.length} job${ids.length === 1 ? '' : 's'}`);
    } catch (e) {
      setError((e as ApiError).message || String(e));
    }
  }

  async function setJobStatus(jobId: string, status: string) {
    if (!status) return;
    setError(null);
    setSuccess(null);
    try {
      await JobsApi.setStatus(jobId, status);
      await refreshAll();
      setSuccess('Job status updated');
    } catch (e) {
      setError((e as ApiError).message || String(e));
    }
  }

  async function bulkCancelSelected() {
    const pendingIds = selectedJobs.filter(j => j.status === 'pending').map(j => j.jobId);
    if (pendingIds.length === 0) {
      window.alert('No pending jobs selected to cancel.');
      return;
    }
    const ok = window.confirm(`Cancel ${pendingIds.length} pending job${pendingIds.length === 1 ? '' : 's'}?`);
    if (!ok) return;
    setError(null);
    setSuccess(null);
    try {
      await JobsApi.bulkCancel(pendingIds);
      setSelectedJobIds(prev => {
        const next = new Set(prev);
        pendingIds.forEach(id => next.delete(id));
        return next;
      });
      await refreshAll();
      setSuccess(`Canceled ${pendingIds.length} job${pendingIds.length === 1 ? '' : 's'}`);
    } catch (e) {
      setError((e as ApiError).message || String(e));
    }
  }

  async function bulkDeleteSelected() {
    const ids = selectedJobs.map(j => j.jobId);
    if (ids.length === 0) return;
    const ok = window.confirm(`Delete ${ids.length} job${ids.length === 1 ? '' : 's'}?`);
    if (!ok) return;
    setError(null);
    setSuccess(null);
    try {
      await JobsApi.bulkDelete(ids);
      setSelectedJobIds(new Set());
      await refreshAll();
      setSuccess(`Deleted ${ids.length} job${ids.length === 1 ? '' : 's'}`);
    } catch (e) {
      setError((e as ApiError).message || String(e));
    }
  }

  const [jobId, setJobId] = useState(generateJobId());
  const [accountId, setAccountId] = useState('');
  const [articleId, setArticleId] = useState('');
  const [runAtLocal, setRunAtLocal] = useState(() => defaultLocalDateTime(10));
  const [delayProfile, setDelayProfile] = useState('default');
  const [typingProfile, setTypingProfile] = useState('medium');
  const [companyPageUrl, setCompanyPageUrl] = useState('');

  const [delayProfiles, setDelayProfiles] = useState<string[]>([]);
  const [typingProfiles, setTypingProfiles] = useState<string[]>([]);

  const [exportOpen, setExportOpen] = useState(false);
  // Defaults to the last day of scheduled jobs; both bounds may be cleared for "all time".
  const [exportFrom, setExportFrom] = useState(() => daysAgoDateInput(1));
  const [exportTo, setExportTo] = useState(() => daysAgoDateInput(0));
  const [exportScope, setExportScope] = useState<'range' | 'view'>('range');

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

  useEffect(() => {
    if (!success) return;
    const timer = window.setTimeout(() => setSuccess(null), 30_000);
    return () => window.clearTimeout(timer);
  }, [success]);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 30_000);
    return () => window.clearTimeout(timer);
  }, [error]);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const [j, a, art, cfg] = await Promise.all([
        JobsApi.list({ accountId: filterAccountId || undefined }),
        AccountsApi.list(),
        ArticlesApi.list(),
        ConfigApi.profiles(),
      ]);
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
  }, [filterAccountId]);

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

  const filterAccountOptions = useMemo(() => {
    const opts: SearchOption[] = [{ value: '', label: 'All accounts' }];
    opts.push(
      ...accounts
        .filter(a => a.status === 'active')
        .map(a => ({
          value: a.accountId,
          label: `${a.displayName} (${a.accountId})`,
        }))
    );
    return opts;
  }, [accounts]);

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

  const publishedUrlFor = useCallback(
    (job: PublishJob): string | undefined => {
      const fromJob = job.articleUrl?.trim();
      if (fromJob) return fromJob;
      // Older jobs predate articleUrl on the job doc; fall back to the article record,
      // but only when this job is the one that actually published it.
      const article = articlesMap.get(job.articleId);
      const fromArticle = article?.publishedUrl?.trim();
      if (fromArticle && job.status === 'success') return fromArticle;
      return undefined;
    },
    [articlesMap]
  );

  /**
   * Jobs record the company page by URL and name, not by id, so recover the id
   * from the owning account's configured pages.
   */
  const companyPageIdFor = useCallback(
    (job: PublishJob): string => {
      const target = normalizeCompanyPageUrl(job.companyPageUrl);
      const pages = accountsMap.get(job.accountId)?.companyPages || [];
      if (target) {
        const byUrl = pages.find(p => normalizeCompanyPageUrl(p.url) === target);
        if (byUrl) return byUrl.pageId;
      }
      const name = (job.companyPageName || '').trim().toLowerCase();
      if (name) {
        const byName = pages.find(p => p.name.trim().toLowerCase() === name);
        if (byName) return byName.pageId;
      }
      return '';
    },
    [accountsMap]
  );

  // Rows the export will write: either everything in the date window, or exactly
  // what the current status/search/account filters are showing.
  const exportJobs = useMemo(() => {
    const base = exportScope === 'view' ? filteredJobs : jobs;
    const from = startOfDay(exportFrom);
    const to = endOfDay(exportTo);
    if (from === null && to === null) return base;
    return base.filter(j => {
      const runAt = new Date(j.runAt).getTime();
      if (Number.isNaN(runAt)) return false;
      if (from !== null && runAt < from) return false;
      if (to !== null && runAt > to) return false;
      return true;
    });
  }, [exportScope, filteredJobs, jobs, exportFrom, exportTo]);

  function downloadExcel() {
    const rows = exportJobs.map(j => {
      const article = articlesMap.get(j.articleId);
      const succeeded = j.status === 'success';
      return {
        'Job ID': j.jobId,
        Status: j.status,
        'Published For': accountsMap.get(j.accountId)?.displayName || j.accountId,
        'Published On': j.companyPageName || j.companyPageUrl || '',
        'Page ID': companyPageIdFor(j),
        'Page URL': j.companyPageUrl || '',
        'Article Title': article?.title || j.articleId,
        'Article Preview': articleExcerpt(article?.markdownContent),
        // Only a successful job actually published, so the time and link stay
        // blank for everything else rather than showing a misleading value.
        'Published At': succeeded ? toExcelDate(j.finishedAt) : undefined,
        'LinkedIn Link': succeeded ? publishedUrlFor(j) || '' : '',
      };
    });

    const sheet = XLSX.utils.json_to_sheet(rows, { cellDates: true });
    sheet['!cols'] = [
      { wch: 34 }, // Job ID
      { wch: 10 }, // Status
      { wch: 18 }, // Published For
      { wch: 22 }, // Published On
      { wch: 16 }, // Page ID
      { wch: 44 }, // Page URL
      { wch: 54 }, // Article Title
      { wch: 70 }, // Article Preview
      { wch: 20 }, // Published At
      { wch: 46 }, // LinkedIn Link
    ];

    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Publish Jobs');

    const span = exportFrom || exportTo ? `${exportFrom || 'start'}_to_${exportTo || 'now'}` : 'all';
    XLSX.writeFile(book, `publish-jobs_${span}.xlsx`);

    setExportOpen(false);
    setSuccess(`Exported ${rows.length} job${rows.length === 1 ? '' : 's'} to Excel`);
  }

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
            <Button variant="ghost" onClick={() => setExportOpen(true)}>
              Export Excel
            </Button>
            <Button variant="ghost" onClick={() => void refreshAll()} disabled={loading}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        }
      >
        <Note text="Scheduling requires the selected account to be linked (bootstrap) and the company page to be added under that account." />
        {success ? <InlineSuccess message={success} onClose={() => setSuccess(null)} /> : null}
        {error ? <InlineError message={error} onClose={() => setError(null)} /> : null}
        {loading ? <Loader label="Refreshing…" /> : null}

        <div className="jobsFilters">
          <div className="statusChips" role="group" aria-label="Filter by status">
            <button
              type="button"
              className={`statusChip${statusFilter === 'all' ? ' active' : ''}`}
              onClick={() => setStatusFilter('all')}
            >
              All <span className="statusChipCount">{statusCounts.all}</span>
            </button>
            {JOB_STATUSES.map(st => (
              <button
                key={st}
                type="button"
                className={`statusChip tone-${statusTone(st)}${statusFilter === st ? ' active' : ''}`}
                onClick={() => setStatusFilter(st)}
              >
                {st} <span className="statusChipCount">{statusCounts[st] ?? 0}</span>
              </button>
            ))}
          </div>

          <div className="jobsFilterInputs">
            <input
              className="jobsSearch"
              type="search"
              value={search}
              placeholder="Search job, article, account or company page…"
              onChange={e => setSearch(e.target.value)}
            />
            <div style={{ minWidth: 240 }}>
              <SearchSelect
                value={filterAccountId}
                options={filterAccountOptions}
                placeholder="Filter by account…"
                onChange={value => setFilterAccountId(value)}
              />
            </div>
          </div>
        </div>

        {selectedCount > 0 ? (
          <div className="selectionBar">
            <span className="strong">
              {selectedCount} job{selectedCount === 1 ? '' : 's'} selected
            </span>
            <div className="row">
              <select
                className="selectFancy"
                value={bulkStatus}
                onChange={e => setBulkStatus(e.target.value)}
                disabled={loading}
              >
                {statusOptions.map(o => (
                  <option key={o.value} value={o.value} disabled={!o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <Button
                variant="ghost"
                onClick={() => void bulkSetStatusSelected()}
                disabled={loading || !bulkStatus}
              >
                Apply status
              </Button>
              <Button variant="ghost" onClick={() => void bulkCancelSelected()} disabled={loading}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void bulkDeleteSelected()} disabled={loading}>
                Delete
              </Button>
              <Button variant="ghost" onClick={() => setSelectedJobIds(new Set())}>
                Clear
              </Button>
            </div>
          </div>
        ) : null}

        <div className="tableWrap">
          <table className="table jobsTable">
            <thead>
              <tr>
                <th style={{ width: 34 }}>
                  <input
                    type="checkbox"
                    aria-label="Select all jobs on this page"
                    checked={allSelected}
                    ref={el => {
                      if (el) el.indeterminate = !allSelected && someSelected;
                    }}
                    onChange={e => {
                      const checked = e.target.checked;
                      setSelectedJobIds(prev => {
                        const next = new Set(prev);
                        if (checked) {
                          pagedJobs.forEach(j => next.add(j.jobId));
                        } else {
                          pagedJobs.forEach(j => next.delete(j.jobId));
                        }
                        return next;
                      });
                    }}
                  />
                </th>
                <th>Job</th>
                <th>Account</th>
                <th>Company page</th>
                <th>Article</th>
                <th>
                  <button
                    type="button"
                    className="sortHeader"
                    onClick={() => setSortDir(d => (d === 'desc' ? 'asc' : 'desc'))}
                    title={sortDir === 'desc' ? 'Sorted newest first' : 'Sorted oldest first'}
                  >
                    Run At <span aria-hidden="true">{sortDir === 'desc' ? '↓' : '↑'}</span>
                  </button>
                </th>
                <th>Status</th>
                <th>Published post</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {pagedJobs.map(j => {
                const publishedUrl = publishedUrlFor(j);
                const isSelected = selectedJobIds.has(j.jobId);
                return (
                <tr key={j.jobId} className={isSelected ? 'selected' : undefined}>
                  <td onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select job ${j.jobId}`}
                      checked={isSelected}
                      onChange={e => {
                        const checked = e.target.checked;
                        setSelectedJobIds(prev => {
                          const next = new Set(prev);
                          if (checked) next.add(j.jobId);
                          else next.delete(j.jobId);
                          return next;
                        });
                      }}
                    />
                  </td>
                  <td>
                    <div className="cellStack jobCell">
                      <span className="mono breakWord">{j.jobId}</span>
                      <CopyButton value={j.jobId} label="Copy ID" />
                    </div>
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
                    <div className="cellStack articleCell">
                      <button type="button" className="linkButton" onClick={() => goToArticle(j.articleId)}>
                        {articlesMap.get(j.articleId)?.title || j.articleId}
                      </button>
                      <div className="muted breakWord">{j.articleId}</div>
                    </div>
                  </td>
                  <td>
                    <div className="cellStack">
                      <span>{new Date(j.runAt).toLocaleString()}</span>
                      <span className="muted">{formatRelative(j.runAt)}</span>
                    </div>
                  </td>
                  <td>
                    <div className="statusCell">
                      <Badge tone={statusTone(j.status)} text={j.status} />
                      {j.status === 'failed' && (j.errorStep || j.errorCode) ? (
                        <div className="statusMeta breakWord">{j.errorStep || j.errorCode}</div>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    {publishedUrl ? (
                      <div className="cellStack publishedCell">
                        <a className="linkButton" href={publishedUrl} target="_blank" rel="noreferrer">
                          Open on LinkedIn ↗
                        </a>
                        <CopyButton value={publishedUrl} label="Copy link" />
                      </div>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <div className="row rowActions">
                      <select
                        className="selectFancy"
                        value=""
                        onChange={e => {
                          const next = e.target.value;
                          e.currentTarget.value = '';
                          if (next) void setJobStatus(j.jobId, next);
                        }}
                        disabled={loading}
                      >
                        {statusOptions.map(o => (
                          <option key={o.value} value={o.value} disabled={!o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
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
                );
              })}
              {pagedJobs.length === 0 ? (
                <tr>
                  <td colSpan={9}>
                    <div className="emptyState">
                      <div className="strong">No publish jobs match this view</div>
                      <div className="muted">
                        {jobs.length === 0
                          ? 'Schedule a job to get started.'
                          : 'Try clearing the search, status or account filter.'}
                      </div>
                      {jobs.length > 0 ? (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setSearch('');
                            setStatusFilter('all');
                            setFilterAccountId('');
                          }}
                        >
                          Clear filters
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {sortedJobs.length > 0 ? (
          <div className="tableFooter">
            <span className="muted">
              Showing {(currentPage - 1) * pageSize + 1}–
              {Math.min(currentPage * pageSize, sortedJobs.length)} of {sortedJobs.length} job
              {sortedJobs.length === 1 ? '' : 's'}
            </span>
            <div className="row">
              <select
                className="selectFancy pageSizeSelect"
                value={pageSize}
                onChange={e => setPageSize(Number(e.target.value))}
                aria-label="Rows per page"
              >
                {[25, 50, 100, 200].map(n => (
                  <option key={n} value={n}>
                    {n} / page
                  </option>
                ))}
              </select>
              <Button
                variant="ghost"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
              >
                Prev
              </Button>
              <span className="muted">
                Page {currentPage} of {totalPages}
              </span>
              <Button
                variant="ghost"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
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
        {error ? <InlineError message={error} onClose={() => setError(null)} /> : null}
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
        open={exportOpen}
        title="Export publish jobs to Excel"
        onClose={() => setExportOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setExportOpen(false)}>
              Cancel
            </Button>
            <Button onClick={downloadExcel} disabled={exportJobs.length === 0}>
              Download ({exportJobs.length})
            </Button>
          </>
        }
      >
        <div className="form">
          <div className="row exportPresets">
            <Button
              variant="ghost"
              onClick={() => {
                setExportFrom(daysAgoDateInput(1));
                setExportTo(daysAgoDateInput(0));
              }}
            >
              Last day
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setExportFrom(daysAgoDateInput(7));
                setExportTo(daysAgoDateInput(0));
              }}
            >
              Last 7 days
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setExportFrom(daysAgoDateInput(30));
                setExportTo(daysAgoDateInput(0));
              }}
            >
              Last 30 days
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setExportFrom('');
                setExportTo('');
              }}
            >
              All time
            </Button>
          </div>

          <div className="form twoCols">
            <Field label="Scheduled from (Run At)" hint="Leave empty for no lower bound">
              <input type="date" value={exportFrom} onChange={e => setExportFrom(e.target.value)} />
            </Field>
            <Field label="Scheduled to (Run At)" hint="Leave empty for no upper bound">
              <input type="date" value={exportTo} onChange={e => setExportTo(e.target.value)} />
            </Field>
          </div>

          <Field label="Rows to include">
            <select
              className="selectFancy"
              value={exportScope}
              onChange={e => setExportScope(e.target.value as 'range' | 'view')}
            >
              <option value="range">All jobs in this date range</option>
              <option value="view">Only what the current filters show</option>
            </select>
          </Field>

          <Note
            text={
              filterAccountId
                ? `${exportJobs.length} job(s) will be exported. The account filter is active, so only jobs for that account are loaded.`
                : `${exportJobs.length} job(s) will be exported.`
            }
          />
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
