'use strict';
const form = document.getElementById('loginForm');
const err = document.getElementById('err');
const btn = document.getElementById('submitBtn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Tekshirilmoqda…';

  try {
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Kirishda xatolik');
    location.href = '/';
  } catch (e2) {
    err.textContent = e2.message;
    btn.disabled = false;
    btn.textContent = 'Kirish';
  }
});
