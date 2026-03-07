const authStorageKey = 'clab-auth-token';
let authToken = localStorage.getItem(authStorageKey) || '';
let authStepUp = false;
let authPermissions = [];
let authSessionProfile = null;
let authSessionNotice = '';
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
    scope: 'account/main and active orders',
    effect: 'Requests cancellation for eligible open orders. Confirm final state from downstream lifecycle events.',
    residualRisk: 'Residual fills, venue lag, or stale projections can leave temporary exposure after approval.',
    approval: 'Step-up required. Audit trail required. Confirm completion from observed state.',
    actionClass: 'danger',
  },
  flatten: {
    endpoint: '/api/control-service/execution/flatten',
    label: 'flatten',
    scope: 'account/main and current exposure',
    effect: 'Requests a governed flatten through the controlled execution path. Desired flat is not truth until exposure converges.',
    residualRisk: 'Residual positions, partial fills, or reconciliation lag can leave exposure after approval.',
    approval: 'Step-up required. Audit trail required. Approval policy may apply.',
    actionClass: 'danger',
  },
  'kill-switch': {
    endpoint: '/api/control-service/risk/kill-switch/arm',
    label: 'kill_switch_arm',
    scope: 'account/main control scope',
    effect: 'Requests a hard risk control on new execution flow and escalates the safety state machine.',
    residualRisk: 'Existing exposure, venue lag, or manual intervention may still require flatten or reconciliation.',
    approval: 'Step-up required. Audit trail required. Dual control may apply downstream.',
    actionClass: 'danger',
  },
  'kill-switch-release': {
    endpoint: '/api/control-service/risk/kill-switch/release',
    label: 'kill_switch_release',
    scope: 'account/main control scope',
    effect: 'Requests release of an active kill switch after incident review or reconciliation.',
    residualRisk: 'Releasing early can reopen unsafe trading if the root cause is unresolved.',
    approval: 'Step-up required. Audit trail required. Approval must confirm incident resolution.',
    actionClass: 'caution',
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
  serviceHealthList: document.getElementById('service-health-list'),
  authSessionState: document.getElementById('auth-session-state'),
  authSessionDetail: document.getElementById('auth-session-detail'),
  authPermissionsList: document.getElementById('auth-permissions-list'),
  authGoogleLoginButton: document.getElementById('auth-google-login-button'),
  authStepUpButton: document.getElementById('auth-step-up-button'),
  authLogoutButton: document.getElementById('auth-logout-button'),
  commandDialog: document.getElementById('command-dialog'),
  commandDialogTitle: document.getElementById('command-dialog-title'),
  commandDialogBody: document.getElementById('command-dialog-body'),
  commandScopeText: document.getElementById('command-scope-text'),
  commandEffectText: document.getElementById('command-effect-text'),
  commandRiskText: document.getElementById('command-risk-text'),
  commandApprovalText: document.getElementById('command-approval-text'),
  commandReasonInput: document.getElementById('command-reason-input'),
  commandConfirmButton: document.getElementById('command-confirm-button'),
  commandConsoleBadge: document.getElementById('command-console-badge'),
};

document.querySelectorAll('[data-command]').forEach((button) => {
  button.addEventListener('click', () => openCommandDialog(button.dataset.command));
});
elements.authGoogleLoginButton.addEventListener('click', startGoogleLogin);
elements.authStepUpButton.addEventListener('click', startGoogleStepUp);
elements.authLogoutButton.addEventListener('click', clearAuthSession);
elements.commandDialog.addEventListener('close', handleCommandDialogClose);
elements.proposalApproveButton.addEventListener('click', () => submitProposalReview('approve'));
elements.proposalHoldButton.addEventListener('click', () => submitProposalReview('hold'));
elements.proposalRejectButton.addEventListener('click', () => submitProposalReview('reject'));

bootstrap();

async function bootstrap() {
  await handleOAuthRedirect();
  await hydrateAuthSession();
  updateAuthSessionUI();
  await refreshDashboard();
  connectRealtime();
  window.setInterval(refreshDashboard, 15000);
}

async function handleOAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');
  const errorDescription = params.get('error_description');
  const isStepUp = localStorage.getItem('clab-step-up-pending') === 'true';
  if (!code && !error) {
    return;
  }
  window.history.replaceState({}, document.title, window.location.pathname);
  localStorage.removeItem('clab-step-up-pending');
  if (error) {
    authSessionNotice = formatOAuthRedirectError(error, errorDescription, isStepUp);
    return;
  }
  if (isStepUp && authToken) {
    const response = await fetch('/api/auth-service/auth/google/step-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ code, state: state || '' }),
    }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    if (!response || !response.ok) {
      elements.authSessionDetail.textContent = payload?.error || 'Google step-up failed.';
      return;
    }
    authToken = payload.access_token || authToken;
    authStepUp = payload?.step_up === true;
    authPermissions = Array.isArray(payload?.permissions) ? payload.permissions : authPermissions;
    authSessionProfile = payload;
    authSessionNotice = '';
    localStorage.setItem(authStorageKey, authToken);
    updateAuthSessionUI(payload);
    connectRealtime();
    return;
  }
  const response = await fetch('/api/auth-service/auth/google/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, state: state || '' }),
  }).catch(() => null);
  const payload = await response?.json().catch(() => null);
  if (!response || !response.ok) {
    elements.authSessionDetail.textContent = payload?.error || 'Google sign-in failed.';
    return;
  }
  authToken = payload.access_token || '';
  authStepUp = payload?.step_up === true;
  authPermissions = Array.isArray(payload?.permissions) ? payload.permissions : [];
  authSessionProfile = payload;
  authSessionNotice = '';
  localStorage.setItem(authStorageKey, authToken);
  updateAuthSessionUI(payload);
  connectRealtime();
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
  authSessionProfile = payload;
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
    setRealtimeState('Realtime locked', 'Sign in to view live patches.');
    return;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  realtimeSocket = new WebSocket(`${protocol}//${window.location.host}/api/realtime-gateway/ws?token=${encodeURIComponent(authToken)}&account_id=main`);
  realtimeSocket.addEventListener('open', () => setRealtimeState('Realtime connected', 'Live patches are streaming in.'));
  realtimeSocket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    applyRealtimePayload(payload.channels || {});
  });
  realtimeSocket.addEventListener('close', () => {
    if (!authToken) {
      setRealtimeState('Realtime locked', 'Sign in to view live patches.');
      return;
    }
    setRealtimeState('Realtime disconnected', 'Showing the last snapshot as stale.');
  });
  realtimeSocket.addEventListener('error', () => setRealtimeState('Realtime error', 'Realtime is unavailable. Showing query snapshots only.'));
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
  const loaded = hasResponse(response);
  const data = response?.data || {};
  const meta = response?.meta || {};
  const balances = Array.isArray(data.balances) ? data.balances : [];
  const positions = Array.isArray(data.positions) ? data.positions : [];
  const healthState = loaded ? (data.state_health || 'Unknown') : 'Unknown';
  const primaryBalance = balances[0] || null;
  const killSwitch = loaded ? (data.kill_switch || 'Unknown') : 'Unknown';
  elements.accountHealthBadge.textContent = healthState;
  elements.accountHealthBadge.className = `badge ${badgeClass(healthState)}`;
  elements.accountHealthList.innerHTML = [
    listRow('Scope', loaded ? (data.account_id || 'main') : 'Unknown'),
    listRow('Source', loaded ? 'query projection + realtime overlay' : 'Unknown'),
    listRow('Freshness', loaded ? freshnessLabel(meta.freshness_ms) : 'Unknown'),
    listRow('Snapshot', loaded ? String(meta.snapshot_version || '--') : 'Unknown'),
    listRow('Balance', primaryBalance ? `${primaryBalance.asset || 'asset'} ${formatValue(primaryBalance.available_balance)}` : (loaded ? 'No reported balance' : 'Unknown')),
    listRow('Positions', loaded ? `${positions.length} live slots` : 'Unknown'),
  ].join('');
  elements.freshnessChip.textContent = loaded ? freshnessLabel(meta.freshness_ms) : 'Unknown';
  elements.killSwitchChip.textContent = killSwitch;
  elements.killSwitchChip.className = `badge ${badgeClass(killSwitch)}`;
}

function renderStrategies(response) {
  const loaded = hasResponse(response);
  const items = Array.isArray(response?.data) ? response.data : [];
  elements.strategyRuntimeBadge.textContent = loaded ? `${items.length} strategies` : 'Unknown';
  elements.strategyRuntimeBadge.className = `badge ${loaded ? 'section-badge' : 'is-muted'}`;
  elements.strategyRuntimeList.innerHTML = items.length
    ? items.slice(0, 4).map((item) => listRow(item.strategy_id, `${safeText(item.desired_state, 'desired ?')} / ${safeText(item.accepted_state || item.decision, 'accepted ?')} / ${safeText(item.observed_state, 'observed ?')}`)).join('')
    : `<p class="proposal-empty">${loaded ? 'No projected strategy runtime view yet.' : 'Strategy runtime is unknown until the first projection arrives.'}</p>`;
  elements.signalsTabCopy.textContent = items.length ? `${items[0].strategy_id} is desired ${safeText(items[0].desired_state, 'Unknown')}, accepted ${safeText(items[0].accepted_state || items[0].decision, 'Unknown')}, observed ${safeText(items[0].observed_state, 'Unknown')}.` : (loaded ? 'No projected strategy runtime view yet.' : 'Strategy runtime is unknown.');
  elements.strategyTabCopy.textContent = items.length ? `Promotion gate is currently serving ${items.length} strategy decisions.` : (loaded ? 'Promotion gate history will appear after evaluation runs.' : 'Promotion gate state is unknown.');
}

function renderOrders(response) {
  const loaded = hasResponse(response);
  const items = Array.isArray(response?.data) ? response.data : [];
  latestOrders = items;
  elements.ordersBadge.textContent = loaded ? `${items.length} rows` : 'Unknown';
  elements.ordersBadge.className = `badge ${loaded ? 'section-badge' : 'is-muted'}`;
  elements.ordersTableBody.innerHTML = items.length
    ? items.slice(0, 8).map((item, index) => `<tr data-order-index="${index}"><td>${escapeHtml(item.internal_order_id || '')}</td><td>${escapeHtml(item.source?.signal_id || 'n/a')}</td><td>${escapeHtml(item.terminal_state || 'open')}</td><td>${escapeHtml(item.pending_state || 'none')}</td></tr>`).join('')
    : `<tr><td colspan="4">${loaded ? 'No order lineage available.' : 'Order lifecycle state is unknown until the first projection arrives.'}</td></tr>`;
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
  elements.orderDetailBadge.textContent = item.pending_state || item.terminal_state || 'Pending';
  elements.orderDetailBadge.className = `badge ${badgeClass(item.pending_state || item.terminal_state)}`;
  elements.orderDetailTimeline.textContent = [item.pending_state, item.terminal_state].filter(Boolean).join(' -> ') || 'No timeline available';
  elements.orderDetailExecution.textContent = item.exchange_order_id || 'Waiting for execution ack';
  elements.orderDetailPortfolio.textContent = item.fills?.length ? `${item.fills.length} fills linked` : 'No portfolio truth linked yet';
  elements.orderDetailRecon.textContent = item.pending_state === 'ReconciliationRequired' ? 'Reconciliation required' : 'No explicit reconciliation hold';
}

function renderPositions(response) {
  const loaded = hasResponse(response);
  const items = Array.isArray(response?.data) ? response.data : [];
  elements.positionsBadge.textContent = loaded ? `${items.length} positions` : 'Unknown';
  elements.positionsBadge.className = `badge ${loaded ? 'section-badge' : 'is-muted'}`;
  elements.positionsTableBody.innerHTML = items.length
    ? items.slice(0, 8).map((item) => `<tr><td>${item.symbol}</td><td>${formatValue(item.qty)}</td><td>${formatSignedValue(item.unrealized_pnl)}</td><td>${safeText(item.position_side, 'Unknown')}</td></tr>`).join('')
    : `<tr><td colspan="4">${loaded ? 'No positions to display.' : 'Position risk is unknown until the first projection arrives.'}</td></tr>`;
  elements.contextActionsList.innerHTML = items.length
    ? items.slice(0, 3).map((item) => listRow(item.symbol, `${safeText(item.position_side, 'Unknown')} / entry ${formatValue(item.entry_price)} / mark ${formatValue(item.mark_price)}`)).join('')
    : `<p class="proposal-empty">${loaded ? 'No live positions to supervise.' : 'Position risk state is unknown.'}</p>`;
  elements.riskBadgeBar.innerHTML = [
    riskPill('Gross exposure', loaded ? (items.length ? 'active' : 'flat') : 'Unknown', loaded ? (items.length ? 'warn' : 'ok') : 'muted'),
    riskPill('Market-data freshness', loaded ? 'projection based' : 'Unknown', loaded ? 'info' : 'muted'),
    riskPill('Kill switch posture', elements.killSwitchChip.textContent || 'Unknown', badgeTone(elements.killSwitchChip.textContent)),
  ].join('');
  elements.riskBadge.textContent = loaded ? (items.length ? 'watch' : 'clear') : 'Unknown';
  elements.riskBadge.className = `badge ${loaded ? (items.length ? 'is-degraded' : 'is-ready') : 'is-muted'}`;
  elements.contextBadge.textContent = loaded ? (items.length ? 'observed live' : 'clear') : 'Unknown';
}

function renderReconciliation(response) {
  const data = response?.data || {};
  const loaded = hasResponse(response);
  elements.reconTabCopy.textContent = loaded ? `Canonical state is ${safeText(data.state_health, 'Unknown')} and completeness is ${safeText(data.completeness, 'Unknown')}.` : 'Reconciliation state is unknown until the first projection arrives.';
}

function renderServices(response) {
  const data = response?.data || {};
  const entries = Object.entries(data);
  elements.serviceHealthList.innerHTML = entries.length
    ? entries.slice(0, 3).map(([name, value]) => listRow(`service ${name}`, String(value))).join('')
    : '<p class="proposal-empty">Service-health projection has not loaded yet.</p>';
}

function renderIncidents(response) {
  const loaded = hasResponse(response);
  const items = Array.isArray(response?.items) ? response.items : (Array.isArray(response?.data) ? response.data : []);
  elements.incidentBadge.textContent = loaded ? `${items.length} open` : 'Unknown';
  elements.incidentBadge.className = `badge ${loaded ? (items.length > 0 ? 'is-degraded' : 'section-badge') : 'is-muted'}`;
  elements.incidentList.innerHTML = items.length
    ? items.slice(0, 6).map((item) => incidentRow(item)).join('')
    : `<p class="proposal-empty">${loaded ? 'No active incidents or alerts.' : 'Incident state is unknown until the first alert projection arrives.'}</p>`;
}

function incidentRow(item) {
  const title = item.title || item.code || 'Incident';
  const severity = (item.severity || 'information').toUpperCase();
  const source = item.source || 'system';
  const message = item.message || 'No details available.';
  return `<div class="review-history-item"><span>${escapeHtml(title)}</span><strong>${escapeHtml(severity)}</strong><small>${escapeHtml(source)} - ${escapeHtml(message)}</small></div>`;
}

function renderProposalQueue(queueResponse, reviewsResponse) {
  latestProposalQueue = queueResponse;
  latestProposalReviews = reviewsResponse;
  const queueLoaded = hasResponse(queueResponse);
  const reviewsLoaded = hasResponse(reviewsResponse);
  const items = Array.isArray(queueResponse?.items) ? queueResponse.items : [];
  const pendingItems = items.filter((item) => item.status === 'PENDING');
  const reviews = Array.isArray(reviewsResponse?.items) ? reviewsResponse.items : [];
  if (!selectedProposalId || !items.some((item) => item.proposal_id === selectedProposalId)) {
    selectedProposalId = pendingItems[0]?.proposal_id || items[0]?.proposal_id || null;
  }
  const selectedProposal = items.find((item) => item.proposal_id === selectedProposalId) || null;
  const latestReview = selectedProposal ? reviews.find((item) => item.proposal_id === selectedProposal.proposal_id && item.status !== 'CREATED') : null;
  const recentDecisions = reviews.filter((item) => item.status !== 'CREATED');
  elements.approvalBadge.textContent = queueLoaded ? `${pendingItems.length} pending` : 'Unknown';
  elements.approvalBadge.className = `badge ${queueLoaded ? (pendingItems.length > 0 ? 'is-degraded' : 'is-ready') : 'is-muted'}`;
  elements.proposalHistoryBadge.textContent = reviewsLoaded ? `${recentDecisions.length} decisions` : 'Unknown';
  elements.proposalHistoryBadge.className = `badge ${reviewsLoaded ? 'section-badge' : 'is-muted'}`;
  elements.proposalQueueList.innerHTML = items.length
    ? items.slice(0, 6).map((item) => `
      <button class="proposal-queue-item${item.proposal_id === selectedProposalId ? ' is-selected' : ''}" type="button" data-proposal-id="${escapeAttr(item.proposal_id)}">
        <span>${escapeHtml(item.instrument?.symbol || item.proposal_id)}</span>
        <strong>${escapeHtml(item.status || '')}</strong>
      </button>
    `).join('')
    : '<p class="proposal-empty">No proposals to review.</p>';
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
    : (!hasPermission('proposal.review') ? 'Missing permission: proposal.review' : 'Ready to review');
  elements.proposalApproveButton.title = reviewTitle;
  elements.proposalHoldButton.title = reviewTitle;
  elements.proposalRejectButton.title = reviewTitle;
  if (!selectedProposal) {
    elements.proposalReviewState.textContent = 'No proposal selected.';
    return;
  }
  const summaryParts = [
    `${selectedProposal.instrument?.symbol || selectedProposal.proposal_id}`,
    `strategy ${selectedProposal.strategy_id || 'Unknown'}`,
    `status ${selectedProposal.status}`,
  ];
  if (latestReview) {
    summaryParts.push(`last review ${latestReview.status.toLowerCase()} / ${latestReview.reviewer || 'system'}`);
  }
  elements.proposalReviewState.textContent = summaryParts.join(' - ');
}

function reviewHistoryRow(item) {
  const reason = item.reason ? ` - ${item.reason}` : '';
  return `<div class="review-history-item${item.proposal_id === selectedProposalId ? ' is-selected' : ''}"><span>${escapeHtml(item.proposal_id || '')}</span><strong>${escapeHtml(item.status || '')}</strong><small>${escapeHtml(item.reviewer || 'system')} / ${escapeHtml(formatTimestamp(item.occurred_at))}${escapeHtml(reason)}</small></div>`;
}

function renderControlState(controlState) {
  const killSwitch = controlState?.kill_switch || 'NORMAL';
  elements.killSwitchChip.textContent = killSwitch;
  elements.killSwitchChip.className = `badge ${badgeClass(killSwitch)}`;
  const latestAction = Array.isArray(controlState?.recent_actions) ? controlState.recent_actions[0] : null;
  elements.contextActionsList.innerHTML = [
    listRow('Desired', latestAction?.desired || latestAction?.type || 'No request'),
    listRow('Accepted', latestAction ? formatTimestamp(latestAction.occurred_at) : 'No accepted state yet'),
    listRow('Observed', latestAction?.observed || 'Waiting for observed state'),
    listRow('Kill switch', killSwitch),
  ].join('');
  elements.commandObserved.textContent = latestAction
    ? `Observed control state: ${latestAction.type} / ${latestAction.actor || 'system'} / ${formatTimestamp(latestAction.occurred_at)} / ${latestAction.observed || 'Waiting for observed state'}`
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

async function startGoogleLogin() {
  const response = await fetch('/api/auth-service/auth/google/url').catch(() => null);
  const payload = await response?.json().catch(() => null);
  if (!response || !response.ok || !payload?.url) {
    elements.authSessionDetail.textContent = payload?.error || 'Could not start Google sign-in.';
    return;
  }
  window.location.href = payload.url;
}

async function startGoogleStepUp() {
  if (!authToken) {
    elements.authSessionDetail.textContent = 'Sign in before requesting step-up.';
    return;
  }
  const response = await fetch('/api/auth-service/auth/google/url').catch(() => null);
  const payload = await response?.json().catch(() => null);
  if (!response || !response.ok || !payload?.url) {
    elements.authSessionDetail.textContent = payload?.error || 'Could not start Google step-up.';
    return;
  }
  localStorage.setItem('clab-step-up-pending', 'true');
  window.location.href = payload.url;
}

async function submitProposalReview(action) {
  if (!authToken) {
    elements.proposalReviewState.textContent = 'Sign in to review proposals.';
    return;
  }
  if (!selectedProposalId) {
    elements.proposalReviewState.textContent = 'Select a proposal first.';
    return;
  }
  const reason = elements.proposalReasonInput.value.trim();
  if (action === 'reject' && !reason) {
    elements.proposalReviewState.textContent = 'A reason is required for reject.';
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
  elements.proposalReviewState.textContent = `Proposal ${payload?.proposal_id || selectedProposalId} recorded as ${payload?.status || action.toUpperCase()}.`;
  await refreshDashboard();
}

function clearAuthSession(rerender = true) {
  authToken = '';
  authStepUp = false;
  authPermissions = [];
  authSessionProfile = null;
  authSessionNotice = '';
  localStorage.removeItem(authStorageKey);
  if (realtimeSocket) {
    realtimeSocket.close();
    realtimeSocket = null;
  }
  setRealtimeState('Realtime locked', 'Sign in to view live patches.');
  if (rerender) {
    updateAuthSessionUI();
  }
}

function updateAuthSessionUI(payload = null) {
  const sessionPayload = payload || authSessionProfile || {};
  if (!authToken) {
    elements.authSessionState.textContent = 'Locked';
    elements.authSessionDetail.textContent = authSessionNotice || 'Sign in with Google to unlock protected views.';
    elements.authPermissionsList.innerHTML = '<p class="proposal-empty">No permissions loaded.</p>';
    elements.authGoogleLoginButton.style.display = '';
    elements.authStepUpButton.disabled = true;
    elements.authStepUpButton.style.display = 'none';
    elements.authLogoutButton.disabled = true;
    elements.authLogoutButton.style.display = 'none';
    updateActionAvailability();
    return;
  }
  elements.authGoogleLoginButton.style.display = 'none';
  elements.authStepUpButton.style.display = '';
  elements.authLogoutButton.style.display = '';
  authStepUp = payload?.step_up === true || authStepUp;
  authPermissions = Array.isArray(payload?.permissions) ? payload.permissions : authPermissions;
  elements.authSessionState.textContent = authStepUp ? 'Step-up active' : (sessionPayload.role || 'Signed in');
  elements.authSessionDetail.textContent = [formatAuthSessionDetail(sessionPayload, !payload), authSessionNotice].filter(Boolean).join(' ');
  elements.authPermissionsList.innerHTML = authPermissions.length
    ? authPermissions.slice(0, 6).map((permission) => listRow('Permission', permission)).join('')
    : '<p class="proposal-empty">No permissions loaded.</p>';
  elements.authStepUpButton.disabled = false;
  elements.authLogoutButton.disabled = false;
  updateActionAvailability();
}

function formatOAuthRedirectError(error, description, isStepUp) {
  if (description) {
    return description;
  }
  if (error === 'access_denied') {
    return isStepUp ? 'Google step-up was canceled.' : 'Google sign-in was canceled.';
  }
  return isStepUp ? 'Google step-up did not complete.' : 'Google sign-in did not complete.';
}

function formatAuthSessionDetail(sessionPayload, restored) {
  const identity = [sessionPayload?.subject, sessionPayload?.role].filter(Boolean).join(' - ');
  const parts = [];

  if (restored) {
    parts.push(identity ? `Restored ${identity}.` : 'Session restored.');
  } else {
    parts.push(identity ? `Signed in as ${identity}.` : 'Signed in.');
  }

  if (authStepUp) {
    parts.push('Step-up active.');
  }

  return parts.join(' ');
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
      button.title = 'Sign in to use governed actions.';
      return;
    }
    if (!hasPermission(permission)) {
      button.disabled = true;
      button.title = `Missing permission: ${permission}`;
      return;
    }
    button.disabled = false;
    button.title = 'Step-up is required before submit.';
  });
  elements.commandConsoleBadge.textContent = authToken ? (authStepUp ? 'Step-up active' : 'Ready') : 'Sign-in required';
  elements.commandConsoleBadge.className = `badge action-badge ${authToken ? (authStepUp ? 'is-ready' : 'is-info') : 'is-muted'}`;
}

function hasPermission(permission) {
  return authPermissions.includes(permission);
}

function openCommandDialog(command) {
  commandIntent = command;
  const supported = supportedControlCommands[command];
  elements.commandDialogTitle.textContent = `Confirm ${command}`;
  elements.commandDialogBody.textContent = supported
    ? `Desired state: ${command}. This action uses the live control-service intake path and requires step-up. Confirm final effect from downstream observed state.`
    : `Desired state: ${command}. This command is still planned and only records intent.`;
  elements.commandScopeText.textContent = supported?.scope || 'No planned scope defined.';
  elements.commandEffectText.textContent = supported?.effect || 'Planned command only.';
  elements.commandRiskText.textContent = supported?.residualRisk || 'No live backend path yet.';
  elements.commandApprovalText.textContent = supported?.approval || 'No live backend path yet.';
  elements.commandConfirmButton.className = supported?.actionClass === 'danger' ? 'dialog-danger' : 'dialog-caution';
  elements.commandConfirmButton.textContent = supported ? 'Submit request' : 'Record intent';
  elements.commandReasonInput.value = '';
  elements.commandDialog.showModal();
}

async function handleCommandDialogClose() {
  if (elements.commandDialog.returnValue !== 'confirm' || !commandIntent) {
    return;
  }
  const reason = elements.commandReasonInput.value.trim() || 'No reason provided';
  const supported = supportedControlCommands[commandIntent];
  if (supported) {
    if (!elements.commandReasonInput.value.trim()) {
      elements.commandObserved.textContent = 'A reason is required for high-risk governed actions.';
      commandIntent = null;
      return;
    }
    if (!authToken) {
      elements.commandObserved.textContent = 'Sign in before sending this action.';
      commandIntent = null;
      return;
    }
    if (!authStepUp) {
      elements.commandObserved.textContent = 'Step-up is required before sending this action.';
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
      if (response?.status === 401) {
        clearAuthSession(false);
        updateAuthSessionUI();
        connectRealtime();
      }
      elements.commandObserved.textContent = payload?.error || 'Control request failed.';
      commandIntent = null;
      return;
    }
    renderControlState(payload?.state);
    elements.commandObserved.textContent = `Observed control state: ${payload?.action?.type || supported.label} accepted by control-service. Reason: ${reason}. Confirm final effect downstream.`;
    commandIntent = null;
    return;
  }
  elements.commandObserved.textContent = `Desired command ${commandIntent} recorded. Reason: ${reason}. No live backend path yet.`;
  commandIntent = null;
}

function listRow(label, value) {
  return `<div class="list-row"><span>${escapeHtml(String(label))}</span><strong>${escapeHtml(String(value))}</strong></div>`;
}

function riskPill(label, value) {
  return `<div class="risk-pill"><span>${escapeHtml(String(label))}</span><strong>${escapeHtml(String(value))}</strong></div>`;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(String(value)));
  return div.innerHTML;
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function badgeClass(state) {
  const normalized = String(state || '').toUpperCase();
  if (normalized === 'SYNCED' || normalized === 'CLEAR' || normalized === 'NORMAL' || normalized === 'HEALTHY' || normalized === 'OK') {
    return 'is-ready';
  }
  if (normalized === 'UNKNOWN' || normalized === '') {
    return 'is-muted';
  }
  if (normalized.includes('INFO') || normalized.includes('REVIEW') || normalized.includes('DRAFT')) {
    return 'is-info';
  }
  if (normalized.includes('DEGRADED') || normalized.includes('PENDING') || normalized.includes('WATCH') || normalized.includes('WARN') || normalized.includes('P2') || normalized.includes('STALE')) {
    return 'is-degraded';
  }
  if (normalized.includes('HALTED') || normalized.includes('FLATTEN') || normalized.includes('REJECT') || normalized.includes('CRITICAL') || normalized.includes('KILL') || normalized.includes('P1') || normalized.includes('BLOCK')) {
    return 'is-blocked';
  }
  return 'section-badge';
}

function formatNumber(value) {
  return typeof value === 'number' ? value.toFixed(2) : 'Unknown';
}

function hasResponse(value) {
  return value !== null && value !== undefined;
}

function safeText(value, fallback) {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function freshnessLabel(value) {
  if (value === null || value === undefined) {
    return 'Unknown';
  }
  return `${value} ms`;
}

function formatValue(value) {
  if (value === null || value === undefined || value === '') {
    return 'Unknown';
  }
  const numeric = Number(value);
  if (!Number.isNaN(numeric)) {
    return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2);
  }
  return String(value);
}

function formatSignedValue(value) {
  if (value === null || value === undefined || value === '') {
    return 'Unknown';
  }
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return String(value);
  }
  return numeric > 0 ? `+${numeric.toFixed(2)}` : numeric.toFixed(2);
}

function badgeTone(state) {
  const className = badgeClass(state);
  if (className === 'is-ready') {
    return 'ok';
  }
  if (className === 'is-degraded') {
    return 'warn';
  }
  if (className === 'is-blocked') {
    return 'critical';
  }
  if (className === 'is-info') {
    return 'info';
  }
  return 'muted';
}

function formatTimestamp(value) {
  if (!value) {
    return 'No timestamp';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'No timestamp';
  }
  return parsed.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}
