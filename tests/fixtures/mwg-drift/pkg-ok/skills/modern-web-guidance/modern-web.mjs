// Minimal fixture for the corpus extractor: a USE_CASES table that is NOT pure
// JSON (single-quoted literal), proving the extractor parses declaratively and
// never evaluates package code.
var USE_CASES = [
  {
    "id": "alpha-guide",
    "description": "First fixture guide.",
    "category": "alpha",
    "featuresUsed": [
      '<not-json single-quoted>'
    ],
    "tokenCount": 10
  },
  {
    "id": "beta-guide",
    "description": "Second fixture guide.",
    "category": "beta",
    "featuresUsed": [],
    "tokenCount": 20
  },
  {
    "id": "delta-guide",
    "description": "Guide whose file is intentionally empty (provenance must stay use_cases).",
    "category": "delta",
    "featuresUsed": [],
    "tokenCount": 0
  },
  // TRIPWIRE: this element sits INSIDE the captured table slice. Any extractor
  // that evaluates the table (eval, node:vm, Function) executes it and dies
  // with this exact message, failing suite case 11 loudly. A parser ignores it.
  (function(){ throw new Error('EXTRACTOR-EVALUATED-THE-TABLE'); })()
];
