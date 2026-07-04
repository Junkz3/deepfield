import { FakeDriver } from './agent/driver';
import { runStep, compileWorkOrder } from './agent/loop';
import { E3_PAGES, HERO_DOC_ID, E3_DIAGNOSIS } from './agent/fixtures/e3-case';
import type { Conversation, Document } from './agent/types';

const heroDoc: Document = {
  id: HERO_DOC_ID, filename: 'whirlpool service manual.pdf', format: 'pdf',
  category: 'dishwasher', brand: 'Whirlpool', model: 'W11187658', docType: 'service',
  pages: Object.values(E3_PAGES), sourceRights: 'Whirlpool official', origin: 'corpus',
};
const conversation: Conversation = {
  id: 'demo', device: 'Whirlpool dishwasher', symptom: 'error code E3, does not heat',
  attachments: [], steps: [], userInputs: [], status: 'active',
};

const driver = new FakeDriver({ delayScale: 0 });
const gen = runStep({ conversation, docs: [heroDoc] }, driver);
while (true) {
  const n = await gen.next();
  if (n.done) { conversation.steps.push(n.value); break; }
  console.log(`  [${n.value.phase.toUpperCase()}] ${n.value.summary}${n.value.detail ? ` - ${n.value.detail}` : ''}`);
}
const step = conversation.steps[0];
console.log('\n=== GUIDED STEP ===');
console.log(`Instruction: ${step.instruction}`);
step.citations.forEach((c) => console.log(`  [cite] ${c.label}${c.quote ? ` - "${c.quote}"` : ''}`));
console.log(`Confidence: ${(step.confidence * 100).toFixed(0)}% (${step.confidenceReason})`);
step.proposedNext.forEach((p) => console.log(`  -> ${p.label}`));

const wo = compileWorkOrder(conversation, E3_DIAGNOSIS, [], { lines: [], citations: [] });
console.log('\n=== WORK ORDER ===');
console.log(JSON.stringify({ ...wo, citations: wo.citations.map((c) => c.label) }, null, 2));
