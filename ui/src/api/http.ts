export type ApiError = {
  status: number;
  message: string;
  details?: unknown;
};

async function readErrorBody(res: Response): Promise<unknown> {
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }
  try {
    return await res.text();
  } catch {
    return undefined;
  }
}

function hasErrorField(value: unknown): value is { error: unknown } {
  return typeof value === 'object' && value !== null && 'error' in value;
}

export async function apiFetchJson<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await readErrorBody(res);
    const message =
      hasErrorField(body)
        ? String((body as { error: unknown }).error)
        : `Request failed: ${res.status}`;

    const err: ApiError = {
      status: res.status,
      message,
      details: body,
    };
    throw err;
  }

  return (await res.json()) as T;
}
