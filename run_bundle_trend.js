#!/usr/bin/env node
// One-off driver: quantumbit bundle process, targeting ONLY accounts that have a
// billing address (BillingState != null) so every order can activate, and using
// the trend-aware generator so both order volume and revenue trend up over time.
//
// Usage:
//   node run_bundle_trend.js
// Env knobs:
//   RMI_TOTAL_ORDERS=N    total orders spread across the whole window (default 120)
//   RMI_ACCOUNT_LIMIT=N   only target the first N address-bearing accounts (for validation)
//   RMI_INVOICING=0|1     invoice each activated order (default: the org type's)
import 'dotenv/config';
import { query } from './src/org.js';
import { fetchBundlePool } from './src/catalog.js';
import { generateTrendedOrders } from './src/orders.js';
import { getOrgType } from './src/orgTypes.js';

const ORG_TYPE = getOrgType('quantumbit');
const TOTAL = parseInt(process.env.RMI_TOTAL_ORDERS, 10) || 120; // orders across the whole window
const LIMIT = process.env.RMI_ACCOUNT_LIMIT ? parseInt(process.env.RMI_ACCOUNT_LIMIT, 10) : null;
const INVOICING = process.env.RMI_INVOICING != null ? process.env.RMI_INVOICING === '1' : ORG_TYPE.invoicing;
const print = m => console.log(m);

print('╔══════════════════════════════════════════════════════════════════╗');
print('║  RMI — Trended Bundle Data Generation (up-and-to-the-right)       ║');
print('╚══════════════════════════════════════════════════════════════════╝');
print(`Target org: ${process.env.SF_TARGET_ORG || '(sf default)'}\n`);

// Phase 1 — Accounts (only those with a billing address)
print('─── Phase 1: Accounts ───────────────────────────────────────────────');
let accounts = query(
  `SELECT Id, Name FROM Account WHERE IsDeleted=false AND BillingState != null ORDER BY Name`
).map(a => ({ id: a.Id, name: a.Name }));
if (LIMIT) accounts = accounts.slice(0, LIMIT);
print(`✓ ${accounts.length} address-bearing account(s) targeted.`);
if (!accounts.length) { print('No accounts to target. Exiting.'); process.exit(0); }

// Phase 2 — Bundles
print('\n─── Phase 2: Bundles ────────────────────────────────────────────────');
const bundles = [];
for (const name of ORG_TYPE.bundleNames) {
  try {
    const b = fetchBundlePool(name);
    print(`✓ "${name}" — ${b.components.length} priceable component(s), ${b.components.filter(c => c.isDefault).length} default(s)`);
    bundles.push(b);
  } catch (e) {
    print(`✗ "${name}" skipped: ${e.message}`);
  }
}
if (!bundles.length) { print('No usable bundles. Exiting.'); process.exit(1); }

// Phase 3 — Trended generation
print('\n─── Phase 3: Order Generation (trended) ─────────────────────────────');
const { created, failed, invoiced, invoiceFailed } = await generateTrendedOrders(accounts, bundles, print, {
  quantityRange: ORG_TYPE.quantityRange,
  maxOrderTotal: ORG_TYPE.maxOrderTotal,
  flatRatio: 0.15,
  invoicing: INVOICING,
  trend: {
    start: '2025-01-01',
    totalOrders: TOTAL,
    growth: 0.10,
    noise: 0.25,
    largeBundleMatch: 'Complete',
    pLargeStart: 0.25,
    pLargeEnd: 0.80,
  },
});

print('\n─── Summary ─────────────────────────────────────────────────────────');
print(`✓ Orders created and activated: ${created.length}`);
if (failed.length) {
  print(`✗ Order failures: ${failed.length}`);
  for (const f of failed) print(`  ${f.accountName} — ${f.error}`);
}
if (invoiced.length || invoiceFailed.length) {
  print(`✓ Invoices posted: ${invoiced.length}`);
  if (invoiceFailed.length) {
    print(`✗ Invoicing failures: ${invoiceFailed.length} (orders are still activated)`);
    for (const f of invoiceFailed) print(`  ${f.accountName} — Order ${f.orderId} — ${f.error}`);
  }
}
