// NEUTRALISED SAMPLE (web-uplift-17q). This file is the provenance record of the
// probe the model-led run authored to submit the demo contact form natively
// (PROVENANCE.md documents that the scratch probes are the agent's own), kept
// under its original name because write-scope.json:50 references this exact
// path. The live requestSubmit() is DISABLED - it is commented out below - and
// the sample payload is a placeholder, so re-running or copying this file cannot
// submit anything to a real endpoint. To probe a target you own and are
// authorised to test, uncomment that line.
(() => {
  document.getElementById('name').value = 'Example User';
  document.getElementById('email').value = 'user@example.invalid';
  document.getElementById('message').value = 'Placeholder message from the web-uplift form probe.';
  // The live side effect this probe performed, kept as the record of it:
  //   document.getElementById('enquiry-form').requestSubmit();
  //   return 'submitted';
  return { submitted: false, note: 'live requestSubmit disabled (web-uplift-17q)' };
})()
