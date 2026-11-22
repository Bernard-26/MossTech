/* Adds a Show/Hide button to every password field (also fields drawn later). */
(function () {
  var css = '.pw-wrap{position:relative;display:block}' +
    '.pw-wrap:has(>.hidden-form){display:none}' +
    '.pw-wrap>input{padding-right:64px!important;box-sizing:border-box}' +
    '.pw-toggle{position:absolute;right:6px;top:50%;transform:translateY(-50%);min-height:32px;padding:4px 8px;' +
    'border:0;background:none;color:inherit;opacity:.75;font:600 12px/1 system-ui,sans-serif;cursor:pointer;border-radius:6px}' +
    '.pw-toggle:hover,.pw-toggle:focus-visible{opacity:1;text-decoration:underline}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function enhance(inp) {
    if (inp.dataset.pw || !inp.parentNode || inp.parentNode.classList.contains('pw-wrap')) return;
    inp.dataset.pw = '1';
    var cs = getComputedStyle(inp), wrap = document.createElement('span'), b = document.createElement('button');
    wrap.className = 'pw-wrap';
    wrap.style.marginTop = cs.marginTop; wrap.style.marginBottom = cs.marginBottom;
    inp.style.margin = '0';
    inp.parentNode.insertBefore(wrap, inp); wrap.appendChild(inp);
    b.type = 'button'; b.className = 'pw-toggle'; b.textContent = 'Show';
    b.setAttribute('aria-label', 'Show password'); b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', function () {
      var show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      b.textContent = show ? 'Hide' : 'Show';
      b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      b.setAttribute('aria-pressed', String(show));
    });
    wrap.appendChild(b);
  }
  function scan() { document.querySelectorAll('input[type=password]').forEach(enhance); }
  scan();
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
})();
