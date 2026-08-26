import { expect, test } from '@playwright/test';

/**
 * The health endpoint is what Render uses to decide whether a deploy goes live,
 * so a change that breaks it silently breaks deployment. It gets its own spec.
 */
test.describe('health endpoint', () => {
  test('reports ok and names the tenant', async ({ request }) => {
    const response = await request.get('/api/health');

    expect(response.status()).toBe(200);
    const body = (await response.json()) as { status: string; storeId: string };
    expect(body.status).toBe('ok');
    expect(body.storeId.length).toBeGreaterThan(0);
  });

  test('is never cached', async ({ request }) => {
    // A cached health check would report a stale "ok" after the database went
    // away, which is worse than having no check at all.
    const response = await request.get('/api/health');
    expect(response.headers()['cache-control']).toContain('no-store');
  });

  test('does not leak the connection string or a stack trace', async ({ request }) => {
    const response = await request.get('/api/health');
    const text = await response.text();

    expect(text).not.toContain('mongodb');
    expect(text).not.toContain('mongodb+srv');
    expect(text).not.toMatch(/at .+:\d+:\d+/);
  });

  test('is reachable without a locale prefix', async ({ request }) => {
    // The proxy matcher must exclude /api, or locale negotiation would redirect
    // the health check to /en/api/health and Render would see a 307.
    const response = await request.get('/api/health', { maxRedirects: 0 });
    expect(response.status()).toBe(200);
  });
});
