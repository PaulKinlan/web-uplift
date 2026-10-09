(() => {
  document.getElementById('name').value = 'Jo Bloggs';
  document.getElementById('email').value = 'jo@example.com';
  document.getElementById('message').value = 'There is a pothole on Mill Lane outside number 12.';
  document.getElementById('enquiry-form').requestSubmit();
  return 'submitted';
})()
