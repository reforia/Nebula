import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { request } from './http';

// Helper to build a Response-like object that matches what the code reads off
// it: `status`, `ok`, and `.json()`.
function mockJsonResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('api/http request()', () => {
  const origLocation = window.location;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // window.location.href is not reassignable in jsdom by default — replace
    // the whole object so the "redirect to /login" branch doesn't throw.
    Object.defineProperty(window, 'location', {
      value: { href: '' },
      writable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'location', { value: origLocation, writable: true });
  });

  it('returns parsed JSON on a 2xx response', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ ok: true, value: 42 }));
    const data = await request<{ value: number }>('/api/test');
    expect(data).toEqual({ ok: true, value: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws with server-provided error message on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ error: 'bad input' }, { status: 400 }));
    await expect(request('/api/test')).rejects.toThrow('bad input');
  });

  it('retries after a successful refresh when the first call 401s', async () => {
    fetchMock
      .mockResolvedValueOnce(mockJsonResponse({ error: 'expired' }, { status: 401 }))
      .mockResolvedValueOnce(mockJsonResponse({ ok: true })) // refresh
      .mockResolvedValueOnce(mockJsonResponse({ retried: true })); // retry
    const data = await request<{ retried: boolean }>('/api/me');
    expect(data).toEqual({ retried: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[1][0] as string)).toBe('/api/auth/refresh');
  });

  it('redirects to /login when refresh fails after a 401', async () => {
    fetchMock
      .mockResolvedValueOnce(mockJsonResponse({ error: 'expired' }, { status: 401 }))
      .mockResolvedValueOnce(mockJsonResponse({}, { status: 401 })); // refresh rejected
    await expect(request('/api/me')).rejects.toThrow('Not authenticated');
    expect(window.location.href).toBe('/login');
  });

  it('shares a single refresh across concurrent 401s (single-flight)', async () => {
    // Two calls hit 401, one refresh succeeds, then each gets its own retry.
    // Without single-flight we'd see two /auth/refresh calls; we assert one.
    fetchMock
      .mockResolvedValueOnce(mockJsonResponse({ error: 'expired' }, { status: 401 })) // call A first
      .mockResolvedValueOnce(mockJsonResponse({ error: 'expired' }, { status: 401 })) // call B first
      .mockResolvedValueOnce(mockJsonResponse({ ok: true })) // single refresh
      .mockResolvedValueOnce(mockJsonResponse({ a: 1 })) // A retry
      .mockResolvedValueOnce(mockJsonResponse({ b: 2 })); // B retry

    const [a, b] = await Promise.all([request('/api/a'), request('/api/b')]);
    expect(a).toEqual({ a: 1 });
    expect(b).toEqual({ b: 2 });
    const refreshCalls = fetchMock.mock.calls.filter((c) => c[0] === '/api/auth/refresh');
    expect(refreshCalls).toHaveLength(1);
  });
});
