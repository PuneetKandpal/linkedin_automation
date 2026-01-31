import { useState, useEffect } from 'react';
import { Card } from '../../components/ui';
import { Button } from '../../components/ui';
import { Field } from '../../components/ui';
import { InlineError, InlineSuccess } from '../../components/ui';
import { Loader } from '../../components/ui';
import { Note } from '../../components/ui';
import { AutoScheduleApi } from '../../api/autoSchedule';
import type { ApiError } from '../../api/http';

function defaultLocalDateTime(offsetMinutes: number): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() + offsetMinutes);
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function optionsToString(values?: number[]): string {
  if (!Array.isArray(values) || values.length === 0) return '';
  return values.join(', ');
}

function parseOptionsString(input: string): number[] | undefined {
  const raw = String(input ?? '').trim();
  if (!raw) return undefined;
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  const nums = parts
    .map(v => Number(v))
    .filter(v => Number.isFinite(v))
    .map(v => Math.floor(v));
  return nums;
}

export function AutoSchedulePage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [maxArticlesPerCompanyPage, setMaxArticlesPerCompanyPage] = useState(10);
  const [minGapMinutesSameCompanyPage, setMinGapMinutesSameCompanyPage] = useState(180);
  const [minGapMinutesCompanyPagesSameAccount, setMinGapMinutesCompanyPagesSameAccount] = useState(60);
  const [minGapMinutesAcrossAccounts, setMinGapMinutesAcrossAccounts] = useState(30);
  const [estimatedPublishDurationMinutes, setEstimatedPublishDurationMinutes] = useState(18);
  const [jitterMinutes, setJitterMinutes] = useState(8);
  const [defaultStartOffsetMinutes, setDefaultStartOffsetMinutes] = useState(10);

  const [maxArticlesPerCompanyPageOptions, setMaxArticlesPerCompanyPageOptions] = useState('');
  const [minGapMinutesSameCompanyPageOptions, setMinGapMinutesSameCompanyPageOptions] = useState('');
  const [minGapMinutesCompanyPagesSameAccountOptions, setMinGapMinutesCompanyPagesSameAccountOptions] = useState('');
  const [minGapMinutesAcrossAccountsOptions, setMinGapMinutesAcrossAccountsOptions] = useState('');
  const [estimatedPublishDurationMinutesOptions, setEstimatedPublishDurationMinutesOptions] = useState('');
  const [jitterMinutesOptions, setJitterMinutesOptions] = useState('');
  const [defaultStartOffsetMinutesOptions, setDefaultStartOffsetMinutesOptions] = useState('');

  const [startFromDate, setStartFromDate] = useState(() => defaultLocalDateTime(10));
  const [executing, setExecuting] = useState(false);

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

  useEffect(() => {
    void loadConfig();
  }, []);

  async function loadConfig() {
    setLoading(true);
    setError(null);
    try {
      const cfg = await AutoScheduleApi.getConfig();
      setMaxArticlesPerCompanyPage(cfg.maxArticlesPerCompanyPage);
      setMinGapMinutesSameCompanyPage(cfg.minGapMinutesSameCompanyPage);
      setMinGapMinutesCompanyPagesSameAccount(cfg.minGapMinutesCompanyPagesSameAccount);
      setMinGapMinutesAcrossAccounts(cfg.minGapMinutesAcrossAccounts);
      setEstimatedPublishDurationMinutes(cfg.estimatedPublishDurationMinutes);
      setJitterMinutes(cfg.jitterMinutes);
      setDefaultStartOffsetMinutes(cfg.defaultStartOffsetMinutes);

      setMaxArticlesPerCompanyPageOptions(optionsToString(cfg.maxArticlesPerCompanyPageOptions));
      setMinGapMinutesSameCompanyPageOptions(optionsToString(cfg.minGapMinutesSameCompanyPageOptions));
      setMinGapMinutesCompanyPagesSameAccountOptions(optionsToString(cfg.minGapMinutesCompanyPagesSameAccountOptions));
      setMinGapMinutesAcrossAccountsOptions(optionsToString(cfg.minGapMinutesAcrossAccountsOptions));
      setEstimatedPublishDurationMinutesOptions(optionsToString(cfg.estimatedPublishDurationMinutesOptions));
      setJitterMinutesOptions(optionsToString(cfg.jitterMinutesOptions));
      setDefaultStartOffsetMinutesOptions(optionsToString(cfg.defaultStartOffsetMinutesOptions));
    } catch (e) {
      setError((e as ApiError).message || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function saveConfig() {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const updated = await AutoScheduleApi.updateConfig({
        maxArticlesPerCompanyPage,
        maxArticlesPerCompanyPageOptions: parseOptionsString(maxArticlesPerCompanyPageOptions),
        minGapMinutesSameCompanyPage,
        minGapMinutesSameCompanyPageOptions: parseOptionsString(minGapMinutesSameCompanyPageOptions),
        minGapMinutesCompanyPagesSameAccount,
        minGapMinutesCompanyPagesSameAccountOptions: parseOptionsString(minGapMinutesCompanyPagesSameAccountOptions),
        minGapMinutesAcrossAccounts,
        minGapMinutesAcrossAccountsOptions: parseOptionsString(minGapMinutesAcrossAccountsOptions),
        estimatedPublishDurationMinutes,
        estimatedPublishDurationMinutesOptions: parseOptionsString(estimatedPublishDurationMinutesOptions),
        jitterMinutes,
        jitterMinutesOptions: parseOptionsString(jitterMinutesOptions),
        defaultStartOffsetMinutes,
        defaultStartOffsetMinutesOptions: parseOptionsString(defaultStartOffsetMinutesOptions),
      });
      void updated;
      setSuccess('Auto-schedule configuration saved');
    } catch (e) {
      setError((e as ApiError).message || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function executeAutoSchedule() {
    setExecuting(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await AutoScheduleApi.execute({
        startFromDate: startFromDate || undefined,
      });
      setSuccess(`Auto-schedule completed: ${result.scheduled} articles scheduled across ${result.jobIds.length} jobs`);
    } catch (e) {
      setError((e as ApiError).message || String(e));
    } finally {
      setExecuting(false);
    }
  }

  return (
    <div className="autoScheduleLayout">
      <Card
        title="Auto-Schedule Configuration"
        right={
          <Button variant="primary" onClick={saveConfig} disabled={loading}>
            Save Configuration
          </Button>
        }
      >
        <Note text="Configure how articles are automatically distributed across active accounts and company pages." />
        {success ? <InlineSuccess message={success} onClose={() => setSuccess(null)} /> : null}
        {error ? <InlineError message={error} onClose={() => setError(null)} /> : null}
        {loading ? <Loader label="Loading configuration…" /> : null}

        <div className="form">
          <Field label="Max Articles Per Company Page">
            <input
              type="number"
              min="1"
              value={maxArticlesPerCompanyPage}
              onChange={e => setMaxArticlesPerCompanyPage(Number(e.target.value))}
            />
          </Field>

          <Field label="Max Articles Per Company Page - Dropdown Options" hint="Comma-separated numbers">
            <input value={maxArticlesPerCompanyPageOptions} onChange={e => setMaxArticlesPerCompanyPageOptions(e.target.value)} />
          </Field>

          <Field label="Min Gap Between Articles (Same Company Page) - Minutes">
            <input
              type="number"
              min="0"
              value={minGapMinutesSameCompanyPage}
              onChange={e => setMinGapMinutesSameCompanyPage(Number(e.target.value))}
            />
          </Field>

          <Field label="Min Gap Between Articles (Same Company Page) - Dropdown Options" hint="Comma-separated numbers">
            <input value={minGapMinutesSameCompanyPageOptions} onChange={e => setMinGapMinutesSameCompanyPageOptions(e.target.value)} />
          </Field>

          <Field label="Min Gap Between Company Pages (Same Account) - Minutes">
            <input
              type="number"
              min="0"
              value={minGapMinutesCompanyPagesSameAccount}
              onChange={e => setMinGapMinutesCompanyPagesSameAccount(Number(e.target.value))}
            />
          </Field>

          <Field label="Min Gap Between Company Pages (Same Account) - Dropdown Options" hint="Comma-separated numbers">
            <input
              value={minGapMinutesCompanyPagesSameAccountOptions}
              onChange={e => setMinGapMinutesCompanyPagesSameAccountOptions(e.target.value)}
            />
          </Field>

          <Field label="Min Gap Between Accounts - Minutes">
            <input
              type="number"
              min="0"
              value={minGapMinutesAcrossAccounts}
              onChange={e => setMinGapMinutesAcrossAccounts(Number(e.target.value))}
            />
          </Field>

          <Field label="Min Gap Between Accounts - Dropdown Options" hint="Comma-separated numbers">
            <input value={minGapMinutesAcrossAccountsOptions} onChange={e => setMinGapMinutesAcrossAccountsOptions(e.target.value)} />
          </Field>

          <Field label="Estimated Publish Duration - Minutes">
            <input
              type="number"
              min="0"
              value={estimatedPublishDurationMinutes}
              onChange={e => setEstimatedPublishDurationMinutes(Number(e.target.value))}
            />
          </Field>

          <Field label="Estimated Publish Duration - Dropdown Options" hint="Comma-separated numbers">
            <input
              value={estimatedPublishDurationMinutesOptions}
              onChange={e => setEstimatedPublishDurationMinutesOptions(e.target.value)}
            />
          </Field>

          <Field label="Random Jitter - Minutes">
            <input
              type="number"
              min="0"
              value={jitterMinutes}
              onChange={e => setJitterMinutes(Number(e.target.value))}
            />
          </Field>

          <Field label="Random Jitter - Dropdown Options" hint="Comma-separated numbers">
            <input value={jitterMinutesOptions} onChange={e => setJitterMinutesOptions(e.target.value)} />
          </Field>

          <Field label="Default Start Offset - Minutes">
            <input
              type="number"
              min="0"
              value={defaultStartOffsetMinutes}
              onChange={e => setDefaultStartOffsetMinutes(Number(e.target.value))}
            />
          </Field>

          <Field label="Default Start Offset - Dropdown Options" hint="Comma-separated numbers">
            <input value={defaultStartOffsetMinutesOptions} onChange={e => setDefaultStartOffsetMinutesOptions(e.target.value)} />
          </Field>
        </div>
      </Card>

      <Card
        title="Execute Auto-Schedule"
        right={
          <Button variant="primary" onClick={executeAutoSchedule} disabled={executing}>
            Run Auto-Schedule
          </Button>
        }
      >
        <Note text="Schedule all ready articles automatically based on the configured rules above. This will distribute articles across active linked accounts and their company pages." />
        {executing ? <Loader label="Auto-scheduling articles…" /> : null}

        <div className="form">
          <Field label="Start From (Optional)" hint="Leave empty to start immediately based on default offset">
            <input
              type="datetime-local"
              value={startFromDate}
              onChange={e => setStartFromDate(e.target.value)}
            />
          </Field>
        </div>

        <div style={{ marginTop: 16 }}>
          <div className="strong">How it works:</div>
          <ul style={{ marginTop: 8, paddingLeft: 20 }}>
            <li>All articles with status "ready" will be scheduled</li>
            <li>Articles are distributed evenly across active linked accounts</li>
            <li>Each company page will receive at most the configured max articles</li>
            <li>Configured gaps between articles are enforced</li>
            <li>Existing scheduled/running jobs are respected when calculating timing</li>
          </ul>
        </div>
      </Card>
    </div>
  );
}
