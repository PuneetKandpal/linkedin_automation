import { apiFetchJson } from './http';
import type { Health } from './types';

export const HealthApi = {
  get: () => apiFetchJson<Health>('/health'),
};
