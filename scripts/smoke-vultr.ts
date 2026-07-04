// Live smoke test: chat, vision, rerank, then a full VultrDriver retrieve+diagnose on the hero pages.
// Usage: set -a; source .env; set +a; npm run smoke
import { readFileSync } from 'node:fs';
import { MODELS, VultrDriver, directTransport } from '../src/vultr/client';
import type { Page } from '../src/agent/types';

const t = directTransport(process.env.VULTR_BASE_URL!, process.env.VULTR_INFERENCE_API_KEY!);
const png = (p: string) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;

const p18: Page = { docId: 'hero', page: 18, imageUrl: png('public/corpus/whirlpool-w11187658/p18.png'), kind: 'error-table' };
const p25: Page = { docId: 'hero', page: 25, imageUrl: png('public/corpus/whirlpool-w11187658/p25.png'), kind: 'schematic' };
const p3: Page = { docId: 'hero', page: 3, imageUrl: png('public/corpus/whirlpool-w11187658/p3.png'), kind: 'other' };

console.log('1. chat...', (await t('/chat/completions', { model: MODELS.kimi, messages: [{ role: 'user', content: 'Reply OK' }], max_tokens: 100 })).choices[0].message.content);
const drv = new VultrDriver(t);
console.log('2. retrieve...');
const r = await drv.retrieve('dishwasher error code E3 does not heat', [p18, p25, p3]);
console.log(r.map((x) => `p${x.page.page}=${x.score.toFixed(2)}`).join(' '), '- expect p18 first');
console.log('3. diagnose...');
const d = await drv.diagnose({ device: 'Whirlpool dishwasher', symptom: 'error E3 does not heat' }, [p18, p25]);
console.log(JSON.stringify(d, null, 2));
if (!/heat|thermistor/i.test(d.component)) throw new Error('diagnosis off-target');
console.log('SMOKE PASS');
