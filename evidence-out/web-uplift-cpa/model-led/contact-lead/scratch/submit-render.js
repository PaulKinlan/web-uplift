// NEUTRALISED SAMPLE (web-uplift-pv1). This file is the provenance record of the
// probe the model-led run authored to drive the demo contact form's real submit
// (PROVENANCE.md documents that the scratch probes are the agent's own), kept
// under its original name because write-scope.json:49 references this exact
// path. The live request is DISABLED - the fetch/POST and the response paint are
// commented out below - and the sample payload is a placeholder, so re-running
// or copying this file cannot submit anything to a real endpoint. To probe a
// target you own and are authorised to test, uncomment those lines.
(async () => {
  // Fill the form, then (as originally written) send exactly what a native
  // submit sends (FormData urlencoded POST to form.action) and paint the
  // server's response the way the browser would after navigation. A native
  // requestSubmit() navigates the page, which the screenshot primitive captured
  // before the response arrived.
  const f = document.getElementById('enquiry-form');
  document.getElementById('name').value = 'Example User';
  document.getElementById('email').value = 'user@example.invalid';
  document.getElementById('message').value = 'Placeholder message from the web-uplift form probe.';
  const valid = f.checkValidity();
  // The live side effect this probe performed, kept as the record of it:
  //   const r = await fetch(f.action, { method: 'POST', body: new URLSearchParams(new FormData(f)) });
  //   const html = await r.text();
  //   document.open(); document.write(html); document.close();
  //   return { valid, status: r.status, statusText: r.statusText };
  return { valid, submitted: false, note: 'live POST disabled (web-uplift-pv1)' };
})()
