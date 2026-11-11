/* =====================================================
   MOSSTECH Login / Sign Up - login.js
   All checks are enforced again on the server (server/routes/auth.js).
   ===================================================== */
'use strict';

const $ = (id) => document.getElementById(id);
let pendingReset = null; // admin password reset waiting for the authenticator code
function setMsg(id, text) { const n = $(id); if (n) n.textContent = text || ''; }
function clearMessages() { ['loginError', 'loginSuccess', 'signupError', 'signupSuccess'].forEach(id => setMsg(id, '')); }

// ---------- Validation (quick feedback only; the server re-checks everything) ----------
function isValidEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 120; }
function isValidUsername(s) { return /^[A-Za-z0-9_]{3,20}$/.test(s); }
function passwordProblems(pw) {
  const issues = [];
  if (pw.length < 8) issues.push('at least 8 characters');
  if (!/[a-z]/.test(pw)) issues.push('a lowercase letter');
  if (!/[A-Z]/.test(pw)) issues.push('an uppercase letter');
  if (!/\d/.test(pw)) issues.push('a number');
  if (!/[^A-Za-z0-9]/.test(pw)) issues.push('a symbol');
  return issues;
}

// ---------- Tabs / form toggles ----------
function showForm(which) {
  clearMessages();
  const isLogin = which === 'login';
  $('loginForm').classList.toggle('hidden-form', !isLogin);
  $('signupForm').classList.toggle('hidden-form', isLogin);
  $('loginTab').classList.toggle('active', isLogin);
  $('signupTab').classList.toggle('active', !isLogin);
  $('formTitle').textContent = isLogin ? 'Log In' : 'Sign Up';
}
function toggleAdminKeyField() {
  const isAdmin = $('signupRole').value === 'admin';
  const field = $('adminSecretKey');
  field.style.display = isAdmin ? 'block' : 'none';
  if (!isAdmin) field.value = '';
}
function checkPasswordStrength() {
  const pw = $('signupPassword').value;
  const warn = $('passWarning');
  if (!pw) { warn.textContent = ''; return; }
  const issues = passwordProblems(pw);
  warn.textContent = issues.length ? 'Password needs: ' + issues.join(', ') + '.' : 'Strong password ✔';
}
function redirectByRole(role) { window.location.href = role === 'admin' ? 'admin.html' : 'home.html'; }

// ---------- Login ----------
let loggingIn = false;
async function login() {
  if (loggingIn) return;
  clearMessages();
  const id = $('loginEmail').value.trim();
  const password = $('loginPassword').value;
  if (!id || !password) return setMsg('loginError', 'Please enter your username/email and password.');

  loggingIn = true;
  const r = await api('POST', '/api/auth/login', { id, password });
  loggingIn = false;
  if (r.status === 403 && r.data.needsVerification) {
    $('loginPassword').value = '';
    await api('POST', '/api/auth/resend-code', { email: r.data.email });   // send a fresh code
    setMsg('loginError', 'Please verify your email address to continue.');
    return openVerifyModal(r.data.email);
  }
  if (!r.ok) return setMsg('loginError', r.data.error || 'Login failed.');
  if (r.data.twoFactorRequired) {
    $('loginPassword').value = '';
    return openTwoFactorModal(r.data.challenge);
  }

  $('loginPassword').value = '';
  setMsg('loginSuccess', 'Login successful! Redirecting...');
  setTimeout(() => redirectByRole(r.data.user.role), 500);
}

// ---------- Sign up ----------
let signingUp = false;
async function startSignupWorkflow() {
  if (signingUp) return;
  clearMessages();
  const username = $('signupUname').value.trim();
  const email = $('signupEmail').value.trim().toLowerCase();
  const pw = $('signupPassword').value;
  const pw2 = $('signupPassword2').value;
  const role = $('signupRole').value === 'admin' ? 'admin' : 'user';
  const adminKey = $('adminSecretKey').value;

  if (!isValidUsername(username)) return setMsg('signupError', 'Username must be 3-20 characters: letters, numbers or underscore.');
  if (!isValidEmail(email)) return setMsg('signupError', 'Please enter a valid email address.');
  const issues = passwordProblems(pw);
  if (issues.length) return setMsg('signupError', 'Password needs: ' + issues.join(', ') + '.');
  if (pw !== pw2) return setMsg('signupError', 'Passwords do not match.');
  if (!$('terms').checked) return setMsg('signupError', 'You must agree to the Terms and Conditions.');
  if (role === 'admin' && !adminKey) return setMsg('signupError', 'Please enter the admin passkey.');

  signingUp = true;
  const r = await api('POST', '/api/auth/signup', { username, email, password: pw, role, adminKey });
  signingUp = false;
  if (!r.ok) return setMsg('signupError', r.data.error || 'Could not create the account.');

  ['signupUname', 'signupEmail', 'signupPassword', 'signupPassword2', 'adminSecretKey'].forEach(id => { $(id).value = ''; });
  $('terms').checked = false;
  $('passWarning').textContent = '';
  if (r.data.needsVerification) {
    setMsg('signupSuccess', 'Account created! Check your email for the verification code.');
    return openVerifyModal(r.data.email);
  }
  setMsg('signupSuccess', 'Account created! You can now log in.');
  setTimeout(() => { showForm('login'); setMsg('loginSuccess', 'Account created. Please log in.'); }, 1200);
}

// ---------- Modal (Forgot Password) ----------
let modalMode = null;   // 'forgot-email' | 'forgot-reset' | 'verify-email' | 'login-2fa'
let resetEmail = '';
let verifyEmail = '';
let twoFactorChallenge = '';

function showModal() {
  const m = $('securityModal');
  m.style.display = 'flex';
  m.classList.add('active', 'show');
}
function closeModal() {
  const m = $('securityModal');
  m.style.display = 'none';
  m.classList.remove('active', 'show');
  $('modalInput1').value = '';
  $('modalInput2').value = '';
  setMsg('modalError', '');
  $('modalResend').style.display = 'none';
  modalMode = null;
  pendingReset = null;
  resetEmail = '';
  verifyEmail = '';
  twoFactorChallenge = '';
}
function prepareCodeModal(title, description, buttonText) {
  $('modalTitle').textContent = title;
  $('modalDescription').textContent = description;
  const i1 = $('modalInput1');
  i1.type = 'text'; i1.value = ''; i1.setAttribute('maxlength', '12');
  i1.setAttribute('inputmode', 'numeric'); i1.setAttribute('autocomplete', 'one-time-code');
  $('modalInput2').classList.add('hidden-form');
  $('modalInput2').value = '';
  $('modalConfirmBtn').textContent = buttonText;
  setMsg('modalError', '');
  showModal();
  i1.focus();
}
function openVerifyModal(email) {
  modalMode = 'verify-email';
  verifyEmail = email;
  prepareCodeModal('Verify Your Email',
    `We sent a 6-digit code to ${email}. Enter it below. The code is valid for 15 minutes.`, 'Verify');
  $('modalInput1').placeholder = '6-digit code';
  $('modalResend').style.display = 'inline';
}
function openTwoFactorModal(challenge) {
  modalMode = 'login-2fa';
  twoFactorChallenge = challenge;
  prepareCodeModal('Two-Factor Authentication',
    'Enter the 6-digit code from your authenticator app. Lost your phone? Use one of your backup codes.', 'Verify');
  $('modalInput1').placeholder = 'Authenticator or backup code';
}
function openForgotPasswordModal() {
  modalMode = 'forgot-email';
  $('modalTitle').textContent = 'Forgot Password';
  $('modalDescription').textContent = 'Enter the email address of your account.';
  const i1 = $('modalInput1');
  i1.type = 'email'; i1.placeholder = 'Email address'; i1.value = '';
  i1.removeAttribute('maxlength'); i1.removeAttribute('inputmode');
  $('modalInput2').classList.add('hidden-form');
  $('modalInput2').value = '';
  $('modalConfirmBtn').textContent = 'Continue';
  setMsg('modalError', '');
  showModal();
  i1.focus();
}

let modalBusy = false;
async function handleModalSubmit() {
  if (modalBusy) return;
  setMsg('modalError', '');
  modalBusy = true;
  try {
    if (modalMode === 'verify-email') {
      const code = $('modalInput1').value.trim();
      if (!/^\d{6}$/.test(code)) return setMsg('modalError', 'Enter the 6-digit code from your email.');
      const r = await api('POST', '/api/auth/verify-email', { email: verifyEmail, code });
      if (!r.ok) return setMsg('modalError', r.data.error || 'Could not verify the code.');
      closeModal();
      showForm('login');
      setMsg('loginSuccess', 'Email verified! You can now log in.');
      return;
    }

    if (modalMode === 'login-2fa') {
      const code = $('modalInput1').value.trim();
      if (!code) return setMsg('modalError', 'Enter your authenticator or backup code.');
      const r = await api('POST', '/api/auth/login/2fa', { challenge: twoFactorChallenge, code });
      if (!r.ok) {
        if (r.data.restart) { closeModal(); return setMsg('loginError', r.data.error); }
        return setMsg('modalError', r.data.error || 'Invalid code.');
      }
      const role = r.data.user.role;
      closeModal();
      setMsg('loginSuccess', 'Login successful! Redirecting...');
      setTimeout(() => redirectByRole(role), 500);
      return;
    }

    if (modalMode === 'forgot-email') {
      const email = $('modalInput1').value.trim().toLowerCase();
      if (!isValidEmail(email)) return setMsg('modalError', 'Please enter a valid email address.');
      const r = await api('POST', '/api/auth/forgot', { email });
      if (!r.ok) return setMsg('modalError', r.data.error || 'Something went wrong.');

      resetEmail = email;
      modalMode = 'forgot-reset';
      $('modalTitle').textContent = 'Reset Password';
      $('modalDescription').textContent =
        'If that account exists, a 6-digit reset code was sent to that email. ' +
        'The code is valid for 5 minutes. Administrators enter the admin passkey instead of a code ' +
        '(and, if 2FA is on, their authenticator code in the next step).';
      const i1 = $('modalInput1');
      i1.type = 'password'; i1.placeholder = 'Reset code (admins: admin passkey)'; i1.value = '';
      i1.removeAttribute('inputmode'); i1.setAttribute('maxlength', '300');
      const i2 = $('modalInput2');
      i2.classList.remove('hidden-form'); i2.type = 'password'; i2.placeholder = 'New password'; i2.value = '';
      $('modalConfirmBtn').textContent = 'Reset Password';
      return;
    }

    if (modalMode === 'forgot-reset') {
      const secret = $('modalInput1').value;
      const newPassword = $('modalInput2').value;
      if (!secret) return setMsg('modalError', 'Enter your reset code or admin passkey.');
      const issues = passwordProblems(newPassword);
      if (issues.length) return setMsg('modalError', 'Password needs: ' + issues.join(', ') + '.');

      const r = await api('POST', '/api/auth/reset', { email: resetEmail, secret, newPassword });
      if (!r.ok && r.data.needsCode) {
        // Administrator with 2FA: the passkey was right, now ask for the authenticator (or backup) code
        pendingReset = { secret, newPassword };
        modalMode = 'forgot-reset-2fa';
        prepareCodeModal('Two-Factor Check',
          'Enter the 6-digit code from your authenticator app (or a backup code) to finish resetting this administrator password.', 'Reset Password');
        $('modalInput1').placeholder = 'Authenticator or backup code';
        return;
      }
      if (!r.ok) return setMsg('modalError', r.data.error || 'Could not reset the password.');
      closeModal();
      showForm('login');
      setMsg('loginSuccess', 'Password updated. Please log in.');
      return;
    }

    if (modalMode === 'forgot-reset-2fa') {
      const code = $('modalInput1').value.trim();
      if (!code) return setMsg('modalError', 'Enter your authenticator or backup code.');
      const r = await api('POST', '/api/auth/reset',
        { email: resetEmail, secret: pendingReset.secret, newPassword: pendingReset.newPassword, code });
      if (!r.ok) return setMsg('modalError', r.data.error || 'Could not reset the password.');
      closeModal();
      showForm('login');
      setMsg('loginSuccess', 'Password updated. Please log in.');
    }
  } finally {
    modalBusy = false;
  }
}

// ---------- Init ----------
window.addEventListener('DOMContentLoaded', async () => {
  // Buttons are wired here (not with inline onclick="..." attributes) so the strict CSP can block inline scripts
  $('loginTab').addEventListener('click', () => showForm('login'));
  $('signupTab').addEventListener('click', () => showForm('signup'));
  $('loginBtn').addEventListener('click', () => login());
  $('forgotLink').addEventListener('click', (e) => { e.preventDefault(); openForgotPasswordModal(); });
  $('signupPassword').addEventListener('input', () => checkPasswordStrength());
  $('signupRole').addEventListener('change', () => toggleAdminKeyField());
  $('signupBtn').addEventListener('click', () => startSignupWorkflow());
  $('modalCancelBtn').addEventListener('click', () => closeModal());
  $('modalConfirmBtn').addEventListener('click', () => handleModalSubmit());

  toggleAdminKeyField();
  ['loginEmail', 'loginPassword'].forEach(id =>
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter') login(); }));
  ['signupUname', 'signupEmail', 'signupPassword', 'signupPassword2', 'adminSecretKey'].forEach(id =>
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter') startSignupWorkflow(); }));
  ['modalInput1', 'modalInput2'].forEach(id =>
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter') handleModalSubmit(); }));
  $('modalResend').addEventListener('click', async (e) => {
    e.preventDefault();
    if (modalMode !== 'verify-email') return;
    await api('POST', '/api/auth/resend-code', { email: verifyEmail });
    setMsg('modalError', 'A new code was sent (you can request one every minute).');
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  $('securityModal').addEventListener('click', e => { if (e.target.id === 'securityModal') closeModal(); });

  const user = await getCurrentUser();
  if (user) redirectByRole(user.role); // already logged in
});
