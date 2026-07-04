// Lazy driver factory: the UI asks for a driver by kind at call time.
// FakeDriver = scripted offline demo (realistic pacing). VultrDriver = live,
// through the /api/agent proxy (the key never reaches the browser).
import type { ModelDriver } from '../agent/driver';
import { FakeDriver } from '../agent/driver';
import type { DriverKind } from './store';

const cache = new Map<DriverKind, ModelDriver>();

export async function getDriver(kind: DriverKind): Promise<ModelDriver> {
  const hit = cache.get(kind);
  if (hit) return hit;
  let driver: ModelDriver;
  if (kind === 'fake') {
    driver = new FakeDriver();
  } else {
    const { VultrDriver, proxyTransport } = await import('../vultr/client');
    driver = new VultrDriver(proxyTransport());
  }
  cache.set(kind, driver);
  return driver;
}
