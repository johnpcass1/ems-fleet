import { describe, it, expect } from 'vitest';
import { as, api, seedDemo, syncAll } from './helpers';

describe('smoke', () => {
  it('logs in and syncs the demo fleet', async () => {
    await seedDemo();
    const { cookie } = await as('fleet_manager');
    const s = await syncAll(cookie);
    expect(s.full).toBe(true);
    expect(s.data.vehicles.length).toBe(20);
    expect(s.data.workOrders.length).toBe(15);
    const wo9 = s.data.workOrders.find((w: any) => w.id === 'wo-09');
    expect(wo9.lines.length).toBe(3);
    expect(wo9.issueIds).toEqual(['i-01']);
    const v1 = s.data.vehicles.find((v: any) => v.id === 'v-01');
    expect(Object.keys(v1.pm).length).toBe(12);
    const r = await api('GET', '/api/health');
    expect(r.status).toBe(200);
  });
});
