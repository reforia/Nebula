const BASE = '';

// Single-flight refresh — if N requests 401 at once, they all wait on the same
// refresh call instead of each POSTing /api/auth/refresh in parallel. Without
// this, concurrent refreshes rotate the refresh cookie in a race and some
// requests end up retrying with an already-invalidated token.
let refreshInflight: Promise<boolean> | null = null;

function sharedRefresh(): Promise<boolean> {
  if (!refreshInflight) {
    refreshInflight = fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      credentials: 'same-origin',
    })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => { refreshInflight = null; });
  }
  return refreshInflight;
}

export async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    credentials: 'same-origin',
  });

  if (res.status === 401) {
    if (await sharedRefresh()) {
      const retryRes = await fetch(`${BASE}${url}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
        credentials: 'same-origin',
      });
      if (retryRes.ok) {
        return (await retryRes.json()) as T;
      }
    }
    window.location.href = '/login';
    throw new Error('Not authenticated');
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

/**
 * Upload a single-file body to an endpoint that expects the filename in the
 * X-Filename header and the raw file in the request body. Used by vault and
 * image-paste uploads — the server side shares one handler.
 */
export async function uploadRaw<T>(url: string, file: File): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Filename': file.name },
    body: file,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(d.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/** GET plain text (used for vault file reads) */
export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
