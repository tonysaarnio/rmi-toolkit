/**
 * Org-type registry.
 *
 * The toolkit supports more than one Revenue Cloud data shape, and the correct
 * generation process differs per org type. Each entry declares which process to
 * run; bin/generate.js prompts for one of these up front and routes accordingly.
 *
 * To add a new org type, add an entry here — the CLI picks it up automatically.
 */
export const ORG_TYPES = [
  {
    key: 'quantumbit',
    label: 'Revenue Cloud - QuantumBit',
    process: 'bundle',
    summary: 'Configured bundles + standalone lines drawn from the bundle components.',
    detail: [
      'Bundle orders are built through the PST configurator, which expands and',
      'validates the bundle (root + component children) exactly like a real',
      'configured quote. A share of orders are instead flat quotes whose lines are',
      'standalone products taken from those bundles.',
    ].join(' '),
    // Bundles to draw from; each order picks one at random.
    bundleNames: ['QuantumBit Complete Solution', 'QuantumBit Starter'],
    // Fraction of orders generated as flat (no-bundle) quotes.
    flatRatio: 0.35,
    // Software licences and professional services are sold in small counts —
    // seats and engagements, not pallets.
    quantityRange: [1, 25],
    // Hard ceiling on a generated quote/order total. Line quantities are scaled
    // down together if a quote would exceed it.
    maxOrderTotal: 10_000_000,
  },
  {
    key: 'manufacturing',
    label: 'Revenue Cloud for Manufacturing',
    process: 'catalog',
    summary: 'Catalog-driven flat orders (the original toolkit process).',
    detail: [
      'You pick one or more product catalogs; each order gets a random set of',
      'products from that pool with randomized quantities, discounts and dates.',
      'No bundle configuration is performed.',
    ].join(' '),
    // Discrete manufactured parts ship in bulk.
    quantityRange: [100, 5000],
    maxOrderTotal: 10_000_000,
  },
];

/** Look up an org type by key (case-insensitive). Returns undefined if unknown. */
export function getOrgType(key) {
  if (!key) return undefined;
  const k = String(key).trim().toLowerCase();
  return ORG_TYPES.find(t => t.key === k);
}
