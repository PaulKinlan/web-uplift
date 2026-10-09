(async () => {
  // Fill the real form, then send exactly what a native submit sends (FormData
  // urlencoded POST to form.action) and paint the server's response the way the
  // browser would after navigation. A native requestSubmit() navigates the page,
  // which the screenshot primitive captured before the response arrived.
  const f = document.getElementById('enquiry-form');
  document.getElementById('name').value = 'Jo Bloggs';
  document.getElementById('email').value = 'jo@example.com';
  document.getElementById('message').value = 'There is a pothole on Mill Lane outside number 12.';
  const valid = f.checkValidity();
  const r = await fetch(f.action, { method: 'POST', body: new URLSearchParams(new FormData(f)) });
  const html = await r.text();
  document.open(); document.write(html); document.close();
  return { valid, status: r.status, statusText: r.statusText };
})()
