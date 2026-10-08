// Fixture for the extractor path-containment guard: one legitimate entry and
// one entry whose id traverses out of the guides directory to the package-root
// secret.md (guides/x/../../../../secret.md).
var USE_CASES = [
  {
    "id": "legit-guide",
    "description": "Legitimate fixture guide.",
    "category": "x",
    "featuresUsed": [],
    "tokenCount": 5
  },
  {
    "id": "../../../../secret",
    "description": "Traversal attempt.",
    "category": "x",
    "featuresUsed": [],
    "tokenCount": 5
  }
];
