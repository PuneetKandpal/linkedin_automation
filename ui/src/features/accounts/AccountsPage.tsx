import { useEffect, useMemo, useState } from 'react';
import type { ApiError } from '../../api/http';
import { AccountsApi } from '../../api/accounts';
import type { Account, AccountIssue } from '../../api/types';
import { generateAccountId } from '../../utils/id';
import { Badge, Button, Card, Field, InlineError } from '../../components/ui';

function formatDate(value?: string) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const selectedAccount = useMemo(
    () => accounts.find(a => a.accountId === selectedAccountId) || null,
    [accounts, selectedAccountId]
  );

  const [issues, setIssues] = useState<AccountIssue[]>([]);
  const [issuesError, setIssuesError] = useState<string | null>(null);

  const [accountId, setAccountId] = useState(generateAccountId());
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  const [status, setStatus] = useState<'active' | 'disabled'>('active');

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const data = await AccountsApi.list();
      setAccounts(data);
    } catch (e) {
      setError((e as ApiError).message || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    async function loadIssues() {
      if (!selectedAccountId) {
        setIssues([]);
        setIssuesError(null);
        return;
      }
      setIssuesError(null);
      try {
        const data = await AccountsApi.issues(selectedAccountId);
        setIssues(data);
      } catch (e) {
        setIssuesError((e as ApiError).message || String(e));
      }
    }
    void loadIssues();
  }, [selectedAccountId]);

  async function createAccount() {
    setError(null);
    try {
      await AccountsApi.create({ accountId, displayName, email, timezone, status });
      setAccountId(generateAccountId());
      setDisplayName('');
      setEmail('');
      await refresh();
    } catch (e) {
      setError((e as ApiError).message || String(e));
    }
  }

  return (
    <div className="grid">
      <Card
        title="Accounts"
        right={
          <div className="row">
            <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>
              Refresh
            </Button>
          </div>
        }
      >
        {error ? <InlineError message={error} /> : null}
        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Email</th>
                <th>Timezone</th>
                <th>Status</th>
                <th>Auth</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map(a => (
                <tr
                  key={a.accountId}
                  className={a.accountId === selectedAccountId ? 'selected' : ''}
                  onClick={() => setSelectedAccountId(a.accountId)}
                >
                  <td>
                    <div className="strong">{a.displayName}</div>
                    <div className="muted">{a.accountId}</div>
                  </td>
                  <td>{a.email}</td>
                  <td>{a.timezone}</td>
                  <td>
                    <Badge tone={a.status === 'active' ? 'ok' : 'warn'} text={a.status} />
                  </td>
                  <td>
                    <Badge
                      tone={a.authStatus === 'valid' ? 'ok' : a.authStatus === 'invalid' ? 'danger' : 'neutral'}
                      text={a.authStatus || 'unknown'}
                    />
                  </td>
                </tr>
              ))}
              {accounts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    No accounts yet
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="Create Account"
        right={
          <Button variant="ghost" onClick={() => setAccountId(generateAccountId())}>
            Generate ID
          </Button>
        }
      >
        <div className="form">
          <Field label="Account ID">
            <input value={accountId} onChange={e => setAccountId(e.target.value)} />
          </Field>
          <Field label="Display Name">
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} />
          </Field>
          <Field label="Email">
            <input value={email} onChange={e => setEmail(e.target.value)} />
          </Field>
          <Field label="Timezone">
            <input value={timezone} onChange={e => setTimezone(e.target.value)} />
          </Field>
          <Field label="Status">
            <select value={status} onChange={e => setStatus(e.target.value as 'active' | 'disabled')}>
              <option value="active">active</option>
              <option value="disabled">disabled</option>
            </select>
          </Field>
          <div className="row">
            <Button onClick={() => void createAccount()}>Create</Button>
          </div>
          <div className="muted">
            Note: after creating an account, run bootstrap to login and store session in DB.
          </div>
        </div>
      </Card>

      <Card title="Account Issues">
        {!selectedAccount ? <div className="muted">Select an account to view issues</div> : null}
        {selectedAccount ? (
          <>
            <div className="muted">
              Selected: <span className="strong">{selectedAccount.displayName}</span> ({selectedAccount.accountId})
              {selectedAccount.storageStateUpdatedAt ? (
                <> · session updated: {formatDate(selectedAccount.storageStateUpdatedAt)}</>
              ) : null}
            </div>
            {issuesError ? <InlineError message={issuesError} /> : null}
            {issues.length === 0 ? (
              <div className="muted">No issues</div>
            ) : (
              <ul className="list">
                {issues.map((i, idx) => (
                  <li key={idx} className="listItem">
                    <div className="strong">{i.code || 'Issue'}</div>
                    <div>{i.message}</div>
                    <div className="muted">{formatDate(i.createdAt)}</div>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </Card>
    </div>
  );
}
