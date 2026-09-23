const form = document.getElementById('loginForm');
const error = document.getElementById('loginError');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.textContent = '';
  const data = Object.fromEntries(new FormData(form));
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (res.ok) { location.href = '/'; return; }
    error.textContent = (await res.json()).error || 'Sign in failed.';
  } catch {
    error.textContent = 'Could not reach the server.';
  }
});
