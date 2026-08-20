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
  // Preferencias de uso diario que sí importa recordar entre sesiones, pero que no
  // necesitan vivir en el servidor (son de cómo cada persona quiere ver la lista, no
  // datos de negocio) — se guardan en localStorage, ver loadFlags()/loadSortMode().
  flags: new Set(),
  sortMode: 'reciente',
  showFlaggedOnly: false,
  // '' (todos) / 'unread' / 'read' — filtro de leído/no leído EN MERCADO LIBRE (no
  // es el estado pendiente/mediación/respondido de esta app). Se combina con
  // cualquier filtro de estado ya activo: ver matchesRead en render(). No se
  // recuerda entre sesiones a propósito, igual que statusFilter — es de "qué estoy
  // viendo ahora", no una preferencia fija.
  readFilter: '',
  // Se recalcula en cada render() a partir de `filtered`, para que los atajos j/k
  // (ver moveSelection()) naveguen exactamente la lista que la persona está viendo
  // ahora (con su búsqueda/filtro/orden aplicados), no el arreglo completo sin filtrar.
  filteredIds: [],
  // packId de la conversación cuya tarjeta de borrador tiene abierto el selector de
  // "Banco de respuestas" (ver bankPickerHtml()) — como mucho una a la vez.
  bankPickerOpenFor: null,
  // PDF que el vendedor quiere adjuntar a su respuesta, por packId — ver
  // startAttachmentUpload(). No se manda a Mercado Libre hasta publicar; antes de
  // eso solo vive en el estado de la app (y ya subido a ML en un archivo temporal,
  // listo para referenciarse). Shape: { uploading, originalFilename, mimeType,
  // filename (nombre hasheado que ya asignó ML), error }.
  pendingAttachments: {},
  // packId al que se le va a asociar el próximo archivo que se elija en
  // el.attachmentFileInput (compartido entre todas las tarjetas, como el lightbox).
  attachTargetPackId: null,
  // Gráfica de respuestas por persona (pestaña Bitácora) — ver renderChart().
  chartOpen: false,
  chartRangeDays: 30, // número de días hacia atrás, o 'all'
  chartTableView: false,
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
  chartToggleBtn: document.getElementById('chartToggleBtn'),
  chartPanel: document.getElementById('chartPanel'),
  chartRangeLabel: document.getElementById('chartRangeLabel'),
  chartFilters: document.querySelector('.chart-filters'),
  chartCustomRange: document.getElementById('chartCustomRange'),
  chartRangeFrom: document.getElementById('chartRangeFrom'),
  chartRangeTo: document.getElementById('chartRangeTo'),
  chartCustomRangeApply: document.getElementById('chartCustomRangeApply'),
  chartStats: document.getElementById('chartStats'),
  chartBody: document.getElementById('chartBody'),
  chartLegend: document.getElementById('chartLegend'),
  chartSvgWrap: document.getElementById('chartSvgWrap'),
  chartEmptyState: document.getElementById('chartEmptyState'),
  chartTableToggleBtn: document.getElementById('chartTableToggleBtn'),
  chartTableWrap: document.getElementById('chartTableWrap'),
  bankSearch: document.getElementById('bankSearch'),
  bankList: document.getElementById('bankList'),
  bankEmptyState: document.getElementById('bankEmptyState'),
  themeToggle: document.getElementById('themeToggle'),
  lightboxOverlay: document.getElementById('lightboxOverlay'),
  lightboxImg: document.getElementById('lightboxImg'),
  lightboxClose: document.getElementById('lightboxClose'),
  attachmentFileInput: document.getElementById('attachmentFileInput'),
  sortMode: document.getElementById('sortMode'),
  flagFilterBtn: document.getElementById('flagFilterBtn'),
  readFilterBtn: document.getElementById('readFilterBtn'),
  shortcutsBtn: document.getElementById('shortcutsBtn'),
  shortcutsOverlay: document.getElementById('shortcutsOverlay'),
  shortcutsClose: document.getElementById('shortcutsClose'),
  chatFlagBtn: document.getElementById('chatFlagBtn'),
  chatWaitPill: document.getElementById('chatWaitPill'),
};

const STATUS_LABELS = { pendiente: 'Pendiente', respondido: 'Respondido', mediacion: 'Mediación' };
// Ícono de forma distinta por estado (además del color): así el estado se distingue
// también por forma, no solo por color, y es más fácil de escanear en una lista larga.
const STATUS_ICON = { pendiente: '●', mediacion: '⚖', respondido: '✓' };
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

// "Marcados para seguimiento": un aparte personal e independiente del estado real de
// Mercado Libre, para no perder de vista un caso que necesita revisarse de nuevo más
// tarde aunque ya esté "respondido" (p. ej. "avisar cuando llegue el repuesto") o
// aunque siga "pendiente" pero de baja prioridad y quieras encontrarlo rápido después.
// Vive solo en localStorage de este navegador (no en el servidor): es una nota para
// quien esté usando ESTE equipo/sesión, no un dato compartido con el resto del equipo.
function loadFlags() {
  try {
    const raw = JSON.parse(localStorage.getItem('ml_flags') || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function saveFlags() {
  localStorage.setItem('ml_flags', JSON.stringify([...state.flags]));
}

function toggleFlag(packId) {
  if (!packId) return;
  if (state.flags.has(packId)) state.flags.delete(packId);
  else state.flags.add(packId);
  saveFlags();
  render();
}

el.chatFlagBtn.addEventListener('click', () => toggleFlag(state.selectedPackId));

el.flagFilterBtn.addEventListener('click', () => {
  state.showFlaggedOnly = !state.showFlaggedOnly;
  render();
});

const READ_FILTER_CYCLE = { '': 'unread', unread: 'read', read: '' };
const READ_FILTER_LABELS = { '': '☰ Todos', unread: '☰ No leídos', read: '☰ Leídos' };

el.readFilterBtn.addEventListener('click', () => {
  state.readFilter = READ_FILTER_CYCLE[state.readFilter];
  render();
});

el.sortMode.addEventListener('change', () => {
  state.sortMode = el.sortMode.value === 'urgencia' ? 'urgencia' : 'reciente';
  localStorage.setItem('ml_sortMode', state.sortMode);
  render();
});

// Indicador de urgencia por tiempo esperando respuesta: no basta con saber que algo
// está "pendiente"/"en mediación", importa hace CUÁNTO. Se deriva del mismo
// `lastQuestion.date` que ya trae cada registro — sin pedir nada nuevo al backend.
function waitingInfo(r) {
  if (r.status === 'respondido') return null;
  const dateStr = r.lastQuestion?.date;
  if (!dateStr) return null;
  const hours = (Date.now() - new Date(dateStr).getTime()) / 3600000;
  let level = 'fresh';
  if (hours >= 72) level = 'critical';
  else if (hours >= 24) level = 'warn';
  return { shortLabel: timeAgo(dateStr).replace(/^hace /, ''), level };
}

// Detecta si una respuesta del banco probablemente trae un dato que cambia por
// pedido (número de guía/rastreo tipo "CMM004975", folio, etc.) — coincide con
// letras+dígitos pegados o una corrida larga de dígitos sueltos. No es perfecto
// (puede marcar de más algo como "12 meses de garantía"), pero el costo de un
// falso positivo es solo un aviso de más, mientras que el de un falso negativo es
// reenviarle a un cliente el número de guía de otro. Ver renderBank/bankPickerHtml.
function looksOrderSpecific(text) {
  return /\b[a-z]{2,6}\d{4,}\b/i.test(text) || /\b\d{6,}\b/.test(text);
}

// Sugiere del banco de respuestas cuáles se usaron antes para preguntas parecidas a
// la última del cliente en ESTA conversación — coincidencia simple por palabras (sin
// backend nuevo: solo compara texto que ya tenemos en memoria). No es IA, es una
// heurística barata para subir al principio lo más probablemente útil.
function suggestBankEntries(record, bank, limit) {
  if (!bank.length) return [];
  const questionText = (record?.lastQuestion?.text || '').toLowerCase();
  const words = [...new Set(questionText.split(/[^a-z0-9áéíóúñ]+/i).filter((w) => w.length >= 4))];
  const scored = bank.map((entry) => {
    const haystack = `${entry.text} ${(entry.questions || []).join(' ')}`.toLowerCase();
    const score = words.reduce((acc, w) => acc + (haystack.includes(w) ? 1 : 0), 0);
    return { ...entry, matched: score > 0 };
  });
  if (words.length) {
    // sort() es estable: dentro del mismo puntaje se conserva el orden en que ya
    // venía el banco (por frecuencia de uso, ver computeResponseBank en el servidor).
    scored.sort((a, b) => (b.matched ? 1 : 0) - (a.matched ? 1 : 0));
  }
  return scored.slice(0, limit);
}

// Navegación de la lista con teclado (atajos j/k, ver el manejador global de abajo):
// se mueve dentro de `state.filteredIds`, que render() recalcula con la búsqueda/
// filtro/orden que la persona tenga puestos en ese momento — no la lista completa.
function moveSelection(delta) {
  const ids = state.filteredIds;
  if (!ids.length) return;
  const currentIndex = ids.indexOf(state.selectedPackId);
  const nextIndex = currentIndex === -1
    ? 0
    : Math.min(ids.length - 1, Math.max(0, currentIndex + delta));
  const nextId = ids[nextIndex];
  if (nextId === state.selectedPackId) return;
  selectConversation(nextId);
  el.conversationList.querySelector(`.conversation-item[data-pack="${CSS.escape(nextId)}"]`)
    ?.scrollIntoView({ block: 'nearest' });
}

function openShortcuts() {
  el.shortcutsOverlay.hidden = false;
  el._shortcutsTrigger = document.activeElement;
  el.shortcutsClose.focus();
  document.addEventListener('keydown', onShortcutsKeydown);
}

function closeShortcuts() {
  el.shortcutsOverlay.hidden = true;
  document.removeEventListener('keydown', onShortcutsKeydown);
  el._shortcutsTrigger?.focus();
}

function onShortcutsKeydown(e) {
  if (e.key === 'Escape') {
    closeShortcuts();
    return;
  }
  // El botón de cerrar es el único elemento enfocable dentro del modal — sin esto,
  // Tab se escapa hacia el contenido de atrás (visualmente tapado por el overlay,
  // pero sigue en el orden de tabulación del DOM), rompiendo el atrapa-foco que
  // aria-modal="true" promete a lectores de pantalla.
  if (e.key === 'Tab') {
    e.preventDefault();
    el.shortcutsClose.focus();
  }
}

el.shortcutsBtn.addEventListener('click', openShortcuts);
el.shortcutsClose.addEventListener('click', closeShortcuts);
el.shortcutsOverlay.addEventListener('click', (e) => {
  if (e.target === el.shortcutsOverlay) closeShortcuts();
});

// Atajos de teclado para quien use la herramienta muchas horas al día (ver también
// el modal de ayuda que abre "?", con la lista completa). Se ignoran por completo
// mientras la persona esté escribiendo en un campo de texto (isEditableField) o
// mientras haya un modal propio abierto (confirmación/imagen/atajos), que ya manejan
// su propio teclado.
document.addEventListener('keydown', (e) => {
  if (!el.confirmOverlay.hidden || !el.lightboxOverlay.hidden || !el.shortcutsOverlay.hidden) return;

  // Sin esto, cualquier combinación con Ctrl/Cmd/Alt donde la tecla coincida con uno
  // de nuestros atajos de letra sin modificador (sobre todo Ctrl/Cmd+F "buscar en la
  // página" y Ctrl/Cmd+C "copiar selección", ambos atajos nativos del navegador de
  // uso constante) quedaba secuestrada por error — p. ej. seleccionar texto del hilo
  // y presionar Ctrl+C copiaba el borrador de IA en vez del texto seleccionado.
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  const target = e.target;
  const isEditableField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
    || target.tagName === 'SELECT' || target.isContentEditable;

  if (e.key === 'Escape') {
    if (target === el.search && el.search.value) {
      el.search.value = '';
      render();
      return;
    }
    if (state.editingPackId) {
      state.editingPackId = null;
      state.editingDraftText = null;
      renderChatPanel();
    }
    return;
  }

  if (isEditableField) return;

  if (e.key === '?') { e.preventDefault(); openShortcuts(); return; }
  if (e.key === '/') { e.preventDefault(); el.search.focus(); return; }
  if (e.key === '1') { e.preventDefault(); switchView('messages'); return; }
  if (e.key === '2') { e.preventDefault(); switchView('log'); return; }
  if (e.key === '3') { e.preventDefault(); switchView('bank'); return; }

  if (el.viewMessages.hidden) return; // j/k/f/e/c son de la vista de Mensajes

  if (e.key === 'j') { e.preventDefault(); moveSelection(1); return; }
  if (e.key === 'k') { e.preventDefault(); moveSelection(-1); return; }
  if (e.key === 'f') { e.preventDefault(); toggleFlag(state.selectedPackId); return; }
  if (e.key === 'e') { e.preventDefault(); el.chatDraftPanel.querySelector('.editBtn')?.click(); return; }
  if (e.key === 'c') { e.preventDefault(); el.chatDraftPanel.querySelector('.copyBtn')?.click(); }
});

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

  // Si hay una conversación pendiente abierta, cada respuesta del banco también
  // ofrece "Usar en <comprador>" — un camino más corto que copiar aquí y luego ir a
  // pegarlo a mano en la otra pestaña.
  const activeRecord = state.records.find((x) => x.packId === state.selectedPackId);
  // Si el borrador de esa conversación falló (draftAnswer.error), draftCardHtml no
  // pinta el textarea de edición — insertar ahí dejaría el estado de edición seteado
  // sin nada visible donde aterrizar, y el toast de "insertado" mentiría.
  const canInsert = Boolean(activeRecord && activeRecord.status === 'pendiente'
    && activeRecord.draftAnswer && !activeRecord.draftAnswer.error);

  el.bankEmptyState.hidden = filtered.length > 0;
  el.bankList.innerHTML = filtered.map((r) => {
    const specific = looksOrderSpecific(r.text);
    const warningHtml = specific
      ? ' <span class="badge draft-error" title="Parece traer un dato específico de ese pedido (número de guía, folio, etc.) — si lo usas en otro cliente, revisa y actualízalo">⚠ Revisa datos del pedido</span>'
      : '';
    return `
    <div class="log-entry bank-entry">
      <div class="log-body">
        <div class="log-line">
          <span class="badge all">Usada ${r.count}×</span>
          <span class="log-meta">última vez ${timeAgo(r.lastUsed)}</span>${warningHtml}
        </div>
        <div class="draft-text">${escapeHtml(r.text)}</div>
        ${(r.questions || []).length ? `<div class="log-meta">Preguntas parecidas: ${r.questions.map((qq) => `"${escapeHtml(qq)}"`).join(' · ')}</div>` : ''}
      </div>
      <div class="bank-entry-actions">
        <button class="btn-secondary copyBtn" data-text="${escapeHtml(r.text)}">Copiar</button>
        ${canInsert ? `<button class="btn-secondary useInChatBtn" data-text="${escapeHtml(r.text)}">Usar en "${escapeHtml(activeRecord.buyerName)}"</button>` : ''}
      </div>
    </div>
  `;
  }).join('');
}

el.bankSearch.addEventListener('input', renderBank);

el.bankList.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('.copyBtn');
  if (copyBtn) {
    await navigator.clipboard.writeText(copyBtn.dataset.text);
    copyBtn.textContent = 'Copiado ✓';
    setTimeout(() => { copyBtn.textContent = 'Copiar'; }, 1500);
    return;
  }

  const useInChatBtn = e.target.closest('.useInChatBtn');
  if (useInChatBtn && state.selectedPackId) {
    state.editingPackId = state.selectedPackId;
    state.editingDraftText = useInChatBtn.dataset.text;
    state.bankPickerOpenFor = null;
    renderChatPanel();
    switchView('messages');
    el.chatDraftPanel.querySelector('.draft-edit-textarea')?.focus();
    showToast(
      looksOrderSpecific(useInChatBtn.dataset.text)
        ? 'Respuesta insertada — esta trae un dato específico del pedido original (ej. número de guía): verifica y actualízalo antes de publicar.'
        : 'Respuesta insertada en el borrador — revísala antes de publicar.',
      'success',
    );
  }
});

async function refreshLog() {
  try {
    const res = await fetch('/api/log');
    if (!res.ok) return;
    const data = await res.json();
    state.logEntries = data.entries || [];
    renderLog();
    renderChart();
  } catch {
    showToast('No se pudo cargar la bitácora');
  }
}

// ============ Gráfica de "respuestas por día" (Bitácora) ============
// Solo estas 4 personas van en la gráfica, a pedido explícito — el color de cada
// una es FIJO en este orden (paleta categórica validada, ver dataviz skill), y
// nunca cambia según quién tenga más o menos respuestas en un rango dado.
const CHART_PEOPLE = [
  { email: 'teresita.zamora@marvelsa.com', name: 'Teresita', series: 1 },
  { email: 'frida.ruiz@marvelsa.com', name: 'Frida', series: 2 },
  { email: 'faviola.aguilar@mdhsports.com', name: 'Faviola', series: 3 },
  { email: 'getzemany.lazo@marvelsa.com', name: 'Getzemany', series: 4 },
];

// Si el sistema pide "menos movimiento" nos saltamos la animación de "dibujado"
// de la línea (ver animateChartLines) — la duración global ya se anula en
// style.css para cualquier animation/transition, pero acá además evitamos armar
// el estado inicial (dasharray a toda la longitud) para no dejar la línea "a
// medio dibujar" ni un instante en la vista.
const prefersReducedMotion = window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
  : false;

// Clave de día en hora LOCAL (no UTC) — mismo criterio que dayLabel() de arriba,
// para que "hoy"/"ayer" coincidan entre la bitácora y la gráfica.
function chartDayKey(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatChartDayLabel(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
}

// Rango personalizado elegido a mano: { custom: true, from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
// — las demás formas de `chartRangeDays` (7/30/90 o 'all') siguen siendo lo que ya
// manejaban chartRangeLabelText/computeChartData/computeChartTrend.
function isCustomChartRange(rangeDays) {
  return Boolean(rangeDays && typeof rangeDays === 'object' && rangeDays.custom);
}

// A partir de un `rangeDays` (número de días, 'all', o rango personalizado),
// resuelve el día de inicio real (Date o null si es "Todo") y de fin real (Date,
// normalmente hoy — pero un rango personalizado puede terminar en el pasado).
function resolveChartWindow(rangeDays) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (isCustomChartRange(rangeDays)) {
    const [fy, fm, fd] = rangeDays.from.split('-').map(Number);
    const [ty, tm, td] = rangeDays.to.split('-').map(Number);
    let start = new Date(fy, fm - 1, fd);
    let end = new Date(ty, tm - 1, td);
    if (end < start) [start, end] = [end, start]; // por si el usuario invierte "desde"/"hasta"
    return { start, end };
  }
  if (rangeDays === 'all') return { start: null, end: today };
  const start = new Date(today);
  start.setDate(start.getDate() - (rangeDays - 1));
  return { start, end: today };
}

function chartRangeLabelText(rangeDays) {
  if (isCustomChartRange(rangeDays)) {
    // Usa el rango YA resuelto (con "desde"/"hasta" reordenados si el usuario
    // los invirtió, ver resolveChartWindow) — mostrar rangeDays.from/to "en
    // crudo" aquí desincroniza la etiqueta del dato real que sí se grafica
    // cuando from > to.
    const { start, end } = resolveChartWindow(rangeDays);
    return `${formatChartDayLabel(chartDayKey(start))} – ${formatChartDayLabel(chartDayKey(end))}`;
  }
  if (rangeDays === 'all') return 'Todo el historial';
  if (rangeDays === 7) return 'Últimos 7 días';
  if (rangeDays === 90) return 'Últimos 90 días';
  return 'Últimos 30 días';
}

// Arma los días del eje X (todos, aunque no haya actividad ese día — para que la
// línea no salte fechas) y, para cada una de las 4 personas, cuántas respuestas
// publicó por día. `rangeDays` es un número de días hacia atrás, 'all', o un
// rango personalizado (ver isCustomChartRange).
function computeChartData(rangeDays) {
  const { start: startDate, end: endDate } = resolveChartWindow(rangeDays);
  // Fin de ese día completo (23:59:59.999) — un rango personalizado puede
  // terminar en el pasado, así que no basta con comparar contra "ahora".
  const endOfEndDate = new Date(endDate);
  endOfEndDate.setHours(23, 59, 59, 999);

  const relevant = state.logEntries.filter((e) => {
    if (!CHART_PEOPLE.some((p) => p.email === e.answeredBy)) return false;
    const d = new Date(e.date);
    if (startDate && d < startDate) return false;
    if (d > endOfEndDate) return false;
    return true;
  });

  if (!relevant.length) return { days: [], series: [] };

  let firstDate = startDate;
  if (!firstDate) {
    // "Todo": arranca en el día del primer dato real que haya para este grupo,
    // no desde el inicio de los tiempos.
    let earliest = new Date(relevant[0].date);
    relevant.forEach((e) => {
      const d = new Date(e.date);
      if (d < earliest) earliest = d;
    });
    firstDate = new Date(earliest.getFullYear(), earliest.getMonth(), earliest.getDate());
  }

  const days = [];
  const cursor = new Date(firstDate);
  while (cursor <= endDate) {
    days.push(chartDayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  const countsByPersonDay = new Map();
  relevant.forEach((e) => {
    const key = `${e.answeredBy}|${chartDayKey(e.date)}`;
    countsByPersonDay.set(key, (countsByPersonDay.get(key) || 0) + 1);
  });

  const series = CHART_PEOPLE.map((p) => ({
    ...p,
    values: days.map((d) => countsByPersonDay.get(`${p.email}|${d}`) || 0),
  }));

  return { days, series };
}

// Total de respuestas de cada persona dentro de una ventana [start, endExclusivo)
// — nada más para comparar contra el período anterior en las tarjetas de resumen;
// no toca ni reemplaza el cálculo día-por-día de computeChartData().
function sumPersonsInWindow(startDate, endExclusive) {
  const totals = new Map(CHART_PEOPLE.map((p) => [p.email, 0]));
  state.logEntries.forEach((e) => {
    if (!totals.has(e.answeredBy)) return;
    const d = new Date(e.date);
    if (d < startDate || d >= endExclusive) return;
    totals.set(e.answeredBy, totals.get(e.answeredBy) + 1);
  });
  return totals;
}

// Compara el total de cada persona contra el mismo número de días inmediatamente
// anterior al rango activo (mismo tamaño de ventana). En "Todo" no existe un
// período anterior de tamaño comparable, así que no se calcula tendencia — mejor
// omitirla que inventar una base falsa.
function computeChartTrend(rangeDays) {
  if (rangeDays === 'all') return null;
  const { start, end } = resolveChartWindow(rangeDays);
  // "end" es inclusivo (el último día del rango) — el tamaño de la ventana en
  // días cuenta ambos extremos, igual para un preset (7/30/90) que para un rango
  // personalizado de cualquier tamaño.
  const spanDays = Math.round((end - start) / 86400000) + 1;
  const previousStart = new Date(start);
  previousStart.setDate(previousStart.getDate() - spanDays);
  return sumPersonsInWindow(previousStart, start);
}

// Geometría del último render — la guarda el hover/tooltip para no tener que
// recalcular todo en cada movimiento del mouse. Se recalcula en cada renderChart().
let chartGeometry = null;

// Curva monótona (interpolación de Hermite con tangentes de Fritsch–Butland) en
// vez de un spline Catmull-Rom genérico: suaviza los quiebres rectos pero NUNCA
// hace overshoot más allá de los dos puntos que conecta (con conteos chicos
// —0, 1, 2 respuestas por día— un Catmull-Rom normal sí puede "inflar" un pico
// falso entre dos ceros). Ver dataviz skill, anti-patterns.md.
function monotoneLinePath(points) {
  const n = points.length;
  if (n === 0) return '';
  if (n === 1) return `M ${points[0][0].toFixed(2)},${points[0][1].toFixed(2)}`;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  if (n === 2) {
    return `M ${xs[0].toFixed(2)},${ys[0].toFixed(2)} L ${xs[1].toFixed(2)},${ys[1].toFixed(2)}`;
  }

  const h = [];
  const delta = [];
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    delta[i] = h[i] === 0 ? 0 : (ys[i + 1] - ys[i]) / h[i];
  }

  const m = new Array(n);
  m[0] = delta[0];
  m[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] === 0 || delta[i] === 0 || (delta[i - 1] > 0) !== (delta[i] > 0)) {
      m[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }

  let d = `M ${xs[0].toFixed(2)},${ys[0].toFixed(2)} `;
  for (let i = 0; i < n - 1; i++) {
    const cp1x = xs[i] + h[i] / 3;
    const cp1y = ys[i] + (m[i] * h[i]) / 3;
    const cp2x = xs[i + 1] - h[i] / 3;
    const cp2y = ys[i + 1] - (m[i + 1] * h[i]) / 3;
    d += `C ${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${xs[i + 1].toFixed(2)},${ys[i + 1].toFixed(2)} `;
  }
  return d.trim();
}

// Mini-trazo de cada tarjeta de resumen: mismo dato de la serie (values por día
// de computeChartData), solo que auto-escalado a su propio mínimo/máximo para
// que se note el vaivén incluso cuando el total del período es chico.
function buildSparkPath(values) {
  const w = 56;
  const h = 20;
  const pad = 2;
  const n = values.length;
  if (!n) return '';
  const max = Math.max(1, ...values);
  const x = (i) => (n > 1 ? pad + (i / (n - 1)) * (w - pad * 2) : w / 2);
  const y = (v) => pad + (h - pad * 2) - (v / max) * (h - pad * 2);
  return monotoneLinePath(values.map((v, i) => [x(i), y(v)]));
}

function buildChartSvg(days, series) {
  const width = 760;
  const height = 260;
  const marginLeft = 34;
  const marginRight = 12;
  const marginTop = 14;
  const marginBottom = 26;
  const plotW = width - marginLeft - marginRight;
  const plotH = height - marginTop - marginBottom;

  const maxValue = Math.max(1, ...series.flatMap((s) => s.values));
  // Redondea el techo del eje Y a un número "limpio" (1/2/5 × 10^n) en vez de un
  // valor arbitrario, para que los ticks se lean bien (0/5/10, no 0/3.7/7.4).
  const magnitude = Math.pow(10, Math.floor(Math.log10(maxValue)));
  const norm = maxValue / magnitude;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  const niceMax = step * magnitude;
  const yTicks = 4;

  const xForIndex = (i) => marginLeft + (days.length > 1 ? (i / (days.length - 1)) * plotW : plotW / 2);
  const yForValue = (v) => marginTop + plotH - (v / niceMax) * plotH;
  const baselineY = marginTop + plotH;

  const gridlinesHtml = Array.from({ length: yTicks + 1 }, (_, i) => {
    const value = (niceMax / yTicks) * i;
    const y = yForValue(value);
    return `
      <line class="chart-gridline" x1="${marginLeft}" x2="${width - marginRight}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" />
      <text class="chart-axis-label" x="${marginLeft - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end">${Math.round(value)}</text>
    `;
  }).join('');

  // Como mucho ~7 etiquetas en el eje X, sin importar cuántos días haya en el
  // rango — si no, con "Todo" (varios meses) se amontonan encima unas de otras.
  const labelEvery = Math.max(1, Math.ceil(days.length / 7));
  const xLabelsHtml = days.map((d, i) => {
    if (i % labelEvery !== 0 && i !== days.length - 1) return '';
    const x = xForIndex(i);
    return `<text class="chart-axis-label" x="${x.toFixed(1)}" y="${height - 8}" text-anchor="middle">${escapeHtml(formatChartDayLabel(d))}</text>`;
  }).join('');

  // Un degradado por serie para el relleno de área bajo la curva — mismo color
  // que la línea, muy tenue (~16% arriba, transparente abajo) para dar "volumen"
  // al día sin competir con la línea ni con la rejilla.
  const defsHtml = `
    <defs>
      ${series.map((s) => `
        <linearGradient id="chartAreaGrad-${s.series}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style="stop-color: var(--series-${s.series}); stop-opacity: 0.16" />
          <stop offset="100%" style="stop-color: var(--series-${s.series}); stop-opacity: 0" />
        </linearGradient>
      `).join('')}
    </defs>
  `;

  const areasHtml = series.map((s) => {
    const points = s.values.map((v, i) => [xForIndex(i), yForValue(v)]);
    const linePath = monotoneLinePath(points);
    if (!linePath) return '';
    const firstX = xForIndex(0).toFixed(2);
    const lastX = xForIndex(s.values.length - 1).toFixed(2);
    return `<path class="chart-series-area" data-series="${s.series}" d="${linePath} L ${lastX},${baselineY.toFixed(2)} L ${firstX},${baselineY.toFixed(2)} Z" fill="url(#chartAreaGrad-${s.series})" />`;
  }).join('');

  const linesHtml = series.map((s) => {
    const points = s.values.map((v, i) => [xForIndex(i), yForValue(v)]);
    const d = monotoneLinePath(points);
    const lastIndex = s.values.length - 1;
    const endDot = lastIndex >= 0
      ? `<circle class="chart-series-dot" data-series="${s.series}" cx="${xForIndex(lastIndex).toFixed(1)}" cy="${yForValue(s.values[lastIndex]).toFixed(1)}" r="4" style="fill: var(--series-${s.series})" />`
      : '';
    return `<path class="chart-series-line" data-series="${s.series}" d="${d}" style="stroke: var(--series-${s.series})" />${endDot}`;
  }).join('');

  // Puntos que solo se encienden durante el hover (ver showChartTooltip) — la
  // cruceta "se clava" en la línea de cada persona en vez de dejar nada más una
  // línea vertical genérica sin referencia a los valores.
  const hoverDotsHtml = series.map((s) => `<circle class="chart-hover-dot" data-series="${s.series}" r="4" style="fill: var(--series-${s.series}); display:none" />`).join('');

  const svgHtml = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Respuestas publicadas por día, por persona">
      ${defsHtml}
      <line class="chart-axis-line" x1="${marginLeft}" x2="${marginLeft}" y1="${marginTop}" y2="${marginTop + plotH}" />
      <line class="chart-axis-line" x1="${marginLeft}" x2="${width - marginRight}" y1="${marginTop + plotH}" y2="${marginTop + plotH}" />
      ${gridlinesHtml}
      ${xLabelsHtml}
      ${areasHtml}
      ${linesHtml}
      ${hoverDotsHtml}
      <line class="chart-crosshair" id="chartCrosshairLine" x1="0" x2="0" y1="${marginTop}" y2="${marginTop + plotH}" style="display:none" />
      <rect class="chart-hit-layer" x="${marginLeft}" y="${marginTop}" width="${plotW}" height="${plotH}" />
    </svg>
  `;

  return { svgHtml, width, height, marginLeft, marginTop, plotW, plotH, xForIndex, yForValue };
}

function renderChartTable(days, series) {
  if (!days.length) {
    el.chartTableWrap.innerHTML = '<p class="empty-state">Nadie de este grupo ha publicado respuestas en este rango.</p>';
    return;
  }
  const rows = days.map((d, i) => `
    <tr>
      <td>${escapeHtml(formatChartDayLabel(d))}</td>
      ${series.map((s) => `<td>${s.values[i]}</td>`).join('')}
    </tr>
  `).join('');
  el.chartTableWrap.innerHTML = `
    <table>
      <thead>
        <tr><th>Día</th>${series.map((s) => `<th>${escapeHtml(s.name)}</th>`).join('')}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// Tarjetas de resumen arriba de la gráfica: total del rango activo + variación
// vs. el período inmediatamente anterior + un mini-trazo, una por persona (mismo
// orden fijo de CHART_PEOPLE/colores que el resto de la gráfica).
function renderChartStats(days, series) {
  if (!days.length) {
    el.chartStats.innerHTML = '';
    el.chartStats.hidden = true;
    return;
  }
  el.chartStats.hidden = false;
  const trendTotals = computeChartTrend(state.chartRangeDays);

  el.chartStats.innerHTML = series.map((s) => {
    const total = s.values.reduce((sum, v) => sum + v, 0);
    const sparkD = buildSparkPath(s.values);
    const sparkHtml = sparkD
      ? `<svg class="chart-stat-spark" viewBox="0 0 56 20" preserveAspectRatio="none" aria-hidden="true"><path d="${sparkD}" style="stroke: var(--series-${s.series})" /></svg>`
      : '';

    let trendHtml = '';
    if (trendTotals) {
      const previous = trendTotals.get(s.email) || 0;
      const delta = total - previous;
      let trendClass = 'chart-stat-trend--flat';
      let arrow = '•';
      let deltaText = 'sin cambio';
      if (delta > 0) { trendClass = 'chart-stat-trend--up'; arrow = '▲'; deltaText = `+${delta}`; }
      else if (delta < 0) { trendClass = 'chart-stat-trend--down'; arrow = '▼'; deltaText = `${delta}`; }
      trendHtml = `
        <div class="chart-stat-trend ${trendClass}">
          <span aria-hidden="true">${arrow}</span>
          <span>${escapeHtml(deltaText)}</span>
          <span class="chart-stat-trend-label">vs. período anterior</span>
        </div>
      `;
    }

    return `
      <div class="chart-stat-tile">
        <div class="chart-stat-head">
          <span class="chart-stat-dot" style="background: var(--series-${s.series})"></span>
          <span class="chart-stat-name">${escapeHtml(s.name)}</span>
        </div>
        <div class="chart-stat-figures">
          <span class="chart-stat-value">${total}</span>
          ${sparkHtml}
        </div>
        ${trendHtml}
      </div>
    `;
  }).join('');
}

// Dibuja cada línea de izquierda a derecha (stroke-dashoffset) en vez de
// aparecer de golpe. Se salta la animación entera con prefers-reduced-motion en
// vez de solo acortarla, para no dejar un delay de "aparece de repente" pegado a
// una transición de 0.01ms.
function animateChartLines() {
  const svg = el.chartSvgWrap.querySelector('svg');
  if (!svg) return;
  const lines = svg.querySelectorAll('.chart-series-line');
  if (prefersReducedMotion) return;
  lines.forEach((line) => {
    const length = line.getTotalLength();
    // Un rango de un solo día (ej. "desde" y "hasta" el mismo día en el
    // selector personalizado) produce un path de un solo punto ("M x,y", sin
    // segmento) — length es 0, y animar "0 a 0" nunca dispara transitionend,
    // así que el cleanup de abajo no correría y el estilo inline de transición
    // quedaría pegado para siempre en esa línea. Nada que dibujar, nada que
    // animar.
    if (!length) return;
    line.style.strokeDasharray = `${length}`;
    line.style.strokeDashoffset = `${length}`;
    // Fuerza el reflow antes de animar — si no, el navegador colapsa el cambio
    // de dashoffset "de 0 a 0" y la línea aparece de golpe sin transición.
    line.getBoundingClientRect();
    line.style.transition = 'stroke-dashoffset 0.7s ease';
    line.style.strokeDashoffset = '0';
    // El estilo inline de arriba (solo stroke-dashoffset) le gana por completo
    // a la transición de opacity/stroke-width del hover de la leyenda que trae
    // la hoja de estilos (.chart-series-line en style.css) mientras exista —
    // sin este cleanup, resaltar a alguien en la leyenda dejaría de animarse
    // suave después de la primera carga.
    line.addEventListener('transitionend', () => {
      line.style.transition = '';
      line.style.strokeDasharray = '';
      line.style.strokeDashoffset = '';
    }, { once: true });
  });
}

function renderChart() {
  if (!state.chartOpen) return;

  // Por si el cambio de rango se dispara mientras el mouse/foco seguía sobre un
  // nombre de la leyenda del render anterior: el navegador no garantiza que
  // mouseout/focusout disparen cuando el elemento resaltado se destruye vía
  // innerHTML (ver renderChart más abajo) — sin este reset podía quedar una
  // serie resaltada/las demás atenuadas "pegado" de un rango que ya no se ve.
  delete el.chartBody.dataset.hoverSeries;

  el.chartRangeLabel.textContent = chartRangeLabelText(state.chartRangeDays);

  const { days, series } = computeChartData(state.chartRangeDays);
  const hasData = days.length > 0;
  el.chartEmptyState.hidden = hasData;
  el.chartSvgWrap.hidden = !hasData;
  el.chartLegend.hidden = !hasData;

  if (!hasData) {
    el.chartSvgWrap.innerHTML = '';
    el.chartLegend.innerHTML = '';
    chartGeometry = null;
    // Mismo motivo que el reset de abajo (rama con datos): el tooltip vive
    // como hijo de chartSvgWrap, así que el innerHTML de arriba ya se lo llevó
    // entre las patas — sin este reset, ensureChartTooltip() seguiría
    // apuntando a un nodo desconectado si se vuelve a esta rama otra vez.
    chartTooltipEl = null;
    renderChartStats([], []);
    renderChartTable([], []);
    return;
  }

  el.chartLegend.innerHTML = series.map((s) => `
    <button type="button" class="chart-legend-item" data-series="${s.series}">
      <span class="chart-legend-key" style="background: var(--series-${s.series})"></span>${escapeHtml(s.name)}
    </button>
  `).join('');

  renderChartStats(days, series);

  const geometry = buildChartSvg(days, series);
  el.chartSvgWrap.innerHTML = geometry.svgHtml;
  chartGeometry = { ...geometry, days, series };
  // El innerHTML de arriba se lleva entre las patas cualquier tooltip que ya
  // existiera (queda huérfano, fuera del documento) — sin este reset,
  // ensureChartTooltip() seguiría reusando ese nodo desconectado y el tooltip
  // dejaría de aparecer después del primer cambio de rango.
  chartTooltipEl = null;

  animateChartLines();

  if (state.chartTableView) renderChartTable(days, series);
}

let chartTooltipEl = null;
function ensureChartTooltip() {
  if (!chartTooltipEl) {
    chartTooltipEl = document.createElement('div');
    chartTooltipEl.className = 'chart-tooltip';
    chartTooltipEl.hidden = true;
    el.chartSvgWrap.appendChild(chartTooltipEl);
  }
  return chartTooltipEl;
}

function showChartTooltip(index, pointerX, pointerY) {
  if (!chartGeometry) return;
  const { days, series, xForIndex, yForValue } = chartGeometry;
  const tooltip = ensureChartTooltip();
  const wrapRect = el.chartSvgWrap.getBoundingClientRect();
  const dayTotal = series.reduce((sum, s) => sum + s.values[index], 0);

  tooltip.innerHTML = `
    <div class="chart-tooltip-date">${escapeHtml(formatChartDayLabel(days[index]))}</div>
    ${series.map((s) => {
      const value = s.values[index];
      // Tendencia día-contra-día de esta persona (mismo dato de la serie, nada
      // nuevo) — se omite en el primer día del rango, donde no hay "anterior".
      const prev = index > 0 ? s.values[index - 1] : null;
      const delta = prev == null ? 0 : value - prev;
      const deltaHtml = delta
        ? `<span class="chart-tooltip-delta ${delta > 0 ? 'is-up' : 'is-down'}">${delta > 0 ? '▲' : '▼'}${Math.abs(delta)}</span>`
        : '';
      return `
        <div class="chart-tooltip-row">
          <span class="chart-tooltip-key" style="background: var(--series-${s.series})"></span>
          <span class="chart-tooltip-name">${escapeHtml(s.name)}</span>
          <span class="chart-tooltip-value">${value}</span>
          ${deltaHtml}
        </div>
      `;
    }).join('')}
    <div class="chart-tooltip-total">
      <span>Total del día</span>
      <span>${dayTotal}</span>
    </div>
  `;
  tooltip.hidden = false;

  // Posición relativa al contenedor, no a la pantalla — y se acomoda del otro
  // lado si se saldría por el borde derecho.
  let left = pointerX - wrapRect.left + 14;
  const top = Math.max(0, pointerY - wrapRect.top - 20);
  if (left + 190 > wrapRect.width) left = pointerX - wrapRect.left - 190 - 14;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;

  const svg = el.chartSvgWrap.querySelector('svg');
  const crosshair = svg?.querySelector('#chartCrosshairLine');
  if (crosshair) {
    const x = xForIndex(index).toFixed(1);
    crosshair.setAttribute('x1', x);
    crosshair.setAttribute('x2', x);
    crosshair.style.display = '';
  }
  // "Clava" un punto por serie sobre la línea en el día del hover, además de la
  // cruceta vertical — ver hoverDotsHtml en buildChartSvg().
  if (svg) {
    series.forEach((s) => {
      const dot = svg.querySelector(`.chart-hover-dot[data-series="${s.series}"]`);
      if (!dot) return;
      dot.setAttribute('cx', xForIndex(index).toFixed(1));
      dot.setAttribute('cy', yForValue(s.values[index]).toFixed(1));
      dot.style.display = '';
    });
  }
}

function hideChartTooltip() {
  if (chartTooltipEl) chartTooltipEl.hidden = true;
  const svg = el.chartSvgWrap.querySelector('svg');
  const crosshair = svg?.querySelector('#chartCrosshairLine');
  if (crosshair) crosshair.style.display = 'none';
  svg?.querySelectorAll('.chart-hover-dot').forEach((dot) => { dot.style.display = 'none'; });
}

function handleChartPointerMove(e) {
  if (!chartGeometry) return;
  const svg = el.chartSvgWrap.querySelector('svg');
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  if (!rect.width) return;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const scaleX = chartGeometry.width / rect.width;
  const localX = (clientX - rect.left) * scaleX;
  const { marginLeft, plotW, days } = chartGeometry;
  const ratio = Math.min(1, Math.max(0, (localX - marginLeft) / plotW));
  const index = days.length > 1 ? Math.round(ratio * (days.length - 1)) : 0;
  showChartTooltip(index, clientX, clientY);
}

el.chartSvgWrap.addEventListener('pointermove', handleChartPointerMove);
el.chartSvgWrap.addEventListener('pointerleave', hideChartTooltip);

// Pasar el mouse (o el foco, con teclado) sobre un nombre de la leyenda resalta
// su línea/área y atenúa las demás — data-hover-series en #chartBody, leído
// desde CSS (ver ".chart-body[data-hover-series]" en style.css). Los listeners
// van en el contenedor, no en cada botón, porque renderChart() reconstruye la
// leyenda entera (innerHTML) cada vez que cambia el rango.
function setChartHoverSeries(target, seriesNum) {
  const item = target.closest ? target.closest('.chart-legend-item') : null;
  if (!item) return;
  if (seriesNum) el.chartBody.dataset.hoverSeries = item.dataset.series;
  else delete el.chartBody.dataset.hoverSeries;
}
el.chartLegend.addEventListener('mouseover', (e) => setChartHoverSeries(e.target, true));
el.chartLegend.addEventListener('mouseout', (e) => setChartHoverSeries(e.target, false));
el.chartLegend.addEventListener('focusin', (e) => setChartHoverSeries(e.target, true));
el.chartLegend.addEventListener('focusout', (e) => setChartHoverSeries(e.target, false));

el.chartToggleBtn.addEventListener('click', () => {
  state.chartOpen = !state.chartOpen;
  el.chartPanel.hidden = !state.chartOpen;
  el.chartToggleBtn.setAttribute('aria-expanded', String(state.chartOpen));
  el.chartToggleBtn.textContent = state.chartOpen
    ? '📊 Ocultar gráfica de respuestas por persona'
    : '📊 Ver gráfica de respuestas por persona';
  if (state.chartOpen) renderChart();
});

// No se puede elegir una fecha futura — no hay respuestas que mostrar ahí.
const chartTodayStr = chartDayKey(new Date());
el.chartRangeFrom.max = chartTodayStr;
el.chartRangeTo.max = chartTodayStr;

el.chartFilters.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-range]');
  if (!btn) return;
  const { range } = btn.dataset;

  if (range === 'custom') {
    // Solo abre/cierra el selector de fechas — no cambia el rango activo hasta
    // que se le dé clic a "Aplicar", así no se rompe lo que ya se estaba viendo.
    const willShow = el.chartCustomRange.hidden;
    el.chartCustomRange.hidden = !willShow;
    if (willShow) {
      // Sincroniza los campos con el rango ACTIVO cada vez que se abre el
      // selector, no solo la primera vez que estaban en blanco — si no, tras
      // aplicar un rango personalizado, cambiar a un preset (7/30/90/Todo) y
      // volver a abrir el selector, quedaban pegadas las fechas del rango
      // personalizado anterior (sin relación con el preset que en verdad se
      // está viendo), y "Aplicar" sin tocar nada reaplicaría ese rango viejo.
      if (isCustomChartRange(state.chartRangeDays)) {
        el.chartRangeFrom.value = state.chartRangeDays.from;
        el.chartRangeTo.value = state.chartRangeDays.to;
      } else {
        // Precarga con el rango activo actual (o los últimos 30 días si no hay
        // un equivalente en días, ej. si ya estaba en "Todo"), para no arrancar
        // con los campos en blanco.
        const { start, end } = resolveChartWindow(typeof state.chartRangeDays === 'number' ? state.chartRangeDays : 30);
        let fallbackStart = start;
        if (!fallbackStart) {
          fallbackStart = new Date(end);
          fallbackStart.setDate(fallbackStart.getDate() - 29);
        }
        el.chartRangeFrom.value = chartDayKey(fallbackStart);
        el.chartRangeTo.value = chartDayKey(end);
      }
    }
    return;
  }

  state.chartRangeDays = range === 'all' ? 'all' : Number(range);
  el.chartCustomRange.hidden = true;
  el.chartFilters.querySelectorAll('[data-range]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b === btn));
  });
  renderChart();
});

el.chartCustomRangeApply.addEventListener('click', () => {
  const from = el.chartRangeFrom.value;
  const to = el.chartRangeTo.value;
  if (!from || !to) {
    showToast('Elige las dos fechas (desde y hasta) antes de aplicar.');
    return;
  }
  state.chartRangeDays = { custom: true, from, to };
  el.chartFilters.querySelectorAll('[data-range]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.range === 'custom'));
  });
  renderChart();
});

el.chartTableToggleBtn.addEventListener('click', () => {
  state.chartTableView = !state.chartTableView;
  el.chartTableWrap.hidden = !state.chartTableView;
  el.chartTableToggleBtn.setAttribute('aria-expanded', String(state.chartTableView));
  el.chartTableToggleBtn.textContent = state.chartTableView ? 'Ocultar tabla' : 'Ver como tabla';
  if (state.chartTableView) {
    const { days, series } = computeChartData(state.chartRangeDays);
    renderChartTable(days, series);
  }
});

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
    + chip('pendiente', 'pendiente', `${STATUS_ICON.pendiente} ${counts.pendiente} pendiente${counts.pendiente === 1 ? '' : 's'}`)
    + chip('mediacion', 'mediacion', `${STATUS_ICON.mediacion} ${counts.mediacion} mediaci${counts.mediacion === 1 ? 'ón' : 'ones'}`)
    + chip('respondido', 'respondido', `${STATUS_ICON.respondido} ${counts.respondido} respondido${counts.respondido === 1 ? '' : 's'}`);
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

// El nombre de la publicación ES el link a Mercado Libre (si lo tenemos) — así no
// hace falta un "Ver publicación ↗" aparte, se puede dar clic directo al nombre.
// Si por lo que sea no se bajó el link de algún producto puntual (falló esa
// consulta al sincronizar), ese título cae a texto plano en vez de romper todo.
function itemTitlesHtml(r) {
  const titles = r.itemTitles && r.itemTitles.length ? r.itemTitles : [];
  if (!titles.length) return 'Producto no identificado';
  const linksByTitle = new Map((r.itemLinks || []).map((l) => [l.title, l.url]));
  return titles
    .map((title) => {
      const url = linksByTitle.get(title);
      return url
        ? `<a class="ml-link" href="${url}" target="_blank" rel="noopener">${escapeHtml(title)}</a>`
        : escapeHtml(title);
    })
    .join(', ');
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
}

// Solo fecha (sin hora) — para la fecha de venta no hace falta la precisión de
// minutos que sí importa en el hilo de mensajes.
function fmtSaleDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Fecha de venta + badge FULL (fulfillment de Mercado Libre) + estatus de envío
// (Entregado/Enviado/Acordar con el vendedor/...) — se arma aparte para reusarse en
// la fila de la lista, el encabezado del chat y la tarjeta de borrador.
function saleInfoHtml(r) {
  const bits = [];
  const dateLabel = fmtSaleDate(r.saleDate);
  if (dateLabel) bits.push(escapeHtml(dateLabel));
  if (r.isFull) {
    bits.push('<span class="badge full-badge" title="Fulfillment: Mercado Libre gestiona el envío">FULL</span>');
  }
  if (r.shippingStatusLabel) {
    bits.push(`<span class="badge shipping-badge">${escapeHtml(r.shippingStatusLabel)}</span>`);
  }
  return bits.join(' ');
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
    const matchesFlag = !state.showFlaggedOnly || state.flags.has(r.packId);
    // "No leídos"/"Leídos" es el concepto de Mercado Libre (¿hay mensajes sin abrir
    // en ML?), no el estado pendiente/mediación/respondido de esta app — por eso se
    // combina con el filtro de estado en vez de reemplazarlo (ver READ_FILTER_CYCLE).
    const matchesRead = !state.readFilter
      || (state.readFilter === 'unread' ? r.unreadCount > 0 : !(r.unreadCount > 0));
    return matchesQ && matchesStatus && matchesFlag && matchesRead;
  });
  // sort() es estable: dentro de cada grupo de prioridad se conserva el orden por
  // fecha que ya trae el arreglo (el servidor lo entrega del más reciente al más viejo)
  // — salvo en modo "urgencia", donde dentro de lo pendiente/mediación se reordena por
  // cuánto lleva esperando (más viejo primero), para no dejar enterrado bajo mensajes
  // recientes un caso que lleva días sin respuesta.
  filtered.sort((a, b) => {
    const byPriority = (STATUS_PRIORITY[a.status] ?? 0) - (STATUS_PRIORITY[b.status] ?? 0);
    if (byPriority !== 0) return byPriority;
    if (state.sortMode === 'urgencia' && a.status !== 'respondido') {
      return new Date(a.lastQuestion?.date || 0) - new Date(b.lastQuestion?.date || 0);
    }
    return 0;
  });

  state.filteredIds = filtered.map((r) => r.packId);

  el.statusCounts.innerHTML = statusCountsHtml(state.records);
  const flaggedTotal = state.records.filter((r) => state.flags.has(r.packId)).length;
  el.flagFilterBtn.textContent = `⭐ Marcados (${flaggedTotal})`;
  el.flagFilterBtn.setAttribute('aria-pressed', String(state.showFlaggedOnly));
  el.readFilterBtn.textContent = READ_FILTER_LABELS[state.readFilter];
  el.readFilterBtn.setAttribute('aria-pressed', String(Boolean(state.readFilter)));
  el.empty.hidden = filtered.length > 0;

  withFocusPreserved(el.conversationList, () => {
    el.conversationList.innerHTML = '';
    for (const r of filtered) {
      const isFlagged = state.flags.has(r.packId);
      const wait = waitingInfo(r);
      const item = document.createElement('div');
      item.className = 'conversation-item' + (r.packId === state.selectedPackId ? ' active' : '');
      item.dataset.pack = r.packId;
      item.dataset.status = r.status;
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      item.setAttribute('aria-current', String(r.packId === state.selectedPackId));
      const waitAria = wait ? `, lleva ${wait.shortLabel} sin responder` : '';
      item.setAttribute('aria-label', `Conversación con ${r.buyerName}, ${STATUS_LABELS[r.status] || r.status}${waitAria}${isFlagged ? ', marcada para seguimiento' : ''}`);
      const answeredLine = r.status === 'respondido' && r.answeredBy
        ? ` · Respondido por ${escapeHtml(shortName(r.answeredBy))}`
        : '';
      // La mediación se puede haber cerrado y ya no bloquear el chat (status volvió a
      // "respondido"/"pendiente"), pero sigue siendo importante saber que esta venta
      // pasó por un reclamo — así que se marca aparte del badge de estado normal.
      const pastMediationBadge = r.status !== 'mediacion' && r.pastMediation
        ? ` <span class="badge mediacion-past" title="Esta venta tuvo un caso de ${escapeHtml(claimTypeLabel(r.pastMediation.type).toLowerCase())} con Mercado Libre">⚖ Tuvo ${escapeHtml(claimTypeLabel(r.pastMediation.type).toLowerCase())}</span>`
        : '';
      // "Listo"/"con error" ayuda a distinguir de un vistazo los pendientes que solo
      // necesitan revisar y publicar, de los que de verdad requieren escribir algo.
      const draftFlagBadge = r.status === 'pendiente' && r.draftAnswer
        ? (r.draftAnswer.error
          ? ' <span class="badge draft-error" title="El borrador de IA falló para esta conversación">⚠ borrador con error</span>'
          : (r.draftAnswer.flags && r.draftAnswer.flags.length
            ? ' <span class="badge draft-error" title="El borrador incluye un teléfono o link que no está en ninguna plantilla aprobada — revísalo antes de publicar">⚠ revisar dato sospechoso</span>'
            : ' <span class="badge draft-ready" title="Ya hay un borrador de IA listo para revisar y publicar">✨ listo para revisar</span>'))
        : '';
      const unreadHtml = r.unreadCount > 1
        ? `<span class="unread-pill" title="Mensajes nuevos sin leer en Mercado Libre">${r.unreadCount} sin leer</span>`
        : '';
      const rightTimeHtml = wait
        ? `<span class="wait-pill wait-${wait.level}" title="Tiempo desde el último mensaje del cliente sin responder">⏱ ${wait.shortLabel}</span>`
        : `<span class="item-time">${fmtTime(r.lastQuestion?.date)}</span>`;
      item.innerHTML = `
        ${avatarHtml(r.buyerName)}
        <div class="item-body">
          <div class="row-top">
            <span class="buyer-name">${escapeHtml(r.buyerName)}</span>
            <div class="row-top-right">
              ${rightTimeHtml}
              <button type="button" class="flag-btn${isFlagged ? ' flagged' : ''}" aria-pressed="${isFlagged}" aria-label="${isFlagged ? 'Quitar de seguimiento' : 'Marcar para seguimiento'}" title="Marcar para seguimiento (f)">${isFlagged ? '★' : '☆'}</button>
            </div>
          </div>
          <div class="row-mid">
            <span class="badge ${r.status}">${STATUS_ICON[r.status] || ''} ${STATUS_LABELS[r.status] || r.status}</span>${r.isFull ? ' <span class="badge full-badge" title="Fulfillment: Mercado Libre gestiona el envío">FULL</span>' : ''}${pastMediationBadge}${draftFlagBadge}${unreadHtml}
          </div>
          <div class="preview">${escapeHtml(lastMessagePreview(r))}</div>
          <div class="item-order">Pedido ${escapeHtml(r.orderId || '—')} · ${escapeHtml(r.itemTitles.join(', ') || '—')}${answeredLine}</div>
        </div>
      `;
      item.addEventListener('click', () => selectConversation(r.packId));
      const flagBtn = item.querySelector('.flag-btn');
      flagBtn.addEventListener('click', (e) => {
        // La estrella vive dentro de una fila que también es clicable entera (para
        // abrir la conversación) — sin esto, marcar/desmarcar también la abriría.
        e.stopPropagation();
        toggleFlag(r.packId);
      });
      flagBtn.addEventListener('keydown', (e) => {
        // Mismo motivo que arriba, pero para el manejador de teclado delegado del
        // contenedor (activateRowOnEnterOrSpace) — sin esto, Enter/Espacio sobre la
        // estrella también activaría la fila completa.
        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
      });
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

// Formatos que Mercado Libre acepta como adjunto en un mensaje de postventa (no es
// una limitación nuestra — coincide con lo que ya valida server.js del otro lado).
const ALLOWED_ATTACHMENT_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);

// Sube el archivo a Mercado Libre EN CUANTO se elige (no hasta publicar): así, si
// algo sale mal (archivo inválido, ML lo rechaza, etc.), la persona se entera de una
// vez en vez de descubrirlo justo al momento de publicar la respuesta. El archivo ya
// subido queda guardado temporalmente en ML (máx. 48h) esperando a que se publique
// el mensaje que lo referencia — ver /api/messages/:packId/attachment en server.js.
async function startAttachmentUpload(packId, file) {
  if (!ALLOWED_ATTACHMENT_TYPES.has(file.type)) {
    showToast('Solo se pueden adjuntar archivos PDF, JPG o PNG.');
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    showToast('El archivo supera el máximo de 25 MB que permite Mercado Libre.');
    return;
  }
  state.pendingAttachments[packId] = { uploading: true, originalFilename: file.name, mimeType: file.type };
  renderChatPanel();
  try {
    const res = await fetch(
      `/api/messages/${packId}/attachment?filename=${encodeURIComponent(file.name)}&mimeType=${encodeURIComponent(file.type)}`,
      { method: 'POST', headers: { 'content-type': file.type }, body: file },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error desconocido');
    state.pendingAttachments[packId] = { filename: data.filename, originalFilename: file.name, mimeType: file.type };
  } catch (err) {
    state.pendingAttachments[packId] = { error: err.message, originalFilename: file.name, mimeType: file.type };
    showToast(`Error al subir el adjunto: ${err.message}`);
  }
  renderChatPanel();
}

el.attachmentFileInput.addEventListener('change', () => {
  const file = el.attachmentFileInput.files[0];
  const packId = state.attachTargetPackId;
  el.attachmentFileInput.value = ''; // permite volver a elegir el mismo archivo si se quita y se agrega otra vez
  if (file && packId) startAttachmentUpload(packId, file);
});

// Botón "📎 Adjuntar archivo" (si no hay nada elegido/subiendo todavía) o la
// "tarjetita" del archivo ya subido (con opción de quitarlo) — nunca los dos a la
// vez, para no dar la impresión de que se pueden adjuntar varios archivos por mensaje.
function attachmentControlHtml(packId) {
  const pending = state.pendingAttachments[packId];
  if (!pending) {
    return `<button type="button" class="btn-secondary attachFileBtn" data-pack="${packId}">📎 Adjuntar archivo</button>`;
  }
  const icon = pending.mimeType === 'application/pdf' ? '📄' : '🖼';
  if (pending.uploading) {
    return `<span class="attachment-chip attachment-chip-pending">${icon} Subiendo ${escapeHtml(pending.originalFilename)}...</span>`;
  }
  if (pending.error) {
    return `
      <span class="attachment-chip attachment-chip-error">⚠ No se pudo subir "${escapeHtml(pending.originalFilename)}"</span>
      <button type="button" class="btn-secondary attachFileBtn" data-pack="${packId}">Reintentar</button>
    `;
  }
  return `
    <span class="attachment-chip">${icon} ${escapeHtml(pending.originalFilename)}
      <button type="button" class="attachment-chip-remove removeAttachmentBtn" data-pack="${packId}" aria-label="Quitar adjunto">✕</button>
    </span>
  `;
}

function draftCardHtml(r) {
  const draftSaleInfo = saleInfoHtml(r);
  const orderLine = `Pedido ${escapeHtml(r.orderId || '—')} · ${itemTitlesHtml(r)}${draftSaleInfo ? ` · ${draftSaleInfo}` : ''}`;

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
  // Gemini bloqueó al menos una de las fotos de este hilo por seguridad y el
  // borrador se generó solo con el texto — avisar para que alguien las revise a
  // mano antes de publicar (ver imagesExcluded en lib/agent.js).
  const imagesExcludedHtml = r.draftAnswer.imagesExcluded
    ? '<div class="collab-alert">⚠ Este borrador se generó SIN analizar las fotos del hilo (Gemini las bloqueó por seguridad) — revísalas tú mismo antes de publicar.</div>'
    : '';
  // Aviso de la validación determinística de lib/agent.js (validateDraftText): la IA
  // escribió un teléfono o un link que no está en ninguna plantilla aprobada — muy
  // probablemente inventado. Revisar SIEMPRE antes de publicar.
  const flagMessages = {
    telefono_no_verificado: 'incluye un teléfono que no está en ninguna plantilla aprobada — probablemente inventado, NO lo publiques sin verificar.',
    link_no_autorizado: 'incluye un link que no es de marvelsa.com ni de Mercado Libre — probablemente inventado, NO lo publiques sin verificar.',
  };
  const draftFlagsHtml = (r.draftAnswer.flags || []).length
    ? `<div class="draft-flag-alert">${r.draftAnswer.flags.map((f) => `⚠ Este borrador ${escapeHtml(flagMessages[f] || 'tiene un dato que hay que revisar antes de publicar.')}`).join('<br>')}</div>`
    : '';
  const bankBtnHtml = `<button class="btn-secondary bankPickerBtn" data-pack="${r.packId}" aria-expanded="${state.bankPickerOpenFor === r.packId}">📚 Banco</button>`;
  const attachHtml = attachmentControlHtml(r.packId);

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
      ${imagesExcludedHtml}
      ${draftFlagsHtml}

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
            ${bankBtnHtml}
            ${attachHtml}
          </div>
          <button class="btn-primary saveEditBtn" data-pack="${r.packId}">Guardar cambios</button>
        ` : `
          <div class="draft-actions-secondary">
            <button class="btn-secondary copyBtn" data-text="${escapeHtml(r.draftAnswer.text)}">Copiar</button>
            <button class="btn-secondary editBtn" data-pack="${r.packId}">Editar</button>
            <button class="btn-secondary regenerateBtn" data-pack="${r.packId}">Regenerar</button>
            ${bankBtnHtml}
            ${attachHtml}
          </div>
          <button class="btn-primary publishBtn" data-pack="${r.packId}" data-buyer="${escapeHtml(r.buyerName)}">Publicar ↗</button>
        `}
      </div>

      ${bankPickerHtml(r)}
    </div>
  `;
}

// Selector de "Banco de respuestas" dentro de la propia tarjeta del borrador: deja
// insertar una respuesta ya usada antes sin salir a la pestaña de Banco. Prioriza las
// que parecen relacionadas con la última pregunta de este cliente (ver
// suggestBankEntries), pero siempre deja ver también las demás más usadas.
function bankPickerHtml(r) {
  if (state.bankPickerOpenFor !== r.packId) return '';
  if (!state.bank.length) {
    return `<div class="bank-picker"><p class="bank-picker-empty">Todavía no hay respuestas frecuentes guardadas — se van llenando conforme el equipo publique respuestas.</p></div>`;
  }
  const suggestions = suggestBankEntries(r, state.bank, 6);
  const hasMatches = suggestions.some((s) => s.matched);
  return `
    <div class="bank-picker">
      <div class="bank-picker-head">${hasMatches ? 'Respuestas frecuentes relacionadas con esta pregunta' : 'Respuestas más usadas por el equipo'}</div>
      ${suggestions.map((s) => {
        const specific = looksOrderSpecific(s.text);
        return `
        <div class="bank-picker-item${s.matched ? ' matched' : ''}">
          <div class="bank-picker-body">
            <div class="bank-picker-text">${escapeHtml(s.text)}</div>
            ${specific ? '<div class="bank-picker-warning">⚠ Parece traer un dato de ese pedido (número de guía, folio...) — revisa y actualízalo antes de publicar.</div>' : ''}
          </div>
          <button type="button" class="btn-secondary useBankBtn" data-pack="${r.packId}" data-text="${escapeHtml(s.text)}">Usar</button>
        </div>
      `;
      }).join('')}
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

  const attachFileBtn = e.target.closest('.attachFileBtn');
  if (attachFileBtn) {
    state.attachTargetPackId = attachFileBtn.dataset.pack;
    el.attachmentFileInput.click();
    return;
  }

  const removeAttachmentBtn = e.target.closest('.removeAttachmentBtn');
  if (removeAttachmentBtn) {
    delete state.pendingAttachments[removeAttachmentBtn.dataset.pack];
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

  const bankPickerBtn = e.target.closest('.bankPickerBtn');
  if (bankPickerBtn) {
    const pid = bankPickerBtn.dataset.pack;
    state.bankPickerOpenFor = state.bankPickerOpenFor === pid ? null : pid;
    renderChatPanel();
    return;
  }

  const useBankBtn = e.target.closest('.useBankBtn');
  if (useBankBtn) {
    // Insertar una respuesta del banco entra en modo edición con ese texto ya puesto
    // (en vez de guardarlo directo): siempre queda una oportunidad de ajustarlo al
    // caso concreto antes de publicar, igual que si se hubiera escrito a mano.
    state.editingPackId = useBankBtn.dataset.pack;
    state.editingDraftText = useBankBtn.dataset.text;
    state.bankPickerOpenFor = null;
    renderChatPanel();
    if (looksOrderSpecific(useBankBtn.dataset.text)) {
      showToast('Esta respuesta trae un dato específico del pedido original (ej. número de guía): verifica y actualízalo antes de publicar.', 'success');
    }
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
      saveEditBtn.textContent = 'Guardar cambios';
    }
    return;
  }

  const publishBtn = e.target.closest('.publishBtn');
  if (publishBtn) {
    const packId = publishBtn.dataset.pack;
    const pending = state.pendingAttachments[packId];
    if (pending?.uploading) {
      showToast('Espera a que termine de subirse el PDF antes de publicar.');
      return;
    }
    if (pending?.error) {
      showToast('El PDF no se subió correctamente — quítalo o reinténtalo antes de publicar.');
      return;
    }
    const confirmed = await showConfirm(
      `¿Enviar esta respuesta a ${publishBtn.dataset.buyer} en Mercado Libre?\n\nEsta acción es real e irreversible.`,
    );
    if (!confirmed) return;
    publishBtn.disabled = true;
    publishBtn.textContent = 'Publicando...';
    try {
      const res = await fetch(`/api/messages/${packId}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ attachments: pending ? [{ filename: pending.filename, mimeType: pending.mimeType }] : [] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error desconocido');
      delete state.pendingAttachments[packId];
      showToast('Respuesta publicada correctamente', 'success');
      await loadMessages();
    } catch (err) {
      showToast(`Error al publicar: ${err.message}`);
      publishBtn.disabled = false;
      publishBtn.textContent = 'Publicar';
      // Un 403 de Mercado Libre (conversación bloqueada por mediación, etc.) ya deja
      // el pack actualizado en el servidor — se recarga para que se vea el estado
      // real de una vez, en vez de que la tarjeta se quede mostrando el borrador
      // viejo hasta el siguiente sondeo automático.
      await loadMessages();
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
      // Si el texto salió idéntico al anterior, no es que el botón no haya hecho
      // nada — casi siempre significa que la respuesta correcta es una plantilla
      // aprobada tal cual (factura, cabezal, etc.), que a propósito no debe variar.
      if (data.draftAnswer?.unchanged) {
        showToast('El texto no cambió: esta respuesta usa una plantilla aprobada que debe quedar igual siempre.', 'success');
      }
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

// Mercado Libre agrupa mediaciones, devoluciones y cancelaciones de compra bajo el
// mismo "claim" — sin distinguir el `type`, todo se veía genérico como "Mediación"
// en la UI aunque en realidad fuera una devolución. "Reclamo" es el resguardo por si
// llega un `type` que no está en esta lista (para no dejarlo sin etiqueta).
const CLAIM_TYPE_LABELS = {
  mediations: 'Mediación',
  return: 'Devolución',
  cancel_purchase: 'Cancelación de compra',
};
function claimTypeLabel(type) {
  return CLAIM_TYPE_LABELS[type] || 'Reclamo';
}

function renderMediation(mediation) {
  if (!mediation) return '';
  const typeLabel = claimTypeLabel(mediation.type);
  if (mediation.error) {
    return `<div class="mediation-box"><strong>⚠ ${escapeHtml(typeLabel)}${mediation.claimId ? ` (reclamo #${mediation.claimId})` : ''}:</strong> no se pudo cargar el detalle (${escapeHtml(mediation.error)}).</div>`;
  }
  if (!mediation.claimId) {
    return `
      <div class="mediation-box">
        <strong>⚖ ${escapeHtml(typeLabel)} en curso</strong>
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
      <strong>${escapeHtml(typeLabel)} / reclamo #${mediation.claimId}</strong>
      <div class="mediation-meta">Estado: ${escapeHtml(mediation.status || '—')} · Etapa: ${escapeHtml(mediation.stage || '—')}</div>
      <div class="thread">${thread}</div>
    </div>
  `;
}

// Motivos de cierre de un reclamo que hemos visto en la práctica — si Mercado
// Libre manda uno que no está aquí, se muestra tal cual (con guiones bajos
// cambiados por espacios) en vez de ocultarlo, para no perder la información.
const CLAIM_REASON_LABELS = {
  timeout: 'venció el plazo sin que nadie respondiera',
  buyer_favored: 'se resolvió a favor del comprador',
  seller_favored: 'se resolvió a favor del vendedor',
  mutual_agreement: 'acuerdo entre comprador y vendedor',
  return_completed: 'devolución del producto completada',
};
const CLAIM_CLOSED_BY_LABELS = {
  mediator: 'un mediador de Mercado Libre',
  seller: 'el vendedor',
  buyer: 'el comprador',
  system: 'el sistema de Mercado Libre',
};

// El detalle de cómo se resolvió un reclamo (`resolution`) viene como objeto, no
// como texto — antes esto se mostraba crudo con JSON.stringify (feo e ilegible).
// Aquí se traduce a los campos que sí sabemos leer; lo que no reconocemos se
// muestra igual (en vez de ocultarlo) pero en palabras, nunca como JSON.
function formatClaimResolution(resolution) {
  if (!resolution) return null;
  if (typeof resolution === 'string') return resolution;
  const bits = [];
  if (resolution.reason) {
    bits.push(`Motivo: ${CLAIM_REASON_LABELS[resolution.reason] || String(resolution.reason).replace(/_/g, ' ')}`);
  }
  if (resolution.closed_by) {
    bits.push(`Cerrado por: ${CLAIM_CLOSED_BY_LABELS[resolution.closed_by] || resolution.closed_by}`);
  }
  if (typeof resolution.applied_coverage === 'boolean') {
    bits.push(`Cobertura de ML aplicada: ${resolution.applied_coverage ? 'sí' : 'no'}`);
  }
  return bits.length ? bits.join(' · ') : null;
}

// A diferencia de renderMediation (mediación EN CURSO, bloqueando el chat), esto es
// para cuando el chat ya no está bloqueado, pero sigue siendo relevante saber que
// esta venta pasó por un reclamo. No asumimos que ya se resolvió — lo decimos según
// el estado real que reporta Mercado Libre, para no contradecir el renglón de abajo.
function renderPastMediation(record) {
  if (record.status === 'mediacion' || !record.pastMediation) return '';
  const { claimId, type, status, stage, resolution } = record.pastMediation;
  const typeLabel = claimTypeLabel(type).toLowerCase();
  const resolutionText = formatClaimResolution(resolution);
  // "un caso de <tipo>" en vez de pegar el artículo directo al tipo: así funciona
  // igual de bien con "mediación"/"devolución" (femenino) que con "reclamo"
  // genérico (masculino), sin tener que cargar el género de cada etiqueta.
  const heading = status === 'closed'
    ? `⚖ Esta venta tuvo un caso de ${typeLabel}${claimId ? ` (#${claimId})` : ''}, ya cerrado`
    : `⚖ Esta venta tiene un caso de ${typeLabel}${claimId ? ` (#${claimId})` : ''} registrado`;
  return `
    <div class="mediation-box mediation-past">
      <strong>${heading}</strong>
      <div class="mediation-meta">Estado: ${escapeHtml(status || '—')} · Etapa: ${escapeHtml(stage || '—')}</div>
      ${resolutionText ? `<div class="mediation-meta">${escapeHtml(resolutionText)}</div>` : ''}
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
  const chatSaleInfo = saleInfoHtml(r);
  el.chatItem.innerHTML = `Pedido ${escapeHtml(r.orderId || '—')} · ${itemTitlesHtml(r)}${chatSaleInfo ? ` · ${chatSaleInfo}` : ''}`;

  const isFlagged = state.flags.has(r.packId);
  el.chatFlagBtn.textContent = isFlagged ? '★' : '☆';
  el.chatFlagBtn.classList.toggle('flagged', isFlagged);
  el.chatFlagBtn.setAttribute('aria-pressed', String(isFlagged));
  el.chatFlagBtn.setAttribute('aria-label', isFlagged ? 'Quitar de seguimiento' : 'Marcar para seguimiento');

  const wait = waitingInfo(r);
  if (wait) {
    el.chatWaitPill.hidden = false;
    el.chatWaitPill.className = `wait-pill wait-${wait.level}`;
    el.chatWaitPill.textContent = `⏱ lleva ${wait.shortLabel} sin responder`;
  } else {
    el.chatWaitPill.hidden = true;
  }

  if (r.status === 'respondido' && r.answeredBy) {
    el.chatAnsweredBy.hidden = false;
    el.chatAnsweredBy.textContent = `Respondido por ${shortName(r.answeredBy)}`;
  } else {
    el.chatAnsweredBy.hidden = true;
  }

  const ATTACHMENT_PLACEHOLDER_TEXTS = ['[imagen adjunta]', '[PDF adjunto]', '[imagen y PDF adjuntos]'];
  const messagesHtml = r.messages.map((m) => {
    const hasRealText = m.text && !ATTACHMENT_PLACEHOLDER_TEXTS.includes(m.text);
    const attachmentsHtml = (m.attachments || []).map((a) => {
      const src = `/api/attachments/${encodeURIComponent(a.filename)}?siteId=${encodeURIComponent(a.siteId || '')}`;
      if (a.kind === 'pdf') {
        // Sin lightbox ni <img> — un PDF se abre/descarga tal cual, no se amplía.
        return `<a class="msg-pdf-link" href="${src}" target="_blank" rel="noopener">📄 Ver PDF adjunto</a>`;
      }
      return `<a class="msg-image-link" href="${src}" target="_blank" rel="noopener"><img class="msg-image" src="${src}" alt="Imagen adjunta del cliente" loading="lazy" /></a>`;
    }).join('');
    return `
      <div class="msg ${m.sender}">
        <div class="meta">${m.sender === 'cliente' ? 'Cliente' : 'Vendedor'} · ${fmtDate(m.date)}</div>
        ${hasRealText ? `<div>${escapeHtml(m.text)}</div>` : ''}
        ${attachmentsHtml}
      </div>
    `;
  }).join('');

  el.chatThread.innerHTML = messagesHtml + renderMediation(r.mediation) + renderPastMediation(r);

  // El refresco automático (cada 20s) llama a esta función igual que cualquier otro
  // cambio — sin esto, si justo se está escribiendo en el textarea de edición, cada
  // refresco reconstruye el <textarea> desde cero y el cursor/foco se pierde a media
  // escritura (se siente como si "se descompusiera" el editor). Se guarda selección
  // y scroll ANTES de reconstruir, y se restauran después en el <textarea> nuevo.
  const textareaEl = el.chatDraftPanel.querySelector('.draft-edit-textarea');
  const preservedSelection = textareaEl && document.activeElement === textareaEl
    ? { selectionStart: textareaEl.selectionStart, selectionEnd: textareaEl.selectionEnd, scrollTop: textareaEl.scrollTop }
    : null;

  const showDraft = r.status === 'pendiente' && r.draftAnswer;
  el.chatDraftPanel.hidden = !showDraft;
  el.chatDraftPanel.innerHTML = showDraft ? draftCardHtml(r) : '';

  if (preservedSelection) {
    const newTextarea = el.chatDraftPanel.querySelector('.draft-edit-textarea');
    if (newTextarea) {
      newTextarea.focus();
      newTextarea.setSelectionRange(preservedSelection.selectionStart, preservedSelection.selectionEnd);
      newTextarea.scrollTop = preservedSelection.scrollTop;
    }
  }
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

// Antes eran 20s: cada persona con la pestaña abierta jala el catálogo COMPLETO de
// conversaciones (con su historial) del servidor. Con varias personas todo el día,
// eso fue lo que agotó el límite gratuito de ancho de banda de Vercel y pausó el
// sitio. 45s sigue siendo "casi al instante" para este uso, pero corta las peticiones
// (y el gasto de banda) más de la mitad.
const AUTO_REFRESH_MS = 45000;
const PRESENCE_POLL_MS = 8000;
const AUTO_SYNC_MS = 120000;
setInterval(loadMessages, AUTO_REFRESH_MS);
setInterval(refreshPresence, PRESENCE_POLL_MS);
setInterval(autoSync, AUTO_SYNC_MS);

// Preferencias personales de este navegador (ver comentarios junto a cada loader):
// se cargan antes del primer render() para que la lista ya salga ordenada/filtrada
// como la persona la dejó la última vez, sin un parpadeo con los valores por default.
state.flags = loadFlags();
state.sortMode = localStorage.getItem('ml_sortMode') === 'urgencia' ? 'urgencia' : 'reciente';
el.sortMode.value = state.sortMode;

initTheme();
loadMessages();
loadUserEmail();
refreshPresence();
autoSync();
// El banco de respuestas se precarga desde el arranque (no solo al abrir su pestaña)
// para que el selector "📚 Banco" dentro de cada borrador ya tenga datos disponibles
// desde el primer momento, sin que la persona tenga que visitar esa pestaña primero.
refreshBank();
