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
  // TRIPWIRE: this element sits INSIDE the captured table slice. Anything that evaluates the
  // table (eval, Function, node:vm) runs it and dies on this message. A data-only parser
  // refuses the table instead, without running a line of it.
  (function () { require("node:fs").writeFileSync(process.env.MWG_CATALOG_TRIPWIRE, "RAN"); throw new Error("CATALOG-EVALUATED-THE-TABLE"); })(),
  {
    "id": "language-model",
    "description": "Twin guide.",
    "category": "built-in-ai",
    "featuresUsed": [],
    "tokenCount": 20,
  },
];
