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
  }
];

// An eval-based extractor would run this; a parser must not.
globalThis.EXTRACTOR_EVALED = true;
