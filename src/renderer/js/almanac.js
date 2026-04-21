// Almanac tooltip — hover any element with `data-almanac-role="<roleId>"` and
// a rich floating card appears: role name, team badge, ability text, night
// order numbers, and reminder-token names. Powered by a single singleton
// <div> positioned next to the hovered element.
//
// The card also responds to the element getting keyboard focus so it's usable
// with the keyboard as well as with the mouse.

(function () {
  const TEAM_LABEL = {
    townsfolk: 'Townsfolk',
    outsider:  'Outsider',
    minion:    'Minion',
    demon:     'Demon',
  };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  let tipEl = null;
  let currentTarget = null;
  let hideTimer = null;

  function ensureTip() {
    if (tipEl) return tipEl;
    tipEl = document.createElement('div');
    tipEl.id = 'almanac-tip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.style.display = 'none';
    document.body.appendChild(tipEl);
    return tipEl;
  }

  function buildContent(roleId) {
    const T = window.Tokens;
    if (!T) return '';
    const meta = T.TOKEN_META[roleId];
    if (meta) {
      const team = meta.team || 'townsfolk';
      const firstLine = meta.firstNight ? `first night: #${meta.firstNight}` : '';
      const otherLine = meta.otherNight ? `other nights: #${meta.otherNight}` : '';
      const orderBits = [firstLine, otherLine].filter(Boolean).join(' · ');
      const reminders = (meta.reminders && meta.reminders.length)
        ? `<div class="al-reminders">Reminders: ${meta.reminders.map(r => `<span class="al-chip team-${team}">${esc(r)}</span>`).join('')}</div>`
        : '';
      return `
        <div class="al-head">
          <span class="al-symbol">${meta.symbol || ''}</span>
          <div class="al-title">
            <div class="al-name">${esc(meta.name)}</div>
            <div class="al-team team-${team}">${TEAM_LABEL[team] || team}</div>
          </div>
        </div>
        <div class="al-ability">${esc(meta.ability || '(No recorded ability.)')}</div>
        ${orderBits ? `<div class="al-order muted">${esc(orderBits)}</div>` : ''}
        ${reminders}`;
    }
    const pseudo = T.PSEUDO_META && T.PSEUDO_META[roleId];
    if (pseudo) {
      return `
        <div class="al-head">
          <span class="al-symbol">${pseudo.symbol || ''}</span>
          <div class="al-title">
            <div class="al-name">${esc(pseudo.name)}</div>
            <div class="al-team">night phase</div>
          </div>
        </div>
        <div class="al-ability">${esc(pseudo.note || '')}</div>`;
    }
    return '';
  }

  function position(tip, anchor) {
    const tipRect = tip.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const pad = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Prefer to the right of the anchor. Fall back to left, then below.
    let x = anchorRect.right + pad;
    let y = anchorRect.top;
    if (x + tipRect.width > vw - 8) {
      x = anchorRect.left - tipRect.width - pad;
    }
    if (x < 8) {
      x = Math.max(8, Math.min(vw - tipRect.width - 8, anchorRect.left));
      y = anchorRect.bottom + pad;
    }
    if (y + tipRect.height > vh - 8) {
      y = Math.max(8, vh - tipRect.height - 8);
    }
    if (y < 8) y = 8;

    tip.style.left = `${x}px`;
    tip.style.top  = `${y}px`;
  }

  function show(anchor, roleId) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    const tip = ensureTip();
    const html = buildContent(roleId);
    if (!html) return;
    tip.innerHTML = html;
    tip.dataset.team = (window.Tokens?.TOKEN_META?.[roleId]?.team) || '';
    tip.style.display = 'block';
    tip.style.opacity = '0';
    // Needs a frame so width is measured for positioning.
    requestAnimationFrame(() => {
      position(tip, anchor);
      tip.style.opacity = '1';
    });
    currentTarget = anchor;
  }

  function hide() {
    if (!tipEl) return;
    hideTimer = setTimeout(() => {
      tipEl.style.display = 'none';
      tipEl.style.opacity = '0';
      currentTarget = null;
    }, 80);
  }

  function findAnchor(el) {
    if (!el || el === document || !el.closest) return null;
    return el.closest('[data-almanac-role]');
  }

  function onOver(ev) {
    const a = findAnchor(ev.target);
    if (!a) return;
    if (a === currentTarget) return;
    const roleId = a.dataset.almanacRole;
    if (!roleId) return;
    show(a, roleId);
  }
  function onOut(ev) {
    const a = findAnchor(ev.target);
    if (!a) return;
    // Only hide if the related target is outside the anchor.
    if (ev.relatedTarget && a.contains(ev.relatedTarget)) return;
    hide();
  }
  function onScroll() {
    // Snap the tooltip to its anchor when the viewport scrolls.
    if (currentTarget && tipEl && tipEl.style.display !== 'none') {
      position(tipEl, currentTarget);
    }
  }
  function onKey(ev) {
    if (ev.key === 'Escape' && tipEl && tipEl.style.display !== 'none') hide();
  }

  window.initAlmanac = function () {
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout',  onOut,  true);
    document.addEventListener('focusin',   onOver, true);
    document.addEventListener('focusout',  onOut,  true);
    document.addEventListener('scroll',    onScroll, true);
    document.addEventListener('keydown',   onKey,  false);
  };
})();
