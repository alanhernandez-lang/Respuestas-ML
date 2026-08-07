const state = {
  records: [],
  selectedPackId: null,
  hasAutoSelected: false,
  editingPackId: null,
  editingDraftText: null,
  viewers: {},
  presenceInterval: null,
  statusFilter: '',
  logEntries: [],
  logFilterEmail: '',
  bank: [],
};

const el = {
  search: document.getElementById('search'),
  syncBtn: document.getElementById('syncBtn'),
  syncInfo: document.getElementById('syncInfo'),
  userEmail: document.getElementById('userEmail'),
  statusCounts: document.getElementById('statusCounts'),
  conversationList: document.getElementById('conversationList'),
  empty: document.getElementById('emptyState'),
  chatEmpty: document.getElementById('chatEmpty'),
  chatOpen: document.getElementById('chatOpen'),
  chatAvatar: document.getElementById('chatAvatar'),
  chatTitle: document.getElementById('chatTitle'),
  chatItem: document.getElementById('chatItem'),
  chatThread: document.getElementById('chatThread'),
  chatDraftPanel: document.getElementById('chatDraftPanel'),
  chatAnsweredBy: document.getElementById('chatAnsweredBy'),
  chatViewingBadge: document.getElementById('chatViewingBadge'),
  toastContainer: document.getElementById('toastContainer'),
  confirmOverlay: document.getElementById('confirmOverlay'),
  confirmMessage: document.getElementById('confirmMessage'),
  confirmCancelBtn: document.getElementById('confirmCancelBtn'),
  confirmOkBtn: document.getElementById('confirmOkBtn'),
  viewSwitch: document.querySelector('.view-switch'),
  tabMessages: document.getElementById('tabMessages'),
  tabLog: document.getElementById('tabLog'),
  tabBank: document.getElementById('tabBank'),
  viewMessages: document.getElementById('viewMessages'),
  viewLog: document.getElementById('viewLog'),
  viewBank: document.getElementById('viewBank'),
  liveNowList: document.getElementById('liveNowList'),
  logFilters: document.getElementById('logFilters'),
  logList: document.getElementById('logList'),
  logEmptyState: document.getElementById('logEmptyState'),
  bankSearch: document.getElementById('bankSearch'),
  bankList: document.getElementById('bankList'),
  bankEmptyState: document.getElementById('bankEmptyState'),
  themeToggle: document.getElementById('themeToggle'),
  lightboxOverlay: document.getElementById('lightboxOverlay'),
  lightboxImg: document.getElementById('lightboxImg'),
  lightboxClose: document.getElementById('lightboxClose'),
};

const STATUS_LABELS = { pendiente: 'Pendiente', respondido: 'Respondido', mediacion: 'Mediación' };
// Pendientes y mediaciones necesitan acción, así que se muestran antes que lo ya respondido.
const STATUS_PRIORITY = { pendiente: 0, mediacion: 0, respondido: 1 };
const AVATAR_COLORS = ['av-1', 'av-2', 'av-3', 'av-4', 'av-5', 'av-6', 'av-7', 'av-8'];

function showToast(message, type = 'error') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const text = document.createElement('span');
  text.textContent = message;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.setAttribute('aria-label', 'Cerrar aviso');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => toast.remove());
  toast.append(text, closeBtn);
  el.toastContainer.appendChild(toast);
  // Los errores se quedan hasta que la persona los cierre a propósito — un aviso de
  // "falló la sincronización" que desaparece solo en 4.5s es fácil de no alcanzar a leer.
  if (type !== 'error') setTimeout(() => toast.remove(), 4500);
}

function showConfirm(message) {
  return new Promise((resolve) => {
    const trigger = document.activeElement;
    el.confirmMessage.textContent = message;
    el.confirmOverlay.hidden = false;
    el.confirmOkBtn.focus();

    function onKeydown(e) {
      if (e.key === 'Escape') {
        cleanup(false);
      } else if (e.key === 'Tab') {
        // Modal chiquito de 2 botones: alterna el foco entre ambos en vez de dejarlo
        // escapar hacia el contenido de atrás.
        e.preventDefault();
        (document.activeElement === el.confirmOkBtn ? el.confirmCancelBtn : el.confirmOkBtn).focus();
      }
    }
    function cleanup(result) {
      el.confirmOverlay.hidden = true;
      document.removeEventListener('keydown', onKeydown);
      el.confirmOkBtn.removeEventListener('click', onOk);
      el.confirmCancelBtn.removeEventListener('click', onCancel);
      trigger?.focus();
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    document.addEventListener('keydown', onKeydown);
    el.confirmOkBtn.addEventListener('click', onOk);
    el.confirmCancelBtn.addEventListener('click', onCancel);
  });
}

// Tema claro/oscuro: por default sigue al sistema operativo (ver style.css), pero
// si la persona lo cambia a mano aquí, esa preferencia gana y se recuerda entre
// sesiones. No hay un tercer botón para "volver a automático" a propósito — para
// una herramienta de trabajo de uso diario, un toggle de 2 estados es más simple.
function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = theme === 'dark' || (theme !== 'light' && prefersDark);
  el.themeToggle.textContent = isDark ? '☀️' : '🌙';
  el.themeToggle.setAttribute('aria-label', isDark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro');
}

function initTheme() {
  applyTheme(localStorage.getItem('theme'));
  // El CSS ya sigue en vivo los cambios de tema del sistema operativo (la variable
  // se recalcula sola vía @media), pero el ícono/aria-label del botón no — si nadie
  // eligió un tema a mano y el sistema cambia de claro a oscuro mientras la pestaña
  // sigue abierta (p. ej. el cambio automático nocturno del SO), sin esto el botón
  // se queda mostrando el ícono/aria-label del tema viejo hasta el siguiente clic.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!localStorage.getItem('theme')) applyTheme(null);
  });
}

function toggleTheme() {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const currentlyDark = document.documentElement.getAttribute('data-theme') === 'dark'
    || (!document.documentElement.getAttribute('data-theme') && prefersDark);
  const next = currentlyDark ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
}

el.themeToggle.addEventListener('click', toggleTheme);

// Visor de imágenes: al hacer clic en una foto del hilo se amplía sobre la app en
// vez de abrir una pestaña nueva del navegador (el <a href> de respaldo sigue ahí
// por si el JS falla, o para quien prefiera abrirla aparte con clic-derecho/ctrl-clic).
function openLightbox(src, alt, trigger) {
  el.lightboxImg.src = src;
  el.lightboxImg.alt = alt || 'Imagen adjunta';
  el.lightboxOverlay.hidden = false;
  el._lightboxTrigger = trigger || document.activeElement;
  el._lightboxSrc = src;
  el.lightboxClose.focus();
  document.addEventListener('keydown', onLightboxKeydown);
}

function closeLightbox() {
  el.lightboxOverlay.hidden = true;
  el.lightboxImg.removeAttribute('src');
  document.removeEventListener('keydown', onLightboxKeydown);
  // El hilo se puede haber vuelto a pintar entero mientras el visor estaba abierto
  // (loadMessages sondea cada 20s y reconstruye el <img> que abrió el visor), en cuyo
  // caso el elemento guardado como "trigger" quedó desconectado del documento y
  // .focus() no haría nada. Si pasó eso, se busca la imagen equivalente por su src en
  // el hilo actual en vez de dejar que el foco caiga a <body> sin avisar.
  const trigger = document.contains(el._lightboxTrigger)
    ? el._lightboxTrigger
    : el.chatThread.querySelector(`img.msg-image[src="${CSS.escape(el._lightboxSrc || '')}"]`);
  trigger?.focus();
}

function onLightboxKeydown(e) {
  if (e.key === 'Escape') closeLightbox();
}

el.lightboxClose.addEventListener('click', closeLightbox);
el.lightboxOverlay.addEventListener('click', (e) => {
  if (e.target === el.lightboxOverlay) closeLightbox();
});

async function loadUserEmail() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return;
    const data = await res.json();
    if (data.email) {
      el.userEmail.textContent = shortName(data.email);
      el.userEmail.title = data.email;
    }
  } catch {
    // No es crítico para el uso de la app si esto falla, se omite en silencio.
  }
}

function startPresenceHeartbeat(packId) {
  stopPresenceHeartbeat();
  const beat = () => fetch(`/api/presence/${packId}`, { method: 'POST' }).catch(() => {});
  beat();
  state.presenceInterval = setInterval(beat, 8000);
}

function stopPresenceHeartbeat() {
  if (state.presenceInterval) {
    clearInterval(state.presenceInterval);
    state.presenceInterval = null;
  }
}

// Anota en el DOM ya existente quién está viendo qué, sin reconstruir toda la lista
// (eso perdería la posición del scroll cada vez que se refresca, cada 8 segundos).
function applyPresence() {
  document.querySelectorAll('.conversation-item').forEach((item) => {
    const packId = item.dataset.pack;
    const existing = item.querySelector('.viewing-badge');
    const viewerEmail = state.viewers[packId];
    if (viewerEmail) {
      const label = `👁 ${shortName(viewerEmail)}`;
      if (existing) {
        existing.textContent = label;
      } else {
        const badge = document.createElement('div');
        badge.className = 'viewing-badge';
        badge.textContent = label;
        item.querySelector('.item-body')?.appendChild(badge);
      }
    } else if (existing) {
      existing.remove();
    }
  });

  const currentViewer = state.viewers[state.selectedPackId];
  if (currentViewer) {
    el.chatViewingBadge.hidden = false;
    el.chatViewingBadge.textContent = `👁 ${shortName(currentViewer)} también está viendo esta conversación`;
  } else {
    el.chatViewingBadge.hidden = true;
  }

  renderLiveNow();
}

async function refreshPresence() {
  try {
    const res = await fetch('/api/presence');
    if (!res.ok) return;
    const data = await res.json();
    state.viewers = data.viewers || {};
    applyPresence();
  } catch {
    // Si falla un refresco de presencia no pasa nada, se reintenta en el siguiente tick.
  }
}

// El roster de "Activos ahora" en la Bitácora reutiliza state.viewers (el mismo dato
// que ya se sondea cada 8s para las insignias inline) — no necesita su propio fetch.
function renderLiveNow() {
  const packIds = Object.keys(state.viewers);
  withFocusPreserved(el.liveNowList, () => {
    if (!packIds.length) {
      el.liveNowList.innerHTML = '<p class="live-now-empty">Nadie más está conectado en este momento.</p>';
      return;
    }
    el.liveNowList.innerHTML = packIds.map((packId) => {
      const email = state.viewers[packId];
      const r = state.records.find((x) => x.packId === packId);
      const buyer = r ? r.buyerName : 'una conversación';
      return `
        <div class="live-now-row" data-pack="${escapeHtml(packId)}" role="button" tabindex="0" aria-label="Ir a la conversación con ${escapeHtml(buyer)}">
          ${avatarHtml(shortName(email))}
          <span>${escapeHtml(shortName(email))} está viendo a <strong>${escapeHtml(buyer)}</strong></span>
        </div>
      `;
    }).join('');
  });
}

function switchView(view) {
  const isMessages = view === 'messages';
  const isLog = view === 'log';
  const isBank = view === 'bank';
  el.viewMessages.hidden = !isMessages;
  el.viewLog.hidden = !isLog;
  el.viewBank.hidden = !isBank;
  el.tabMessages.setAttribute('aria-selected', String(isMessages));
  el.tabLog.setAttribute('aria-selected', String(isLog));
  el.tabBank.setAttribute('aria-selected', String(isBank));
  // Patrón ARIA de tabs (WAI-ARIA APG): solo la pestaña seleccionada queda en el
  // orden de tabulación (tabindex 0); las demás se navegan con las flechas ←/→,
  // no con Tab. Sin esto, role="tab" anuncia a lectores de pantalla un widget que
  // no se comporta como tal.
  el.tabMessages.setAttribute('tabindex', isMessages ? '0' : '-1');
  el.tabLog.setAttribute('tabindex', isLog ? '0' : '-1');
  el.tabBank.setAttribute('tabindex', isBank ? '0' : '-1');
  if (isLog) {
    stopPresenceHeartbeat();
    refreshLog();
  } else if (isBank) {
    stopPresenceHeartbeat();
    refreshBank();
  } else if (state.selectedPackId) {
    startPresenceHeartbeat(state.selectedPackId);
  }
}

async function refreshBank() {
  try {
    const res = await fetch('/api/response-bank');
    if (!res.ok) return;
    const data = await res.json();
    state.bank = data.bank || [];
    renderBank();
  } catch {
    showToast('No se pudo cargar el banco de respuestas');
  }
}

function renderBank() {
  const q = el.bankSearch.value.trim().toLowerCase();
  const filtered = state.bank.filter((r) => !q
    || r.text.toLowerCase().includes(q)
    || (r.questions || []).some((qq) => qq.toLowerCase().includes(q)));

  el.bankEmptyState.hidden = filtered.length > 0;
  el.bankList.innerHTML = filtered.map((r) => `
    <div class="log-entry bank-entry">
      <div class="log-body">
        <div class="log-line">
          <span class="badge all">Usada ${r.count}×</span>
          <span class="log-meta">última vez ${timeAgo(r.lastUsed)}</span>
        </div>
        <div class="draft-text">${escapeHtml(r.text)}</div>
        ${(r.questions || []).length ? `<div class="log-meta">Preguntas parecidas: ${r.questions.map((qq) => `"${escapeHtml(qq)}"`).join(' · ')}</div>` : ''}
      </div>
      <button class="btn-secondary copyBtn" data-text="${escapeHtml(r.text)}">Copiar</button>
    </div>
  `).join('');
}

el.bankSearch.addEventListener('input', renderBank);

el.bankList.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('.copyBtn');
  if (!copyBtn) return;
  await navigator.clipboard.writeText(copyBtn.dataset.text);
  copyBtn.textContent = 'Copiado ✓';
  setTimeout(() => { copyBtn.textContent = 'Copiar'; }, 1500);
});

async function refreshLog() {
  try {
    const res = await fetch('/api/log');
    if (!res.ok) return;
    const data = await res.json();
    state.logEntries = data.entries || [];
    renderLog();
  } catch {
    showToast('No se pudo cargar la bitácora');
  }
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return 'Hoy';
  if (sameDay(d, yesterday)) return 'Ayer';
  return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
}

function renderLog() {
  const uniqueEmails = [...new Set(state.logEntries.map((e) => e.answeredBy).filter(Boolean))];
  const filterChip = (email, label, count) => `
    <button class="badge all${state.logFilterEmail === email ? ' active' : ''}" aria-selected="${state.logFilterEmail === email}" data-email="${escapeHtml(email)}">${escapeHtml(label)} (${count})</button>
  `;
  el.logFilters.innerHTML = filterChip('', 'Todas', state.logEntries.length)
    + uniqueEmails.map((email) => filterChip(email, shortName(email), state.logEntries.filter((e) => e.answeredBy === email).length)).join('');

  const entries = state.logEntries.filter((e) => !state.logFilterEmail || e.answeredBy === state.logFilterEmail);
  el.logEmptyState.hidden = entries.length > 0;

  withFocusPreserved(el.logList, () => {
    if (!entries.length) {
      el.logList.innerHTML = '';
      return;
    }

    let lastDay = null;
    el.logList.innerHTML = entries.map((e) => {
      const day = dayLabel(e.date);
      const heading = day !== lastDay ? `<div class="log-day-heading">${escapeHtml(day)}</div>` : '';
      lastDay = day;
      const itemLine = (e.itemTitles || []).join(', ') || 'Producto no identificado';
      const who = shortName(e.answeredBy) || 'Alguien';
      return `
        ${heading}
        <div class="log-entry" data-pack="${escapeHtml(e.packId)}" role="button" tabindex="0" aria-label="Ir a la conversación con ${escapeHtml(e.buyerName)}">
          ${avatarHtml(who)}
          <div class="log-body">
            <div class="log-line"><strong>${escapeHtml(who)}</strong> respondió a <strong>${escapeHtml(e.buyerName)}</strong></div>
            <div class="log-meta">${escapeHtml(itemLine)} · ${timeAgo(e.date)}${e.wasEdited ? ' · editado a mano' : ''}</div>
            <div class="log-snippet">${escapeHtml(e.text)}</div>
          </div>
        </div>
      `;
    }).join('');
  });
}

function statusCountsHtml(records) {
  const counts = { pendiente: 0, mediacion: 0, respondido: 0 };
  records.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const chip = (status, cls, label) => `
    <button class="badge ${cls}" aria-selected="${state.statusFilter === status}" data-status="${status}">${label}</button>
  `;
  return chip('', 'all', `Todas (${records.length})`)
    + chip('pendiente', 'pendiente', `${counts.pendiente} pendiente${counts.pendiente === 1 ? '' : 's'}`)
    + chip('mediacion', 'mediacion', `${counts.mediacion} mediaci${counts.mediacion === 1 ? 'ón' : 'ones'}`)
    + chip('respondido', 'respondido', `${counts.respondido} respondido${counts.respondido === 1 ? '' : 's'}`);
}

function timeAgo(iso) {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'ahora';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} d`;
}

function shortName(email) {
  if (!email) return '';
  const local = email.split('@')[0];
  return local.split(/[._-]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join(' ');
}

function initials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

function avatarColorClass(name) {
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function avatarHtml(name) {
  return `<div class="avatar ${avatarColorClass(name)}">${escapeHtml(initials(name))}</div>`;
}

function itemLinksHtml(itemLinks) {
  if (!itemLinks || !itemLinks.length) return '';
  return itemLinks
    .map((l, i) => `<a class="ml-link" href="${l.url}" target="_blank" rel="noopener">Ver publicación${itemLinks.length > 1 ? ` ${i + 1}` : ''} ↗</a>`)
    .join(' · ');
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
}

function lastMessagePreview(r) {
  const last = r.messages && r.messages.length ? r.messages[r.messages.length - 1] : null;
  if (!last) return '—';
  const prefix = last.sender === 'vendedor' ? 'Tú: ' : '';
  return prefix + (last.text || (last.hasAttachment ? '[imagen adjunta]' : ''));
}

// Las filas de conversationList/liveNowList/logList ahora son role="button" con
// tabindex y se pueden enfocar con teclado — pero se reconstruyen enteras (innerHTML
// o remove+append) cada vez que llega un refresco de fondo (polling de mensajes o de
// presencia, cada 8-20s), no solo cuando la persona interactúa. Sin esto, una fila
// enfocada con teclado pierde el foco (cae a <body>) en cuanto pasa el siguiente tick,
// aunque nadie haya tocado nada. Esto reubica el foco en la fila equivalente (mismo
// data-pack) después de reconstruir el contenedor.
function withFocusPreserved(container, rebuild) {
  const active = document.activeElement;
  const focusedPack = active && container.contains(active) ? active.dataset.pack : null;
  rebuild();
  if (focusedPack) {
    container.querySelector(`[data-pack="${CSS.escape(focusedPack)}"]`)?.focus();
  }
}

function render() {
  const q = el.search.value.trim().toLowerCase();

  const filtered = state.records.filter((r) => {
    const matchesQ = !q
      || r.buyerName.toLowerCase().includes(q)
      || r.itemTitles.join(' ').toLowerCase().includes(q)
      || (r.lastQuestion?.text || '').toLowerCase().includes(q);
    const matchesStatus = !state.statusFilter || r.status === state.statusFilter;
    return matchesQ && matchesStatus;
  });
  // sort() es estable: dentro de cada grupo de prioridad se conserva el orden por
  // fecha que ya trae el arreglo (el servidor lo entrega del más reciente al más viejo).
  filtered.sort((a, b) => (STATUS_PRIORITY[a.status] ?? 0) - (STATUS_PRIORITY[b.status] ?? 0));

  el.statusCounts.innerHTML = statusCountsHtml(state.records);
  el.empty.hidden = filtered.length > 0;

  withFocusPreserved(el.conversationList, () => {
    el.conversationList.innerHTML = '';
    for (const r of filtered) {
      const item = document.createElement('div');
      item.className = 'conversation-item' + (r.packId === state.selectedPackId ? ' active' : '');
      item.dataset.pack = r.packId;
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      item.setAttribute('aria-current', String(r.packId === state.selectedPackId));
      item.setAttribute('aria-label', `Conversación con ${r.buyerName}, ${STATUS_LABELS[r.status] || r.status}`);
      const answeredLine = r.status === 'respondido' && r.answeredBy
        ? ` · Respondido por ${escapeHtml(shortName(r.answeredBy))}`
        : '';
      // La mediación se puede haber cerrado y ya no bloquear el chat (status volvió a
      // "respondido"/"pendiente"), pero sigue siendo importante saber que esta venta
      // pasó por un reclamo — así que se marca aparte del badge de estado normal.
      const pastMediationBadge = r.status !== 'mediacion' && r.pastMediation
        ? ' <span class="badge mediacion-past" title="Esta venta tuvo un reclamo/mediación con Mercado Libre">⚖ Tuvo mediación</span>'
        : '';
      item.innerHTML = `
        ${avatarHtml(r.buyerName)}
        <div class="item-body">
          <div class="row-top">
            <span class="buyer-name">${escapeHtml(r.buyerName)}</span>
            <span class="item-time">${fmtTime(r.lastQuestion?.date)}</span>
          </div>
          <div class="row-mid">
            <span class="badge ${r.status}">${STATUS_LABELS[r.status] || r.status}</span>${pastMediationBadge}
            <span class="preview">${escapeHtml(lastMessagePreview(r))}</span>
          </div>
          <div class="item-order">Pedido ${escapeHtml(r.orderId || '—')} · ${escapeHtml(r.itemTitles.join(', ') || '—')}${answeredLine}</div>
        </div>
      `;
      item.addEventListener('click', () => selectConversation(r.packId));
      el.conversationList.appendChild(item);
    }
  });

  applyPresence();

  if (!state.hasAutoSelected && !state.selectedPackId && filtered.length) {
    state.hasAutoSelected = true;
    selectConversation(filtered[0].packId);
    return;
  }

  renderChatPanel();
}

function draftCardHtml(r) {
  const orderLine = `Pedido ${escapeHtml(r.orderId || '—')} · ${escapeHtml(r.itemTitles.join(', ') || '—')}${r.itemLinks && r.itemLinks.length ? ` · ${itemLinksHtml(r.itemLinks)}` : ''}`;

  if (r.draftAnswer.error) {
    return `
      <div class="draft-card" data-pack="${r.packId}">
        <div class="draft-card-header">
          ${avatarHtml(r.buyerName)}
          <div class="draft-card-heading">
            <div class="draft-card-title-row">
              <strong>${escapeHtml(r.buyerName)}</strong>
              <span class="draft-time">${timeAgo(r.lastQuestion?.date)}</span>
            </div>
            <div class="draft-subtitle">${orderLine}</div>
          </div>
        </div>
        <div class="draft-error">⚠ No se pudo generar el borrador: ${escapeHtml(r.draftAnswer.error)}</div>
        <div class="draft-actions">
          <div class="draft-actions-secondary">
            <button class="btn-secondary regenerateBtn" data-pack="${r.packId}">Reintentar</button>
          </div>
        </div>
      </div>
    `;
  }

  const isEditing = state.editingPackId === r.packId;
  const len = (isEditing ? (state.editingDraftText ?? r.draftAnswer.text) : r.draftAnswer.text).length;
  const overLimit = len > 350;
  const viewerEmail = state.viewers[r.packId];
  const collabAlertHtml = viewerEmail
    ? `<div class="collab-alert">⚠ ${escapeHtml(shortName(viewerEmail))} también está viendo esta conversación ahora mismo. Coordinen para no responder dos veces.</div>`
    : '';

  return `
    <div class="draft-card" data-pack="${r.packId}">
      <div class="draft-card-header">
        ${avatarHtml(r.buyerName)}
        <div class="draft-card-heading">
          <div class="draft-card-title-row">
            <strong>${escapeHtml(r.buyerName)}</strong>
            <span class="draft-time">${timeAgo(r.lastQuestion?.date)}</span>
          </div>
          <div class="draft-subtitle">${orderLine}</div>
        </div>
      </div>

      ${collabAlertHtml}

      <div class="draft-suggestion">
        <div class="draft-suggestion-head">
          <span class="draft-label">✨ Respuesta sugerida</span>
          ${r.draftAnswer.edited ? '<span class="edited-pill">editado a mano</span>' : ''}
        </div>
        ${isEditing
          ? `<textarea class="draft-edit-textarea" rows="5">${escapeHtml(state.editingDraftText ?? r.draftAnswer.text)}</textarea>`
          : `<div class="draft-text">${escapeHtml(r.draftAnswer.text)}</div>`}
        <div class="draft-charcount ${overLimit ? 'char-count-over' : 'char-count'}">${len}/350${overLimit ? ' ⚠ excede el límite de ML' : ''}</div>
      </div>

      <div class="draft-actions">
        ${isEditing ? `
          <div class="draft-actions-secondary">
            <button class="btn-secondary cancelEditBtn" data-pack="${r.packId}">Cancelar</button>
          </div>
          <button class="btn-primary saveEditBtn" data-pack="${r.packId}">Guardar cambios</button>
        ` : `
          <div class="draft-actions-secondary">
            <button class="btn-secondary copyBtn" data-text="${escapeHtml(r.draftAnswer.text)}">Copiar</button>
            <button class="btn-secondary editBtn" data-pack="${r.packId}">Editar</button>
            <button class="btn-secondary regenerateBtn" data-pack="${r.packId}">Regenerar</button>
          </div>
          <button class="btn-primary publishBtn" data-pack="${r.packId}" data-buyer="${escapeHtml(r.buyerName)}">Publicar ↗</button>
        `}
      </div>
    </div>
  `;
}

async function handleDraftAction(e) {
  const copyBtn = e.target.closest('.copyBtn');
  if (copyBtn) {
    await navigator.clipboard.writeText(copyBtn.dataset.text);
    copyBtn.textContent = 'Copiado ✓';
    setTimeout(() => { copyBtn.textContent = 'Copiar'; }, 1500);
    return;
  }

  const editBtn = e.target.closest('.editBtn');
  if (editBtn) {
    const r = state.records.find((x) => x.packId === editBtn.dataset.pack);
    state.editingPackId = editBtn.dataset.pack;
    state.editingDraftText = r?.draftAnswer?.text ?? '';
    renderChatPanel();
    return;
  }

  const cancelEditBtn = e.target.closest('.cancelEditBtn');
  if (cancelEditBtn) {
    state.editingPackId = null;
    state.editingDraftText = null;
    renderChatPanel();
    return;
  }

  const saveEditBtn = e.target.closest('.saveEditBtn');
  if (saveEditBtn) {
    const card = saveEditBtn.closest('.draft-card');
    const textarea = card.querySelector('.draft-edit-textarea');
    const text = textarea.value.trim();
    if (!text) {
      showToast('El borrador no puede quedar vacío.');
      return;
    }
    saveEditBtn.disabled = true;
    saveEditBtn.textContent = 'Guardando...';
    try {
      const res = await fetch(`/api/messages/${saveEditBtn.dataset.pack}/draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      state.editingPackId = null;
      state.editingDraftText = null;
      showToast('Borrador guardado', 'success');
      await loadMessages();
    } catch (err) {
      showToast(`Error al guardar: ${err.message}`);
      saveEditBtn.disabled = false;
      saveEditBtn.textContent = 'Guardar';
    }
    return;
  }

  const publishBtn = e.target.closest('.publishBtn');
  if (publishBtn) {
    const confirmed = await showConfirm(
      `¿Enviar esta respuesta a ${publishBtn.dataset.buyer} en Mercado Libre?\n\nEsta acción es real e irreversible.`,
    );
    if (!confirmed) return;
    publishBtn.disabled = true;
    publishBtn.textContent = 'Publicando...';
    try {
      const res = await fetch(`/api/messages/${publishBtn.dataset.pack}/publish`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      showToast('Respuesta publicada correctamente', 'success');
      await loadMessages();
    } catch (err) {
      showToast(`Error al publicar: ${err.message}`);
      publishBtn.disabled = false;
      publishBtn.textContent = 'Publicar';
    }
    return;
  }

  const regenBtn = e.target.closest('.regenerateBtn');
  if (regenBtn) {
    regenBtn.disabled = true;
    regenBtn.textContent = 'Generando...';
    try {
      const res = await fetch(`/api/messages/${regenBtn.dataset.pack}/regenerate-draft`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      state.editingDraftText = null;
      await loadMessages();
    } catch (err) {
      showToast(`Error al regenerar borrador: ${err.message}`);
      regenBtn.disabled = false;
      regenBtn.textContent = 'Regenerar';
    }
  }
}

function handleDraftInput(e) {
  if (e.target.matches('.draft-edit-textarea') && state.editingPackId) {
    state.editingDraftText = e.target.value;
  }
}

el.chatDraftPanel.addEventListener('click', handleDraftAction);
el.chatDraftPanel.addEventListener('input', handleDraftInput);

el.chatThread.addEventListener('click', (e) => {
  const img = e.target.closest('.msg-image');
  if (!img) return;
  // Ctrl/Cmd/Shift+clic o clic con el botón central se dejan pasar tal cual, para
  // quien prefiera el comportamiento nativo de abrir la imagen en una pestaña nueva.
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  openLightbox(img.src, img.alt, img);
});

// Activar el visor con el teclado (Enter sobre el <a> enfocado) es un caso distinto
// al del click de arriba: al activar un <a> por teclado, el navegador dispara el
// click con e.target = el propio <a>, no el <img> que envuelve — así que ".closest
// ('.msg-image')" ahí nunca encuentra nada y quien usa teclado siempre terminaba en
// el comportamiento nativo (pestaña nueva) sin el visor, aunque con el mouse sí lo
// tenga. Este listener aparte cubre ese caso para que el teclado tenga la misma
// experiencia que el mouse.
el.chatThread.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const link = e.target.closest('.msg-image-link');
  const img = link?.querySelector('.msg-image');
  if (!img) return;
  e.preventDefault();
  openLightbox(img.src, img.alt, img);
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderMediation(mediation) {
  if (!mediation) return '';
  if (mediation.error) {
    return `<div class="mediation-box"><strong>⚠ Mediación${mediation.claimId ? ` (reclamo #${mediation.claimId})` : ''}:</strong> no se pudo cargar el detalle (${escapeHtml(mediation.error)}).</div>`;
  }
  if (!mediation.claimId) {
    return `
      <div class="mediation-box">
        <strong>⚖ Mediación en curso</strong>
        <div class="mediation-meta">Mercado Libre bloqueó esta conversación por un reclamo, pero todavía no dio el número de caso.</div>
      </div>
    `;
  }
  const thread = mediation.messages.map((m) => `
    <div class="msg ${m.role === 'respondent' ? 'vendedor' : m.role === 'complainant' ? 'cliente' : 'mediador'}">
      <div class="meta">${escapeHtml(m.roleLabel)} · ${fmtDate(m.date)}</div>
      <div>${escapeHtml(m.text)}</div>
    </div>
  `).join('');
  return `
    <div class="mediation-box">
      <strong>Mediación / reclamo #${mediation.claimId}</strong>
      <div class="mediation-meta">Estado: ${escapeHtml(mediation.status || '—')} · Etapa: ${escapeHtml(mediation.stage || '—')}</div>
      <div class="thread">${thread}</div>
    </div>
  `;
}

// A diferencia de renderMediation (mediación EN CURSO, bloqueando el chat), esto es
// para cuando el chat ya no está bloqueado, pero sigue siendo relevante saber que
// esta venta pasó por un reclamo. No asumimos que ya se resolvió — lo decimos según
// el estado real que reporta Mercado Libre, para no contradecir el renglón de abajo.
function renderPastMediation(record) {
  if (record.status === 'mediacion' || !record.pastMediation) return '';
  const { claimId, status, stage, resolution } = record.pastMediation;
  const resolutionText = typeof resolution === 'string' ? resolution : (resolution ? JSON.stringify(resolution) : null);
  const heading = status === 'closed'
    ? `⚖ Esta venta tuvo un reclamo${claimId ? ` (#${claimId})` : ''}, ya cerrado`
    : `⚖ Esta venta tiene un reclamo${claimId ? ` (#${claimId})` : ''} registrado`;
  return `
    <div class="mediation-box mediation-past">
      <strong>${heading}</strong>
      <div class="mediation-meta">Estado: ${escapeHtml(status || '—')} · Etapa: ${escapeHtml(stage || '—')}${resolutionText ? ` · ${escapeHtml(resolutionText)}` : ''}</div>
    </div>
  `;
}

function selectConversation(packId) {
  state.selectedPackId = packId;
  startPresenceHeartbeat(packId);
  render();
}

function renderChatPanel() {
  const r = state.records.find((x) => x.packId === state.selectedPackId);
  if (!r) {
    el.chatEmpty.hidden = false;
    el.chatOpen.hidden = true;
    return;
  }

  el.chatEmpty.hidden = true;
  el.chatOpen.hidden = false;

  el.chatAvatar.innerHTML = avatarHtml(r.buyerName);
  el.chatTitle.textContent = r.buyerName;
  el.chatItem.innerHTML = `Pedido ${escapeHtml(r.orderId || '—')} · ${escapeHtml(r.itemTitles.join(', ') || 'Producto no identificado')}
    ${r.orderUrl ? ` · <a class="ml-link" href="${r.orderUrl}" target="_blank" rel="noopener">Ver venta en Mercado Libre ↗</a>` : ''}
    ${itemLinksHtml(r.itemLinks)}`;

  if (r.status === 'respondido' && r.answeredBy) {
    el.chatAnsweredBy.hidden = false;
    el.chatAnsweredBy.textContent = `Respondido por ${shortName(r.answeredBy)}`;
  } else {
    el.chatAnsweredBy.hidden = true;
  }

  const messagesHtml = r.messages.map((m) => {
    const hasRealText = m.text && m.text !== '[imagen adjunta]';
    const imagesHtml = (m.attachments || []).map((a) => {
      const src = `/api/attachments/${encodeURIComponent(a.filename)}?siteId=${encodeURIComponent(a.siteId || '')}`;
      return `<a class="msg-image-link" href="${src}" target="_blank" rel="noopener"><img class="msg-image" src="${src}" alt="Imagen adjunta del cliente" loading="lazy" /></a>`;
    }).join('');
    return `
      <div class="msg ${m.sender}">
        <div class="meta">${m.sender === 'cliente' ? 'Cliente' : 'Vendedor'} · ${fmtDate(m.date)}</div>
        ${hasRealText ? `<div>${escapeHtml(m.text)}</div>` : ''}
        ${imagesHtml}
      </div>
    `;
  }).join('');

  el.chatThread.innerHTML = messagesHtml + renderMediation(r.mediation) + renderPastMediation(r);

  const showDraft = r.status === 'pendiente' && r.draftAnswer;
  el.chatDraftPanel.hidden = !showDraft;
  el.chatDraftPanel.innerHTML = showDraft ? draftCardHtml(r) : '';
}

async function loadMessages() {
  const res = await fetch('/api/messages');
  const data = await res.json();

  // Si mientras alguien editaba un borrador, otra persona ya respondió esa misma
  // conversación, no la pisamos en silencio: avisamos y salimos del modo edición.
  if (state.editingPackId) {
    const prev = state.records.find((x) => x.packId === state.editingPackId);
    const next = (data.records || []).find((x) => x.packId === state.editingPackId);
    if (prev?.status === 'pendiente' && next && next.status !== 'pendiente') {
      showToast(`${shortName(next.answeredBy) || 'Alguien más'} ya respondió esta conversación mientras la editabas. Tu borrador no se envió.`);
      state.editingPackId = null;
      state.editingDraftText = null;
    }
  }

  state.records = data.records;
  el.syncInfo.textContent = data.syncedAt
    ? `Última sincronización: ${fmtDate(data.syncedAt)}`
    : 'Aún no se ha sincronizado';
  if (data.lastSyncError) {
    el.syncInfo.textContent += ` (⚠ falló la última sincronización automática: ${data.lastSyncError})`;
  }
  render();
}

async function sync() {
  el.syncBtn.disabled = true;
  el.syncBtn.textContent = 'Sincronizando...';
  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error desconocido');
    await loadMessages();
    if (data.errors) {
      el.syncInfo.textContent += ` (⚠ ${data.errors} paquetes con error)`;
    }
  } catch (err) {
    showToast(`Error al sincronizar: ${err.message}`);
  } finally {
    el.syncBtn.disabled = false;
    el.syncBtn.textContent = 'Sincronizar';
  }
}

// Sincronización automática: mientras cualquiera del equipo tenga la app abierta en
// el navegador, esta misma pestaña pide sincronizar con Mercado Libre cada 2 minutos
// — sin depender de un cron externo. Si otra pestaña/persona ya está sincronizando en
// ese momento, el servidor responde 409 (por el lock en Redis) y aquí se ignora en
// silencio: no es un error real, solo significa que el trabajo ya se está haciendo.
async function autoSync() {
  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    if (res.ok) {
      await loadMessages();
    }
  } catch {
    // Fallo de red silencioso: el siguiente tick (cada 2 min) o el botón manual lo reintentan.
  }
}

el.search.addEventListener('input', render);
el.syncBtn.addEventListener('click', sync);

// Filas clicables que son <div role="button"> (no <button>/<a> nativos): el navegador
// no les da activación por teclado gratis, así que Enter/Espacio se manejan a mano
// aquí y se delegan al mismo listener de click ya puesto en cada fila.
function activateRowOnEnterOrSpace(rowSelector) {
  return (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest(rowSelector);
    if (!row) return;
    e.preventDefault();
    row.click();
  };
}
el.conversationList.addEventListener('keydown', activateRowOnEnterOrSpace('.conversation-item'));

el.statusCounts.addEventListener('click', (e) => {
  const btn = e.target.closest('.badge');
  if (!btn) return;
  state.statusFilter = btn.dataset.status;
  render();
});

el.tabMessages.addEventListener('click', () => switchView('messages'));
el.tabLog.addEventListener('click', () => switchView('log'));
el.tabBank.addEventListener('click', () => switchView('bank'));

// Navegación con flechas del role="tablist" de arriba, siguiendo el patrón ARIA de
// tabs: ←/→ (y Home/End) mueven el foco Y activan la pestaña; Tab ya no entra a cada
// una por separado porque switchView() deja tabindex=-1 en las no seleccionadas.
el.viewSwitch?.addEventListener('keydown', (e) => {
  const tabs = [el.tabMessages, el.tabLog, el.tabBank];
  const views = ['messages', 'log', 'bank'];
  const currentIndex = tabs.indexOf(document.activeElement);
  if (currentIndex === -1) return;
  let nextIndex = null;
  if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
  else if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  else if (e.key === 'Home') nextIndex = 0;
  else if (e.key === 'End') nextIndex = tabs.length - 1;
  if (nextIndex === null) return;
  e.preventDefault();
  switchView(views[nextIndex]);
  tabs[nextIndex].focus();
});

el.logFilters.addEventListener('click', (e) => {
  const btn = e.target.closest('.badge');
  if (!btn) return;
  state.logFilterEmail = btn.dataset.email || '';
  renderLog();
});

function jumpToConversation(packId) {
  switchView('messages');
  selectConversation(packId);
}

el.logList.addEventListener('click', (e) => {
  const row = e.target.closest('.log-entry');
  if (row) jumpToConversation(row.dataset.pack);
});
el.logList.addEventListener('keydown', activateRowOnEnterOrSpace('.log-entry'));

el.liveNowList.addEventListener('click', (e) => {
  const row = e.target.closest('.live-now-row');
  if (row) jumpToConversation(row.dataset.pack);
});
el.liveNowList.addEventListener('keydown', activateRowOnEnterOrSpace('.live-now-row'));

window.addEventListener('beforeunload', stopPresenceHeartbeat);

const AUTO_REFRESH_MS = 20000;
const PRESENCE_POLL_MS = 8000;
const AUTO_SYNC_MS = 120000;
setInterval(loadMessages, AUTO_REFRESH_MS);
setInterval(refreshPresence, PRESENCE_POLL_MS);
setInterval(autoSync, AUTO_SYNC_MS);

initTheme();
loadMessages();
loadUserEmail();
refreshPresence();
autoSync();
