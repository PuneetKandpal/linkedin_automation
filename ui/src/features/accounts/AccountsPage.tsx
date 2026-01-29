import { useEffect, useMemo, useState } from 'react';
import type { ApiError } from '../../api/http';
import { AccountsApi } from '../../api/accounts';
import type { Account, AccountIssue, CompanyPage } from '../../api/types';
import { generateAccountId } from '../../utils/id';
import { Badge, Button, Card, Field, InlineError, Modal, Note } from '../../components/ui';
import { NAVIGATE_ACCOUNT_KEY } from '../../constants/navigation';

function formatDate(value?: string) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export function AccountsPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [updatingAccountId, setUpdatingAccountId] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'disabled'>('all');

  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const selectedAccount = useMemo(
    () => accounts.find(a => a.accountId === selectedAccountId) || null,
    [accounts, selectedAccountId]
  );

  const [issues, setIssues] = useState<AccountIssue[]>([]);
  const [issuesError, setIssuesError] = useState<string | null>(null);

  const [companyPages, setCompanyPages] = useState<CompanyPage[]>([]);
  const [companyPagesError, setCompanyPagesError] = useState<string | null>(null);
  const [companyPagesLoading, setCompanyPagesLoading] = useState(false);
  const [companyPageName, setCompanyPageName] = useState('');
  const [companyPageUrl, setCompanyPageUrl] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const [accountId, setAccountId] = useState(generateAccountId());
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  const [status, setStatus] = useState<'active' | 'disabled'>('active');

  const [editDisplayName, setEditDisplayName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editTimezone, setEditTimezone] = useState('');
  const [editStatus, setEditStatus] = useState<'active' | 'disabled'>('active');

  const [createTouched, setCreateTouched] = useState<{ [k: string]: boolean }>({});
  const [editTouched, setEditTouched] = useState<{ [k: string]: boolean }>({});

  const createErrors = useMemo(() => {
    const e: Record<string, string> = {};
    if (!accountId.trim()) e.accountId = 'Account ID is required';
    if (!displayName.trim()) e.displayName = 'Display name is required';
    if (!email.trim()) e.email = 'Email is required';
    if (!timezone.trim()) e.timezone = 'Timezone is required';
    return e;
  }, [accountId, displayName, email, timezone]);

  const canCreate = Object.keys(createErrors).length === 0;

  const editErrors = useMemo(() => {
    const e: Record<string, string> = {};
    if (!editDisplayName.trim()) e.displayName = 'Display name is required';
    if (!editEmail.trim()) e.email = 'Email is required';
    if (!editTimezone.trim()) e.timezone = 'Timezone is required';
    return e;
  }, [editDisplayName, editEmail, editTimezone]);

  const canSave = Object.keys(editErrors).length === 0;

  const stats = useMemo(() => {
    const total = accounts.length;
    const active = accounts.filter(a => a.status === 'active').length;
    const disabled = accounts.filter(a => a.status === 'disabled').length;
    const authValid = accounts.filter(a => a.authStatus === 'valid').length;
    const authAttention = accounts.filter(a => a.authStatus === 'needs_reauth' || a.authStatus === 'unknown').length;
    return { total, active, disabled, authValid, authAttention };
  }, [accounts]);

  const filteredAccounts = useMemo(() => {
    const term = search.trim().toLowerCase();
    return accounts.filter(account => {
      const matchesSearch = term
        ? [account.displayName, account.email, account.accountId].some(field => field?.toLowerCase().includes(term))
        : true;
      const matchesStatus = statusFilter === 'all' ? true : account.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [accounts, search, statusFilter]);

  useEffect(() => {
    if (!filteredAccounts.length) {
      if (selectedAccountId) setSelectedAccountId('');
      return;
    }
    const exists = filteredAccounts.some(a => a.accountId === selectedAccountId);
    if (!exists) {
      setSelectedAccountId(filteredAccounts[0].accountId);
    }
  }, [filteredAccounts, selectedAccountId]);

  useEffect(() => {
    function resolveNavigation(targetId: string | null | undefined) {
      if (!targetId) return;
      const exists = accounts.some(a => a.accountId === targetId);
      if (exists) {
        setSelectedAccountId(targetId);
        window.localStorage.removeItem(NAVIGATE_ACCOUNT_KEY);
      }
    }

    function handleNavigate(event: Event) {
      const detail = (event as CustomEvent<{ accountId?: string }>).detail;
      resolveNavigation(detail?.accountId);
    }

    window.addEventListener(NAVIGATE_ACCOUNT_KEY, handleNavigate as EventListener);
    resolveNavigation(window.localStorage.getItem(NAVIGATE_ACCOUNT_KEY));
    return () => window.removeEventListener(NAVIGATE_ACCOUNT_KEY, handleNavigate as EventListener);
  }, [accounts]);

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
      setIssuesLoading(true);
      setIssuesError(null);
      try {
        const data = await AccountsApi.issues(selectedAccountId);
        setIssues(data);
      } catch (e) {
        setIssuesError((e as ApiError).message || String(e));
      } finally {
        setIssuesLoading(false);
      }
    }
    void loadIssues();
  }, [selectedAccountId]);

  useEffect(() => {
    async function loadCompanyPages() {
      if (!selectedAccountId) {
        setCompanyPages([]);
        setCompanyPagesError(null);
        return;
      }
      setCompanyPagesLoading(true);
      setCompanyPagesError(null);
      try {
        const pages = await AccountsApi.listCompanyPages(selectedAccountId);
        setCompanyPages(pages);
      } catch (e) {
        setCompanyPagesError((e as ApiError).message || String(e));
      } finally {
        setCompanyPagesLoading(false);
      }
    }
    void loadCompanyPages();
  }, [selectedAccountId]);

  async function addCompanyPage() {
    if (!selectedAccountId) return;
    setCompanyPagesError(null);
    try {
      await AccountsApi.addCompanyPage(selectedAccountId, { name: companyPageName, url: companyPageUrl });
      setCompanyPageName('');
      setCompanyPageUrl('');
      const pages = await AccountsApi.listCompanyPages(selectedAccountId);
      setCompanyPages(pages);
    } catch (e) {
      setCompanyPagesError((e as ApiError).message || String(e));
    }
  }

  async function removeCompanyPage(pageId: string) {
    if (!selectedAccountId) return;
    setCompanyPagesError(null);
    try {
      await AccountsApi.deleteCompanyPage(selectedAccountId, pageId);
      const pages = await AccountsApi.listCompanyPages(selectedAccountId);
      setCompanyPages(pages);
    } catch (e) {
      setCompanyPagesError((e as ApiError).message || String(e));
    }
  }

  async function createAccount() {
    setError(null);
    setCreateTouched({ accountId: true, displayName: true, email: true, timezone: true });
    if (!canCreate) return;
    try {
      await AccountsApi.create({ accountId, displayName, email, timezone, status });
      setAccountId(generateAccountId());
      setDisplayName('');
      setEmail('');
      await refresh();
      setCreateOpen(false);
    } catch (e) {
      setError((e as ApiError).message || String(e));
    }
  }

  async function saveAccountEdits() {
    if (!selectedAccount) return;
    setUpdatingAccountId(selectedAccount.accountId);
    setError(null);
    setEditTouched({ displayName: true, email: true, timezone: true });
    if (!canSave) {
      setUpdatingAccountId(null);
      return;
    }
    try {
      await AccountsApi.update(selectedAccount.accountId, {
        displayName: editDisplayName,
        email: editEmail,
        timezone: editTimezone,
        status: editStatus,
      });
      await refresh();
      setEditOpen(false);
      setSelectedAccountId(selectedAccount.accountId);
    } catch (e) {
      setError((e as ApiError).message || String(e));
    } finally {
      setUpdatingAccountId(null);
    }
  }

  function openCreate() {
    setAccountId(generateAccountId());
    setDisplayName('');
    setEmail('');
    setTimezone('Asia/Kolkata');
    setStatus('active');
    setCreateTouched({});
    setCreateOpen(true);
  }

  function openEdit() {
    if (!selectedAccount) return;
    setEditDisplayName(selectedAccount.displayName || '');
    setEditEmail(selectedAccount.email || '');
    setEditTimezone(selectedAccount.timezone || '');
    setEditStatus(selectedAccount.status || 'active');
    setEditTouched({});
    setEditOpen(true);
  }

  async function toggleAccountStatus(account: Account) {
    setUpdatingAccountId(account.accountId);
    setError(null);
    try {
      await AccountsApi.update(account.accountId, {
        status: account.status === 'active' ? 'disabled' : 'active',
      });
      await refresh();
      setSelectedAccountId(account.accountId);
    } catch (e) {
      setError((e as ApiError).message || String(e));
    } finally {
      setUpdatingAccountId(null);
    }
  }

  return (
    <div className="accountsPage">
      <section className="overviewGrid">
        <div className="statCard">
          <div className="muted">Accounts</div>
          <div className="statValue">{stats.total}</div>
          <div className="statDelta">{stats.active} active</div>
        </div>
        <div className="statCard">
          <div className="muted">Active vs Disabled</div>
          <div className="statValue">{stats.active}</div>
          <div className="statDelta">{stats.disabled} disabled</div>
        </div>
        <div className="statCard">
          <div className="muted">Auth valid</div>
          <div className="statValue">{stats.authValid}</div>
          <div className="statDelta">{stats.authAttention} need attention</div>
        </div>
      </section>

      <Card
        title="Account Directory"
        right={
          <div className="row">
            <Button variant="primary" onClick={openCreate}>
              New account
            </Button>
            <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>
              Refresh
            </Button>
          </div>
        }
      >
        <div className="filtersRow">
          <input
            className="searchInput"
            placeholder="Search name, email, or ID"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select
            className="filterSelect"
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value as 'all' | 'active' | 'disabled')}
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
          <div className="muted">
            Showing {filteredAccounts.length} of {accounts.length}
          </div>
        </div>

        {error ? <InlineError message={error} /> : null}

        <div className="tableWithSidebar">
          <div className="primaryPane">
            <div className="tableWrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Email</th>
                    <th>Timezone</th>
                    <th>Status</th>
                    <th>Link</th>
                    <th>Auth</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={6} className="muted">
                        Loading accounts…
                      </td>
                    </tr>
                  ) : null}
                  {!loading && filteredAccounts.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="muted">
                        No accounts match the filters
                      </td>
                    </tr>
                  ) : null}
                  {filteredAccounts.map(a => (
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
                          tone={a.linkStatus === 'linked' ? 'ok' : 'neutral'}
                          text={a.linkStatus || 'unlinked'}
                        />
                      </td>
                      <td>
                        <Badge
                          tone={a.authStatus === 'valid' ? 'ok' : a.authStatus === 'needs_reauth' ? 'danger' : 'neutral'}
                          text={a.authStatus || 'unknown'}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <aside className="sidePane">
            {selectedAccount ? (
              <div className="detailCard">
                <div className="detailHeader">
                  <div>
                    <div className="detailTitle">{selectedAccount.displayName}</div>
                    <div className="muted">{selectedAccount.accountId}</div>
                  </div>
                  <div className="row">
                    <Badge tone={selectedAccount.status === 'active' ? 'ok' : 'warn'} text={selectedAccount.status} />
                    <Badge tone={selectedAccount.linkStatus === 'linked' ? 'ok' : 'neutral'} text={selectedAccount.linkStatus || 'unlinked'} />
                    <Badge
                      tone={selectedAccount.authStatus === 'valid' ? 'ok' : selectedAccount.authStatus === 'needs_reauth' ? 'danger' : 'neutral'}
                      text={selectedAccount.authStatus || 'unknown'}
                    />
                  </div>
                </div>

                <div className="detailSection">
                  <div className="detailRow">
                    <div className="detailLabel">Email</div>
                    <div className="detailValue">{selectedAccount.email}</div>
                  </div>
                  <div className="detailRow">
                    <div className="detailLabel">Timezone</div>
                    <div className="detailValue">{selectedAccount.timezone}</div>
                  </div>
                  <div className="detailRow">
                    <div className="detailLabel">Proxy</div>
                    <div className="detailValue">{selectedAccount.proxy?.server || 'Not set'}</div>
                  </div>
                  <div className="detailRow">
                    <div className="detailLabel">Session updated</div>
                    <div className="detailValue">{formatDate(selectedAccount.storageStateUpdatedAt)}</div>
                  </div>
                </div>

                <div className="detailActions">
                  <Button variant="ghost" onClick={openEdit}>
                    Edit
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => void toggleAccountStatus(selectedAccount)}
                    disabled={updatingAccountId === selectedAccount.accountId}
                  >
                    {selectedAccount.status === 'active' ? 'Disable account' : 'Activate account'}
                  </Button>
                </div>

                <div className="detailSection">
                  <div className="detailLabel">Company pages</div>
                  {companyPagesError ? <InlineError message={companyPagesError} /> : null}
                  {companyPagesLoading ? <div className="muted">Loading company pages…</div> : null}
                  {!companyPagesLoading && companyPages.length === 0 ? (
                    <div className="muted">No company pages added</div>
                  ) : null}
                  {!companyPagesLoading && companyPages.length > 0 ? (
                    <ul className="list">
                      {companyPages.map(p => (
                        <li key={p.pageId} className="listItem">
                          <div className="row" style={{ justifyContent: 'space-between' }}>
                            <div>
                              <div className="strong">{p.name}</div>
                              <div className="muted">{p.url}</div>
                            </div>
                            <Button variant="ghost" onClick={() => void removeCompanyPage(p.pageId)}>
                              Remove
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <div className="form" style={{ marginTop: 12 }}>
                    <Field label="Company page name">
                      <input value={companyPageName} onChange={e => setCompanyPageName(e.target.value)} />
                    </Field>
                    <Field label="Company page URL">
                      <input value={companyPageUrl} onChange={e => setCompanyPageUrl(e.target.value)} placeholder="https://www.linkedin.com/company/your-page/" />
                    </Field>
                    <Button variant="primary" onClick={() => void addCompanyPage()} disabled={!companyPageName.trim() || !companyPageUrl.trim()}>
                      Add company page
                    </Button>
                    <Note text="Company pages must be added per account. Scheduling will fail if the page is not linked to the chosen account." />
                  </div>
                </div>

                <div className="detailSection">
                  <div className="detailLabel">Recent issues</div>
                  {issuesError ? <InlineError message={issuesError} /> : null}
                  {issuesLoading ? <div className="muted">Loading issues…</div> : null}
                  {!issuesLoading && issues.length === 0 ? (
                    <div className="muted">No issues</div>
                  ) : null}
                  {!issuesLoading && issues.length > 0 ? (
                    <ul className="list">
                      {issues.map((i, idx) => (
                        <li key={idx} className="listItem">
                          <div className="strong">{i.code || 'Issue'}</div>
                          <div>{i.message}</div>
                          <div className="muted">{formatDate(i.createdAt)}</div>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="emptyState">Select an account to inspect details</div>
            )}
          </aside>
        </div>
      </Card>

      <Modal
        open={createOpen}
        title="Create Account"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void createAccount()} disabled={!canCreate}>
              Create
            </Button>
          </>
        }
      >
        <div className="form twoCols">
          <Field label="Account ID" error={createTouched.accountId ? createErrors.accountId : undefined}>
            <div className="inputWithButton">
              <input
                value={accountId}
                onChange={e => setAccountId(e.target.value)}
                onBlur={() => setCreateTouched(t => ({ ...t, accountId: true }))}
              />
              <Button variant="ghost" onClick={() => setAccountId(generateAccountId())}>
                Generate
              </Button>
            </div>
          </Field>
          <Field label="Display Name" error={createTouched.displayName ? createErrors.displayName : undefined}>
            <input
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              onBlur={() => setCreateTouched(t => ({ ...t, displayName: true }))}
            />
          </Field>
          <Field label="Email" error={createTouched.email ? createErrors.email : undefined}>
            <input value={email} onChange={e => setEmail(e.target.value)} onBlur={() => setCreateTouched(t => ({ ...t, email: true }))} />
          </Field>
          <Field label="Timezone" error={createTouched.timezone ? createErrors.timezone : undefined}>
            <input
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              onBlur={() => setCreateTouched(t => ({ ...t, timezone: true }))}
            />
          </Field>
          <Field label="Status">
            <select value={status} onChange={e => setStatus(e.target.value as 'active' | 'disabled')}>
              <option value="active">active</option>
              <option value="disabled">disabled</option>
            </select>
          </Field>
          <Note text="After creation, run bootstrap to log in and capture LinkedIn session cookies." />
        </div>
      </Modal>

      <Modal
        open={editOpen}
        title={selectedAccount ? `Edit ${selectedAccount.displayName}` : 'Edit Account'}
        onClose={() => setEditOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void saveAccountEdits()}
              disabled={!selectedAccount || !canSave || updatingAccountId === selectedAccount?.accountId}
            >
              Save
            </Button>
          </>
        }
      >
        {selectedAccount ? (
          <div className="form twoCols">
            <Field label="Account ID">
              <input value={selectedAccount.accountId} readOnly />
            </Field>
            <Field label="Display Name" error={editTouched.displayName ? editErrors.displayName : undefined}>
              <input
                value={editDisplayName}
                onChange={e => setEditDisplayName(e.target.value)}
                onBlur={() => setEditTouched(t => ({ ...t, displayName: true }))}
              />
            </Field>
            <Field label="Email" error={editTouched.email ? editErrors.email : undefined}>
              <input
                value={editEmail}
                onChange={e => setEditEmail(e.target.value)}
                onBlur={() => setEditTouched(t => ({ ...t, email: true }))}
              />
            </Field>
            <Field label="Timezone" error={editTouched.timezone ? editErrors.timezone : undefined}>
              <input
                value={editTimezone}
                onChange={e => setEditTimezone(e.target.value)}
                onBlur={() => setEditTouched(t => ({ ...t, timezone: true }))}
              />
            </Field>
            <Field label="Status">
              <select value={editStatus} onChange={e => setEditStatus(e.target.value as 'active' | 'disabled')}>
                <option value="active">active</option>
                <option value="disabled">disabled</option>
              </select>
            </Field>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
