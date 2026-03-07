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
    scope: 'account/main 및 활성 주문 범위',
    effect: '적격한 대기 주문의 취소를 요청합니다. 최종 주문 상태는 downstream lifecycle event로 확인해야 합니다.',
    residualRisk: '체결 잔여분, venue 지연, stale projection 때문에 승인 후에도 일시적인 노출이 남을 수 있습니다.',
    approval: 'step-up 필수, 감사 기록 필수, 취소 완료는 observed state로 확인',
    actionClass: 'danger',
  },
  flatten: {
    endpoint: '/api/control-service/execution/flatten',
    label: 'flatten',
    scope: 'account/main 및 현재 노출 범위',
    effect: 'governed execution path를 통해 통제된 flatten을 요청합니다. 노출이 수렴하기 전까지 desired flat은 truth가 아닙니다.',
    residualRisk: '잔여 포지션, 부분 체결, reconciliation 지연으로 인해 승인 후에도 노출이 남을 수 있습니다.',
    approval: 'step-up 필수, 감사 기록 필수, 정책에 따라 승인 경로 적용 가능',
    actionClass: 'danger',
  },
  'kill-switch': {
    endpoint: '/api/control-service/risk/kill-switch/arm',
    label: 'kill_switch_arm',
    scope: 'account/main 제어 범위',
    effect: '신규 실행 흐름에 hard risk control을 요청하고 safety state machine을 상향 전환합니다.',
    residualRisk: '기존 노출, venue 지연, 수동 개입에 따라 추가 flatten 또는 reconciliation이 필요할 수 있습니다.',
    approval: 'step-up 필수, 감사 기록 필수, downstream에서 dual control 적용 가능',
    actionClass: 'danger',
  },
  'kill-switch-release': {
    endpoint: '/api/control-service/risk/kill-switch/release',
    label: 'kill_switch_release',
    scope: 'account/main 제어 범위',
    effect: '인시던트 검토 또는 reconciliation 이후 활성 kill switch 상태의 해제를 요청합니다.',
    residualRisk: '근본 원인이 해소되지 않은 상태에서 조기 해제하면 unsafe trading이 다시 열릴 수 있습니다.',
    approval: 'step-up 필수, 감사 기록 필수, 승인 경로에서 incident 해소를 확인해야 합니다',
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
  if (!code) {
    return;
  }
  window.history.replaceState({}, document.title, window.location.pathname);
  const isStepUp = localStorage.getItem('clab-step-up-pending') === 'true';
  localStorage.removeItem('clab-step-up-pending');
  if (isStepUp && authToken) {
    const response = await fetch('/api/auth-service/auth/google/step-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ code, state: state || '' }),
    }).catch(() => null);
    const payload = await response?.json().catch(() => null);
    if (!response || !response.ok) {
      elements.authSessionDetail.textContent = payload?.error || 'Google step-up 인증에 실패했습니다.';
      return;
    }
    authToken = payload.access_token || authToken;
    authStepUp = payload?.step_up === true;
    authPermissions = Array.isArray(payload?.permissions) ? payload.permissions : authPermissions;
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
    elements.authSessionDetail.textContent = payload?.error || 'Google 로그인에 실패했습니다.';
    return;
  }
  authToken = payload.access_token || '';
  authStepUp = payload?.step_up === true;
  authPermissions = Array.isArray(payload?.permissions) ? payload.permissions : [];
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
    setRealtimeState('Realtime 잠금', 'realtime gateway의 live patch를 보려면 로그인해야 합니다.');
    return;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  realtimeSocket = new WebSocket(`${protocol}//${window.location.host}/api/realtime-gateway/ws?token=${encodeURIComponent(authToken)}&account_id=main`);
  realtimeSocket.addEventListener('open', () => setRealtimeState('Realtime 연결됨', 'realtime gateway에서 live patch가 유입되고 있습니다.'));
  realtimeSocket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    applyRealtimePayload(payload.channels || {});
  });
  realtimeSocket.addEventListener('close', () => {
    if (!authToken) {
      setRealtimeState('Realtime 잠금', 'realtime gateway의 live patch를 보려면 로그인해야 합니다.');
      return;
    }
    setRealtimeState('Realtime 연결 끊김', '대시보드는 마지막 정상 snapshot을 stale 표기와 함께 보여주고 있습니다.');
  });
  realtimeSocket.addEventListener('error', () => setRealtimeState('Realtime 오류', 'realtime gateway를 사용할 수 없어 query snapshot만 표시됩니다.'));
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
  const healthState = loaded ? (data.state_health || '알 수 없음') : '알 수 없음';
  const primaryBalance = balances[0] || null;
  const killSwitch = loaded ? (data.kill_switch || '알 수 없음') : '알 수 없음';
  elements.accountHealthBadge.textContent = healthState;
  elements.accountHealthBadge.className = `badge ${badgeClass(healthState)}`;
  elements.accountHealthList.innerHTML = [
    listRow('범위', loaded ? (data.account_id || 'main') : '알 수 없음'),
    listRow('소스', loaded ? 'query projection + realtime overlay' : '알 수 없음'),
    listRow('freshness', loaded ? freshnessLabel(meta.freshness_ms) : '알 수 없음'),
    listRow('snapshot', loaded ? String(meta.snapshot_version || '--') : '알 수 없음'),
    listRow('잔고', primaryBalance ? `${primaryBalance.asset || 'asset'} ${formatValue(primaryBalance.available_balance)}` : (loaded ? '보고된 값 없음' : '알 수 없음')),
    listRow('포지션', loaded ? `${positions.length}개 라이브 슬롯` : '알 수 없음'),
  ].join('');
  elements.freshnessChip.textContent = loaded ? freshnessLabel(meta.freshness_ms) : '알 수 없음';
  elements.killSwitchChip.textContent = killSwitch;
  elements.killSwitchChip.className = `badge ${badgeClass(killSwitch)}`;
}

function renderStrategies(response) {
  const loaded = hasResponse(response);
  const items = Array.isArray(response?.data) ? response.data : [];
  elements.strategyRuntimeBadge.textContent = loaded ? `${items.length}개 전략` : '알 수 없음';
  elements.strategyRuntimeBadge.className = `badge ${loaded ? 'section-badge' : 'is-muted'}`;
  elements.strategyRuntimeList.innerHTML = items.length
    ? items.slice(0, 4).map((item) => listRow(item.strategy_id, `${safeText(item.desired_state, 'desired ?')} / ${safeText(item.accepted_state || item.decision, 'accepted ?')} / ${safeText(item.observed_state, 'observed ?')}`)).join('')
    : `<p class="proposal-empty">${loaded ? '아직 projection된 전략 runtime view가 없습니다.' : '첫 projection 전까지 전략 runtime 상태를 알 수 없습니다.'}</p>`;
  elements.signalsTabCopy.textContent = items.length ? `${items[0].strategy_id} 전략은 desired ${safeText(items[0].desired_state, '알 수 없음')}, accepted ${safeText(items[0].accepted_state || items[0].decision, '알 수 없음')}, observed ${safeText(items[0].observed_state, '알 수 없음')} 상태입니다.` : (loaded ? '아직 projection된 전략 runtime view가 없습니다.' : '전략 runtime 상태를 알 수 없습니다.');
  elements.strategyTabCopy.textContent = items.length ? `promotion gate에서 ${items.length}개 전략 결정을 제공하고 있습니다.` : (loaded ? '평가가 실행되면 promotion gate 이력이 표시됩니다.' : 'promotion gate 상태를 알 수 없습니다.');
}

function renderOrders(response) {
  const loaded = hasResponse(response);
  const items = Array.isArray(response?.data) ? response.data : [];
  latestOrders = items;
  elements.ordersBadge.textContent = loaded ? `${items.length}건` : '알 수 없음';
  elements.ordersBadge.className = `badge ${loaded ? 'section-badge' : 'is-muted'}`;
  elements.ordersTableBody.innerHTML = items.length
    ? items.slice(0, 8).map((item, index) => `<tr data-order-index="${index}"><td>${item.internal_order_id}</td><td>${item.source?.signal_id || 'n/a'}</td><td>${item.terminal_state || 'open'}</td><td>${item.pending_state || 'none'}</td></tr>`).join('')
    : `<tr><td colspan="4">${loaded ? '표시할 주문 lineage가 없습니다.' : '첫 projection 전까지 주문 lifecycle 상태를 알 수 없습니다.'}</td></tr>`;
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
  elements.orderDetailBadge.textContent = item.pending_state || item.terminal_state || '대기';
  elements.orderDetailBadge.className = `badge ${badgeClass(item.pending_state || item.terminal_state)}`;
  elements.orderDetailTimeline.textContent = [item.pending_state, item.terminal_state].filter(Boolean).join(' -> ') || '표시할 타임라인이 없습니다';
  elements.orderDetailExecution.textContent = item.exchange_order_id || 'Execution ack 대기 중';
  elements.orderDetailPortfolio.textContent = item.fills?.length ? `${item.fills.length}건 fill 연결됨` : 'Portfolio truth가 아직 연결되지 않았습니다';
  elements.orderDetailRecon.textContent = item.pending_state === 'ReconciliationRequired' ? 'Reconciliation 필요' : '명시적 reconciliation hold 없음';
}

function renderPositions(response) {
  const loaded = hasResponse(response);
  const items = Array.isArray(response?.data) ? response.data : [];
  elements.positionsBadge.textContent = loaded ? `${items.length}개 포지션` : '알 수 없음';
  elements.positionsBadge.className = `badge ${loaded ? 'section-badge' : 'is-muted'}`;
  elements.positionsTableBody.innerHTML = items.length
    ? items.slice(0, 8).map((item) => `<tr><td>${item.symbol}</td><td>${formatValue(item.qty)}</td><td>${formatSignedValue(item.unrealized_pnl)}</td><td>${safeText(item.position_side, '알 수 없음')}</td></tr>`).join('')
    : `<tr><td colspan="4">${loaded ? '표시할 포지션이 없습니다.' : '첫 projection 전까지 포지션 리스크를 알 수 없습니다.'}</td></tr>`;
  elements.contextActionsList.innerHTML = items.length
    ? items.slice(0, 3).map((item) => listRow(item.symbol, `${safeText(item.position_side, '알 수 없음')} / entry ${formatValue(item.entry_price)} / mark ${formatValue(item.mark_price)}`)).join('')
    : `<p class="proposal-empty">${loaded ? '감독할 실시간 포지션이 없습니다.' : '포지션 리스크 상태를 알 수 없습니다.'}</p>`;
  elements.riskBadgeBar.innerHTML = [
    riskPill('총 노출', loaded ? (items.length ? '활성' : '평탄') : '알 수 없음', loaded ? (items.length ? 'warn' : 'ok') : 'muted'),
    riskPill('마켓 데이터 freshness', loaded ? 'projection 기준' : '알 수 없음', loaded ? 'info' : 'muted'),
    riskPill('Kill switch posture', elements.killSwitchChip.textContent || '알 수 없음', badgeTone(elements.killSwitchChip.textContent)),
  ].join('');
  elements.riskBadge.textContent = loaded ? (items.length ? 'watch' : 'clear') : '알 수 없음';
  elements.riskBadge.className = `badge ${loaded ? (items.length ? 'is-degraded' : 'is-ready') : 'is-muted'}`;
  elements.contextBadge.textContent = loaded ? (items.length ? 'observed live' : 'clear') : '알 수 없음';
}

function renderReconciliation(response) {
  const data = response?.data || {};
  const loaded = hasResponse(response);
  elements.reconTabCopy.textContent = loaded ? `Canonical state는 ${safeText(data.state_health, '알 수 없음')}이며 completeness는 ${safeText(data.completeness, '알 수 없음')}입니다.` : '첫 projection 전까지 reconciliation 상태를 알 수 없습니다.';
}

function renderServices(response) {
  const data = response?.data || {};
  const entries = Object.entries(data);
  elements.serviceHealthList.innerHTML = entries.length
    ? entries.slice(0, 3).map(([name, value]) => listRow(`service ${name}`, String(value))).join('')
    : '<p class="proposal-empty">service health projection이 아직 로드되지 않았습니다.</p>';
}

function renderIncidents(response) {
  const loaded = hasResponse(response);
  const items = Array.isArray(response?.items) ? response.items : (Array.isArray(response?.data) ? response.data : []);
  elements.incidentBadge.textContent = loaded ? `${items.length}건 open` : '알 수 없음';
  elements.incidentBadge.className = `badge ${loaded ? (items.length > 0 ? 'is-degraded' : 'section-badge') : 'is-muted'}`;
  elements.incidentList.innerHTML = items.length
    ? items.slice(0, 6).map((item) => incidentRow(item)).join('')
    : `<p class="proposal-empty">${loaded ? '활성 인시던트 또는 알림이 없습니다.' : '첫 alert projection 전까지 인시던트 상태를 알 수 없습니다.'}</p>`;
}

function incidentRow(item) {
  const title = item.title || item.code || '인시던트';
  const severity = (item.severity || 'information').toUpperCase();
  const source = item.source || 'system';
  const message = item.message || '상세 정보가 없습니다.';
  return `<div class="review-history-item"><span>${title}</span><strong>${severity}</strong><small>${source} - ${message}</small></div>`;
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
  elements.approvalBadge.textContent = queueLoaded ? `${pendingItems.length}건 대기` : '알 수 없음';
  elements.approvalBadge.className = `badge ${queueLoaded ? (pendingItems.length > 0 ? 'is-degraded' : 'is-ready') : 'is-muted'}`;
  elements.proposalHistoryBadge.textContent = reviewsLoaded ? `${recentDecisions.length}건` : '알 수 없음';
  elements.proposalHistoryBadge.className = `badge ${reviewsLoaded ? 'section-badge' : 'is-muted'}`;
  elements.proposalQueueList.innerHTML = items.length
    ? items.slice(0, 6).map((item) => `
      <button class="proposal-queue-item${item.proposal_id === selectedProposalId ? ' is-selected' : ''}" type="button" data-proposal-id="${item.proposal_id}">
        <span>${item.instrument?.symbol || item.proposal_id}</span>
        <strong>${item.status}</strong>
      </button>
    `).join('')
    : '<p class="proposal-empty">검토할 제안이 없습니다.</p>';
  elements.proposalQueueList.querySelectorAll('[data-proposal-id]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedProposalId = button.dataset.proposalId;
      renderProposalQueue(latestProposalQueue, latestProposalReviews);
    });
  });
  elements.proposalHistoryList.innerHTML = recentDecisions.length
    ? recentDecisions.slice(0, 6).map((item) => reviewHistoryRow(item)).join('')
    : '<p class="proposal-empty">기록된 검토 결정이 아직 없습니다.</p>';
  const reviewDisabled = !selectedProposal || selectedProposal.status !== 'PENDING' || !authToken || !hasPermission('proposal.review');
  elements.proposalApproveButton.disabled = reviewDisabled;
  elements.proposalHoldButton.disabled = reviewDisabled;
  elements.proposalRejectButton.disabled = reviewDisabled;
  const reviewTitle = !authToken
    ? '제안을 검토하려면 로그인해야 합니다.'
    : (!hasPermission('proposal.review') ? '권한 부족: proposal.review' : '검토 가능');
  elements.proposalApproveButton.title = reviewTitle;
  elements.proposalHoldButton.title = reviewTitle;
  elements.proposalRejectButton.title = reviewTitle;
  if (!selectedProposal) {
    elements.proposalReviewState.textContent = '선택된 제안이 없습니다.';
    return;
  }
  const summaryParts = [
    `${selectedProposal.instrument?.symbol || selectedProposal.proposal_id}`,
    `strategy ${selectedProposal.strategy_id || '알 수 없음'}`,
    `status ${selectedProposal.status}`,
  ];
  if (latestReview) {
    summaryParts.push(`최근 검토 ${latestReview.status.toLowerCase()} / ${latestReview.reviewer || 'system'}`);
  }
  elements.proposalReviewState.textContent = summaryParts.join(' - ');
}

function reviewHistoryRow(item) {
  const reason = item.reason ? ` - ${item.reason}` : '';
  return `<div class="review-history-item${item.proposal_id === selectedProposalId ? ' is-selected' : ''}"><span>${item.proposal_id}</span><strong>${item.status}</strong><small>${item.reviewer || 'system'} / ${formatTimestamp(item.occurred_at)}${reason}</small></div>`;
}

function renderControlState(controlState) {
  const killSwitch = controlState?.kill_switch || 'NORMAL';
  elements.killSwitchChip.textContent = killSwitch;
  elements.killSwitchChip.className = `badge ${badgeClass(killSwitch)}`;
  const latestAction = Array.isArray(controlState?.recent_actions) ? controlState.recent_actions[0] : null;
  elements.contextActionsList.innerHTML = [
    listRow('Desired', latestAction?.desired || latestAction?.type || '요청 없음'),
    listRow('Accepted', latestAction ? formatTimestamp(latestAction.occurred_at) : '아직 accepted 상태 없음'),
    listRow('Observed', latestAction?.observed || 'observed 대기 중'),
    listRow('Kill switch', killSwitch),
  ].join('');
  elements.commandObserved.textContent = latestAction
    ? `Observed control state: ${latestAction.type} / ${latestAction.actor || 'system'} / ${formatTimestamp(latestAction.occurred_at)} / ${latestAction.observed || 'observed 대기 중'}`
    : `Observed control state: kill switch ${killSwitch.toLowerCase()}.`;
}

function setRealtimeState(title, copy) {
  elements.pollState.textContent = title;
  elements.staleBannerTitle.textContent = title;
  elements.staleBannerCopy.textContent = copy;
  elements.staleBanner.classList.toggle('is-warning', title !== 'Realtime 연결됨');
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
    elements.authSessionDetail.textContent = payload?.error || 'Google 로그인 시작에 실패했습니다.';
    return;
  }
  window.location.href = payload.url;
}

async function startGoogleStepUp() {
  if (!authToken) {
    elements.authSessionDetail.textContent = 'Step-up 인증을 요청하기 전에 먼저 로그인해야 합니다.';
    return;
  }
  const response = await fetch('/api/auth-service/auth/google/url').catch(() => null);
  const payload = await response?.json().catch(() => null);
  if (!response || !response.ok || !payload?.url) {
    elements.authSessionDetail.textContent = payload?.error || 'Google step-up 시작에 실패했습니다.';
    return;
  }
  localStorage.setItem('clab-step-up-pending', 'true');
  window.location.href = payload.url;
}

async function submitProposalReview(action) {
  if (!authToken) {
    elements.proposalReviewState.textContent = '제안을 검토하려면 먼저 로그인해야 합니다.';
    return;
  }
  if (!selectedProposalId) {
    elements.proposalReviewState.textContent = '먼저 제안을 선택하세요.';
    return;
  }
  const reason = elements.proposalReasonInput.value.trim();
  if (action === 'reject' && !reason) {
    elements.proposalReviewState.textContent = 'Reject에는 사유가 필요합니다.';
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
    elements.proposalReviewState.textContent = payload?.error || '제안 검토에 실패했습니다.';
    return;
  }
  elements.proposalReasonInput.value = '';
  elements.proposalReviewState.textContent = `제안 ${payload?.proposal_id || selectedProposalId}이(가) ${payload?.status || action.toUpperCase()} 상태로 기록되었습니다.`;
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
  setRealtimeState('Realtime 잠금', 'realtime gateway의 live patch를 보려면 로그인해야 합니다.');
  if (rerender) {
    updateAuthSessionUI();
  }
}

function updateAuthSessionUI(payload = null) {
  if (!authToken) {
    elements.authSessionState.textContent = '잠금';
    elements.authSessionDetail.textContent = '보호된 조회를 열려면 Google로 로그인해야 합니다.';
    elements.authPermissionsList.innerHTML = '<p class="proposal-empty">로드된 권한이 없습니다.</p>';
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
  elements.authSessionState.textContent = authStepUp ? 'step-up 활성' : (payload?.role || '운영 세션');
  elements.authSessionDetail.textContent = payload?.subject
    ? `${payload.subject} 계정이 인증되었습니다.${authStepUp ? ' 비상 제어용 step-up이 활성화되었습니다.' : ''}`
    : `저장된 운영 세션을 복원했습니다.${authStepUp ? ' 비상 제어용 step-up이 활성화되었습니다.' : ''}`;
  elements.authPermissionsList.innerHTML = authPermissions.length
    ? authPermissions.slice(0, 6).map((permission) => listRow('권한', permission)).join('')
    : '<p class="proposal-empty">로드된 권한이 없습니다.</p>';
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
      button.title = 'governed action을 보거나 실행하려면 로그인해야 합니다.';
      return;
    }
    if (!hasPermission(permission)) {
      button.disabled = true;
      button.title = `권한 부족: ${permission}`;
      return;
    }
    button.disabled = false;
    button.title = '제출 전 step-up 인증이 필요합니다.';
  });
  elements.commandConsoleBadge.textContent = authToken ? (authStepUp ? 'step-up 활성' : '요청 준비') : '요청 전용';
  elements.commandConsoleBadge.className = `badge action-badge ${authToken ? (authStepUp ? 'is-ready' : 'is-info') : 'is-muted'}`;
}

function hasPermission(permission) {
  return authPermissions.includes(permission);
}

function openCommandDialog(command) {
  commandIntent = command;
  const supported = supportedControlCommands[command];
  elements.commandDialogTitle.textContent = `${command} 확인`;
  elements.commandDialogBody.textContent = supported
    ? `Desired state: ${command}. 이 액션은 현재 control-service intake path에 연결되어 있으며 step-up 인증이 필요합니다. 실제 실행 효과는 downstream observed state로 별도 확인해야 합니다.`
    : `Desired state: ${command}. 아직 planned 상태인 command이므로 backend endpoint 호출 없이 요청 의도만 기록합니다.`;
  elements.commandScopeText.textContent = supported?.scope || 'planned scope가 정의되지 않았습니다';
  elements.commandEffectText.textContent = supported?.effect || 'planned command 전용입니다.';
  elements.commandRiskText.textContent = supported?.residualRisk || '아직 live backend path가 없습니다.';
  elements.commandApprovalText.textContent = supported?.approval || '아직 live backend path가 없습니다.';
  elements.commandConfirmButton.className = supported?.actionClass === 'danger' ? 'dialog-danger' : 'dialog-caution';
  elements.commandConfirmButton.textContent = supported ? '요청 제출' : '요청 기록';
  elements.commandReasonInput.value = '';
  elements.commandDialog.showModal();
}

async function handleCommandDialogClose() {
  if (elements.commandDialog.returnValue !== 'confirm' || !commandIntent) {
    return;
  }
  const reason = elements.commandReasonInput.value.trim() || '사유 미입력';
  const supported = supportedControlCommands[commandIntent];
  if (supported) {
    if (!elements.commandReasonInput.value.trim()) {
      elements.commandObserved.textContent = '고위험 governed action에는 사유가 필수입니다.';
      commandIntent = null;
      return;
    }
    if (!authToken) {
      elements.commandObserved.textContent = '비상 제어를 실행하기 전에 먼저 로그인해야 합니다.';
      commandIntent = null;
      return;
    }
    if (!authStepUp) {
      elements.commandObserved.textContent = '비상 제어 실행 전 step-up 인증이 필요합니다.';
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
      elements.commandObserved.textContent = payload?.error || '비상 제어 요청에 실패했습니다.';
      commandIntent = null;
      return;
    }
    renderControlState(payload?.state);
    elements.commandObserved.textContent = `Observed control state: ${payload?.action?.type || supported.label} 명령이 control-service에 accepted 되었습니다. 사유: ${reason}. 실제 실행 효과는 downstream에서 별도로 observed 됩니다.`;
    commandIntent = null;
    return;
  }
  elements.commandObserved.textContent = `Desired command ${commandIntent} 요청이 기록되었습니다. 사유: ${reason}. 아직 live backend path에는 연결되지 않았습니다.`;
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
  return typeof value === 'number' ? value.toFixed(2) : '알 수 없음';
}

function hasResponse(value) {
  return value !== null && value !== undefined;
}

function safeText(value, fallback) {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function freshnessLabel(value) {
  if (value === null || value === undefined) {
    return '알 수 없음';
  }
  return `${value} ms`;
}

function formatValue(value) {
  if (value === null || value === undefined || value === '') {
    return '알 수 없음';
  }
  const numeric = Number(value);
  if (!Number.isNaN(numeric)) {
    return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2);
  }
  return String(value);
}

function formatSignedValue(value) {
  if (value === null || value === undefined || value === '') {
    return '알 수 없음';
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
    return '시간 정보 없음';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '시간 정보 없음';
  }
  return parsed.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}
