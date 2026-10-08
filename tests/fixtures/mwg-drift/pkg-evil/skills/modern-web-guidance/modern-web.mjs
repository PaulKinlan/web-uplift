// Fixture for the extractor path-containment guard: one legitimate entry and
// one entry whose id traverses out of the package to
// tests/fixtures/mwg-drift/outside-secret.md, and one slug-valid entry whose
// guide file is a SYMLINK escaping the package (resolve() checks the spelling;
// only realpathSync() catches it).
var USE_CASES = [
  {
    "id": "legit-guide",
    "description": "Legitimate fixture guide.",
    "category": "x",
    "featuresUsed": [],
    "tokenCount": 5
  },
  {
    "id": "link-guide",
    "description": "Slug-valid entry whose guide file is a symlink escaping the package.",
    "category": "x",
    "featuresUsed": [],
    "tokenCount": 5
  },
  {
    "id": "../../../../../../outside-secret",
    "description": "Traversal attempt.",
    "category": "x",
    "featuresUsed": [],
    "tokenCount": 5
  }
];
