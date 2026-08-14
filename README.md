# RMI Toolkit — Revenue Management Intelligence Bulk Data Generator

A CLI toolkit that generates realistic demo transaction data for a Salesforce Revenue Cloud org. It creates accounts, places priced orders via the `PlaceSalesTransaction` (PST) Apex API, and activates them — all through an interactive prompt-based flow.

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
```

Two things that will bite an automated caller:

- **The interactive prompts can't be driven by piped stdin.** Piping answers into `node bin/generate.js` makes `readline` consume the buffer and hang. Use the [non-interactive drivers](#non-interactive-drivers), or `--org-type <key>` plus a pty.
- **Failures are logged, not fatal.** A run reports `✓ created` and `✗ failures` and keeps going. Always read the summary — a "successful" run can still have failed orders. Common causes are an account with no billing/shipping address or no contact (activation is refused) and `TaxCalculationInProcess` (async pricing hadn't settled before conversion).

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

| Org type | Key | Process | Line quantity | Max order total |
|----------|-----|---------|---------------|-----------------|
| Revenue Cloud - QuantumBit | `quantumbit` | Configured bundles + standalone lines drawn from those bundles' components | 1–25 | $10M |
| Revenue Cloud for Manufacturing | `manufacturing` | Catalog-driven flat orders (the original toolkit process) | 100–5,000 | $10M |

Quantity ranges are per org type because the catalogs sell differently: software seats and professional-services engagements go out in single or double digits, discrete manufactured parts go out by the pallet. A quote is also capped at `maxOrderTotal` — quantities are projected against `unitPrice × quantity × (1 − discount)` (which is exactly how the line prices out) and scaled down together if the quote would exceed the ceiling.

**Revenue Cloud - QuantumBit** targets orgs whose catalog is built around configurable bundles. Bundle orders are placed by POSTing only the bundle root with the PST configurator enabled (`addDefaultConfiguration` + `executeConfigurationRules`), which expands and validates the bundle exactly like a hand-built configured quote — the only path that reliably converts, since a hand-assembled bundle trips CML constraint validation and is blocked at conversion. The remaining ~35% of orders are flat quotes whose lines are standalone products taken from those same bundles, restricted to products proven to convert on their own (non-configurable, and previously seen as top-level items on an activated order).

**Revenue Cloud for Manufacturing** is the original process: you pick one or more product catalogs and each order draws a random set of products from that pool. No bundle configuration is performed.

Org types are declared in `src/orgTypes.js` — add an entry there and the CLI picks it up automatically.

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
Specify how many orders per account and confirm the total. Each order is either a configured bundle order (bundle chosen at random) or a flat standalone order, with randomized products, quantities, discounts and dates. Orders are converted and activated as they are created.

> Randomization *within* a bundle is not performed: swapping components on a hand-assembled bundle trips the constraint model and blocks conversion. Variety comes from the bundle choice and from the flat standalone orders.

### Phase 3 — Order Generation *(Manufacturing)*
Specify how many orders per account. The toolkit will then:
- Randomly select 3–10 products per order from the chosen catalog(s)
- Assign a random discount of 0–40% per line item via the `Discount` field on `OrderItem`
- Assign a random order date between January 1, 2025 and today
- Call `PlaceSalesTransaction` (PST) to price each order
- Activate each order upon successful PST response
- Log any failures without stopping the run

A summary of created vs. failed orders is printed at the end.

---

## Non-Interactive Drivers

For scripted or long batch runs, each process has a driver that takes its parameters up front:

```bash
# Revenue Cloud - QuantumBit — 3 orders per account, all accounts
node run_bundle.js 3

# Same, limited to the first 2 accounts, half of them flat orders
RMI_ACCOUNT_LIMIT=2 RMI_FLAT_RATIO=0.5 node run_bundle.js 3

# Revenue Cloud for Manufacturing
node run_batch.js
```

`run_bundle.js` reads its bundle list and default flat ratio from the same `src/orgTypes.js` entry the interactive CLI uses, so the two stay in sync.

---

## Governor Limit Guidance

PST is called once per order — each call is its own Apex transaction. For large runs:

| Orders | Estimated time |
|--------|---------------|
| 1–50   | 2–10 min      |
| 50–200 | 10–40 min     |
| 200+   | Toolkit warns before proceeding |

If you hit CPU timeout errors on individual orders, the failure is logged and the run continues.

---

## Reference Apex Scripts

Standalone scripts for manual debugging are in `scripts/apex/data-gen/`:

| Script | Purpose |
|--------|---------|
| `01_create_accounts.apex` | Create a sample batch of accounts manually |
| `02_create_order_pst.apex` | Place a single PST order (fill in placeholder IDs) |
| `03_activate_order.apex` | Activate a single order by ID |

Run any of them with:
```bash
sf apex run --target-org <your-org-alias> --file scripts/apex/data-gen/02_create_order_pst.apex
```
