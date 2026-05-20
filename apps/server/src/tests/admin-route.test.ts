import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { RescanScheduler } from '../rescan-scheduler.js';
import { adminRoute } from '../routes/admin.js';
import { LOCAL_ACTION_HEADER } from '../routes/local-action.js';

function buildAdminApp(scheduler: RescanScheduler): Hono {
  const app = new Hono();
  app.route('/api/admin', adminRoute(scheduler));
  return app;
}

function mockScheduler(): RescanScheduler {
  return { tick: vi.fn().mockResolvedValue(undefined) } as unknown as RescanScheduler;
}

describe('POST /api/admin/rescan', () => {
  it('rejects requests without the local action header', async () => {
    const scheduler = mockScheduler();
    const app = buildAdminApp(scheduler);

    const res = await app.request('/api/admin/rescan', { method: 'POST' });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('local action header required');
    expect(scheduler.tick).not.toHaveBeenCalled();
  });

  it('runs a rescan when the local action header is present', async () => {
    const scheduler = mockScheduler();
    const app = buildAdminApp(scheduler);

    const res = await app.request('/api/admin/rescan', {
      method: 'POST',
      headers: { [LOCAL_ACTION_HEADER]: '1' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ts: number };
    expect(body.ok).toBe(true);
    expect(typeof body.ts).toBe('number');
    expect(scheduler.tick).toHaveBeenCalledOnce();
  });
});
