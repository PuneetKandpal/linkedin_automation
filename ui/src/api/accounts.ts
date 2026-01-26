import { apiFetchJson } from './http';
import type { Account, AccountIssue } from './types';

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

  update: (accountId: string, patch: UpdateAccountInput) =>
    apiFetchJson<Account>(`/accounts/${encodeURIComponent(accountId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  issues: (accountId: string) =>
    apiFetchJson<AccountIssue[]>(`/accounts/${encodeURIComponent(accountId)}/issues`),
};
