(() => {
  'use strict';
  const root = document.documentElement;
  const resources = window.BabaMessages;
  const localeControl = document.getElementById('locale');
  const themeControl = document.getElementById('theme');
  const menuControl = document.getElementById('menu');
  const navigation = document.getElementById('navigation');
  const sharePanel = document.getElementById('share-panel');
  const shareToggle = document.getElementById('share-toggle');
  const shareRevoke = document.getElementById('revoke-share');
  const filenames = { index: 'index.html', about: 'about.html', style: 'assets/style.css' };
  const tabs = Array.from(document.querySelectorAll('.deploy-tab'));
  const fileButtons = Array.from(document.querySelectorAll('[data-file]'));
  const context = {
    locale: Object.hasOwn(resources.locales, root.lang) ? root.lang : 'zh-CN',
    theme: root.dataset.mode === 'dark' ? 'dark' : 'light'
  };
  let currentFile = 'index';
  let revoked = false;

  function t(key, params = {}) {
    const values = resources.text[key];
    const column = resources.locales[context.locale].column;
    let text = values && values[column];
    if (typeof text !== 'string') {
      console.warn('babaShare: missing translation', key, context.locale);
      text = values && values[0] || key;
    }
    return text.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
  }

  function put(id, key) {
    document.getElementById(id).textContent = t(key).replaceAll('\\n', '\n');
  }

  function renderPreview(announce = false) {
    fileButtons.forEach(button => {
      if (button.dataset.file === currentFile) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    });
    document.getElementById('preview-path').textContent = filenames[currentFile];
    document.getElementById('mini-page').hidden = currentFile === 'style';
    document.getElementById('style-preview').hidden = currentFile !== 'style';
    put('mini-title', currentFile === 'about' ? 'aboutTitle' : 'miniTitle');
    put('mini-label', currentFile === 'about' ? 'aboutLabel' : 'miniLabel');
    document.getElementById('style-preview').textContent = '.prototype {\n  display: grid;\n  gap: 24px;\n}\n\n' + t('styleComment');
    if (announce) document.getElementById('demo-status').textContent = t('previewChanged', { file: filenames[currentFile] });
  }

  function renderShare() {
    shareToggle.textContent = t(sharePanel.hidden ? 'shareOpen' : 'shareClose');
    put('share-state', revoked ? 'shareRevoked' : 'shareActive');
    put('share-explanation', revoked ? 'shareRevokedCopy' : 'shareExpiry');
    shareRevoke.textContent = t(revoked ? 'restore' : 'revoke');
  }

  function closeMenu(returnFocus = false) {
    navigation.dataset.open = 'false';
    menuControl.setAttribute('aria-expanded', 'false');
    menuControl.setAttribute('aria-label', t('menuOpen'));
    if (returnFocus) menuControl.focus();
  }

  function applyContext(persist = false) {
    root.lang = context.locale;
    root.dir = resources.locales[context.locale].dir;
    root.dataset.mode = context.theme;
    document.title = t('pageTitle');
    document.querySelectorAll('[data-i18n]').forEach(node => {
      node.textContent = t(node.dataset.i18n).replaceAll('\\n', '\n');
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(node => {
      node.setAttribute('aria-label', t(node.dataset.i18nAria));
    });
    localeControl.value = context.locale;
    themeControl.setAttribute('aria-label', t(context.theme === 'dark' ? 'themeLight' : 'themeDark'));
    themeControl.setAttribute('aria-pressed', String(context.theme === 'dark'));
    menuControl.setAttribute('aria-label', t(navigation.dataset.open === 'true' ? 'menuClose' : 'menuOpen'));
    document.getElementById('copy-status').textContent = '';
    renderPreview();
    renderShare();
    if (persist) {
      try { localStorage.setItem('babaShare.site.context', JSON.stringify(context)); }
      catch (error) { console.warn('babaShare: display preferences not persisted', error.name); }
    }
  }

  localeControl.addEventListener('change', () => {
    if (Object.hasOwn(resources.locales, localeControl.value)) {
      context.locale = localeControl.value;
      applyContext(true);
    }
  });
  themeControl.addEventListener('click', () => {
    context.theme = context.theme === 'dark' ? 'light' : 'dark';
    applyContext(true);
  });
  menuControl.addEventListener('click', () => {
    const expanded = menuControl.getAttribute('aria-expanded') !== 'true';
    menuControl.setAttribute('aria-expanded', String(expanded));
    menuControl.setAttribute('aria-label', t(expanded ? 'menuClose' : 'menuOpen'));
    navigation.dataset.open = String(expanded);
  });
  navigation.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link) return;
    closeMenu();
    const section = document.querySelector(link.getAttribute('href'));
    if (section) {
      section.tabIndex = -1;
      section.focus({ preventScroll: true });
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && navigation.dataset.open === 'true') closeMenu(true);
  });
  fileButtons.forEach(button => {
    button.addEventListener('click', () => {
      currentFile = button.dataset.file;
      renderPreview(true);
    });
  });
  shareToggle.addEventListener('click', () => {
    sharePanel.hidden = !sharePanel.hidden;
    shareToggle.setAttribute('aria-expanded', String(!sharePanel.hidden));
    renderShare();
  });
  shareRevoke.addEventListener('click', () => {
    revoked = !revoked;
    renderShare();
    document.getElementById('demo-status').textContent = t(revoked ? 'shareRevoked' : 'shareActive');
  });

  function activateTab(tab, focus = false) {
    tabs.forEach(candidate => {
      const selected = candidate === tab;
      candidate.setAttribute('aria-selected', String(selected));
      candidate.tabIndex = selected ? 0 : -1;
      document.getElementById(candidate.getAttribute('aria-controls')).hidden = !selected;
    });
    document.getElementById('copy-status').textContent = '';
    if (focus) tab.focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activateTab(tab));
    tab.addEventListener('keydown', event => {
      let target;
      const next = resources.locales[context.locale].nextKey;
      const previous = resources.locales[context.locale].previousKey;
      if (event.key === next) target = (index + 1) % tabs.length;
      else if (event.key === previous) target = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = tabs.length - 1;
      if (target !== undefined) {
        event.preventDefault();
        activateTab(tabs[target], true);
      }
    });
  });
  document.querySelectorAll('[data-copy]').forEach(button => {
    button.addEventListener('click', async () => {
      const code = document.getElementById(button.dataset.copy);
      const status = document.getElementById('copy-status');
      button.disabled = true;
      try {
        if (!navigator.clipboard || !window.isSecureContext) throw new Error('CLIPBOARD_UNAVAILABLE');
        await navigator.clipboard.writeText(code.textContent);
        status.textContent = t('copied');
      } catch (error) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(code);
        selection.removeAllRanges();
        selection.addRange(range);
        status.textContent = t('copyFailed');
        console.warn('babaShare: clipboard fallback', error.name);
      } finally { button.disabled = false; }
    });
  });
  applyContext();
  root.dataset.enhanced = 'true';
})();
