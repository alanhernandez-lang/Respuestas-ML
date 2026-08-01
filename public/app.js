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
  tabMessages: document.getElementById('tabMessages'),
  tabLog: document.getElementById('tabLog'),
  viewMessages: document.getElementById('viewMessages'),
  viewLog: document.getElementById('viewLog'),
  liveNowList: document.getElementById('liveNowList'),
  logFilters: document.getElementById('logFilters'),
  logList: document.getElementById('logList'),
  logEmptyState: document.getElementById('logEmptyState'),
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
  if (!packIds.length) {
    el.liveNowList.innerHTML = '<p class="live-now-empty">Nadie más está conectado en este momento.</p>';
    return;
  }
  el.liveNowList.innerHTML = packIds.map((packId) => {
    const email = state.viewers[packId];
    const r = state.records.find((x) => x.packId === packId);
    const buyer = r ? r.buyerName : 'una conversación';
    return `
      <div class="live-now-row" data-pack="${packId}">
        ${avatarHtml(shortName(email))}
        <span>${escapeHtml(shortName(email))} está viendo a <strong>${escapeHtml(buyer)}</strong></span>
      </div>
    `;
  }).join('');
}

function switchView(view) {
  const isLog = view === 'log';
  el.viewMessages.hidden = isLog;
  el.viewLog.hidden = !isLog;
  el.tabMessages.setAttribute('aria-selected', String(!isLog));
  el.tabLog.setAttribute('aria-selected', String(isLog));
  if (isLog) {
    stopPresenceHeartbeat();
    refreshLog();
  } else if (state.selectedPackId) {
    startPresenceHeartbeat(state.selectedPackId);
  }
}

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
      <div class="log-entry" data-pack="${e.packId}">
        ${avatarHtml(who)}
        <div class="log-body">
          <div class="log-line"><strong>${escapeHtml(who)}</strong> respondió a <strong>${escapeHtml(e.buyerName)}</strong></div>
          <div class="log-meta">${escapeHtml(itemLine)} · ${timeAgo(e.date)}${e.wasEdited ? ' · editado a mano' : ''}</div>
          <div class="log-snippet">${escapeHtml(e.text)}</div>
        </div>
      </div>
    `;
  }).join('');
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
  el.conversationList.innerHTML = '';
  el.empty.hidden = filtered.length > 0;

  for (const r of filtered) {
    const item = document.createElement('div');
    item.className = 'conversation-item' + (r.packId === state.selectedPackId ? ' active' : '');
    item.dataset.pack = r.packId;
    const answeredLine = r.status === 'respondido' && r.answeredBy
      ? ` · Respondido por ${escapeHtml(shortName(r.answeredBy))}`
      : '';
    item.innerHTML = `
      ${avatarHtml(r.buyerName)}
      <div class="item-body">
        <div class="row-top">
          <span class="buyer-name">${escapeHtml(r.buyerName)}</span>
          <span class="item-time">${fmtTime(r.lastQuestion?.date)}</span>
        </div>
        <div class="row-mid">
          <span class="badge ${r.status}">${STATUS_LABELS[r.status] || r.status}</span>
          <span class="preview">${escapeHtml(lastMessagePreview(r))}</span>
        </div>
        <div class="item-order">Pedido ${escapeHtml(r.orderId || '—')} · ${escapeHtml(r.itemTitles.join(', ') || '—')}${answeredLine}</div>
      </div>
    `;
    item.addEventListener('click', () => selectConversation(r.packId));
    el.conversationList.appendChild(item);
  }

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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderMediation(mediation) {
  if (!mediation) return '';
  if (mediation.error) {
    return `<div class="mediation-box"><strong>⚠ Mediación (reclamo #${mediation.claimId}):</strong> no se pudo cargar el detalle (${escapeHtml(mediation.error)}).</div>`;
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
      return `<a href="${src}" target="_blank" rel="noopener"><img class="msg-image" src="${src}" alt="Imagen adjunta del cliente" loading="lazy" /></a>`;
    }).join('');
    return `
      <div class="msg ${m.sender}">
        <div class="meta">${m.sender === 'cliente' ? 'Cliente' : 'Vendedor'} · ${fmtDate(m.date)}</div>
        ${hasRealText ? `<div>${escapeHtml(m.text)}</div>` : ''}
        ${imagesHtml}
      </div>
    `;
  }).join('');

  el.chatThread.innerHTML = messagesHtml + renderMediation(r.mediation);

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

el.statusCounts.addEventListener('click', (e) => {
  const btn = e.target.closest('.badge');
  if (!btn) return;
  state.statusFilter = btn.dataset.status;
  render();
});

el.tabMessages.addEventListener('click', () => switchView('messages'));
el.tabLog.addEventListener('click', () => switchView('log'));

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

el.liveNowList.addEventListener('click', (e) => {
  const row = e.target.closest('.live-now-row');
  if (row) jumpToConversation(row.dataset.pack);
});

window.addEventListener('beforeunload', stopPresenceHeartbeat);

const AUTO_REFRESH_MS = 20000;
const PRESENCE_POLL_MS = 8000;
const AUTO_SYNC_MS = 120000;
setInterval(loadMessages, AUTO_REFRESH_MS);
setInterval(refreshPresence, PRESENCE_POLL_MS);
setInterval(autoSync, AUTO_SYNC_MS);

loadMessages();
loadUserEmail();
refreshPresence();
autoSync();
