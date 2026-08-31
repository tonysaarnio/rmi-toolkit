# RMI Toolkit — Revenue Management Intelligence Bulk Data Generator

A CLI toolkit that generates realistic demo transaction data for a Salesforce Revenue Cloud org. It creates accounts, places priced orders via the `PlaceSalesTransaction` (PST) Apex API, activates them, and invoices them — all through an interactive prompt-based flow.

The right way to generate that data differs by org, so the CLI asks which **org type** you are targeting before anything else and then runs the process that matches it. See [Org Types](#org-types) below.

---

## If You Were Asked to "Deploy This Repo to an Org"

This section is for anyone — human or AI agent — handed a task like *"clone this repo and deploy it into org X."* That instruction doesn't apply cleanly here, and following it literally wastes a lot of time.

**There is no metadata to deploy.** This repo has no `sfdx-project.json`, no `force-app/`, and no `manifest/`. `sf project deploy start` has nothing to act on. The toolkit is a Node.js CLI that runs *against* an org that is already configured — it reads that org's catalog and writes transaction data (accounts, quotes, orders) through the `PlaceSalesTransaction` Apex API.

So "deploying" this repo means:

1. `npm install` and set `SF_TARGET_ORG` in `.env` (see [Setup](#setup)).
2. Confirm the target org — the data lands in a real org and is not trivially reversible.
3. **Ask which org type to generate for** (see [Org Types](#org-types)). This is the one question that must be answered before generating: the two processes produce structurally different data and are not interchangeable. Do not guess from the org name.
4. Run the generator, then verify.

Verify with a query rather than trusting the console summary:

```bash
sf data query --target-org <alias> \
  --query "SELECT COUNT(Id) FROM Order WHERE Status = 'Activated' AND CreatedDate = TODAY"

sf data query --target-org <alias> \
  --query "SELECT COUNT(Id) FROM Invoice WHERE Status = 'Posted' AND CreatedDate = TODAY"
```

Two things that will bite an automated caller:

- **The interactive prompts can't be driven by piped stdin.** Piping answers into `node bin/generate.js` makes `readline` consume the buffer and hang. Use the [non-interactive drivers](#non-interactive-drivers), or `--org-type <key>` plus a pty.
- **Failures are logged, not fatal.** A run reports `✓ created` and `✗ failures` and keeps going. Always read the summary — a "successful" run can still have failed orders. Common causes are an account with no billing/shipping address or no contact (activation is refused) and `TaxCalculationInProcess` (async pricing hadn't settled before conversion). Invoicing failures are tallied on a separate line and do **not** mean the order failed; see [Invoicing](#invoicing).
- **Transport failures are retried; side effects are not repeated blindly.** A dropped connection to the org (`fetch failed`, `ECONNRESET`, a 502/503) surfaces as a failed order even though nothing was wrong with the request, and on a long run it will happen. Reads retry automatically. Writes are handled per step according to whether repeating them can duplicate a record — see [Transient transport failures](#transient-transport-failures).

---

## Prerequisites

- Node.js 18+
- `sf` CLI authenticated to your target org

Verify your org auth before running:
```bash
sf org display --target-org <your-org-alias>
```

---

## Setup

From the `rmi-toolkit/` directory:

```bash
# 1. Install dependencies
npm install

# 2. Set your target org alias
cp .env.example .env
#    Edit .env and set SF_TARGET_ORG to your org alias
```

---

## Org Types

| Org type | Key | Process | Line quantity | Max order total | Invoicing |
|----------|-----|---------|---------------|-----------------|-----------|
| Revenue Cloud - QuantumBit | `quantumbit` | Configured bundles + standalone lines drawn from those bundles' components | 1–25 | $10M | on |
| Revenue Cloud for Manufacturing | `manufacturing` | Catalog-driven flat orders (the original toolkit process) | 100–5,000 | $10M | on |

Quantity ranges are per org type because the catalogs sell differently: software seats and professional-services engagements go out in single or double digits, discrete manufactured parts go out by the pallet. A quote is also capped at `maxOrderTotal` — quantities are projected against `unitPrice × quantity × (1 − discount)` (which is exactly how the line prices out) and scaled down together if the quote would exceed the ceiling.

**Revenue Cloud - QuantumBit** targets orgs whose catalog is built around configurable bundles. Bundle orders are placed by POSTing only the bundle root with the PST configurator enabled (`addDefaultConfiguration` + `executeConfigurationRules`), which expands and validates the bundle exactly like a hand-built configured quote — the only path that reliably converts, since a hand-assembled bundle trips CML constraint validation and is blocked at conversion. The remaining ~35% of orders are flat quotes whose lines are standalone products taken from those same bundles, restricted to products proven to convert on their own (non-configurable, and previously seen as top-level items on an activated order).

**Revenue Cloud for Manufacturing** is the original process: you pick one or more product catalogs and each order draws a random set of products from that pool. No bundle configuration is performed.

Org types are declared in `src/orgTypes.js` — add an entry there and the CLI picks it up automatically.

---

## Invoicing

When an org type declares `invoicing: true`, every order the toolkit activates is also invoiced: a Draft invoice is generated from the order's billing schedules and then posted, which is what assigns the `InvoiceNumber` and makes the revenue reportable.

**This runs after activation because it has to.** Activating an order is the billing trigger — it fires the Order-to-Billing-Schedule flow, and only the `BillingSchedule` records that flow writes can be invoiced. The flow is asynchronous, so the toolkit polls for those schedules (and waits for the count to settle, since a bundle order produces one schedule per billable component) before generating anything.

Invoices are dated with **the order's own date, not today** — `invoiceDate` is back-dated to `Order.EffectiveDate`, so invoices land on the same timeline as the orders and revenue can be charted over it. (Verified: an order dated 2025-10-08 produced a posted invoice with `InvoiceDate = 2025-10-08`.)

`targetDate`, which is a different thing, is **today**. It selects which billing periods are due, and the billing engine dates a subscription schedule from the subscription's own start rather than from the order's back-dated `EffectiveDate` — so an earlier target leaves those lines not-yet-due. The toolkit also drops schedules whose `NextBillingDate` is still in the future before calling `generate`, because `generate` rejects the *entire* call if any one submitted schedule falls outside the filter, and a single order legitimately mixes dates (a bundle's one-time lines bill on the order date while its subscription lines bill from their own start).

**Invoicing failures never fail the order.** They are reported on their own summary line and the order stays counted as created. This is deliberate: an order that activated is correct and complete, and a failure at this stage almost always describes the *org*, not the order. The usual causes are a billing engine that isn't configured (no billing policies or treatments, or the Order-to-Billing-Schedule flow is inactive), a missing `AccountingPeriod` covering the order's back-dated invoice date, or missing General Ledger accounts for the account's region.

If the target org has no billing configuration at all, set `invoicing: false` on its org type. Leaving it on still completes the run, but each order first burns the billing-schedule timeout (3 minutes) waiting for schedules that never arrive.

### Why this path, and not Preview Invoices or an Invoice Scheduler

Nothing here hand-assembles an invoice. The toolkit calls the billing engine's own invoice-creation API (`commerce/invoicing/invoices/collection/actions/generate`, then `.../actions/post`), which consumes the `BillingSchedule` records activation produced and lets the engine compute the lines, amounts and `InvoiceNumber`. It is the same operation the **Bill Now** action on the Account and Order pages performs, and Salesforce ships a permission set named *Generate Invoices From Billing Schedule API* specifically for it.

The two adjacent mechanisms don't fit this job:

- **Preview Invoices** (the action on the Account/Order page) *persists nothing*. It returns a projection of the next two billing periods for verifying products, discounts and tax — there is no invoice and no ID to keep. It also requires a custom procedure plan definition per object before it works at all. It's a useful thing to click when checking an org by hand; it can't generate data.
- **Invoice Scheduler / batch invoice runs** are the answer for *scale*, not for correctness — Salesforce recommends them above 200 billing schedules or 200 invoice lines per call. They select schedules by declarative filter criteria rather than by ID, which is the wrong shape when the goal is one invoice attributable to the order just created; they additionally need the Data Pipelines Base User permission set, and they leave persistent scheduler and batch-run records behind. The toolkit raises a clear error if an order ever exceeds the 200-schedule limit rather than silently invoicing part of it.

Note that switching to a scheduler would not change the date rules: `NextBillingDate ≤ targetDate` governs schedule selection for "an invoice scheduler or API" identically.

### Diagnosing a failed invoice

Billing failures are terse and often end with *"Check the billing schedule's RTEL log."* **RTEL** is the `RevenueTransactionErrorLog` object, which carries the real explanation:

```bash
sf data query --target-org <alias> \
  --query "SELECT Category, ErrorMessage, PrimaryRecordId FROM RevenueTransactionErrorLog ORDER BY CreatedDate DESC LIMIT 10"
```

`PrimaryRecordId` is the billing schedule, order or invoice involved, and `Category` values such as `Core Invoice Generation Failure` narrow down the stage. Reading it needs the Billing Operations User permission set; in the UI it's the *Revenue Transaction Error Logs* related list on the record.

Posted invoices **cannot be deleted**, so unlike the rest of the generated data this step is not reversible. Each invoice is stamped with an `RMI-<date>-<order suffix>` marker in `Description` and linked back to its order via `ReferenceEntityId`, which makes the generated set identifiable after the fact.

---

## Running the Toolkit

```bash
node bin/generate.js
```

The CLI walks you through the phases interactively:

### Phase 0 — Target Org Type
Pick the org type you are generating data for. This selects the process used in Phases 2 and 3. To skip the prompt in scripted runs, pass `--org-type quantumbit` (or set `RMI_ORG_TYPE`).

### Phase 1 — Accounts
You will be asked whether to create new accounts or use existing ones.
- **New accounts:** specify how many. The toolkit generates industry-appropriate names (automotive OEMs, wire harness manufacturers, aerospace suppliers, etc.) with:
  - `Type` — randomly assigned (Customer / Prospect / Reseller / Integrator)
  - `Rating` — randomly assigned (Hot / Warm / Cold)
  - `BillingState/Country` and `ShippingState/Country` — randomly assigned from a pool of US states, Canada (Ontario, Quebec), and Germany (Bavaria, Baden-Württemberg)
  - `Customer_Tier__c` — randomly assigned (Bronze / Silver / Gold / Platinum) if the field exists in the org
- **Existing accounts:** all current accounts in the org will be used as targets.

### Phase 2 — Bundles *(QuantumBit)* or Product Catalog *(Manufacturing)*
- **QuantumBit:** the bundles declared for the org type are loaded with their allowed, priceable components. No input needed.
- **Manufacturing:** available product catalogs are queried from the org and presented. Select one or more by number.

### Phase 3 — Order Generation *(QuantumBit)*
Specify how many orders per account and confirm the total. Each order is either a configured bundle order (bundle chosen at random) or a flat standalone order, with randomized products, quantities, discounts and dates. Orders are converted, activated and — when the org type enables it — invoiced as they are created.

> Randomization *within* a bundle is not performed: swapping components on a hand-assembled bundle trips the constraint model and blocks conversion. Variety comes from the bundle choice and from the flat standalone orders.

### Phase 3 — Order Generation *(Manufacturing)*
Specify how many orders per account. The toolkit will then:
- Randomly select 3–10 products per order from the chosen catalog(s)
- Assign a random discount of 0–40% per line item via the `Discount` field on `OrderItem`
- Assign a random order date between January 1, 2025 and today
- Call `PlaceSalesTransaction` (PST) to price each order
- Activate each order upon successful PST response
- Generate and post an invoice for each activated order (see [Invoicing](#invoicing))
- Log any failures without stopping the run

A summary of created vs. failed orders — and of posted vs. failed invoices — is printed at the end.

---

## Non-Interactive Drivers

For scripted or long batch runs, each process has a driver that takes its parameters up front:

```bash
# Revenue Cloud - QuantumBit — 3 orders per account, all accounts
node run_bundle.js 3

# Same, limited to the first 2 accounts, half of them flat orders
RMI_ACCOUNT_LIMIT=2 RMI_FLAT_RATIO=0.5 node run_bundle.js 3

# Orders only — skip invoicing (useful on an org with no billing configuration)
RMI_INVOICING=0 node run_bundle.js 3

# Revenue Cloud for Manufacturing
node run_batch.js

# Trended bundle data — 120 orders spread across Jan 2025 → today
RMI_TOTAL_ORDERS=120 node run_bundle_trend.js
```

`run_bundle_trend.js` spreads orders across calendar months so that both order volume and revenue climb over time: monthly counts rise geometrically with noise, the larger bundle's share ramps up with recency, and the discount ceiling on flat orders ramps down. It targets only accounts that have a billing address, since those are the ones that can activate. Because the order's date is written to `Order.EffectiveDate`, charts built on this data must use `EffectiveDate` as the time axis, not `CreatedDate`.

`run_bundle.js` reads its bundle list, default flat ratio and invoicing default from the same `src/orgTypes.js` entry the interactive CLI uses, so the two stay in sync. `RMI_INVOICING=0|1` overrides the invoicing default for one run.

---

## Transient transport failures

The `sf` CLI occasionally fails to reach the org — `fetch failed`, `ECONNRESET`, a 502/503 — and the toolkit cannot tell that apart from a lost order without help. Over a 120-order run this is routine, so each step declares whether it may be repeated.

The distinction that matters: **a lost response does not mean the work didn't happen.** PST takes 30–60s, so a client-side timeout has very likely already committed its Quote. Retrying blind would create a duplicate.

| Step | On a transport failure | Why |
|------|------------------------|-----|
| Any SOQL read | Retried up to 3× | A read has no side effect |
| PST (create Quote) | Not retried — order is failed and reported | No idempotency key exists to recognise a Quote it already created |
| Link Account | Retried up to 3× | Made idempotent: adopts the Quote's existing stub Opportunity instead of inserting a second |
| Convert to Order | Verified, then adopted or retried | `Order.QuoteId` identifies an Order the conversion already committed |
| Activate Order | Retried up to 3× | Re-sets fixed fields on a known Order — a no-op the second time |
| Invoice `generate` | Not retried — invoicing is failed and reported | No idempotency key; a second call means a second invoice |
| Invoice `post` | Status is re-read to settle it | Targets an existing invoice, so `Invoice.Status` reveals whether the post landed |
| Invoice tag | Retried up to 3× | An update to known ids, and its failure only warns |

Two steps deliberately give up rather than risk a duplicate. If PST or `generate` reports a transport failure, the order or its invoice is genuinely lost and simply needs re-running.

---

## Governor Limit Guidance

PST is called once per order — each call is its own Apex transaction. For large runs:

| Orders | Estimated time |
|--------|---------------|
| 1–50   | 2–10 min      |
| 50–200 | 10–40 min     |
| 200+   | Toolkit warns before proceeding |

Invoicing adds roughly 30–60s per order on top of those figures. Almost all of it is spent waiting rather than computing: the billing-schedule flow and invoice generation are both asynchronous, so the toolkit polls for each. Budget accordingly on large runs, or generate orders first with `RMI_INVOICING=0`.

If you hit CPU timeout errors on individual orders, the failure is logged and the run continues.

---

## Reference Apex Scripts

Standalone scripts for manual debugging are in `scripts/apex/data-gen/`:

| Script | Purpose |
|--------|---------|
| `01_create_accounts.apex` | Create a sample batch of accounts manually |
| `02_create_order_pst.apex` | Place a single PST order (fill in placeholder IDs) |
| `03_activate_order.apex` | Activate a single order by ID |
| `04_create_invoice.apex` | Invoice a single activated order by ID (generate + post) |

Run any of them with:
```bash
sf apex run --target-org <your-org-alias> --file scripts/apex/data-gen/02_create_order_pst.apex
```
