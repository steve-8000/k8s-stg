const authStorageKey = 'clab-auth-token';
let authToken = localStorage.getItem(authStorageKey) || '';
let realtimeSocket = null;
let commandIntent = null;
let latestOrders = [];

const elements = {
  pollState: document.getElementById('poll-state'),
  freshnessChip: document.getElementById('freshness-chip'),
  killSwitchChip: document.getElementById('kill-switch-chip'),
  staleBanner: document.getElementById('stale-banner'),
  staleBannerTitle: document.getElementById('stale-banner-title'),
  staleBannerCopy: document.getElementById('stale-banner-copy'),
  accountHealthBadge: document.getElementById('account-health-badge'),
  accountHealthList: document.getElementById('account-health-list'),
  strategyRuntimeBadge: document.getElementById('strategy-runtime-badge'),
  strategyRuntimeList: document.getElementById('strategy-runtime-list'),
  incidentBadge: document.getElementById('incident-badge'),
  incidentList: document.getElementById('incident-list'),
  approvalBadge: document.getElementById('approval-badge'),
  commandObserved: document.getElementById('command-observed'),
  ordersBadge: document.getElementById('orders-badge'),
  ordersTableBody: document.getElementById('orders-table-body'),
  orderDetailBadge: document.getElementById('order-detail-badge'),
  orderDetailTimeline: document.getElementById('order-detail-timeline'),
  orderDetailExecution: document.getElementById('order-detail-execution'),
  orderDetailPortfolio: document.getElementById('order-detail-portfolio'),
  orderDetailRecon: document.getElementById('order-detail-recon'),
  signalsTabCopy: document.getElementById('signals-tab-copy'),
  reconTabCopy: document.getElementById('recon-tab-copy'),
  strategyTabCopy: document.getElementById('strategy-tab-copy'),
  riskBadge: document.getElementById('risk-badge'),
  riskBadgeBar: document.getElementById('risk-badge-bar'),
  positionsBadge: document.getElementById('positions-badge'),
  positionsTableBody: document.getElementById('positions-table-body'),
  contextBadge: document.getElementById('context-badge'),
  contextActionsList: document.getElementById('context-actions-list'),
  authSessionState: document.getElementById('auth-session-state'),
  authSessionDetail: document.getElementById('auth-session-detail'),
  authUsernameInput: document.getElementById('auth-username-input'),
  authPasswordInput: document.getElementById('auth-password-input'),
  authLoginButton: document.getElementById('auth-login-button'),
  authLogoutButton: document.getElementById('auth-logout-button'),
  commandDialog: document.getElementById('command-dialog'),
  commandDialogTitle: document.getElementById('command-dialog-title'),
  commandDialogBody: document.getElementById('command-dialog-body'),
  commandReasonInput: document.getElementById('command-reason-input'),
};

document.querySelectorAll('.command-button').forEach((button) => {
  button.addEventListener('click', () => openCommandDialog(button.dataset.command));
});
elements.authLoginButton.addEventListener('click', submitAuthLogin);
elements.authLogoutButton.addEventListener('click', clearAuthSession);
elements.commandDialog.addEventListener('close', handleCommandDialogClose);

bootstrap();

async function bootstrap() {
  await hydrateAuthSession();
  updateAuthSessionUI();
  await refreshDashboard();
  connectRealtime();
  window.setInterval(refreshDashboard, 15000);
}

async function hydrateAuthSession() {
  if (!authToken) {
    return;
  }
  const response = await fetch('/api/auth-service/auth/verify', { cache: 'no-store', headers: { Authorization: `Bearer ${authToken}` } }).catch(() => null);
  if (!response || !response.ok) {
    clearAuthSession(false);
  }
}

async function refreshDashboard() {
  const [overview, strategies, orders, positions, reconciliation, services] = await Promise.all([
    fetchJSON('/api/query-api/accounts/main/overview'),
    fetchJSON('/api/query-api/strategies'),
    fetchJSON('/api/query-api/orders?account_id=main'),
    fetchJSON('/api/query-api/positions?account_id=main'),
    fetchJSON('/api/query-api/reconciliation/status?account_id=main'),
    fetchJSON('/api/query-api/services/health'),
  ]);
  renderOverview(overview);
  renderStrategies(strategies);
  renderOrders(orders);
  renderPositions(positions);
  renderReconciliation(reconciliation);
  renderServices(services);
}

function connectRealtime() {
  if (realtimeSocket) {
    realtimeSocket.close();
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  realtimeSocket = new WebSocket(`${protocol}//${window.location.host}/api/realtime-gateway/ws?account_id=main`);
  realtimeSocket.addEventListener('open', () => setRealtimeState('Realtime connected', 'Live patches are flowing from the realtime gateway.'));
  realtimeSocket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    applyRealtimePayload(payload.channels || {});
  });
  realtimeSocket.addEventListener('close', () => setRealtimeState('Realtime disconnected', 'Dashboard is showing the last known good snapshot with stale markings.'));
  realtimeSocket.addEventListener('error', () => setRealtimeState('Realtime error', 'Realtime gateway is unavailable, so only query snapshots are shown.'));
}

function applyRealtimePayload(channels) {
  if (channels['account.health']) {
    renderOverview(channels['account.health']);
  }
  if (channels['orders.lifecycle']) {
    renderOrders(channels['orders.lifecycle']);
  }
  if (channels['positions.risk']) {
    renderPositions(channels['positions.risk']);
  }
  if (channels['service.health']) {
    renderServices(channels['service.health']);
  }
}

function renderOverview(response) {
  const data = response?.data || {};
  const meta = response?.meta || {};
  const balances = Array.isArray(data.balances) ? data.balances : [];
  const positions = Array.isArray(data.positions) ? data.positions : [];
  elements.accountHealthBadge.textContent = data.state_health || 'unknown';
  elements.accountHealthBadge.className = `badge ${badgeClass(data.state_health)}`;
  elements.accountHealthList.innerHTML = [
    listRow('Account', data.account_id || 'main'),
    listRow('Completeness', meta.completeness || 'partial'),
    listRow('Snapshot version', String(meta.snapshot_version || '--')),
    listRow('Balance', balances[0] ? `${balances[0].asset} ${balances[0].available_balance}` : 'n/a'),
    listRow('Positions', `${positions.length} live slots`),
  ].join('');
  elements.freshnessChip.textContent = meta.freshness_ms !== undefined ? `${meta.freshness_ms} ms` : '--';
  elements.killSwitchChip.textContent = data.state_health || 'DEGRADED';
  elements.killSwitchChip.className = `badge ${badgeClass(data.state_health)}`;
}

function renderStrategies(response) {
  const items = Array.isArray(response?.data) ? response.data : [];
  elements.strategyRuntimeBadge.textContent = `${items.length} strategies`;
  elements.strategyRuntimeBadge.className = 'badge section-badge';
  elements.strategyRuntimeList.innerHTML = items.length
    ? items.slice(0, 4).map((item) => listRow(item.strategy_id, `${item.decision} / ${formatNumber(item.promotion_score)}`)).join('')
    : '<p class="proposal-empty">No promotion decisions recorded yet.</p>';
  elements.signalsTabCopy.textContent = items.length ? `${items[0].strategy_id} is ${itemLower(items[0].decision)} with score ${formatNumber(items[0].promotion_score)}.` : 'No strategy runtime view has been projected yet.';
  elements.strategyTabCopy.textContent = items.length ? `${items.length} strategy decisions are available from the promotion gate.` : 'Promotion gate history will appear here once evaluations run.';
}

function renderOrders(response) {
  const items = Array.isArray(response?.data) ? response.data : [];
  latestOrders = items;
  elements.ordersBadge.textContent = `${items.length} rows`;
  elements.ordersBadge.className = 'badge section-badge';
  elements.ordersTableBody.innerHTML = items.length
    ? items.slice(0, 8).map((item, index) => `<tr data-order-index="${index}"><td>${item.internal_order_id}</td><td>${item.source?.signal_id || 'n/a'}</td><td>${item.terminal_state || 'open'}</td><td>${item.pending_state || 'none'}</td></tr>`).join('')
    : '<tr><td colspan="4">No order lineage rows available.</td></tr>';
  elements.ordersTableBody.querySelectorAll('[data-order-index]').forEach((row) => {
    row.addEventListener('click', () => selectOrder(Number(row.dataset.orderIndex || '0')));
  });
  if (items[0]) {
    selectOrder(0);
  }
}

function selectOrder(index) {
  const item = latestOrders[index];
  if (!item) {
    return;
  }
  elements.orderDetailBadge.textContent = item.pending_state || item.terminal_state || 'idle';
  elements.orderDetailBadge.className = `badge ${badgeClass(item.pending_state || item.terminal_state)}`;
  elements.orderDetailTimeline.textContent = [item.pending_state, item.terminal_state].filter(Boolean).join(' -> ') || 'No timeline available';
  elements.orderDetailExecution.textContent = item.exchange_order_id || 'Execution ack pending';
  elements.orderDetailPortfolio.textContent = item.fills?.length ? `${item.fills.length} fills linked` : 'Portfolio truth not linked yet';
  elements.orderDetailRecon.textContent = item.pending_state === 'ReconciliationRequired' ? 'Reconciliation required' : 'No explicit reconciliation hold';
}

function renderPositions(response) {
  const items = Array.isArray(response?.data) ? response.data : [];
  elements.positionsBadge.textContent = `${items.length} positions`;
  elements.positionsBadge.className = 'badge section-badge';
  elements.positionsTableBody.innerHTML = items.length
    ? items.slice(0, 8).map((item) => `<tr><td>${item.symbol}</td><td>${item.qty}</td><td>${item.unrealized_pnl || '0'}</td><td>${item.position_side}</td></tr>`).join('')
    : '<tr><td colspan="4">No positions available.</td></tr>';
  elements.contextActionsList.innerHTML = items.length
    ? items.slice(0, 3).map((item) => listRow(item.symbol, `${item.position_side} / entry ${item.entry_price || 'n/a'} / mark ${item.mark_price || 'n/a'}`)).join('')
    : '<p class="proposal-empty">No live positions to act on.</p>';
  elements.riskBadgeBar.innerHTML = [riskPill('Gross exposure', items.length ? 'active' : 'flat'), riskPill('Stale market data', 'guarded'), riskPill('Safe mode', items.length ? 'watch' : 'clear')].join('');
  elements.riskBadge.textContent = items.length ? 'watch' : 'clear';
  elements.riskBadge.className = `badge ${items.length ? 'is-degraded' : 'is-ready'}`;
  elements.contextBadge.textContent = items.length ? 'observed live' : 'idle';
}

function renderReconciliation(response) {
  const data = response?.data || {};
  elements.reconTabCopy.textContent = `Canonical state is ${data.state_health || 'unknown'} with ${data.completeness || 'unknown'} completeness.`;
}

function renderServices(response) {
  const data = response?.data || {};
  const entries = Object.entries(data);
  elements.incidentBadge.textContent = `${entries.filter(([, value]) => String(value).toLowerCase().includes('unavailable')).length} open`;
  elements.incidentBadge.className = 'badge section-badge';
  elements.incidentList.innerHTML = entries.length ? entries.map(([name, value]) => listRow(name, String(value))).join('') : '<p class="proposal-empty">No service health data available.</p>';
}

function setRealtimeState(title, copy) {
  elements.pollState.textContent = title;
  elements.staleBannerTitle.textContent = title;
  elements.staleBannerCopy.textContent = copy;
  elements.staleBanner.classList.toggle('is-warning', title !== 'Realtime connected');
}

async function fetchJSON(url) {
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
  const response = await fetch(url, { cache: 'no-store', headers }).catch(() => null);
  if (!response) {
    return null;
  }
  if (response.status === 401) {
    clearAuthSession(false);
    updateAuthSessionUI();
    return null;
  }
  return response.json().catch(() => null);
}

async function submitAuthLogin() {
  const username = elements.authUsernameInput.value.trim();
  const password = elements.authPasswordInput.value;
  if (!username || !password) {
    elements.authSessionDetail.textContent = 'Enter the bootstrap operator username and password.';
    return;
  }
  const response = await fetch('/api/auth-service/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) }).catch(() => null);
  const payload = await response?.json().catch(() => null);
  if (!response || !response.ok) {
    clearAuthSession(false);
    elements.authSessionDetail.textContent = payload?.error || 'Sign in failed.';
    return;
  }
  authToken = payload.access_token || '';
  localStorage.setItem(authStorageKey, authToken);
  updateAuthSessionUI(payload);
  await refreshDashboard();
}

function clearAuthSession(rerender = true) {
  authToken = '';
  localStorage.removeItem(authStorageKey);
  if (rerender) {
    updateAuthSessionUI();
  }
}

function updateAuthSessionUI(payload = null) {
  if (!authToken) {
    elements.authSessionState.textContent = 'locked';
    elements.authSessionDetail.textContent = 'Sign in to unlock protected queries.';
    elements.authLogoutButton.disabled = true;
    return;
  }
  elements.authSessionState.textContent = payload?.role || 'operator session';
  elements.authSessionDetail.textContent = payload?.subject ? `${payload.subject} authenticated.` : 'Stored operator session restored.';
  elements.authLogoutButton.disabled = false;
}

function openCommandDialog(command) {
  commandIntent = command;
  elements.commandDialogTitle.textContent = `Confirm ${command}`;
  elements.commandDialogBody.textContent = `Desired state: ${command}. Observed state is unchanged until the command API is confirmed and the Query API reports the resulting transition.`;
  elements.commandReasonInput.value = '';
  elements.commandDialog.showModal();
}

function handleCommandDialogClose() {
  if (elements.commandDialog.returnValue !== 'confirm' || !commandIntent) {
    return;
  }
  const reason = elements.commandReasonInput.value.trim() || 'no reason supplied';
  elements.commandObserved.textContent = `Desired command ${commandIntent} submitted with reason: ${reason}. Observed state remains unchanged until the command path reports completion.`;
  commandIntent = null;
}

function listRow(label, value) {
  return `<div class="list-row"><span>${label}</span><strong>${value}</strong></div>`;
}

function riskPill(label, value) {
  return `<div class="risk-pill"><span>${label}</span><strong>${value}</strong></div>`;
}

function badgeClass(state) {
  const normalized = String(state || '').toUpperCase();
  if (normalized === 'SYNCED' || normalized === 'CLEAR' || normalized === 'NORMAL') {
    return 'is-ready';
  }
  if (normalized.includes('DEGRADED') || normalized.includes('PENDING') || normalized.includes('WATCH')) {
    return 'is-degraded';
  }
  if (normalized.includes('HALTED') || normalized.includes('FLATTEN') || normalized.includes('REJECT')) {
    return 'is-blocked';
  }
  return 'section-badge';
}

function itemLower(value) {
  return String(value || '').toLowerCase();
}

function formatNumber(value) {
  return typeof value === 'number' ? value.toFixed(2) : 'n/a';
}
