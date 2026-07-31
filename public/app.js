const state = { records: [], selectedPackId: null, hasAutoSelected: false, editingPackId: null };

const el = {
  search: document.getElementById('search'),
  statusFilter: document.getElementById('statusFilter'),
  syncBtn: document.getElementById('syncBtn'),
  syncInfo: document.getElementById('syncInfo'),
  conversationList: document.getElementById('conversationList'),
  empty: document.getElementById('emptyState'),
  chatEmpty: document.getElementById('chatEmpty'),
  chatOpen: document.getElementById('chatOpen'),
  chatAvatar: document.getElementById('chatAvatar'),
  chatTitle: document.getElementById('chatTitle'),
  chatItem: document.getElementById('chatItem'),
  chatThread: document.getElementById('chatThread'),
  chatDraftPanel: document.getElementById('chatDraftPanel'),
};

const STATUS_LABELS = { pendiente: 'Pendiente', respondido: 'Respondido', mediacion: 'Mediación' };
const AVATAR_COLORS = ['av-1', 'av-2', 'av-3', 'av-4', 'av-5', 'av-6', 'av-7', 'av-8'];

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
  const statusQ = el.statusFilter.value;

  const filtered = state.records.filter((r) => {
    const matchesQ = !q
      || r.buyerName.toLowerCase().includes(q)
      || r.itemTitles.join(' ').toLowerCase().includes(q)
      || (r.lastQuestion?.text || '').toLowerCase().includes(q);
    const matchesStatus = !statusQ || r.status === statusQ;
    return matchesQ && matchesStatus;
  });

  el.conversationList.innerHTML = '';
  el.empty.hidden = filtered.length > 0;

  for (const r of filtered) {
    const item = document.createElement('div');
    item.className = 'conversation-item' + (r.packId === state.selectedPackId ? ' active' : '');
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
        <div class="item-order">Pedido ${escapeHtml(r.orderId || '—')} · ${escapeHtml(r.itemTitles.join(', ') || '—')}</div>
      </div>
    `;
    item.addEventListener('click', () => selectConversation(r.packId));
    el.conversationList.appendChild(item);
  }

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
  const len = r.draftAnswer.text.length;
  const overLimit = len > 350;

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

      <div class="draft-suggestion">
        <div class="draft-suggestion-head">
          <span class="draft-label">✨ Respuesta sugerida</span>
          ${r.draftAnswer.edited ? '<span class="edited-pill">editado a mano</span>' : ''}
        </div>
        ${isEditing
          ? `<textarea class="draft-edit-textarea" rows="5">${escapeHtml(r.draftAnswer.text)}</textarea>`
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
    state.editingPackId = editBtn.dataset.pack;
    renderChatPanel();
    return;
  }

  const cancelEditBtn = e.target.closest('.cancelEditBtn');
  if (cancelEditBtn) {
    state.editingPackId = null;
    renderChatPanel();
    return;
  }

  const saveEditBtn = e.target.closest('.saveEditBtn');
  if (saveEditBtn) {
    const card = saveEditBtn.closest('.draft-card');
    const textarea = card.querySelector('.draft-edit-textarea');
    const text = textarea.value.trim();
    if (!text) {
      alert('El borrador no puede quedar vacío.');
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
      await loadMessages();
    } catch (err) {
      alert(`Error al guardar: ${err.message}`);
      saveEditBtn.disabled = false;
      saveEditBtn.textContent = 'Guardar';
    }
    return;
  }

  const publishBtn = e.target.closest('.publishBtn');
  if (publishBtn) {
    const confirmed = confirm(
      `¿Enviar esta respuesta a ${publishBtn.dataset.buyer} en Mercado Libre?\n\nEsta acción es real e irreversible.`,
    );
    if (!confirmed) return;
    publishBtn.disabled = true;
    publishBtn.textContent = 'Publicando...';
    try {
      const res = await fetch(`/api/messages/${publishBtn.dataset.pack}/publish`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      await loadMessages();
    } catch (err) {
      alert(`Error al publicar: ${err.message}`);
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
      await loadMessages();
    } catch (err) {
      alert(`Error al regenerar borrador: ${err.message}`);
      regenBtn.disabled = false;
      regenBtn.textContent = 'Regenerar';
    }
  }
}

el.chatDraftPanel.addEventListener('click', handleDraftAction);

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
    alert(`Error al sincronizar: ${err.message}`);
  } finally {
    el.syncBtn.disabled = false;
    el.syncBtn.textContent = 'Sincronizar';
  }
}

el.search.addEventListener('input', render);
el.statusFilter.addEventListener('change', render);
el.syncBtn.addEventListener('click', sync);

const AUTO_REFRESH_MS = 20000;
setInterval(loadMessages, AUTO_REFRESH_MS);

loadMessages();
