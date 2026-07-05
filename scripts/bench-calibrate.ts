// Cold-start calibration probe: does the team calibration write a sensible
// workspace for domains the engine never touched? Six third-party corpus
// signals (file names + optional intent), no scoring - read the output.
// The rule it watches: agents are JOBS users bring, and the calibration must
// not invent jobs the files do not support. Run it before and after ANY
// change to teamPrompt: a one-line nudge measured here both failed to fix
// per-file splitting AND regressed a correctly-sized team (see bench/README).
//
// Usage: set -a; source .env; set +a; npx tsx scripts/bench-calibrate.ts
import { VultrDriver, directTransport } from '../src/vultr/client';
import { heuristicCalibration } from '../src/agent/team';
import type { TeamCalibrationInput } from '../src/agent/team';

const DOMAINS: TeamCalibrationInput[] = [
  { workspaceName: 'HR desk', fileNames: ['employee-handbook-2026.pdf', 'leave-policy-france.pdf', 'onboarding-checklist.pdf'], intent: 'HR team answering employee questions about leave, benefits and onboarding' },
  { workspaceName: 'Incident response', fileNames: ['k8s-incident-runbook.pdf', 'postgres-backup-restore-procedures.pdf', 'oncall-escalation-matrix.pdf'], intent: 'on-call engineers during production incidents' },
  { workspaceName: 'Pharmacy counter', fileNames: ['ibuprofen-200mg-package-insert.pdf', 'paracetamol-dosage-guide.pdf', 'drug-interactions-quick-reference.pdf'], intent: 'pharmacy assistants checking dosage and contraindications' },
  { workspaceName: 'Expense desk', fileNames: ['expense-policy-2026.pdf', 'vat-invoice-requirements-eu.pdf', 'travel-reimbursement-rules.pdf'], intent: 'employees filing expense reports' },
  { workspaceName: 'Hotel operations', fileNames: ['housekeeping-sop.pdf', 'front-desk-procedures.pdf', 'pool-maintenance-manual.pdf'] }, // no intent on purpose
  { workspaceName: 'Factory maintenance', fileNames: ['cnc-lathe-alarm-codes.pdf', 'hydraulic-press-service-manual.pdf', 'forklift-daily-inspection-checklist.pdf'], intent: 'factory maintenance technicians on the floor' },
];

async function main() {
  const baseUrl = process.env.VULTR_BASE_URL;
  const apiKey = process.env.VULTR_INFERENCE_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error('Set VULTR_BASE_URL and VULTR_INFERENCE_API_KEY (set -a; source .env; set +a)');
    process.exit(1);
  }
  const driver = new VultrDriver(directTransport(baseUrl, apiKey));

  for (const input of DOMAINS) {
    const t0 = Date.now();
    const live = await driver.calibrateTeam!(input);
    const fallback = heuristicCalibration(input);
    const looksFallback = JSON.stringify(live.team.map((a) => a.label)) === JSON.stringify(fallback.team.map((a) => a.label));
    console.log(`\n######## ${input.workspaceName} (${((Date.now() - t0) / 1000).toFixed(1)}s${input.intent ? '' : ', NO intent'}${looksFallback ? ', SAME-AS-FALLBACK?' : ''})`);
    for (const a of live.team) {
      console.log(`  agent [${a.id}] ${a.label} | mode=${a.profile.decisionMode} phys=${a.profile.physicalTools}`);
      console.log(`    role: ${a.profile.agentRole}`);
      console.log(`    charter: ${a.charter}`);
      console.log(`    retrieval: ${a.profile.retrievalHint}`);
    }
    for (const op of live.ops) console.log(`  op [${op.id}] ${op.label}`);
    if (live.ops.length === 0) console.log('  ops: none');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
