/* ========================================================
   Verification Dashboard — verification.js
   Read-only verification view with polling.
   NEVER show 0 for missing data — always show "\u2014" or "unknown".
   ======================================================== */

const VerificationDashboard = {
  state: {
    dataState: 'unknown', // unknown | loading | fresh | stale | disconnected
    lastFetch: null,
    overview: null,
    orders: [],
    positions: [],
    fills: [],
    reconciliation: null,
    pnl: null,
    controlState: null,
    selectedOrderId: null,
    selectedOrder: null,
    ws: null,
    incidents: [],
    serviceHealth: null,
    filterStatus: '',
    filterSymbol: '',
    filterCorrelation: '',
  },

  elements: {},

  // ── Bootstrap ──
  init() {
    this.cacheElements();
    this.bindTabs();
    this.bindFilters();
    this.renderAll();
    this.poll();
    this.pollTimer = window.setInterval(() => this.poll(), 5000);
  },

  cacheElements() {
    this.elements = {
      pollState: document.getElementById('poll-state'),
      globalPulse: document.getElementById('global-pulse'),
      // Health bar
      hbFreshnessDot: document.getElementById('hb-freshness-dot'),
      hbFreshness: document.getElementById('hb-freshness'),
      hbMarketDot: document.getElementById('hb-market-dot'),
      hbMarket: document.getElementById('hb-market'),
      hbKillDot: document.getElementById('hb-kill-dot'),
      hbKill: document.getElementById('hb-kill'),
      hbReconDot: document.getElementById('hb-recon-dot'),
      hbReconLag: document.getElementById('hb-recon-lag'),
      // Summary cards
      scEquity: document.getElementById('sc-equity'),
      scEquityFresh: document.getElementById('sc-equity-fresh'),
      scBalance: document.getElementById('sc-balance'),
      scBalanceFresh: document.getElementById('sc-balance-fresh'),
      scMargin: document.getElementById('sc-margin'),
      scMarginFresh: document.getElementById('sc-margin-fresh'),
      scOrdersPositions: document.getElementById('sc-orders-positions'),
      scOrdersFresh: document.getElementById('sc-orders-fresh'),
      // Blotter
      blotterBadge: document.getElementById('blotter-badge'),
      blotterBody: document.getElementById('blotter-body'),
      blotterStatusFilter: document.getElementById('blotter-status-filter'),
      blotterSymbolFilter: document.getElementById('blotter-symbol-filter'),
      // Detail
      detailBadge: document.getElementById('detail-badge'),
      detailCorrelation: document.getElementById('detail-correlation'),
      truthPanelLifecycle: document.getElementById('truth-panel-lifecycle'),
      truthPanelExecution: document.getElementById('truth-panel-execution'),
      truthPanelPortfolio: document.getElementById('truth-panel-portfolio'),
      truthPanelReconciliation: document.getElementById('truth-panel-reconciliation'),
      // Bottom panel
      positionsBody: document.getElementById('positions-body'),
      driftSummary: document.getElementById('drift-summary'),
      reconMismatchList: document.getElementById('recon-mismatch-list'),
      fillsBody: document.getElementById('fills-body'),
      pnlRealized: document.getElementById('pnl-realized'),
      pnlUnrealized: document.getElementById('pnl-unrealized'),
      pnlTotal: document.getElementById('pnl-total'),
      actionsBody: document.getElementById('actions-body'),
      incidentsBody: document.getElementById('incidents-body'),
      // Footer
      footerCorrelation: document.getElementById('footer-correlation'),
    };
  },

  bindTabs() {
    // Truth split tabs
    document.querySelectorAll('#truth-tabs .truth-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('#truth-tabs .truth-tab').forEach((t) => {
          t.classList.remove('is-active');
        });
        tab.classList.add('is-active');
        const target = tab.dataset.tab;
        ['lifecycle', 'execution', 'portfolio', 'reconciliation'].forEach((id) => {
          const panel = document.getElementById('truth-panel-' + id);
          if (panel) panel.style.display = id === target ? '' : 'none';
        });
      });
    });

    // Bottom tabs
    document.querySelectorAll('#bottom-tabs .bottom-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('#bottom-tabs .bottom-tab').forEach((t) => {
          t.classList.remove('is-active');
        });
        tab.classList.add('is-active');
        const target = tab.dataset.btab;
        ['positions', 'reconciliation', 'fills', 'pnl', 'actions', 'incidents'].forEach((id) => {
          const panel = document.getElementById('btab-' + id);
          if (panel) panel.style.display = id === target ? '' : 'none';
        });
      });
    });
  },

  bindFilters() {
    this.elements.blotterStatusFilter.addEventListener('change', () => {
      this.state.filterStatus = this.elements.blotterStatusFilter.value;
      this.renderOrderBlotter();
    });
    this.elements.blotterSymbolFilter.addEventListener('input', () => {
      this.state.filterSymbol = this.elements.blotterSymbolFilter.value.trim().toLowerCase();
      this.renderOrderBlotter();
    });
  },

  // ── Polling ──
  async poll() {
    this.state.dataState = 'loading';
    this.elements.pollState.textContent = 'Refreshing';

    const results = await Promise.all([
      this.fetchJSON('/verification/live/overview'),
      this.fetchJSON('/verification/live/orders'),
      this.fetchJSON('/verification/live/positions'),
      this.fetchJSON('/verification/live/reconciliation'),
      this.fetchJSON('/verification/live/fills'),
      this.fetchJSON('/verification/live/pnl'),
      this.fetchJSON('/verification/live/actions'),
      this.fetchJSON('/verification/live/incidents'),
      this.fetchJSON('/verification/live/service-health'),
    ]);

    const [overview, orders, positions, reconciliation, fills, pnl, actions, incidents, serviceHealth] = results;
    const anySuccess = results.some((r) => r !== null);

    if (anySuccess) {
      this.state.dataState = 'fresh';
      this.state.lastFetch = Date.now();
    } else if (this.state.lastFetch === null) {
      this.state.dataState = 'unknown';
    } else {
      this.state.dataState = 'disconnected';
    }

    if (overview !== null) this.state.overview = overview;
    if (orders !== null) this.state.orders = Array.isArray(orders?.data) ? orders.data : (Array.isArray(orders) ? orders : []);
    if (positions !== null) this.state.positions = Array.isArray(positions?.data) ? positions.data : (Array.isArray(positions) ? positions : []);
    if (reconciliation !== null) this.state.reconciliation = reconciliation;
    if (fills !== null) this.state.fills = Array.isArray(fills?.data) ? fills.data : (Array.isArray(fills) ? fills : []);
    if (pnl !== null) this.state.pnl = pnl?.data || pnl;
    if (actions !== null) this.state.controlState = actions;
    if (incidents !== null) this.state.incidents = Array.isArray(incidents?.data?.incidents) ? incidents.data.incidents : [];
    if (serviceHealth !== null) this.state.serviceHealth = serviceHealth?.data || serviceHealth;

    this.renderAll();
  },

  async fetchJSON(url) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  },

  // ── Render orchestrator ──
  renderAll() {
    this.renderHealthBar();
    this.renderSummaryCards();
    this.renderOrderBlotter();
    this.renderOrderDetail();
    this.renderPositions();
    this.renderReconciliation();
    this.renderFills();
    this.renderPnl();
    this.renderActions();
    this.renderIncidents();
    this.renderFooter();
  },

  // ── Health Bar ──
  renderHealthBar() {
    const overview = this.state.overview;
    const meta = overview?.meta || {};
    const data = overview?.data || {};

    // Freshness
    const freshMs = meta.freshness_ms;
    this.elements.hbFreshness.textContent = this.freshnessLabel(freshMs);
    this.setDotState(this.elements.hbFreshnessDot, freshMs != null ? (freshMs < 3000 ? 'fresh' : 'stale') : this.state.dataState);

    // Market data
    const marketState = data.market_data_state || null;
    this.elements.hbMarket.textContent = marketState || 'unknown';
    this.setDotState(this.elements.hbMarketDot, marketState === 'live' ? 'fresh' : (marketState ? 'stale' : 'unknown'));

    // Kill switch
    const killSwitch = data.kill_switch || null;
    this.elements.hbKill.textContent = killSwitch || 'unknown';
    const killDotState = killSwitch === 'NORMAL' ? 'fresh' : (killSwitch ? 'disconnected' : 'unknown');
    this.setDotState(this.elements.hbKillDot, killDotState);

    // Recon lag
    const reconLag = data.recon_lag_ms;
    this.elements.hbReconLag.textContent = this.freshnessLabel(reconLag);
    this.setDotState(this.elements.hbReconDot, reconLag != null ? (reconLag < 5000 ? 'fresh' : 'stale') : 'unknown');

    // Global pulse
    this.setDotState(this.elements.globalPulse, this.state.dataState === 'fresh' ? 'fresh' : (this.state.dataState === 'stale' ? 'stale' : (this.state.dataState === 'disconnected' ? 'disconnected' : 'unknown')));
    this.elements.pollState.textContent = this.state.dataState;
  },

  // ── Summary Cards ──
  renderSummaryCards() {
    const overview = this.state.overview;
    const data = overview?.data || {};
    const meta = overview?.meta || {};
    const balances = Array.isArray(data.balances) ? data.balances : [];
    const bal = balances[0] || {};

    this.setSummaryCard(this.elements.scEquity, bal.equity, meta.freshness_ms);
    this.setSummaryCard(this.elements.scBalance, bal.available_balance, meta.freshness_ms);
    this.setSummaryCard(this.elements.scMargin, bal.margin_used, meta.freshness_ms);

    const orderCount = this.state.orders.length;
    const posCount = this.state.positions.length;
    const opVal = this.state.dataState === 'unknown' && orderCount === 0 && posCount === 0
      ? '\u2014 / \u2014'
      : `${orderCount} / ${posCount}`;
    this.elements.scOrdersPositions.textContent = opVal;
    this.elements.scOrdersPositions.className = 'summary-card-value' + (this.state.dataState === 'unknown' ? ' unknown-value' : '');
    this.elements.scOrdersFresh.textContent = meta.freshness_ms != null ? this.freshnessLabel(meta.freshness_ms) : '';

    // Stale card treatment
    document.querySelectorAll('.summary-card').forEach((card) => {
      card.classList.toggle('stale-card', this.state.dataState === 'stale');
    });
  },

  setSummaryCard(el, value, freshnessMs) {
    const freshEl = el.id ? document.getElementById(el.id + '-fresh') : null;
    if (value == null || value === undefined) {
      el.textContent = '\u2014';
      el.className = 'summary-card-value unknown-value';
    } else {
      el.textContent = this.formatValue(value);
      el.className = 'summary-card-value';
    }
    if (freshEl) {
      freshEl.textContent = freshnessMs != null ? this.freshnessLabel(freshnessMs) : '';
    }
  },

  // ── Order Blotter ──
  renderOrderBlotter() {
    let orders = this.state.orders;
    const statusFilter = this.state.filterStatus;
    const symbolFilter = this.state.filterSymbol;

    if (statusFilter) {
      orders = orders.filter((o) => (o.status || o.terminal_state || '') === statusFilter);
    }
    if (symbolFilter) {
      orders = orders.filter((o) => (o.symbol || '').toLowerCase().includes(symbolFilter));
    }
    if (this.state.filterCorrelation) {
      orders = orders.filter((o) => o.correlation_id === this.state.filterCorrelation);
    }

    const filterBadgeHtml = this.state.filterCorrelation
      ? ` <span class="correlation-filter-badge" id="clear-correlation-filter" title="Click to clear correlation filter">\u2715 ${this.escapeHtml(this.state.filterCorrelation.slice(0, 12))}…</span>`
      : '';
    this.elements.blotterBadge.innerHTML = `${orders.length} rows${filterBadgeHtml}`;
    if (this.state.filterCorrelation) {
      const clearBtn = document.getElementById('clear-correlation-filter');
      if (clearBtn) {
        clearBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.state.filterCorrelation = '';
          this.renderOrderBlotter();
        });
      }
    }

    if (this.state.dataState === 'unknown' && this.state.orders.length === 0) {
      this.elements.blotterBody.innerHTML = '<tr><td colspan="7" class="empty-state">Waiting for first snapshot...</td></tr>';
      return;
    }

    if (orders.length === 0) {
      this.elements.blotterBody.innerHTML = '<tr><td colspan="7" class="empty-state">No orders match the current filters.</td></tr>';
      return;
    }

    this.elements.blotterBody.innerHTML = orders.slice(0, 50).map((order) => {
      const status = order.status || order.terminal_state || 'unknown';
      const statusClass = 'order-status order-status-' + status.toLowerCase().replace(/\s+/g, '');
      const isSelected = order.internal_order_id === this.state.selectedOrderId || order.order_id === this.state.selectedOrderId;
      const orderId = order.internal_order_id || order.order_id || '';
      return `<tr class="${isSelected ? 'is-selected' : ''}" data-order-id="${this.escapeAttr(orderId)}">
        <td><span class="${statusClass}">${this.escapeHtml(status)}</span></td>
        <td>${this.escapeHtml(order.symbol || '\u2014')}</td>
        <td>${this.escapeHtml(order.side || '\u2014')}</td>
        <td>${this.formatValue(order.qty || order.quantity)}</td>
        <td>${this.formatValue(order.price)}</td>
        <td>${this.escapeHtml(order.strategy_id || order.strategy || '\u2014')}</td>
        <td>${this.formatTimestamp(order.updated_at || order.occurred_at)}</td>
      </tr>`;
    }).join('');

    this.elements.blotterBody.querySelectorAll('[data-order-id]').forEach((row) => {
      row.addEventListener('click', () => {
        const id = row.dataset.orderId;
        this.state.selectedOrderId = id;
        this.state.selectedOrder = this.state.orders.find(
          (o) => (o.internal_order_id || o.order_id) === id
        ) || null;
        this.renderOrderBlotter();
        this.renderOrderDetail();
      });
    });
  },

  // ── Order Detail ──
  renderOrderDetail(orderId) {
    const order = orderId
      ? this.state.orders.find((o) => (o.internal_order_id || o.order_id) === orderId)
      : this.state.selectedOrder;

    if (!order) {
      this.elements.detailBadge.textContent = 'none selected';
      this.elements.detailCorrelation.textContent = '';
      this.elements.truthPanelLifecycle.innerHTML = '<p class="truth-placeholder">Select an order to view lifecycle details.</p>';
      this.elements.truthPanelExecution.innerHTML = '<p class="truth-placeholder">No data to display.</p>';
      this.elements.truthPanelPortfolio.innerHTML = '<p class="truth-placeholder">No data to display.</p>';
      this.elements.truthPanelReconciliation.innerHTML = '<p class="truth-placeholder">No data to display.</p>';
      return;
    }

    const status = order.status || order.terminal_state || 'unknown';
    this.elements.detailBadge.textContent = status;
    if (order.correlation_id) {
      this.elements.detailCorrelation.innerHTML = `<span class="clickable-correlation" title="Click to filter by correlation_id">correlation_id: ${this.escapeHtml(order.correlation_id)}</span>`;
      this.elements.detailCorrelation.querySelector('.clickable-correlation').addEventListener('click', () => {
        this.state.filterCorrelation = order.correlation_id;
        this.renderOrderBlotter();
      });
    } else {
      this.elements.detailCorrelation.textContent = '';
    }

    // Lifecycle tab
    this.elements.truthPanelLifecycle.innerHTML = [
      this.truthRow('Order ID', order.internal_order_id || order.order_id || '\u2014'),
      this.truthRow('Symbol', order.symbol || '\u2014'),
      this.truthRow('Side', order.side || '\u2014'),
      this.truthRow('Qty', this.formatValue(order.qty || order.quantity)),
      this.truthRow('Price', this.formatValue(order.price)),
      this.truthRow('Status', status),
      this.truthRow('Pending State', order.pending_state || '\u2014'),
      this.truthRow('Terminal State', order.terminal_state || '\u2014'),
      this.truthRow('Strategy', order.strategy_id || order.strategy || '\u2014'),
      this.truthRow('Updated', this.formatTimestamp(order.updated_at || order.occurred_at)),
    ].join('');

    // Execution truth tab
    const execHtml = order.exchange_order_id
      ? [
          this.truthRow('Exchange Order ID', order.exchange_order_id),
          this.truthRow('Exchange Status', order.exchange_status || '\u2014'),
          this.truthRow('Filled Qty', this.formatValue(order.filled_qty)),
          this.truthRow('Avg Fill Price', this.formatValue(order.avg_fill_price)),
        ].join('')
      : '<p class="truth-placeholder">No execution-truth data available.</p>';
    this.elements.truthPanelExecution.innerHTML = execHtml;

    // Portfolio truth tab
    const fills = order.fills || [];
    const portfolioHtml = fills.length > 0
      ? fills.map((f, i) => this.truthRow(`Fill #${i + 1}`, `${this.formatValue(f.qty)} @ ${this.formatValue(f.price)}`)).join('')
      : '<p class="truth-placeholder">No linked portfolio-truth data yet.</p>';
    this.elements.truthPanelPortfolio.innerHTML = portfolioHtml;

    // Reconciliation tab
    const reconState = order.pending_state === 'ReconciliationRequired' ? 'Reconciliation required' : 'No explicit reconciliation hold';
    this.elements.truthPanelReconciliation.innerHTML = this.truthRow('Reconciliation', reconState);
  },

  // ── Positions ──
  renderPositions() {
    if (this.state.dataState === 'unknown' && this.state.positions.length === 0) {
      this.elements.positionsBody.innerHTML = '<tr><td colspan="6" class="empty-state">Waiting for first snapshot...</td></tr>';
      return;
    }

    if (this.state.positions.length === 0) {
      this.elements.positionsBody.innerHTML = '<tr><td colspan="6" class="empty-state">No open positions.</td></tr>';
      return;
    }

    this.elements.positionsBody.innerHTML = this.state.positions.slice(0, 30).map((p) => `<tr>
      <td>${this.escapeHtml(p.symbol || '\u2014')}</td>
      <td>${this.formatValue(p.qty || p.quantity)}</td>
      <td>${this.formatValue(p.entry_price)}</td>
      <td>${this.formatValue(p.mark_price)}</td>
      <td>${this.formatValue(p.unrealized_pnl)}</td>
      <td>${this.formatValue(p.leverage)}</td>
    </tr>`).join('');
  },

  // ── Reconciliation ──
  renderReconciliation() {
    const recon = this.state.reconciliation;
    const data = recon?.data || recon || {};
    const mismatches = Array.isArray(data.mismatches) ? data.mismatches : [];
    const driftCounts = data.drift_counts || {};

    // Update drift badges with counts
    this.elements.driftSummary.innerHTML = [
      this.driftBadge('no_drift', driftCounts.no_drift),
      this.driftBadge('explainable', driftCounts.explainable),
      this.driftBadge('actionable', driftCounts.actionable),
      this.driftBadge('critical', driftCounts.critical),
    ].join('');

    if (mismatches.length === 0) {
      this.elements.reconMismatchList.innerHTML = '<p class="truth-placeholder">No reconciliation mismatches detected.</p>';
      return;
    }

    this.elements.reconMismatchList.innerHTML = mismatches.slice(0, 20).map((m) => `
      <div class="recon-mismatch-item">
        <strong>${this.escapeHtml(m.symbol || m.field || 'Mismatch')}</strong>
        <span>${this.escapeHtml(m.description || m.message || 'Drift detected')}</span>
        <span class="drift-badge drift-${(m.drift_class || 'unknown').replace(/\s+/g, '-')}">${this.escapeHtml(m.drift_class || 'unknown')}</span>
      </div>
    `).join('');
  },

  // ── Fills ──
  renderFills() {
    if (this.state.dataState === 'unknown' && this.state.fills.length === 0) {
      this.elements.fillsBody.innerHTML = '<tr><td colspan="6" class="empty-state">Waiting for first snapshot...</td></tr>';
      return;
    }

    if (this.state.fills.length === 0) {
      this.elements.fillsBody.innerHTML = '<tr><td colspan="6" class="empty-state">No recent fills.</td></tr>';
      return;
    }

    this.elements.fillsBody.innerHTML = this.state.fills.slice(0, 30).map((f) => `<tr>
      <td>${this.formatTimestamp(f.occurred_at || f.time)}</td>
      <td>${this.escapeHtml(f.symbol || '\u2014')}</td>
      <td>${this.escapeHtml(f.side || '\u2014')}</td>
      <td>${this.formatValue(f.qty || f.quantity)}</td>
      <td>${this.formatValue(f.price)}</td>
      <td>${this.escapeHtml(f.order_id || f.internal_order_id || '\u2014')}</td>
    </tr>`).join('');
  },

  // ── PnL ──
  renderPnl() {
    const pnl = this.state.pnl || {};
    const realized = pnl.realized != null ? pnl.realized : (pnl.realized_pnl != null ? pnl.realized_pnl : null);
    const unrealized = pnl.unrealized != null ? pnl.unrealized : (pnl.unrealized_pnl != null ? pnl.unrealized_pnl : null);
    const total = pnl.total != null ? pnl.total : null;

    this.setPnlValue(this.elements.pnlRealized, realized);
    this.setPnlValue(this.elements.pnlUnrealized, unrealized);
    this.setPnlValue(this.elements.pnlTotal, total);

    // Position-level PnL breakdown
    const positions = Array.isArray(pnl.positions) ? pnl.positions : [];
    const breakdownEl = document.getElementById('pnl-breakdown');
    if (breakdownEl && positions.length > 0) {
      breakdownEl.innerHTML = '<h4 class="pnl-breakdown-title">Position attribution</h4>' +
        '<table class="data-table"><thead><tr><th>Symbol</th><th>Qty</th><th>Entry</th><th>Mark</th><th>Unrealized</th><th>Realized</th></tr></thead><tbody>' +
        positions.map((p) => `<tr>
          <td>${this.escapeHtml(p.symbol || '\u2014')}</td>
          <td>${this.formatValue(p.qty)}</td>
          <td>${this.formatValue(p.entry_price)}</td>
          <td>${this.formatValue(p.mark_price)}</td>
          <td>${this.formatValue(p.unrealized_pnl)}</td>
          <td>${this.formatValue(p.realized_pnl)}</td>
        </tr>`).join('') +
        '</tbody></table>';
    } else if (breakdownEl) {
      breakdownEl.innerHTML = '';
    }
  },

  setPnlValue(el, value) {
    if (value == null || value === undefined) {
      el.textContent = '\u2014';
      el.className = 'pnl-value unknown-value';
      return;
    }
    const num = Number(value);
    el.textContent = this.formatValue(value);
    el.className = 'pnl-value' + (num > 0 ? ' positive' : (num < 0 ? ' negative' : ''));
  },

  // ── Operator Actions ──
  renderActions() {
    const cs = this.state.controlState;
    const actions = Array.isArray(cs?.data) ? cs.data : (Array.isArray(cs?.recent_actions) ? cs.recent_actions : []);

    if (actions.length === 0) {
      this.elements.actionsBody.innerHTML = '<tr><td colspan="5" class="empty-state">No recent operator actions.</td></tr>';
      return;
    }

    this.elements.actionsBody.innerHTML = actions.slice(0, 20).map((a) => `<tr>
      <td>${this.formatTimestamp(a.occurred_at || a.time)}</td>
      <td>${this.escapeHtml(a.type || a.action || '\u2014')}</td>
      <td>${this.escapeHtml(a.actor || '\u2014')}</td>
      <td>${this.escapeHtml(a.reason || '\u2014')}</td>
      <td>${this.escapeHtml(a.observed || '\u2014')}</td>
    </tr>`).join('');
  },

  // ── Incidents ──
  renderIncidents() {
    if (this.state.incidents.length === 0) {
      this.elements.incidentsBody.innerHTML = '<tr><td colspan="5" class="empty-state">No active incidents.</td></tr>';
      return;
    }

    this.elements.incidentsBody.innerHTML = this.state.incidents.slice(0, 20).map((inc) => {
      const severityClass = 'incident-severity incident-' + (inc.severity || 'unknown');
      return `<tr>
        <td><span class="${severityClass}">${this.escapeHtml(inc.severity || 'unknown')}</span></td>
        <td>${this.escapeHtml(inc.type || '\u2014')}</td>
        <td>${this.escapeHtml(inc.title || '\u2014')}</td>
        <td>${this.escapeHtml(inc.status || '\u2014')}</td>
        <td>${this.formatTimestamp(inc.detected_at)}</td>
      </tr>`;
    }).join('');
  },

  // ── Footer ──
  renderFooter() {
    const overview = this.state.overview;
    const correlationId = overview?.meta?.correlation_id || overview?.correlation_id || null;
    this.elements.footerCorrelation.textContent = correlationId
      ? `correlation_id: ${correlationId}`
      : 'correlation_id: \u2014';
  },

  // ── Helpers ──
  formatValue(value, unit) {
    if (value == null || value === undefined || value === '') return '\u2014';
    if (typeof value === 'number') {
      const formatted = Number.isInteger(value) ? String(value) : value.toFixed(4);
      return unit ? `${formatted} ${unit}` : formatted;
    }
    return unit ? `${value} ${unit}` : String(value);
  },

  dataStateIndicator(state) {
    return `<span class="data-state-dot ${state || 'unknown'}"></span>`;
  },

  setDotState(dotEl, state) {
    if (!dotEl) return;
    dotEl.className = 'data-state-dot ' + (state || 'unknown');
    // Also update pulse dot class for global
    if (dotEl.classList.contains('pulse-dot') || dotEl.id === 'global-pulse') {
      dotEl.className = 'pulse-dot data-state-dot ' + (state || 'unknown');
    }
  },

  freshnessLabel(ms) {
    if (ms == null || ms === undefined) return '\u2014ms';
    if (ms < 1000) return `${ms}ms`;
    const seconds = (ms / 1000).toFixed(1);
    if (ms > 5000) return `stale (${seconds}s)`;
    return `${seconds}s`;
  },

  driftBadge(driftClass, count) {
    const cls = 'drift-badge drift-' + driftClass.replace(/\s+/g, '-');
    const label = driftClass;
    const countStr = count != null ? ` (${count})` : '';
    return `<span class="${cls}">${label}${countStr}</span>`;
  },

  truthRow(key, value) {
    return `<div class="truth-data-row"><span class="truth-key">${this.escapeHtml(key)}</span><span class="truth-val">${this.escapeHtml(String(value))}</span></div>`;
  },

  formatTimestamp(value) {
    if (!value) return '\u2014';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '\u2014';
    return parsed.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium' });
  },

  escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  },

  escapeAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },
};

// ── Start ──
document.addEventListener('DOMContentLoaded', () => {
  VerificationDashboard.init();
});
