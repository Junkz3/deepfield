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
    driver = new VultrDriver(proxyTransport(demoToken()));
  }
  cache.set(kind, driver);
  return driver;
}

/** Private-demo access key: read from ?key= in the URL once, kept for the
 *  session. Only meaningful when the server sets DEMO_TOKEN. */
function demoToken(): string | undefined {
  try {
    const fromUrl = new URLSearchParams(location.search).get('key');
    if (fromUrl) { sessionStorage.setItem('rc.key', fromUrl); return fromUrl; }
    return sessionStorage.getItem('rc.key') ?? undefined;
  } catch {
    return undefined;
  }
}
