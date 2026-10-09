(() => {
  const f = document.getElementById('enquiry-form');
  for (let i = 0; i < 10; i++) {
    document.getElementById('name').value = 'Jo ' + i;
    document.getElementById('email').value = 'jo' + i + '@';
    document.getElementById('message').value = 'Message ' + i + ' '.repeat(50);
    f.checkValidity();
    document.getElementById('name').focus();
    document.getElementById('message').focus();
    f.reset();
  }
  return 'cycled 10x';
})()
