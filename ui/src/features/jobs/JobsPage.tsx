import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiError } from '../../api/http';
import { AccountsApi } from '../../api/accounts';
import { ArticlesApi } from '../../api/articles';
import { JobsApi } from '../../api/jobs';
import type { Account, Article, PublishJob } from '../../api/types';
import { Card, Field, InlineError, Button, Badge } from '../../components/ui';
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

  const [jobId, setJobId] = useState(generateJobId());
  const [accountId, setAccountId] = useState('');
  const [articleId, setArticleId] = useState('');
  const [runAtLocal, setRunAtLocal] = useState(() => defaultLocalDateTime(10));
  const [delayProfile, setDelayProfile] = useState('default');
  const [typingProfile, setTypingProfile] = useState('medium');

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setError(null);
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

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const accountOptions = useMemo(() => accounts.filter(a => a.status === 'active'), [accounts]);

  const articleOptions = useMemo(
    () => articles.filter(a => a.status !== 'published'),
    [articles]
  );

  async function createJob() {
    setError(null);
    try {
      await JobsApi.create({
        jobId,
        accountId,
        articleId,
        runAt: toIsoFromLocal(runAtLocal),
        delayProfile,
        typingProfile,
      });
      setJobId(generateJobId());
      await refreshAll();
    } catch (e) {
      setError((e as ApiError).message || String(e));
    }
  }

  async function cancelJob(id: string) {
    setError(null);
    try {
      await JobsApi.cancel(id);
      await refreshAll();
    } catch (e) {
      setError((e as ApiError).message || String(e));
    }
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
                        j.status === 'completed'
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
                    {j.status === 'pending' ? (
                      <Button variant="danger" onClick={() => void cancelJob(j.jobId)}>
                        Cancel
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {jobs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted">
                    No jobs
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="Create Publish Job"
        right={
          <Button variant="ghost" onClick={() => setJobId(generateJobId())}>
            Generate ID
          </Button>
        }
      >
        <div className="form">
          <Field label="Job ID">
            <input value={jobId} onChange={e => setJobId(e.target.value)} />
          </Field>
          <Field label="Account">
            <select value={accountId} onChange={e => setAccountId(e.target.value)}>
              <option value="">Select account…</option>
              {accountOptions.map(a => (
                <option key={a.accountId} value={a.accountId}>
                  {a.displayName} ({a.accountId})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Article">
            <select value={articleId} onChange={e => setArticleId(e.target.value)}>
              <option value="">Select article…</option>
              {articleOptions.map(a => (
                <option key={a.articleId} value={a.articleId}>
                  {a.title} ({a.articleId})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Run At">
            <input type="datetime-local" value={runAtLocal} onChange={e => setRunAtLocal(e.target.value)} />
          </Field>
          <Field label="Delay Profile">
            <input value={delayProfile} onChange={e => setDelayProfile(e.target.value)} />
          </Field>
          <Field label="Typing Profile">
            <input value={typingProfile} onChange={e => setTypingProfile(e.target.value)} />
          </Field>
          <div className="row">
            <Button onClick={() => void createJob()} disabled={!accountId || !articleId}>
              Schedule
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
