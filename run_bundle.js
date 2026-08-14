#!/usr/bin/env node
// Non-interactive driver for the "Revenue Cloud - QuantumBit" org type —
// the scripted equivalent of `bin/generate.js --org-type quantumbit`.
// Models real quotes: configurable bundles (QuantumBit Complete Solution /
// QuantumBit Starter), PLUS some flat quotes whose line items are drawn
// standalone FROM those bundles' component products.
//
// Usage:
//   node run_bundle.js [ordersPerAccount]
// Env knobs (for controlled/test runs):
//   RMI_ACCOUNT_LIMIT=N   only target the first N accounts
//   RMI_FLAT_RATIO=0..1   fraction of orders that are flat (default 0.35)
import 'dotenv/config';
import { fetchBundlePool } from './src/catalog.js';
import { fetchExistingAccounts } from './src/accounts.js';
import { generateMixedOrders } from './src/orders.js';
import { getOrgType } from './src/orgTypes.js';

// ── Parameters ────────────────────────────────────────────────────────────────
const ORG_TYPE = getOrgType('quantumbit');
const BUNDLE_NAMES = ORG_TYPE.bundleNames;
const ORDERS_PER_ACCOUNT = parseInt(process.argv[2], 10) || 3;
const ACCOUNT_LIMIT = process.env.RMI_ACCOUNT_LIMIT ? parseInt(process.env.RMI_ACCOUNT_LIMIT, 10) : null;
const FLAT_RATIO = process.env.RMI_FLAT_RATIO != null ? parseFloat(process.env.RMI_FLAT_RATIO) : ORG_TYPE.flatRatio;
// ─────────────────────────────────────────────────────────────────────────────

function print(msg) { console.log(msg); }

print('╔══════════════════════════════════════════════════════════════════╗');
print('║  RMI — Bundle-Aware Data Generation (bundles + standalone lines)  ║');
print('╚══════════════════════════════════════════════════════════════════╝');
print(`Target org: ${process.env.SF_TARGET_ORG || '(sf default)'}\n`);

// Phase 1 — Accounts
print('─── Phase 1: Accounts ───────────────────────────────────────────────');
let accounts = fetchExistingAccounts().map(a => ({ id: a.Id, name: a.Name }));
if (ACCOUNT_LIMIT) accounts = accounts.slice(0, ACCOUNT_LIMIT);
print(`✓ ${accounts.length} account(s) targeted.`);
if (!accounts.length) { print('No accounts to target. Exiting.'); process.exit(0); }

// Phase 2 — Bundles
print('\n─── Phase 2: Bundles ────────────────────────────────────────────────');
const bundles = [];
for (const name of BUNDLE_NAMES) {
  try {
    const cfg = fetchBundlePool(name);
    print(`✓ "${name}" — ${cfg.components.length} priceable component(s), ${cfg.components.filter(c => c.isDefault).length} default(s)`);
    bundles.push(cfg);
  } catch (e) {
    print(`✗ "${name}" skipped: ${e.message}`);
  }
}
if (!bundles.length) { print('No usable bundles. Exiting.'); process.exit(1); }

// Phase 3 — Generation
print('\n─── Phase 3: Order Generation ───────────────────────────────────────');
print(`Accounts: ${accounts.length} | Orders each: ${ORDERS_PER_ACCOUNT} | Total: ${accounts.length * ORDERS_PER_ACCOUNT}`);
print(`Mix: ~${Math.round((1 - FLAT_RATIO) * 100)}% bundle / ~${Math.round(FLAT_RATIO * 100)}% flat-from-components\n`);

const { created, failed } = await generateMixedOrders(
  accounts,
  bundles,
  ORDERS_PER_ACCOUNT,
  msg => print(msg),
  {
    flatRatio: FLAT_RATIO,
    quantityRange: ORG_TYPE.quantityRange,
    maxOrderTotal: ORG_TYPE.maxOrderTotal,
  }
);

print('\n─── Summary ─────────────────────────────────────────────────────────');
print(`✓ Orders created and activated: ${created.length}`);
if (failed.length) {
  print(`✗ Failures: ${failed.length}`);
  for (const f of failed) print(`  ${f.accountName} — ${f.error}`);
}
