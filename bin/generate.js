#!/usr/bin/env node
import 'dotenv/config';
import * as readline from 'readline';
import { fetchCatalogs, fetchProductPool, mergeProductPools, fetchBundlePool } from '../src/catalog.js';
import {
  checkCustomerTierFieldExists,
  fetchExistingAccounts,
  buildAccountData,
  createAccounts,
} from '../src/accounts.js';
import { generateOrders, generateMixedOrders } from '../src/orders.js';
import { ORG_TYPES, getOrgType } from '../src/orgTypes.js';

// ─── I/O helpers ─────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

function print(msg) {
  console.log(msg);
}

function parseYesNo(text) {
  return /^(yes|y|yep|yeah|sure|ok|okay)$/i.test(text.trim());
}

function parseNumber(text) {
  const match = text.trim().match(/^\d+$/);
  return match ? parseInt(text.trim(), 10) : null;
}

/**
 * Print the end-of-run tallies. Invoices are reported on their own line because
 * an order can be activated and correct while its invoice fails — that failure
 * points at the org's billing configuration, not at the order.
 */
function printRunSummary({ created, failed, invoiced = [], invoiceFailed = [] }) {
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
}

// ─── Phase 0 — Org type ──────────────────────────────────────────────────────

/**
 * Ask which kind of org this data is being generated for. The org type decides
 * the whole generation process (bundle-aware vs catalog-driven), so it's the
 * first question. Can be pre-answered with `--org-type <key>` for scripted runs.
 */
async function phaseOrgType() {
  print('\n─── Phase 0: Target Org Type ────────────────────────────────────────');

  const flagIdx = process.argv.indexOf('--org-type');
  const preset = flagIdx !== -1 ? process.argv[flagIdx + 1] : process.env.RMI_ORG_TYPE;
  if (preset) {
    const match = getOrgType(preset);
    if (match) {
      print(`Org type (preset): ${match.label}`);
      return match;
    }
    print(`Unknown org type "${preset}". Valid keys: ${ORG_TYPES.map(t => t.key).join(', ')}`);
  }

  print('What type of org are you targeting this data insert for?\n');
  ORG_TYPES.forEach((t, i) => {
    print(`  ${i + 1}. ${t.label}`);
    print(`     ${t.summary}`);
  });

  while (true) {
    const input = await ask(`\nSelect org type (1-${ORG_TYPES.length}): `);
    const idx = parseNumber(input);
    if (idx && idx >= 1 && idx <= ORG_TYPES.length) {
      const chosen = ORG_TYPES[idx - 1];
      print(`\n✓ ${chosen.label}`);
      print(`  ${chosen.detail}`);
      return chosen;
    }
    print(`Please enter a number between 1 and ${ORG_TYPES.length}.`);
  }
}

// ─── Phase 1 — Accounts ──────────────────────────────────────────────────────

async function phaseAccounts() {
  print('\n─── Phase 1: Accounts ───────────────────────────────────────────────');

  print('Querying existing accounts...');
  const existingAccounts = fetchExistingAccounts();
  print(`Found ${existingAccounts.length} existing account(s) in the org.`);

  const answer = await ask('\nCreate new accounts? (yes/no): ');
  const createNew = parseYesNo(answer);

  if (!createNew) {
    print(`Using ${existingAccounts.length} existing accounts.`);
    return existingAccounts.map(a => ({ id: a.Id, name: a.Name }));
  }

  let count = null;
  while (!count) {
    const n = await ask('How many new accounts? ');
    count = parseNumber(n);
    if (!count) print('Please enter a whole number.');
  }

  print('\nChecking for Customer_Tier__c field...');
  const hasTierField = await checkCustomerTierFieldExists();
  print(hasTierField ? '  ✓ Customer_Tier__c found — tiers will be assigned.' : '  — Customer_Tier__c not found — skipping tier assignment.');

  print(`\nGenerating ${count} account(s)...`);
  const accountData = buildAccountData(count, hasTierField);
  const created = createAccounts(accountData, hasTierField);
  print(`✓ ${created.length} account(s) created.`);
  return created;
}

// ─── Phase 2 — Catalog ───────────────────────────────────────────────────────

async function phaseCatalog() {
  print('\n─── Phase 2: Product Catalog ────────────────────────────────────────');

  print('Querying available product catalogs...');
  const catalogs = fetchCatalogs();

  if (!catalogs.length) {
    print('No product catalogs found in the org. Cannot proceed.');
    process.exit(1);
  }

  print('\nAvailable catalogs:');
  catalogs.forEach((c, i) => print(`  ${i + 1}. ${c.Name}`));

  let selectedIndexes = [];
  while (!selectedIndexes.length) {
    const input = await ask('\nSelect catalog(s) by number (e.g. 1, or 1,2 for both): ');
    const parts = input.split(',').map(s => parseInt(s.trim(), 10) - 1);
    selectedIndexes = parts.filter(n => !isNaN(n) && n >= 0 && n < catalogs.length);
    if (!selectedIndexes.length) print('Invalid selection. Please enter valid catalog number(s).');
  }

  const pools = [];
  for (const idx of selectedIndexes) {
    const catalog = catalogs[idx];
    print(`\nLoading products from "${catalog.Name}"...`);
    const pool = fetchProductPool(catalog.Id);
    print(`  → ${pool.length} product(s) loaded`);
    pools.push(pool);
  }

  const productPool = mergeProductPools(pools);
  print(`\n✓ Total product pool: ${productPool.length} product(s)`);
  return productPool;
}

// ─── Phase 2 (bundle process) — Bundles ──────────────────────────────────────

/**
 * Load each configured bundle declared by the org type, along with its allowed
 * component products (priced + enriched). Used by the bundle-aware process.
 */
function phaseBundles(orgType) {
  print('\n─── Phase 2: Bundles ────────────────────────────────────────────────');

  const bundles = [];
  for (const name of orgType.bundleNames) {
    try {
      const cfg = fetchBundlePool(name);
      const defaults = cfg.components.filter(c => c.isDefault).length;
      print(`✓ "${name}" — ${cfg.components.length} priceable component(s), ${defaults} default(s)`);
      bundles.push(cfg);
    } catch (e) {
      print(`✗ "${name}" skipped: ${e.message}`);
    }
  }
  return bundles;
}

// ─── Phase 3 (bundle process) — Orders ───────────────────────────────────────

async function phaseBundleOrders(accounts, bundles, orgType) {
  print('\n─── Phase 3: Order Generation ───────────────────────────────────────');
  print(`Accounts: ${accounts.length} | Bundles: ${bundles.map(b => b.bundle.productName).join(', ')}`);
  print(`Mix: ~${Math.round((1 - orgType.flatRatio) * 100)}% configured bundle orders / ~${Math.round(orgType.flatRatio * 100)}% flat standalone orders.`);
  print(`Invoicing: ${orgType.invoicing ? 'on — each activated order is invoiced and posted' : 'off'}.`);

  let ordersPerAccount = null;
  while (!ordersPerAccount) {
    const input = await ask('\nHow many orders per account? ');
    ordersPerAccount = parseNumber(input);
    if (!ordersPerAccount) print('Please enter a whole number.');
  }

  const total = accounts.length * ordersPerAccount;
  const confirm = await ask(`\nThis will create ${total} order(s) total. Proceed? (yes/no): `);
  if (!parseYesNo(confirm)) {
    print('Order generation cancelled.');
    return;
  }

  print('\nGenerating orders...\n');
  const result = await generateMixedOrders(
    accounts,
    bundles,
    ordersPerAccount,
    msg => print(msg),
    {
      flatRatio: orgType.flatRatio,
      quantityRange: orgType.quantityRange,
      maxOrderTotal: orgType.maxOrderTotal,
      invoicing: orgType.invoicing,
    }
  );

  printRunSummary(result);
}

// ─── Phase 3 (catalog process) — Orders ──────────────────────────────────────

async function phaseOrders(accounts, productPool, orgType) {
  print('\n─── Phase 3: Order Generation ───────────────────────────────────────');
  print(`Accounts: ${accounts.length} | Products available: ${productPool.length}`);
  print('Each order: 3–10 random products, 0–40% discount per line, date spread Jan 2025–today.');
  print(`Invoicing: ${orgType.invoicing ? 'on — each activated order is invoiced and posted' : 'off'}.`);

  let ordersPerAccount = null;
  while (!ordersPerAccount) {
    const input = await ask('\nHow many orders per account? ');
    ordersPerAccount = parseNumber(input);
    if (!ordersPerAccount) print('Please enter a whole number.');
  }

  const total = accounts.length * ordersPerAccount;
  const confirm = await ask(`\nThis will create ${total} order(s) total. Proceed? (yes/no): `);
  if (!parseYesNo(confirm)) {
    print('Order generation cancelled.');
    return;
  }

  print('\nGenerating orders...\n');
  const result = await generateOrders(
    accounts,
    productPool,
    ordersPerAccount,
    msg => print(msg),
    {
      quantityRange: orgType.quantityRange,
      maxOrderTotal: orgType.maxOrderTotal,
      invoicing: orgType.invoicing,
    }
  );

  printRunSummary(result);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  print('╔══════════════════════════════════════════════════════════════════╗');
  print('║  Revenue Management Intelligence — Bulk Data Generation Toolkit  ║');
  print('╚══════════════════════════════════════════════════════════════════╝');
  print(`Target org: ${process.env.SF_TARGET_ORG || 'iewc-mfg-rca'}`);

  const orgType = await phaseOrgType();

  const accounts = await phaseAccounts();
  if (!accounts.length) { print('No accounts to target. Exiting.'); rl.close(); return; }

  if (orgType.process === 'bundle') {
    const bundles = phaseBundles(orgType);
    if (!bundles.length) { print('No usable bundles in this org. Exiting.'); rl.close(); return; }
    await phaseBundleOrders(accounts, bundles, orgType);
  } else {
    const productPool = await phaseCatalog();
    if (!productPool.length) { print('No products in pool. Exiting.'); rl.close(); return; }
    await phaseOrders(accounts, productPool, orgType);
  }

  rl.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  rl.close();
  process.exit(1);
});
