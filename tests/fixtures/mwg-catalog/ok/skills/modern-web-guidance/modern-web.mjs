// Minimal fixture for the catalog generator: a USE_CASES table that is NOT pure JSON
// (single-quoted literal, a comment, a trailing comma), so the generator proves it parses
// data declaratively and would never have to evaluate the package.
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
  // The twin below is what a file-only guide is inserted next to.
  {
    "id": "language-model",
    "description": "Twin guide.",
    "category": "built-in-ai",
    "featuresUsed": [],
    "tokenCount": 20,
  },
];
