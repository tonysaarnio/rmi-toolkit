#!/usr/bin/env node
// Non-interactive driver for the "Revenue Cloud for Manufacturing" org type —
// the scripted equivalent of `bin/generate.js --org-type manufacturing`.
// Fixed parameters, no prompts: all existing accounts, catalog name fragment,
// fixed orders per account.
import 'dotenv/config';
import { fetchCatalogs, fetchProductPool, mergeProductPools } from './src/catalog.js';
import { fetchExistingAccounts } from './src/accounts.js';
import { generateOrders } from './src/orders.js';
import { getOrgType } from './src/orgTypes.js';

// ── Parameters ────────────────────────────────────────────────────────────────
const ORG_TYPE          = getOrgType('manufacturing');
const CATALOG_NAMES     = ['Software'];  // match by name fragment (QuantumBit Software)
const ORDERS_PER_ACCOUNT = 3;
// ─────────────────────────────────────────────────────────────────────────────

function print(msg) { console.log(msg); }

print('╔══════════════════════════════════════════════════════════════════╗');
print('║  Revenue Management Intelligence — Bulk Data Generation Toolkit  ║');
print('╚══════════════════════════════════════════════════════════════════╝');
print(`Target org: ${process.env.SF_TARGET_ORG || 'iewc-mfg-rca'}\n`);

// Phase 1 — Accounts (all existing)
print('─── Phase 1: Accounts ───────────────────────────────────────────────');
const accounts = fetchExistingAccounts().map(a => ({ id: a.Id, name: a.Name }));
print(`✓ ${accounts.length} existing account(s) targeted.`);
if (!accounts.length) { print('No accounts to target. Exiting.'); process.exit(0); }

// Phase 2 — Catalog
print('\n─── Phase 2: Product Catalog ────────────────────────────────────────');
const allCatalogs = fetchCatalogs();
print(`Found ${allCatalogs.length} catalog(s): ${allCatalogs.map(c => c.Name).join(', ')}`);
const selectedCatalogs = allCatalogs.filter(c =>
  CATALOG_NAMES.some(n => c.Name.toLowerCase().includes(n.toLowerCase()))
);
if (!selectedCatalogs.length) {
  print('ERROR: No matching catalogs found. Check CATALOG_NAMES parameter.');
  process.exit(1);
}
const pools = [];
for (const catalog of selectedCatalogs) {
  print(`Loading products from "${catalog.Name}"...`);
  const pool = fetchProductPool(catalog.Id);
  print(`  → ${pool.length} product(s) loaded`);
  pools.push(pool);
}
const productPool = mergeProductPools(pools);
print(`✓ Total product pool: ${productPool.length} product(s)`);
if (!productPool.length) { print('No products in pool. Exiting.'); process.exit(1); }

// Phase 3 — Orders
print('\n─── Phase 3: Order Generation ───────────────────────────────────────');
print(`Accounts: ${accounts.length} | Orders each: ${ORDERS_PER_ACCOUNT} | Total: ${accounts.length * ORDERS_PER_ACCOUNT}`);
print('Each order: 3–10 random products, 0–40% discount per line, date spread Jan 2025–today.\n');

const { created, failed, invoiced, invoiceFailed } = await generateOrders(
  accounts,
  productPool,
  ORDERS_PER_ACCOUNT,
  msg => print(msg),
  {
    quantityRange: ORG_TYPE.quantityRange,
    maxOrderTotal: ORG_TYPE.maxOrderTotal,
    invoicing: ORG_TYPE.invoicing,
  }
);

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
