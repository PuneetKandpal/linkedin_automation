import { apiFetchJson } from './http';
import type { Article } from './types';

export type CreateArticleInput = {
  articleId: string;
  language: string;
  title: string;
  markdownContent: string;
  coverImagePath?: string;
  communityPostText?: string;
};

export type UpdateArticleInput = Partial<Pick<CreateArticleInput, 'language' | 'title' | 'markdownContent' | 'coverImagePath' | 'communityPostText'>>;

export const ArticlesApi = {
  list: (status?: string) => {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    return apiFetchJson<Article[]>(`/articles${q}`);
  },

  create: (input: CreateArticleInput) =>
    apiFetchJson<{ articleId: string }>('/articles', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  bulkCreate: (items: CreateArticleInput[]) =>
    apiFetchJson<{ articleIds: string[] }>('/articles/bulk', {
      method: 'POST',
      body: JSON.stringify({ items }),
    }),

  update: (articleId: string, patch: UpdateArticleInput) =>
    apiFetchJson<Article>(`/articles/${encodeURIComponent(articleId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  markReady: (articleId: string) =>
    apiFetchJson<Article>(`/articles/${encodeURIComponent(articleId)}/ready`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  bulkMarkReady: (articleIds: string[]) =>
    apiFetchJson<{ ok: boolean; articleIds: string[] }>('/articles/ready/bulk', {
      method: 'POST',
      body: JSON.stringify({ articleIds }),
    }),
};
