import axios, { AxiosError, type AxiosRequestConfig } from 'axios';

export type ApiError = {
  status: number;
  message: string;
  details?: unknown;
};

function hasErrorField(value: unknown): value is { error: unknown } {
  return typeof value === 'object' && value !== null && 'error' in value;
}

const initialBaseUrl = import.meta.env?.VITE_API_BASE_URL?.trim();

const apiClient = axios.create({
  baseURL: initialBaseUrl || undefined,
});

export function setApiBaseUrl(baseUrl?: string | null) {
  apiClient.defaults.baseURL = baseUrl && baseUrl.trim().length > 0 ? baseUrl : undefined;
}

export async function apiFetchJson<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  try {
    const { method, headers, body, signal } = init ?? {};

    const config: AxiosRequestConfig = {
      url: path,
      method,
      data: body,
      headers: {
        'Content-Type': 'application/json',
        ...(headers as Record<string, string> | undefined),
      },
    };

    if (signal) {
      config.signal = signal;
    }

    const response = await apiClient.request<T>(config);

    return response.data as T;
  } catch (error) {
    const axiosError = error as AxiosError;
    const status = axiosError.response?.status ?? 0;
    const data = axiosError.response?.data;

    const message = hasErrorField(data)
      ? String((data as { error: unknown }).error)
      : `Request failed: ${status || 'network error'}`;

    const err: ApiError = {
      status,
      message,
      details: data,
    };
    throw err;
  }
}
