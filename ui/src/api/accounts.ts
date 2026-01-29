import { apiFetchJson } from './http';
import type { Account, AccountIssue, CompanyPage } from './types';

export type CreateAccountInput = {
  accountId: string;
  displayName: string;
  email: string;
  timezone: string;
  status: 'active' | 'disabled';
};

export type UpdateAccountInput = Partial<Pick<Account, 'displayName' | 'email' | 'timezone' | 'status' | 'proxy'>>;

export const AccountsApi = {
  list: () => apiFetchJson<Account[]>('/accounts'),

  create: (input: CreateAccountInput) =>
    apiFetchJson<{ accountId: string }>('/accounts', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  bulkCreate: (items: CreateAccountInput[]) =>
    apiFetchJson<{ accountIds: string[] }>('/accounts/bulk', {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),

  update: (accountId: string, patch: UpdateAccountInput) =>
    apiFetchJson<Account>(`/accounts/${encodeURIComponent(accountId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  issues: (accountId: string) =>
    apiFetchJson<AccountIssue[]>(`/accounts/${encodeURIComponent(accountId)}/issues`),

  listCompanyPages: (accountId: string) =>
    apiFetchJson<CompanyPage[]>(`/accounts/${encodeURIComponent(accountId)}/company-pages`),

  addCompanyPage: (accountId: string, input: { pageId?: string; name: string; url: string }) =>
    apiFetchJson<{ pageId: string }>(`/accounts/${encodeURIComponent(accountId)}/company-pages`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  deleteCompanyPage: (accountId: string, pageId: string) =>
    apiFetchJson<{ ok: boolean }>(
      `/accounts/${encodeURIComponent(accountId)}/company-pages/${encodeURIComponent(pageId)}`,
      { method: 'DELETE' }
    ),
};
