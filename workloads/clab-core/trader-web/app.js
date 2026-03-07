const authStorageKey = 'clab-auth-token';
let authToken = localStorage.getItem(authStorageKey) || '';
let authStepUp = false;
let authPermissions = [];
let realtimeSocket = null;
let commandIntent = null;
let latestOrders = [];
let latestProposalQueue = null;
let latestProposalReviews = null;
let selectedProposalId = null;

const supportedControlCommands = {
  'cancel-all': {
    endpoint: '/api/control-service/execution/cancel-all',
    label: 'cancel_all',
  },
  flatten: {
    endpoint: '/api/control-service/execution/flatten',
    label: 'flatten',
  },
  'kill-switch': {
    endpoint: '/api/control-service/risk/kill-switch/arm',
    label: 'kill_switch_arm',
  },
  'kill-switch-release': {
    endpoint: '/api/control-service/risk/kill-switch/release',
    label: 'kill_switch_release',
  },
};

const requiredPermissionForCommand = {
  'cancel-all': 'trading.cancel_all',
  flatten: 'trading.flatten_positions',
  'kill-switch': 'trading.kill_switch',
  'kill-switch-release': 'trading.kill_switch',
};

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
  proposalQueueList: document.getElementById('proposal-queue-list'),
  proposalReasonInput: document.getElementById('proposal-reason-input'),
  proposalApproveButton: document.getElementById('proposal-approve-button'),
  proposalHoldButton: document.getElementById('proposal-hold-button'),
  proposalRejectButton: document.getElementById('proposal-reject-button'),
  proposalReviewState: document.getElementById('proposal-review-state'),
  proposalHistoryBadge: document.getElementById('proposal-history-badge'),
  proposalHistoryList: document.getElementById('proposal-history-list'),
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
  authPermissionsList: document.getElementById('auth-permissions-list'),
  authUsernameInput: document.getElementById('auth-username-input'),
  authPasswordInput: document.getElementById('auth-password-input'),
  authLoginButton: document.getElementById('auth-login-button'),
  authStepUpButton: document.getElementById('auth-step-up-button'),
  authLogoutButton: document.getElementById('auth-logout-button'),
  commandDialog: document.getElementById('command-dialog'),
  commandDialogTitle: document.getElementById('command-dialog-title'),
  commandDialogBody: document.getElementById('command-dialog-body'),
  commandReasonInput: document.getElementById('command-reason-input'),
  commandConfirmButton: document.getElementById('command-confirm-button'),
};

document.querySelectorAll('[data-command]').forEach((button) => {
  button.addEventListener('click', () => openCommandDialog(button.dataset.command));
});
elements.authLoginButton.addEventListener('click', submitAuthLogin);
elements.authStepUpButton.addEventListener('click', submitAuthStepUp);
elements.authLogoutButton.addEventListener('click', clearAuthSession);
elements.commandDialog.addEventListener('close', handleCommandDialogClose);
elements.proposalApproveButton.addEventListener('click', () => submitProposalReview('approve'));
elements.proposalHoldButton.addEventListener('click', () => submitProposalReview('hold'));
elements.proposalRejectButton.addEventListener('click', () => submitProposalReview('reject'));

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
    return;
  }
  const payload = await response.json().catch(() => null);
  authStepUp = payload?.step_up === true;
  authPermissions = Array.isArray(payload?.permissions) ? payload.permissions : [];
}

async function refreshDashboard() {
  const [overview, strategies, orders, positions, reconciliation, services, alerts, controlState, proposalQueue, proposalReviews] = await Promise.all([
    fetchJSON('/api/query-api/accounts/main/overview'),
    fetchJSON('/api/query-api/strategies'),
    fetchJSON('/api/query-api/orders?account_id=main'),
    fetchJSON('/api/query-api/positions?account_id=main'),
    fetchJSON('/api/query-api/reconciliation/status?account_id=main'),
    fetchJSON('/api/query-api/services/health'),
    fetchJSON('/api/notification-service/alerts'),
    fetchJSON('/api/control-service/state'),
    fetchJSON('/api/proposal-service/queue'),
    fetchJSON('/api/proposal-service/reviews'),
  ]);
  renderOverview(overview);
  renderStrategies(strategies);
  renderOrders(orders);
  renderPositions(positions);
  renderReconciliation(reconciliation);
  renderServices(services);
  renderIncidents(alerts);
  renderControlState(controlState);
  renderProposalQueue(proposalQueue, proposalReviews);
}

function connectRealtime() {
  if (realtimeSocket) {
    realtimeSocket.close();
  }
  if (!authToken) {
    setRealtimeState('Realtime locked', 'Sign in to unlock live patches from the realtime gateway.');
    return;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  realtimeSocket = new WebSocket(`${protocol}//${window.location.host}/api/realtime-gateway/ws?token=${encodeURIComponent(authToken)}&account_id=main`);
  realtimeSocket.addEventListener('open', () => setRealtimeState('Realtime connected', 'Live patches are flowing from the realtime gateway.'));
  realtimeSocket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    applyRealtimePayload(payload.channels || {});
  });
  realtimeSocket.addEventListener('close', () => {
    if (!authToken) {
      setRealtimeState('Realtime locked', 'Sign in to unlock live patches from the realtime gateway.');
      return;
    }
    setRealtimeState('Realtime disconnected', 'Dashboard is showing the last known good snapshot with stale markings.');
  });
  realtimeSocket.addEventListener('error', () => setRealtimeState('Realtime error', 'Realtime gateway is unavailable, so only query snapshots are shown.'));
}

function applyRealtimePayload(channels) {
  if (channels['account.health']) {
    renderOverview(channels['account.health']);
  }
  if (channels['strategy.runtime']) {
    renderStrategies(channels['strategy.runtime']);
  }
  if (channels['orders.lifecycle']) {
    renderOrders(channels['orders.lifecycle']);
  }
  if (channels['positions.risk']) {
    renderPositions(channels['positions.risk']);
  }
  if (channels.reconciliation) {
    renderReconciliation(channels.reconciliation);
  }
  if (channels['service.health']) {
    renderServices(channels['service.health']);
  }
  if (channels.incidents) {
    renderIncidents(channels.incidents);
  }
  if (channels['control.state']) {
    renderControlState(channels['control.state']);
  }
  if (channels['proposal.queue'] || channels['proposal.reviews']) {
    renderProposalQueue(channels['proposal.queue'] || latestProposalQueue, channels['proposal.reviews'] || latestProposalReviews);
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
  elements.signalsTabCopy.textContent = items.length ? `${items[0].strategy_id} is ${items[0].decision.toLowerCase()} with score ${formatNumber(items[0].promotion_score)}.` : 'No strategy runtime view has been projected yet.';
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
  elements.riskBadgeBar.innerHTML = [
    riskPill('Gross exposure', items.length ? 'active' : 'flat'),
    riskPill('Stale market data', 'guarded'),
    riskPill('Safe mode', items.length ? 'watch' : 'clear'),
  ].join('');
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
  elements.contextActionsList.innerHTML = entries.length
    ? entries.slice(0, 3).map(([name, value]) => listRow(`service ${name}`, String(value))).join('')
    : elements.contextActionsList.innerHTML;
}

function renderIncidents(response) {
  const items = Array.isArray(response?.items) ? response.items : (Array.isArray(response?.data) ? response.data : []);
  elements.incidentBadge.textContent = `${items.length} open`;
  elements.incidentBadge.className = `badge ${items.length > 0 ? 'is-degraded' : 'section-badge'}`;
  elements.incidentList.innerHTML = items.length
    ? items.slice(0, 6).map((item) => incidentRow(item)).join('')
    : '<p class="proposal-empty">No active incidents or alerts.</p>';
}

function incidentRow(item) {
  const title = item.title || item.code || 'Incident';
  const severity = (item.severity || 'information').toUpperCase();
  const source = item.source || 'system';
  const message = item.message || 'No detail provided.';
  return `<div class="review-history-item"><span>${title}</span><strong>${severity}</strong><small>${source} - ${message}</small></div>`;
}

function renderProposalQueue(queueResponse, reviewsResponse) {
  latestProposalQueue = queueResponse;
  latestProposalReviews = reviewsResponse;
  const items = Array.isArray(queueResponse?.items) ? queueResponse.items : [];
  const pendingItems = items.filter((item) => item.status === 'PENDING');
  const reviews = Array.isArray(reviewsResponse?.items) ? reviewsResponse.items : [];
  if (!selectedProposalId || !items.some((item) => item.proposal_id === selectedProposalId)) {
    selectedProposalId = pendingItems[0]?.proposal_id || items[0]?.proposal_id || null;
  }
  const selectedProposal = items.find((item) => item.proposal_id === selectedProposalId) || null;
  const latestReview = selectedProposal ? reviews.find((item) => item.proposal_id === selectedProposal.proposal_id && item.status !== 'CREATED') : null;
  const recentDecisions = reviews.filter((item) => item.status !== 'CREATED');
  elements.approvalBadge.textContent = `${pendingItems.length} pending`;
  elements.approvalBadge.className = `badge ${pendingItems.length > 0 ? 'is-degraded' : 'is-ready'}`;
  elements.proposalHistoryBadge.textContent = `${recentDecisions.length} items`;
  elements.proposalHistoryBadge.className = 'badge section-badge';
  elements.proposalQueueList.innerHTML = items.length
    ? items.slice(0, 6).map((item) => `
      <button class="proposal-queue-item${item.proposal_id === selectedProposalId ? ' is-selected' : ''}" type="button" data-proposal-id="${item.proposal_id}">
        <span>${item.instrument?.symbol || item.proposal_id}</span>
        <strong>${item.status}</strong>
      </button>
    `).join('')
    : '<p class="proposal-empty">No proposals available for review.</p>';
  elements.proposalQueueList.querySelectorAll('[data-proposal-id]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedProposalId = button.dataset.proposalId;
      renderProposalQueue(latestProposalQueue, latestProposalReviews);
    });
  });
  elements.proposalHistoryList.innerHTML = recentDecisions.length
    ? recentDecisions.slice(0, 6).map((item) => reviewHistoryRow(item)).join('')
    : '<p class="proposal-empty">No review decisions recorded yet.</p>';
  const reviewDisabled = !selectedProposal || selectedProposal.status !== 'PENDING' || !authToken || !hasPermission('proposal.review');
  elements.proposalApproveButton.disabled = reviewDisabled;
  elements.proposalHoldButton.disabled = reviewDisabled;
  elements.proposalRejectButton.disabled = reviewDisabled;
  const reviewTitle = !authToken
    ? 'Sign in to review proposals.'
    : (!hasPermission('proposal.review') ? 'Missing permission: proposal.review' : 'Ready');
  elements.proposalApproveButton.title = reviewTitle;
  elements.proposalHoldButton.title = reviewTitle;
  elements.proposalRejectButton.title = reviewTitle;
  if (!selectedProposal) {
    elements.proposalReviewState.textContent = 'No proposal selected.';
    return;
  }
  const summaryParts = [
    `${selectedProposal.instrument?.symbol || selectedProposal.proposal_id}`,
    `strategy ${selectedProposal.strategy_id || 'unknown'}`,
    `status ${selectedProposal.status}`,
  ];
  if (latestReview) {
    summaryParts.push(`latest review ${latestReview.status.toLowerCase()} by ${latestReview.reviewer || 'system'}`);
  }
  elements.proposalReviewState.textContent = summaryParts.join(' - ');
}

function reviewHistoryRow(item) {
  const reason = item.reason ? ` - ${item.reason}` : '';
  return `<div class="review-history-item${item.proposal_id === selectedProposalId ? ' is-selected' : ''}"><span>${item.proposal_id}</span><strong>${item.status}</strong><small>${item.reviewer || 'system'} at ${formatTimestamp(item.occurred_at)}${reason}</small></div>`;
}

function renderControlState(controlState) {
  const killSwitch = controlState?.kill_switch || 'NORMAL';
  elements.killSwitchChip.textContent = killSwitch;
  elements.killSwitchChip.className = `badge ${badgeClass(killSwitch)}`;
  const latestAction = Array.isArray(controlState?.recent_actions) ? controlState.recent_actions[0] : null;
  elements.commandObserved.textContent = latestAction
    ? `Observed control state: ${latestAction.type} by ${latestAction.actor || 'system'} at ${formatTimestamp(latestAction.occurred_at)} (${latestAction.observed || 'observation pending'}).`
    : `Observed control state: kill switch ${killSwitch.toLowerCase()}.`;
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
    connectRealtime();
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
  authStepUp = payload?.step_up === true;
  authPermissions = Array.isArray(payload?.permissions) ? payload.permissions : [];
  localStorage.setItem(authStorageKey, authToken);
  updateAuthSessionUI(payload);
  await refreshDashboard();
  connectRealtime();
}

async function submitAuthStepUp() {
  if (!authToken) {
    elements.authSessionDetail.textContent = 'Sign in before requesting step-up authentication.';
    return;
  }
  const password = elements.authPasswordInput.value;
  if (!password) {
    elements.authSessionDetail.textContent = 'Re-enter your password to complete step-up authentication.';
    return;
  }
  const response = await fetch('/api/auth-service/auth/step-up', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ password }),
  }).catch(() => null);
  const payload = await response?.json().catch(() => null);
  if (!response || !response.ok) {
    elements.authSessionDetail.textContent = payload?.error || 'Step-up failed.';
    return;
  }
  authToken = payload.access_token || authToken;
  authStepUp = payload?.step_up === true;
  authPermissions = Array.isArray(payload?.permissions) ? payload.permissions : authPermissions;
  localStorage.setItem(authStorageKey, authToken);
  elements.authPasswordInput.value = '';
  updateAuthSessionUI(payload);
  connectRealtime();
}

async function submitProposalReview(action) {
  if (!authToken) {
    elements.proposalReviewState.textContent = 'Sign in before reviewing proposals.';
    return;
  }
  if (!selectedProposalId) {
    elements.proposalReviewState.textContent = 'Select a proposal first.';
    return;
  }
  const reason = elements.proposalReasonInput.value.trim();
  if (action === 'reject' && !reason) {
    elements.proposalReviewState.textContent = 'Reject requires a reason.';
    return;
  }
  const response = await fetch(`/api/proposal-service/queue/${encodeURIComponent(selectedProposalId)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ reason }),
  }).catch(() => null);
  const payload = await response?.json().catch(() => null);
  if (!response || !response.ok) {
    if (response?.status === 401) {
      clearAuthSession(false);
      updateAuthSessionUI();
    }
    elements.proposalReviewState.textContent = payload?.error || 'Proposal review failed.';
    return;
  }
  elements.proposalReasonInput.value = '';
  elements.proposalReviewState.textContent = `Proposal ${payload?.proposal_id || selectedProposalId} marked ${payload?.status || action.toUpperCase()}.`;
  await refreshDashboard();
}

function clearAuthSession(rerender = true) {
  authToken = '';
  authStepUp = false;
  authPermissions = [];
  localStorage.removeItem(authStorageKey);
  if (realtimeSocket) {
    realtimeSocket.close();
    realtimeSocket = null;
  }
  setRealtimeState('Realtime locked', 'Sign in to unlock live patches from the realtime gateway.');
  if (rerender) {
    updateAuthSessionUI();
  }
}

function updateAuthSessionUI(payload = null) {
  if (!authToken) {
    elements.authSessionState.textContent = 'locked';
    elements.authSessionDetail.textContent = 'Sign in to unlock protected queries.';
    elements.authPermissionsList.innerHTML = '<p class="proposal-empty">No permissions loaded.</p>';
    elements.authStepUpButton.disabled = true;
    elements.authLogoutButton.disabled = true;
    updateActionAvailability();
    return;
  }
  authStepUp = payload?.step_up === true || authStepUp;
  authPermissions = Array.isArray(payload?.permissions) ? payload.permissions : authPermissions;
  elements.authSessionState.textContent = authStepUp ? 'step-up active' : (payload?.role || 'operator session');
  elements.authSessionDetail.textContent = payload?.subject
    ? `${payload.subject} authenticated.${authStepUp ? ' Step-up enabled for emergency controls.' : ''}`
    : `Stored operator session restored.${authStepUp ? ' Step-up enabled for emergency controls.' : ''}`;
  elements.authPermissionsList.innerHTML = authPermissions.length
    ? authPermissions.slice(0, 6).map((permission) => listRow('permission', permission)).join('')
    : '<p class="proposal-empty">No permissions loaded.</p>';
  elements.authStepUpButton.disabled = false;
  elements.authLogoutButton.disabled = false;
  updateActionAvailability();
}

function updateActionAvailability() {
  document.querySelectorAll('[data-command]').forEach((button) => {
    const command = button.dataset.command;
    const permission = requiredPermissionForCommand[command];
    if (!permission) {
      return;
    }
    if (!authToken) {
      button.disabled = true;
      button.title = 'Sign in to view or run governed actions.';
      return;
    }
    if (!hasPermission(permission)) {
      button.disabled = true;
      button.title = `Missing permission: ${permission}`;
      return;
    }
    button.disabled = false;
    button.title = 'Step-up authentication required before submit.';
  });
}

function hasPermission(permission) {
  return authPermissions.includes(permission);
}

function openCommandDialog(command) {
  commandIntent = command;
  const supported = supportedControlCommands[command];
  elements.commandDialogTitle.textContent = `Confirm ${command}`;
  elements.commandDialogBody.textContent = supported
    ? `Desired state: ${command}. This action is wired to the current control-service intake path and requires step-up authentication. Downstream execution effects can remain delayed or observational.`
    : `Desired state: ${command}. This command is still planned only, so the console will record intent locally without calling a backend endpoint.`;
  elements.commandReasonInput.value = '';
  elements.commandDialog.showModal();
}

async function handleCommandDialogClose() {
  if (elements.commandDialog.returnValue !== 'confirm' || !commandIntent) {
    return;
  }
  const reason = elements.commandReasonInput.value.trim() || 'no reason supplied';
  const supported = supportedControlCommands[commandIntent];
  if (supported) {
    if (!authToken) {
      elements.commandObserved.textContent = 'Sign in before running emergency controls.';
      commandIntent = null;
      return;
    }
    if (!authStepUp) {
      elements.commandObserved.textContent = 'Step-up authentication is required before running emergency controls.';
      commandIntent = null;
      return;
    }
    const response = await fetch(supported.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ reason }),
    }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    if (!response || !response.ok) {
      elements.commandObserved.textContent = payload?.error || 'Emergency control request failed.';
      commandIntent = null;
      return;
    }
    renderControlState(payload?.state);
    elements.commandObserved.textContent = `Observed control state: ${payload?.action?.type || supported.label} accepted into control-service with reason: ${reason}. Downstream execution effect is still observed separately.`;
    commandIntent = null;
    return;
  }
  elements.commandObserved.textContent = `Desired command ${commandIntent} recorded with reason: ${reason}. This action is not wired to a live backend path yet.`;
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

function formatNumber(value) {
  return typeof value === 'number' ? value.toFixed(2) : 'n/a';
}

function formatTimestamp(value) {
  if (!value) {
    return 'unknown time';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'unknown time';
  }
  return parsed.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}
