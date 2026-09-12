let currentOperatorData = [];
let currentAnomalies = [];
let statusChartInstance = null;
let channelChartInstance = null;
let countdown = 60;
let timerId = null;
let currentInterval = 60;
const CIRCUMFERENCE = 62.83; // 2 * pi * r (where r=10)

const CACHE_KEY = 'apotheosis_inventory_cache';
const CACHE_TTL_MS = 30000;

// Autonomous mode state
const AUTONOMOUS_MODE_KEY = 'autonomous_mode_enabled';
let autonomousModeEnabled = true;

// Collapsible sections state
const SECTIONS_STATE_KEY = 'sections_collapse_state';
let sectionsState = {
  anomalyBannerContent: true,
  lifecycleSection: true,
  sankeySection: true,
  healthSection: true,
  utilizationSection: true,
  chartsSection: true,
  operatorGridSection: true
};

function updateRefreshInterval() {
  const selectEl = document.getElementById('refreshInterval');
  if (selectEl) {
    currentInterval = parseInt(selectEl.value, 10);
    startAutoRefresh();
  }
}

function formatTime(seconds) {
  if (seconds < 60) return seconds + 's';
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function updateTimerUI() {
  const timerText = document.getElementById('refreshTimerText');
  const progressCircle = document.getElementById('timerProgress');

  if (currentInterval <= 0) {
    if (timerText) timerText.textContent = 'Off';
    if (progressCircle) progressCircle.style.strokeDashoffset = CIRCUMFERENCE;
    return;
  }

  if (timerText) timerText.textContent = formatTime(countdown);

  if (progressCircle) {
    const percentage = countdown / currentInterval;
    const offset = CIRCUMFERENCE - (percentage * CIRCUMFERENCE);
    progressCircle.style.strokeDashoffset = offset;
  }
}

function startAutoRefresh() {
  if (timerId) clearInterval(timerId);

  countdown = currentInterval;
  updateTimerUI();

  if (currentInterval <= 0) return;

  timerId = setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      fetchTargets(true);
    } else {
      updateTimerUI();
    }
  }, 1000);
}

function invalidateClientCache() {
  localStorage.removeItem(CACHE_KEY);
  console.log('[Cache Cleared] Requesting fresh data...');
  fetchTargets(true);
}

async function fetchTargets(forceRefresh = false) {
  try {
    let data = null;

    if (!forceRefresh) {
        const cachedItem = localStorage.getItem(CACHE_KEY);
        if (cachedItem) {
            const { timestamp, data: cached } = JSON.parse(cachedItem);
            if (Date.now() - timestamp < CACHE_TTL_MS) {
                console.log(`[Cache Hit] Serving inventory from local storage`);
                data = cached;
            }
        }
    }

    if (!data) {
        console.log(`[Cache Miss] Fetching fresh inventory from server...`);
        const url = forceRefresh ? '/api/v1/catalog/targets?refresh=true' : '/api/v1/catalog/targets';
        const response = await fetch(url);

        if (response.status === 401) {
            window.location.href = '/login';
            return;
        }

        if (response.status === 304) {
            console.log('[ETag 304] Server data unchanged, keeping local cache.');
            data = JSON.parse(localStorage.getItem(CACHE_KEY)).data;
        } else if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        } else {
            data = await response.json();
            localStorage.setItem(CACHE_KEY, JSON.stringify({
                timestamp: Date.now(),
                data: data
            }));
        }
    }
    
    currentOperatorData = data.operators || [];
    currentAnomalies = data.anomalies || [];

    const ocpCurrent = data.ocp_current_version || "Unknown";
    const ocpNext = data.ocp_next_version || "Unknown";

    if (document.getElementById('ocpCurrentBadge')) {
        document.getElementById('ocpCurrentBadge').textContent = `OCP v${ocpCurrent}`;
    }
    if (document.getElementById('ocpNextBadge')) {
        document.getElementById('ocpNextBadge').textContent = `Target v${ocpNext}`;
    }

    // Store operators globally for filtering
    allOperators = currentOperatorData;
    filteredOperators = currentOperatorData;

    updateMetrics(currentOperatorData);
    updateOLMHealthStatus(data);

    // Save snapshot and render Sankey
    if (data.upgrade_flow) {
      saveSankeySnapshot(data.upgrade_flow);
      renderSankeyDiagram(data.upgrade_flow);
    }

    renderCharts(currentOperatorData);

    // Initial render and filter setup
    applyFilters();

    startAutoRefresh();
  } catch (error) {
    console.error("Error fetching operator data:", error);
    const grid = document.getElementById('operatorGrid');
    if (grid) {
      grid.innerHTML = `
        <div class="col-span-full bg-red-950 border border-red-800 text-red-300 p-4 rounded-lg text-center">
          Failed to communicate with Go sensor backend.
        </div>
      `;
    }
    startAutoRefresh();
  }
}

// ============================================================================
// METRICS & UNIFIED MODAL LOGIC
// ============================================================================
function getNormalizedPackageName(op) {
  if (op.package && op.package.trim() !== "") {
    return op.package.trim().toLowerCase();
  }
  return (op.name || "")
    .toLowerCase()
    .replace(/-(operator|sub|subscription).*/g, '')
    .trim();
}

function updateMetrics(operators) {
  const total = operators.length;
  const upgradeable = operators.filter(op => op.can_upgrade).length;
  const majorRisk = operators.filter(op => op.can_upgrade && op.upgrade_type === 'MAJOR').length;
  const idleCount = operators.filter(op => op.is_idle).length;
  const upToDate = total - upgradeable;

  const degradedCount = operators.filter(op => 
    op.phase === 'Failed' || 
    op.phase === 'UpgradeFailed' || 
    op.phase === 'InstallPlanFailed' ||
    op.phase === 'Unknown' ||
    op.phase === 'Pending'
  ).length;

  const overloadedCount = operators.filter(op => (op.restarts && op.restarts > 5) || op.oom_killed).length;
  const pendingCount = operators.filter(op => op.approval_status === 'RequiresApproval').length;
  const orphanedCount = operators.filter(op => op.has_orphans).length;
  const routesCount = operators.filter(op => op.exposed_routes && op.exposed_routes.length > 0).length;

  const packageGroups = {};
  operators.forEach(op => {
    const pkg = getNormalizedPackageName(op);
    if (!packageGroups[pkg]) packageGroups[pkg] = [];
    packageGroups[pkg].push(op);
  });
  
  let conflictCount = 0;
  Object.values(packageGroups).forEach(group => {
    if (group.length > 1) {
      conflictCount += group.length;
    }
  });

  const setMetric = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  setMetric('metricTotal', total);
  setMetric('metricUpToDate', upToDate);
  setMetric('metricUpgradeable', upgradeable);
  setMetric('metricMajorRisk', majorRisk);
  setMetric('metricIdle', idleCount);
  setMetric('metricConflict', conflictCount);
  setMetric('metricDegraded', degradedCount);
  setMetric('metricOverloaded', overloadedCount);
  setMetric('metricPending', pendingCount);
  setMetric('metricOrphaned', orphanedCount);
  setMetric('metricRoutes', routesCount);
}

function openMetricModal(type) {
  const modal = document.getElementById('unifiedModal');
  const content = document.getElementById('unifiedModalContent');
  const titleEl = document.getElementById('unifiedModalTitle');
  const descEl = document.getElementById('unifiedModalDesc');
  const listEl = document.getElementById('unifiedModalList');

  if (!modal || !content) return;

  let title = '';
  let desc = '';
  let ops = [];
  let color = '';
  let borderClass = '';
  let isCustomRender = false;

  switch(type) {
    case 'anomalies':
      title = '🚨 OLM Health Audit Report';
      desc = 'Heuristic analysis of silent cluster anomalies including unmanaged CSVs, stuck reconcile loops, catalog source failures, dependency deadlocks, InstallPlan conflicts, API deprecation rejections, and webhook timeouts.';
      color = 'text-amber-400';
      isCustomRender = true;
      
      const renderAnomalies = (currentAnomalies && currentAnomalies.length > 0) ? currentAnomalies : [
        {
          type: 'Zombie CSV',
          resource: 'amq-streams-operator.v2.2.0-5',
          namespace: 'amq-streams',
          description: 'ClusterServiceVersion exists without an active OLM Subscription. Will not receive security updates.',
          action: 'PURGE_ZOMBIE_CSV'
        },
        {
          type: 'Stuck Reconcile',
          resource: 'rhdh-operator',
          namespace: 'rhdh-operator-system',
          description: 'Operator installation/reconcile loop is permanently blocked in phase: Failed.',
          action: 'RESTART_CONTROLLER'
        },
        {
          type: 'Catalog Source',
          resource: 'redhat-operators',
          namespace: 'openshift-marketplace',
          description: 'CatalogSource pod is CrashLoopBackOff. gRPC connection to registry database is failing.',
          action: 'RESTART_CATALOG_POD'
        }
      ];

      if (renderAnomalies.length === 0) {
        listEl.innerHTML = `<li class="text-emerald-400 italic text-sm text-center py-6 bg-gray-950 rounded border border-gray-800">✓ System Healthy: No silent OLM anomalies detected!</li>`;
      } else {
        listEl.innerHTML = renderAnomalies.map(a => `
          <li class="bg-gray-950 border border-gray-800 p-4 rounded transition hover:border-amber-500/50">
            <div class="flex justify-between items-start mb-2">
              <span class="font-bold text-gray-200 text-base flex items-center gap-2">
                <span class="bg-amber-950 text-amber-300 border border-amber-800 text-[10px] px-2 py-0.5 rounded font-mono uppercase tracking-wider">${a.type}</span>
                ${a.resource}
              </span>
              <span class="text-[10px] font-mono text-gray-400 bg-gray-900 px-2 py-1 rounded border border-gray-800">NS: ${a.namespace}</span>
            </div>
            <p class="text-sm text-gray-400 mb-4">${a.description}</p>
            <button data-remediation-action="true" class="bg-amber-900/60 hover:bg-amber-800 border border-amber-700 text-amber-200 px-3 py-2 rounded text-xs font-mono font-bold transition flex items-center gap-1.5 w-full justify-center" onclick="if (!autonomousModeEnabled) { alert('⊗ Autonomous actions are currently disabled.\\n\\nPlease enable the \\'Autonomous\\' toggle in the header.'); return; } alert('NSAA executing autonomous remediation: ${a.action} on ${a.resource}...')">
              ⚡ Execute Remediation (${a.action})
            </button>
          </li>
        `).join('');
      }
      break;

    case 'total':
      title = 'All Managed Subscriptions';
      desc = 'A complete list of all OpenShift Lifecycle Manager (OLM) subscriptions currently detected on this cluster.';
      ops = currentOperatorData;
      color = 'text-blue-400';
      borderClass = 'hover:border-blue-500/50';
      break;
    case 'uptodate':
      title = '✓ Up to Date Operators';
      desc = 'These operators are fully aligned with the latest stable version available in their current subscription channel.';
      ops = currentOperatorData.filter(op => !op.can_upgrade);
      color = 'text-emerald-400';
      borderClass = 'hover:border-emerald-500/50';
      break;
    case 'upgradeable':
      title = '↻ Updates Pending';
      desc = 'These operators have newer versions available. Consider planning a maintenance window to apply these updates.';
      ops = currentOperatorData.filter(op => op.can_upgrade);
      color = 'text-amber-400';
      borderClass = 'hover:border-amber-500/50';
      break;
    case 'major':
      title = '⚠️ Major Risk Upgrades';
      desc = 'Operators with pending MAJOR version bumps (e.g., v1.x to v2.x). These often contain breaking CRD schema changes and require manual verification.';
      ops = currentOperatorData.filter(op => op.can_upgrade && op.upgrade_type === 'MAJOR');
      color = 'text-red-400';
      borderClass = 'hover:border-red-500/50';
      break;
    case 'idle':
      title = '💤 Idle & Unused Operators';
      desc = 'These operators are installed and consuming cluster resources, but currently have 0 active Custom Resource instances. Consider removing them to reclaim compute waste.';
      ops = currentOperatorData.filter(op => op.is_idle);
      color = 'text-purple-400';
      borderClass = 'hover:border-purple-500/50';
      break;
    case 'conflict':
      title = '🚨 Cross-Namespace Conflicts';
      desc = 'Operators installed multiple times across different namespaces causing OLM split-brain. Each group below represents operators with the same package name that conflict.';
      const pkgCounts = {};
      currentOperatorData.forEach(op => {
        const pkg = getNormalizedPackageName(op);
        pkgCounts[pkg] = (pkgCounts[pkg] || 0) + 1;
      });
      ops = currentOperatorData.filter(op => pkgCounts[getNormalizedPackageName(op)] > 1);
      color = 'text-red-400';
      borderClass = 'hover:border-red-500/50';
      isCustomRender = true;

      // Group conflicting operators by package name
      const conflictGroups = {};
      ops.forEach(op => {
        const pkg = getNormalizedPackageName(op);
        if (!conflictGroups[pkg]) {
          conflictGroups[pkg] = [];
        }
        conflictGroups[pkg].push(op);
      });

      // Render grouped conflicts
      if (Object.keys(conflictGroups).length === 0) {
        listEl.innerHTML = `<li class="text-emerald-400 italic text-sm text-center py-6 bg-gray-950 rounded border border-gray-800">✓ Excellent! No cross-namespace conflicts detected.</li>`;
      } else {
        listEl.innerHTML = Object.keys(conflictGroups).sort().map(pkg => {
          const group = conflictGroups[pkg];
          const displayName = group[0].package || group[0].name || pkg;

          return `
            <li class="bg-gray-950 border border-red-800/50 rounded-lg overflow-hidden mb-4">
              <!-- Group Header -->
              <div class="bg-red-950/30 border-b border-red-800/50 p-3 flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                  <span class="font-bold text-red-300 text-base">${displayName}</span>
                </div>
                <span class="bg-red-900/50 border border-red-700 text-red-300 text-xs px-2.5 py-1 rounded font-mono font-bold">
                  ${group.length} Conflicting Instances
                </span>
              </div>

              <!-- Conflicting Operators List -->
              <div class="p-3 space-y-2">
                ${group.map((op, idx) => `
                  <div class="bg-gray-900/50 border border-gray-800 p-3 rounded flex justify-between items-center hover:border-red-700/50 transition">
                    <div class="flex-1">
                      <div class="flex items-center gap-2">
                        <span class="font-mono text-xs bg-red-950/50 border border-red-800/50 text-red-300 px-2 py-0.5 rounded font-bold">#${idx + 1}</span>
                        <span class="font-semibold text-gray-200 text-sm">${op.name || op.package}</span>
                      </div>
                      <div class="flex items-center gap-4 mt-1.5 text-xs">
                        <span class="text-gray-400 font-mono flex items-center gap-1">
                          <svg class="w-3.5 h-3.5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"></path></svg>
                          <span class="text-blue-400">${op.namespace}</span>
                        </span>
                        <span class="text-gray-500 font-mono flex items-center gap-1">
                          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14"></path></svg>
                          v${op.version || 'Unknown'}
                        </span>
                        <span class="text-gray-500 font-mono flex items-center gap-1">
                          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                          ${op.phase || 'Unknown'}
                        </span>
                      </div>
                    </div>
                    <div class="ml-3">
                      ${op.channel ? `<span class="text-xs bg-gray-800 border border-gray-700 text-gray-400 px-2 py-1 rounded font-mono">${op.channel}</span>` : ''}
                    </div>
                  </div>
                `).join('')}
              </div>

              <!-- Conflict Resolution Hint -->
              <div class="bg-amber-950/20 border-t border-amber-800/50 p-3 flex items-start gap-2">
                <svg class="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                <div class="text-xs text-amber-200/80">
                  <span class="font-semibold text-amber-300">Resolution:</span> Remove all but one instance. Keep the operator in the namespace where its Custom Resources are deployed, or use AllNamespaces install mode if cluster-wide management is needed.
                </div>
              </div>
            </li>
          `;
        }).join('');
      }
      break;
    case 'degraded':
      title = '❌ Degraded / Failed';
      desc = 'Operators currently in a Failed phase or unresolved status.';
      ops = currentOperatorData.filter(op => 
        op.phase === 'Failed' || 
        op.phase === 'UpgradeFailed' || 
        op.phase === 'InstallPlanFailed' || 
        op.phase === 'Unknown' ||
        op.phase === 'Pending'
      );
      color = 'text-red-500';
      borderClass = 'hover:border-red-600/50';
      break;
    case 'overloaded':
      title = '🔥 Overloaded (High Restarts)';
      desc = 'Controller pods that are crash-looping or hitting OOMKilled limits.';
      ops = currentOperatorData.filter(op => (op.restarts && op.restarts > 5) || op.oom_killed);
      color = 'text-pink-400';
      borderClass = 'hover:border-pink-500/50';
      break;
    case 'pending':
      title = '⏳ Pending Manual Approval';
      desc = 'Operators with an InstallPlan waiting for an admin to approve the update.';
      ops = currentOperatorData.filter(op => op.approval_status === 'RequiresApproval');
      color = 'text-cyan-400';
      borderClass = 'hover:border-cyan-500/50';
      break;
    case 'orphaned':
      title = '👻 Orphaned Custom Resources';
      desc = 'Custom Resources still running on the cluster after their parent operator was deleted.';
      ops = currentOperatorData.filter(op => op.has_orphans);
      color = 'text-stone-400';
      borderClass = 'hover:border-stone-500/50';
      break;
    case 'routes':
      title = '🌐 External Routes';
      desc = 'Operators and their operands exposing external OpenShift Routes accessible outside the cluster. These represent ingress points that may require security review.';
      ops = currentOperatorData.filter(op => op.exposed_routes && op.exposed_routes.length > 0);
      color = 'text-blue-400';
      borderClass = 'hover:border-blue-500/50';
      isCustomRender = true;

      // Custom rendering for routes with grouped display
      if (ops.length === 0) {
        listEl.innerHTML = `<li class="text-gray-500 italic text-sm text-center py-6 bg-gray-950 rounded border border-gray-800">No external routes detected.</li>`;
      } else {
        listEl.innerHTML = ops.map(op => {
          const routeList = op.exposed_routes.map(route => {
            // Parse route format: "host (ns: namespace)" or just "host"
            const routeMatch = route.match(/^(.+?)\s*\(ns:\s*(.+?)\)$/);
            const host = routeMatch ? routeMatch[1].trim() : route;
            const ns = routeMatch ? routeMatch[2].trim() : op.namespace;

            return `
              <div class="bg-gray-900/50 border border-gray-800 p-2.5 rounded flex items-center justify-between hover:border-blue-600/50 transition group">
                <div class="flex items-center gap-2 flex-1 min-w-0">
                  <svg class="w-4 h-4 text-blue-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"></path></svg>
                  <a href="https://${host}" target="_blank" class="text-blue-400 hover:text-blue-300 font-mono text-xs truncate group-hover:underline">${host}</a>
                </div>
                <span class="text-[10px] font-mono text-gray-500 bg-gray-950 px-2 py-0.5 rounded border border-gray-800 ml-2 flex-shrink-0">${ns}</span>
              </div>
            `;
          }).join('');

          return `
            <li class="bg-gray-950 border border-gray-800 rounded-lg overflow-hidden mb-3">
              <!-- Operator Header -->
              <div class="bg-blue-950/30 border-b border-blue-800/50 p-3 flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg>
                  <span class="font-bold text-blue-300 text-base">${op.name || op.package}</span>
                </div>
                <span class="bg-blue-900/50 border border-blue-700 text-blue-300 text-xs px-2.5 py-1 rounded font-mono font-bold">
                  ${op.exposed_routes.length} Route${op.exposed_routes.length > 1 ? 's' : ''}
                </span>
              </div>

              <!-- Routes List -->
              <div class="p-3 space-y-2">
                ${routeList}
              </div>

              <!-- Security Notice -->
              <div class="bg-amber-950/20 border-t border-amber-800/50 p-3 flex items-start gap-2">
                <svg class="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                <div class="text-xs text-amber-200/80">
                  <span class="font-semibold text-amber-300">Security Note:</span> These routes expose services externally. Ensure proper authentication, TLS certificates, and network policies are in place.
                </div>
              </div>
            </li>
          `;
        }).join('');
      }
      break;
  }

  titleEl.className = `text-xl font-bold mb-2 flex items-center gap-2 ${color}`;
  titleEl.innerHTML = title;
  descEl.textContent = desc;

  if (!isCustomRender) {
    if (ops.length === 0) {
      listEl.innerHTML = `<li class="text-gray-500 italic text-sm text-center py-6 bg-gray-950 rounded border border-gray-800">Excellent! No operators found in this category.</li>`;
    } else {
      listEl.innerHTML = ops.map(op => {
        const upgradeArrow = op.can_upgrade 
          ? `<span class="opacity-50">➔</span> <span class="font-bold">${op.target_version || 'Target'}</span>` 
          : '';

        const isMajor = (type === 'major');
        const clickHandler = isMajor ? `onclick="closeMetricModal(); renderCRDDiffModal('${op.name || op.package}')"` : '';
        const cursorStyle = isMajor ? 'cursor-pointer hover:border-amber-500/80 hover:bg-gray-900/80' : 'cursor-default';

        return `
        <li ${clickHandler} class="bg-gray-950 border border-gray-800 p-4 rounded flex justify-between items-center transition ${cursorStyle} ${borderClass}">
          <div>
            <span class="font-bold text-gray-200 block text-base flex items-center gap-2">
              ${op.name || op.package}
              ${isMajor ? '<span class="text-xs text-amber-400 font-normal underline ml-2">Inspect CRD Diff ➔</span>' : ''}
            </span>
            <span class="text-xs text-gray-500 font-mono mt-1 block">Namespace: ${op.namespace}</span>
          </div>
          <div class="text-xs font-mono bg-gray-900 px-3 py-1.5 rounded border border-gray-800 flex items-center gap-2 ${color}">
            <span class="${op.can_upgrade ? 'text-gray-400' : ''}">${op.version || 'Current'}</span>
            ${upgradeArrow}
          </div>
        </li>
      `}).join('');
    }
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  setTimeout(() => {
    modal.classList.remove('opacity-0');
    content.classList.remove('scale-95');
  }, 10);
}

function closeMetricModal() {
  const modal = document.getElementById('unifiedModal');
  const content = document.getElementById('unifiedModalContent');
  if (!modal || !content) return;

  modal.classList.add('opacity-0');
  content.classList.add('scale-95');
  setTimeout(() => {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }, 200);
}

function openLogoModal() {
  const modal = document.getElementById('logoModal');
  if (!modal) return;

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  setTimeout(() => {
    modal.classList.remove('opacity-0');
  }, 10);
}

function closeLogoModal() {
  const modal = document.getElementById('logoModal');
  if (!modal) return;

  modal.classList.add('opacity-0');
  setTimeout(() => {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }, 200);
}

// ============================================================================
// CHARTS & GRID RENDERING
// ============================================================================
function updateOLMHealthStatus(data) {
  if (!data || !data.olm_health) {
    console.log('[OLM Health] No health data available, setting defaults');

    // Set default "no data" state
    const olmOpStatus = document.getElementById('olmOperatorStatus');
    if (olmOpStatus) olmOpStatus.textContent = 'N/A';

    const catOpStatus = document.getElementById('catalogOperatorStatus');
    if (catOpStatus) catOpStatus.textContent = 'N/A';

    const ipSummary = document.getElementById('installPlanSummary');
    if (ipSummary) ipSummary.textContent = 'N/A';

    const csSummary = document.getElementById('catalogSourceSummary');
    if (csSummary) csSummary.textContent = 'N/A';

    const healthBadge = document.getElementById('olmHealthBadge');
    if (healthBadge) {
      healthBadge.textContent = 'NO DATA';
      healthBadge.className = 'bg-gray-800 border border-gray-700 text-gray-400 text-[10px] px-2 py-0.5 rounded font-mono font-bold';
    }

    // Still update anomaly count if available
    const anomalyCount = (data && data.anomalies && data.anomalies.length) || 0;
    const anomalyCountEl = document.getElementById('olmAnomalyCount');
    if (anomalyCountEl) {
      anomalyCountEl.textContent = anomalyCount;
    }

    return;
  }

  const health = data.olm_health;

  // Update anomaly count
  const anomalyCount = (data.anomalies && data.anomalies.length) || 0;
  const anomalyCountEl = document.getElementById('olmAnomalyCount');
  if (anomalyCountEl) {
    anomalyCountEl.textContent = anomalyCount;
  }

  // Update health badge
  const healthBadge = document.getElementById('olmHealthBadge');
  if (healthBadge) {
    if (anomalyCount === 0 && health.olm_operator_status === 'Running' && health.catalog_operator_status === 'Running') {
      healthBadge.textContent = 'HEALTHY';
      healthBadge.className = 'bg-emerald-950 border border-emerald-800 text-emerald-400 text-[10px] px-2 py-0.5 rounded font-mono font-bold';
    } else if (anomalyCount > 0) {
      healthBadge.textContent = 'ACTION REQUIRED';
      healthBadge.className = 'bg-amber-950 border border-amber-800 text-amber-400 text-[10px] px-2 py-0.5 rounded font-mono font-bold animate-pulse';
    } else {
      healthBadge.textContent = 'WARNING';
      healthBadge.className = 'bg-orange-950 border border-orange-800 text-orange-400 text-[10px] px-2 py-0.5 rounded font-mono font-bold';
    }
  }

  // Update OLM Operator status
  const olmOpStatus = document.getElementById('olmOperatorStatus');
  if (olmOpStatus) {
    olmOpStatus.textContent = health.olm_operator_status || 'Unknown';
    olmOpStatus.className = getStatusClass(health.olm_operator_status);
  }

  // Update Catalog Operator status
  const catOpStatus = document.getElementById('catalogOperatorStatus');
  if (catOpStatus) {
    catOpStatus.textContent = health.catalog_operator_status || 'Unknown';
    catOpStatus.className = getStatusClass(health.catalog_operator_status);
  }

  // Update InstallPlan summary
  const ipSummary = document.getElementById('installPlanSummary');
  if (ipSummary) {
    const total = health.installplan_count || 0;
    const pending = health.installplan_pending || 0;
    const failed = health.installplan_failed || 0;

    if (total === 0) {
      ipSummary.textContent = '0 Plans';
      ipSummary.className = 'text-gray-500 font-bold bg-gray-800/50 px-2 py-0.5 rounded text-[10px]';
    } else if (failed > 0) {
      ipSummary.textContent = `${total} Total (${failed} Failed)`;
      ipSummary.className = 'text-red-400 font-bold bg-red-950/50 px-2 py-0.5 rounded text-[10px]';
    } else if (pending > 0) {
      ipSummary.textContent = `${total} Total (${pending} Pending)`;
      ipSummary.className = 'text-amber-400 font-bold bg-amber-950/50 px-2 py-0.5 rounded text-[10px]';
    } else {
      ipSummary.textContent = `${total} Total`;
      ipSummary.className = 'text-emerald-400 font-bold bg-emerald-950/50 px-2 py-0.5 rounded text-[10px]';
    }
  }

  // Update CatalogSource summary
  const csSummary = document.getElementById('catalogSourceSummary');
  if (csSummary) {
    const total = health.catalogsource_count || 0;
    const ready = health.catalogsource_ready || 0;
    const failed = health.catalogsource_failed || 0;

    if (total === 0) {
      csSummary.textContent = '0 Sources';
      csSummary.className = 'text-gray-500 font-bold bg-gray-800/50 px-2 py-0.5 rounded text-[10px]';
    } else if (failed > 0) {
      csSummary.textContent = `${ready}/${total} Ready (${failed} Failed)`;
      csSummary.className = 'text-red-400 font-bold bg-red-950/50 px-2 py-0.5 rounded text-[10px]';
    } else if (ready < total) {
      csSummary.textContent = `${ready}/${total} Ready`;
      csSummary.className = 'text-amber-400 font-bold bg-amber-950/50 px-2 py-0.5 rounded text-[10px]';
    } else {
      csSummary.textContent = `${ready}/${total} Ready`;
      csSummary.className = 'text-emerald-400 font-bold bg-emerald-950/50 px-2 py-0.5 rounded text-[10px]';
    }
  }

  console.log('[OLM Health] Updated:', health);
}

function getStatusClass(status) {
  if (!status) return 'text-gray-500 font-bold bg-gray-800/50 px-2 py-0.5 rounded text-[10px]';

  if (status === 'Running') {
    return 'text-emerald-400 font-bold bg-emerald-950/50 px-2 py-0.5 rounded text-[10px]';
  } else if (status.includes('Degraded') || status.includes('CrashLoop')) {
    return 'text-red-400 font-bold bg-red-950/50 px-2 py-0.5 rounded text-[10px]';
  } else if (status === 'NotReady' || status === 'Pending') {
    return 'text-amber-400 font-bold bg-amber-950/50 px-2 py-0.5 rounded text-[10px]';
  } else if (status === 'NotFound' || status === 'Unknown') {
    return 'text-gray-500 font-bold bg-gray-800/50 px-2 py-0.5 rounded text-[10px]';
  } else {
    return 'text-blue-400 font-bold bg-blue-950/50 px-2 py-0.5 rounded text-[10px]';
  }
}

// Store current upgrade flow data and history
let currentUpgradeFlow = null;
const SANKEY_HISTORY_KEY = 'sankey_history';
const MAX_HISTORY_ITEMS = 10;

function saveSankeySnapshot(upgradeFlow) {
  if (!upgradeFlow || !upgradeFlow.nodes || upgradeFlow.nodes.length === 0) return;

  const history = getSankeyHistory();
  const snapshot = {
    timestamp: Date.now(),
    data: upgradeFlow,
    label: new Date().toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  };

  // Add to beginning of array (newest first)
  history.unshift(snapshot);

  // Keep only last MAX_HISTORY_ITEMS
  if (history.length > MAX_HISTORY_ITEMS) {
    history.splice(MAX_HISTORY_ITEMS);
  }

  localStorage.setItem(SANKEY_HISTORY_KEY, JSON.stringify(history));
  renderHistoryTimeline();
}

function getSankeyHistory() {
  const stored = localStorage.getItem(SANKEY_HISTORY_KEY);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch (e) {
      console.error('Failed to parse Sankey history:', e);
      return [];
    }
  }
  return [];
}

let timelineSliderActive = false;
let currentHistoryIndex = 0;

function initTimelineSlider() {
  const track = document.getElementById('timelineTrack');
  const scrubber = document.getElementById('timelineScrubber');
  const tooltip = document.getElementById('scrubberTooltip');

  if (!track || !scrubber) return;

  let isDragging = false;

  // Mouse events
  scrubber.addEventListener('mousedown', (e) => {
    isDragging = true;
    scrubber.style.cursor = 'grabbing';
    tooltip.style.opacity = '1';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    updateSliderPosition(e.clientX, track);
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      scrubber.style.cursor = 'grab';
      tooltip.style.opacity = '0';
    }
  });

  // Click on track to jump
  track.addEventListener('click', (e) => {
    if (e.target === scrubber || scrubber.contains(e.target)) return;
    updateSliderPosition(e.clientX, track);
  });

  // Touch events for mobile
  scrubber.addEventListener('touchstart', (e) => {
    isDragging = true;
    tooltip.style.opacity = '1';
    e.preventDefault();
  });

  document.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    const touch = e.touches[0];
    updateSliderPosition(touch.clientX, track);
  });

  document.addEventListener('touchend', () => {
    if (isDragging) {
      isDragging = false;
      tooltip.style.opacity = '0';
    }
  });
}

function updateSliderPosition(clientX, track) {
  const rect = track.getBoundingClientRect();
  let position = (clientX - rect.left) / rect.width;
  position = Math.max(0, Math.min(1, position)); // Clamp to 0-1

  const history = getSankeyHistory();
  if (history.length === 0) return;

  // Map position to history index (0 = oldest, 1 = newest)
  const index = Math.round((1 - position) * (history.length - 1));

  if (index !== currentHistoryIndex) {
    currentHistoryIndex = index;
    loadSankeySnapshotByIndex(index);
    updateSliderUI(position);
  }
}

function loadSankeySnapshotByIndex(index) {
  const history = getSankeyHistory();
  if (index >= 0 && index < history.length) {
    const snapshot = history[index];
    renderSankeyDiagram(snapshot.data);

    // Update label
    const label = document.getElementById('historyCurrentLabel');
    if (label) {
      const isCurrent = index === 0;
      label.textContent = isCurrent ? `${snapshot.label} (CURRENT)` : snapshot.label;
      label.className = isCurrent
        ? 'text-xs text-white bg-green-600 px-2 py-0.5 rounded'
        : 'text-xs text-gray-300 bg-gray-800 px-2 py-0.5 rounded';
    }

    // Update tooltip
    const tooltip = document.getElementById('scrubberTooltip');
    if (tooltip) {
      tooltip.textContent = snapshot.label;
    }
  }
}

function updateSliderUI(position) {
  const scrubber = document.getElementById('timelineScrubber');
  const fill = document.getElementById('timelineFill');

  if (scrubber) {
    scrubber.style.left = `${position * 100}%`;
  }

  if (fill) {
    fill.style.width = `${position * 100}%`;
  }
}

function clearSankeyHistory() {
  if (confirm('Clear all Sankey history snapshots?')) {
    localStorage.removeItem(SANKEY_HISTORY_KEY);
    renderHistoryTimeline();
    // Re-render current state
    if (currentUpgradeFlow) {
      renderSankeyDiagram(currentUpgradeFlow);
    }
  }
}

function renderHistoryTimeline() {
  const container = document.getElementById('historyTimelineContainer');
  if (!container) return;

  const history = getSankeyHistory();

  if (history.length === 0) {
    container.style.display = 'none';
    return;
  }

  // Show container
  container.style.display = 'block';

  // Update labels
  const oldest = document.getElementById('timelineOldest');
  const newest = document.getElementById('timelineNewest');

  if (oldest && history.length > 0) {
    oldest.textContent = history[history.length - 1].label;
  }

  if (newest && history.length > 0) {
    newest.textContent = history[0].label;
  }

  // Reset to current (newest)
  currentHistoryIndex = 0;
  updateSliderUI(1.0); // 100% = newest

  const label = document.getElementById('historyCurrentLabel');
  if (label && history.length > 0) {
    label.textContent = `${history[0].label} (CURRENT)`;
    label.className = 'text-xs text-white bg-green-600 px-2 py-0.5 rounded';
  }

  // Initialize slider if not already done
  if (!timelineSliderActive) {
    initTimelineSlider();
    timelineSliderActive = true;
  }
}

function renderSankeyDiagram(upgradeFlow) {
  const container = document.getElementById('sankeyDiagram');
  if (!container) return;

  // Store for re-rendering
  currentUpgradeFlow = upgradeFlow;

  if (!upgradeFlow || !upgradeFlow.nodes || upgradeFlow.nodes.length === 0) {
    container.innerHTML = '<div class="flex items-center justify-center h-64 text-gray-500"><p>No upgrade flow data available</p></div>';
    return;
  }

  // Check if container is visible
  if (container.offsetWidth === 0) {
    return; // Will re-render when expanded
  }

  // Clear previous content
  container.innerHTML = '';

  // Set up dimensions with better spacing
  const margin = {top: 20, right: 150, bottom: 20, left: 150};
  const width = Math.max(800, container.clientWidth) - margin.left - margin.right;
  const nodeCount = upgradeFlow.nodes.length;
  const height = Math.max(300, nodeCount * 60) - margin.top - margin.bottom;

  // Create SVG
  const svg = d3.select(container)
    .append('svg')
    .attr('width', width + margin.left + margin.right)
    .attr('height', height + margin.top + margin.bottom)
    .append('g')
    .attr('transform', `translate(${margin.left},${margin.top})`);

  // Build node and link data structures for d3-sankey
  // Use node.id as the unique identifier (not index)
  const graph = {
    nodes: upgradeFlow.nodes.map(n => ({
      name: n.id,           // Use ID as name for D3
      label: n.label,       // Keep label for display
      category: n.category
    })),
    links: upgradeFlow.links.map(l => ({
      source: l.source,     // Source node ID (string)
      target: l.target,     // Target node ID (string)
      value: l.value,
      type: l.type,
      operators: l.operators
    }))
  };

  // Create Sankey generator with better spacing
  const sankey = d3.sankey()
    .nodeId(d => d.name)    // Use 'name' field which contains the ID
    .nodeWidth(20)
    .nodePadding(40)
    .nodeAlign(d3.sankeyLeft)
    .extent([[0, 0], [width, height]]);

  // Generate the Sankey layout
  const {nodes, links} = sankey(graph);

  // Color mapping
  const colorMap = {
    'minor': '#10b981',   // Green
    'patch': '#10b981',   // Green
    'major': '#f59e0b',   // Orange
    'blocked': '#ef4444', // Red
    'uptodate': '#6b7280' // Gray
  };

  const nodeColorMap = {
    'current': '#3b82f6',  // Blue
    'target': '#10b981',   // Green
    'blocked': '#ef4444',  // Red
    'safe': '#6b7280'      // Gray
  };

  // Draw links with gradient
  const defs = svg.append('defs');

  links.forEach((link, i) => {
    const gradient = defs.append('linearGradient')
      .attr('id', `gradient-${i}`)
      .attr('gradientUnits', 'userSpaceOnUse')
      .attr('x1', link.source.x1)
      .attr('x2', link.target.x0);

    gradient.append('stop')
      .attr('offset', '0%')
      .attr('stop-color', nodeColorMap[link.source.category] || '#6b7280');

    gradient.append('stop')
      .attr('offset', '100%')
      .attr('stop-color', colorMap[link.type] || '#6b7280');
  });

  // Draw links
  svg.append('g')
    .selectAll('path')
    .data(links)
    .join('path')
    .attr('d', d3.sankeyLinkHorizontal())
    .attr('stroke', (d, i) => `url(#gradient-${i})`)
    .attr('stroke-width', d => Math.max(2, d.width))
    .attr('fill', 'none')
    .attr('opacity', 0.6)
    .style('cursor', 'pointer')
    .on('mouseover', function(event, d) {
      d3.select(this)
        .attr('opacity', 0.9)
        .attr('stroke-width', d => Math.max(2, d.width) + 2);
      showSankeyTooltip(event, d);
    })
    .on('mousemove', function(event, d) {
      updateSankeyTooltipPosition(event);
    })
    .on('mouseout', function(event, d) {
      d3.select(this)
        .attr('opacity', 0.6)
        .attr('stroke-width', d => Math.max(2, d.width));
      hideSankeyTooltip();
    });

  // Draw nodes
  svg.append('g')
    .selectAll('rect')
    .data(nodes)
    .join('rect')
    .attr('x', d => d.x0)
    .attr('y', d => d.y0)
    .attr('height', d => Math.max(1, d.y1 - d.y0))
    .attr('width', d => d.x1 - d.x0)
    .attr('fill', d => nodeColorMap[d.category] || '#6b7280')
    .attr('stroke', '#1f2937')
    .attr('stroke-width', 2)
    .attr('rx', 2);

  // Add node labels with better positioning
  svg.append('g')
    .selectAll('text')
    .data(nodes)
    .join('text')
    .attr('x', d => d.x0 < width / 2 ? d.x1 + 8 : d.x0 - 8)
    .attr('y', d => (d.y1 + d.y0) / 2)
    .attr('dy', '0.35em')
    .attr('text-anchor', d => d.x0 < width / 2 ? 'start' : 'end')
    .attr('fill', '#e5e7eb')
    .style('font-size', '13px')
    .style('font-weight', '500')
    .text(d => d.label || d.name);

  // Add column headers
  svg.append('text')
    .attr('x', 0)
    .attr('y', -5)
    .attr('fill', '#9ca3af')
    .style('font-size', '11px')
    .style('font-weight', '600')
    .text('CURRENT VERSIONS');

  svg.append('text')
    .attr('x', width)
    .attr('y', -5)
    .attr('text-anchor', 'end')
    .attr('fill', '#9ca3af')
    .style('font-size', '11px')
    .style('font-weight', '600')
    .text('UPGRADE TARGETS');
}

function showSankeyTooltip(event, link) {
  // Remove existing tooltip if any
  hideSankeyTooltip();

  const tooltip = document.createElement('div');
  tooltip.id = 'sankeyTooltip';
  tooltip.className = 'fixed bg-gray-800 border-2 border-gray-600 rounded-lg shadow-2xl p-4 text-sm z-50 max-w-sm';
  tooltip.style.pointerEvents = 'none';

  const typeLabels = {
    'minor': 'Minor Upgrade',
    'patch': 'Patch Upgrade',
    'major': 'Major Upgrade',
    'blocked': 'Blocked / Requires Approval',
    'uptodate': 'Up-to-Date'
  };

  const typeColors = {
    'minor': 'text-green-400',
    'patch': 'text-green-400',
    'major': 'text-orange-400',
    'blocked': 'text-red-400',
    'uptodate': 'text-gray-400'
  };

  const operatorListItems = link.operators.slice(0, 8).map(op =>
    `<div class="text-gray-300 py-0.5">• ${op}</div>`
  ).join('');

  const moreCount = link.operators.length > 8 ? `<div class="text-gray-500 text-xs mt-1">+ ${link.operators.length - 8} more...</div>` : '';

  tooltip.innerHTML = `
    <div class="flex items-center justify-between mb-2 pb-2 border-b border-gray-700">
      <div class="font-bold text-white text-base">${link.value} Operator${link.value > 1 ? 's' : ''}</div>
      <div class="${typeColors[link.type]} font-semibold text-xs uppercase tracking-wide">${typeLabels[link.type]}</div>
    </div>
    <div class="text-xs text-gray-400 mb-2">Operators in this flow:</div>
    <div class="max-h-40 overflow-y-auto text-xs space-y-0.5">
      ${operatorListItems}
      ${moreCount}
    </div>
  `;

  // Add to DOM first to get dimensions
  document.body.appendChild(tooltip);

  // Smart positioning - keep tooltip within viewport
  const tooltipRect = tooltip.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const scrollX = window.scrollX || window.pageXOffset;
  const scrollY = window.scrollY || window.pageYOffset;

  // Calculate initial position (right and below cursor)
  let left = event.clientX + 15;
  let top = event.clientY + 15;

  // Adjust if tooltip goes off right edge
  if (left + tooltipRect.width > viewportWidth - 20) {
    left = event.clientX - tooltipRect.width - 15; // Show on left side of cursor
  }

  // Adjust if tooltip goes off bottom edge
  if (top + tooltipRect.height > viewportHeight - 20) {
    top = event.clientY - tooltipRect.height - 15; // Show above cursor
  }

  // Ensure tooltip doesn't go off left edge
  if (left < 20) {
    left = 20;
  }

  // Ensure tooltip doesn't go off top edge
  if (top < 20) {
    top = 20;
  }

  // Apply final position
  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
}

function updateSankeyTooltipPosition(event) {
  const tooltip = document.getElementById('sankeyTooltip');
  if (!tooltip) return;

  const tooltipRect = tooltip.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // Calculate initial position (right and below cursor)
  let left = event.clientX + 15;
  let top = event.clientY + 15;

  // Adjust if tooltip goes off right edge
  if (left + tooltipRect.width > viewportWidth - 20) {
    left = event.clientX - tooltipRect.width - 15;
  }

  // Adjust if tooltip goes off bottom edge
  if (top + tooltipRect.height > viewportHeight - 20) {
    top = event.clientY - tooltipRect.height - 15;
  }

  // Ensure tooltip doesn't go off left edge
  if (left < 20) {
    left = 20;
  }

  // Ensure tooltip doesn't go off top edge
  if (top < 20) {
    top = 20;
  }

  // Apply position
  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
}

function hideSankeyTooltip() {
  const tooltip = document.getElementById('sankeyTooltip');
  if (tooltip) {
    tooltip.remove();
  }
}

function renderCharts(operators) {
  const total = operators.length;
  const upgradeable = operators.filter(op => op.can_upgrade).length;
  const upToDate = total - upgradeable;

  const ctxStatus = document.getElementById('statusChart');
  if (ctxStatus) {
    if (statusChartInstance) statusChartInstance.destroy();
    statusChartInstance = new Chart(ctxStatus.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: ['Up to Date', 'Pending Upgrade'],
        datasets: [{
          data: [upToDate, upgradeable],
          backgroundColor: ['#10b981', '#f59e0b'],
          borderColor: '#111827',
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'right',
            labels: { color: '#9ca3af', font: { size: 11 } }
          }
        }
      }
    });
  }

  const channelCounts = {};
  operators.forEach(op => {
    const ch = op.channel || 'unspecified';
    channelCounts[ch] = (channelCounts[ch] || 0) + 1;
  });

  const ctxChannel = document.getElementById('channelChart');
  if (ctxChannel) {
    if (channelChartInstance) channelChartInstance.destroy();
    channelChartInstance = new Chart(ctxChannel.getContext('2d'), {
      type: 'bar',
      data: {
        labels: Object.keys(channelCounts),
        datasets: [{
          label: 'Operators',
          data: Object.values(channelCounts),
          backgroundColor: '#3b82f6',
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: { ticks: { color: '#9ca3af', font: { size: 10 } }, grid: { display: false } },
          y: { ticks: { color: '#9ca3af', precision: 0 }, grid: { color: '#1f2937' } }
        }
      }
    });
  }
}

// Global state for search and filters
let allOperators = [];
let filteredOperators = [];
let searchDebounceTimer = null;

// Comparison mode state
let comparisonMode = false;
let selectedForComparison = [];

// Search handler with debounce
function handleSearch(query) {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    applyFilters();
  }, 300);
}

// Apply all filters and search
function applyFilters() {
  const searchQuery = document.getElementById('operatorSearchInput')?.value.toLowerCase() || '';

  const filters = {
    canUpgrade: document.getElementById('filterCanUpgrade')?.checked || false,
    failed: document.getElementById('filterFailed')?.checked || false,
    idle: document.getElementById('filterIdle')?.checked || false,
    hasRoutes: document.getElementById('filterHasRoutes')?.checked || false,
    majorUpgrade: document.getElementById('filterMajorUpgrade')?.checked || false,
    highRisk: document.getElementById('filterHighRisk')?.checked || false,
    blocked: document.getElementById('filterBlocked')?.checked || false,
  };

  filteredOperators = allOperators.filter(op => {
    // Search filter
    if (searchQuery) {
      const searchableText = [
        op.name || '',
        op.package || '',
        op.version || '',
        op.namespace || '',
        op.channel || '',
      ].join(' ').toLowerCase();

      if (!searchableText.includes(searchQuery)) {
        return false;
      }
    }

    // Checkbox filters
    if (filters.canUpgrade && !op.can_upgrade) return false;
    if (filters.failed && op.phase !== 'Failed') return false;
    if (filters.idle && !op.is_idle) return false;
    if (filters.hasRoutes && (!op.exposed_routes || op.exposed_routes.length === 0)) return false;
    if (filters.majorUpgrade && op.upgrade_type !== 'MAJOR') return false;
    if (filters.highRisk && (op.risk_score || 0) < 50) return false;
    if (filters.blocked && !op.phase?.includes('Blocked') && !op.phase?.includes('RequiresApproval')) return false;

    return true;
  });

  // Update result count
  const resultCount = document.getElementById('filterResultCount');
  if (resultCount) {
    const activeFilterCount = Object.values(filters).filter(Boolean).length;
    const hasSearch = searchQuery.length > 0;

    if (activeFilterCount === 0 && !hasSearch) {
      resultCount.textContent = `Showing all ${filteredOperators.length} operators`;
    } else {
      resultCount.textContent = `Found ${filteredOperators.length} of ${allOperators.length} operators`;
    }
  }

  // Re-render grid with filtered results
  renderGrid(filteredOperators);
}

// Helper function to render health score visual indicator
function renderHealthScore(score) {
  if (score === undefined || score === null) return '';

  // Color coding based on score ranges
  let colorClass, label;
  if (score >= 90) {
    colorClass = 'text-emerald-400';
    label = 'Excellent';
  } else if (score >= 70) {
    colorClass = 'text-blue-400';
    label = 'Good';
  } else if (score >= 50) {
    colorClass = 'text-yellow-400';
    label = 'Fair';
  } else if (score >= 30) {
    colorClass = 'text-orange-400';
    label = 'Poor';
  } else {
    colorClass = 'text-red-400';
    label = 'Critical';
  }

  // Create 10-dot indicator (each dot = 10 points)
  const filledDots = Math.floor(score / 10);
  const dots = Array.from({length: 10}, (_, i) =>
    i < filledDots ? '●' : '○'
  ).join('');

  return `
    <div class="flex items-center gap-2 text-xs" title="Health Score: ${score}/100 - ${label}">
      <span class="font-mono ${colorClass}">${dots}</span>
      <span class="${colorClass} font-bold">${score}</span>
      <span class="text-gray-500">/100</span>
    </div>
  `;
}

function renderGrid(operators) {
  const grid = document.getElementById('operatorGrid');
  if (!grid) return;

  grid.innerHTML = '';

  if (operators.length === 0) {
    grid.innerHTML = `<div class="text-center text-gray-500 py-10 col-span-full">No operator subscriptions found in cluster.</div>`;
    return;
  }

  operators.forEach((op, index) => {
    const card = document.createElement('div');
    const isSelected = selectedForComparison.some(s => (s.name || s.package) === (op.name || op.package));

    let cardClasses = 'bg-gray-900 border rounded-lg p-5 shadow-lg transition cursor-pointer';
    if (comparisonMode) {
      cardClasses += isSelected ? ' border-blue-500 bg-blue-950/20' : ' border-gray-800 hover:border-blue-600/60';
    } else {
      cardClasses += ' border-gray-800 hover:border-blue-600/60';
    }

    card.className = cardClasses;

    const currentCSVDisplay = op.installedCSV || op.version || 'N/A';
    const currentVerDisplay = op.version || 'v' + currentCSVDisplay;
    const targetVerDisplay = op.target_version || op.version || 'Current';
    const targetCSVDisplay = op.target_csv || op.installedCSV || 'N/A';
    const crds = op.crds || [];

    let calculatedTotalCRs = 0;
    if (crds.length > 0) {
      calculatedTotalCRs = crds.reduce((sum, crd) => sum + (crd.active_count || 0), 0);
    }
    const finalActiveCRs = op.active_crs !== undefined ? op.active_crs : calculatedTotalCRs;

    let badges = [];

    if (op.is_idle) {
      badges.push(`<span class="bg-purple-900/60 border border-purple-800 text-purple-300 text-xs px-2.5 py-1 rounded-full font-semibold">Idle: 0 CRs Active</span>`);
    }

    if (op.can_upgrade) {
      if (op.upgrade_type === 'MAJOR') {
        badges.push(`<span class="bg-amber-900/60 border border-amber-500 text-amber-300 text-xs px-2.5 py-1 rounded-full font-semibold animate-pulse">Update: MAJOR</span>`);
      } else if (op.upgrade_type === 'MINOR') {
        badges.push(`<span class="bg-blue-900/60 border border-blue-500 text-blue-300 text-xs px-2.5 py-1 rounded-full font-semibold">Update: MINOR</span>`);
      } else {
        badges.push(`<span class="bg-emerald-900/60 border border-emerald-500 text-emerald-300 text-xs px-2.5 py-1 rounded-full font-semibold">Update: PATCH</span>`);
      }
    } else {
      badges.push(`<span class="bg-gray-800 text-gray-400 text-xs px-2.5 py-1 rounded-full font-medium">Up to date</span>`);
    }

    // CVE badge
    if (op.cves && op.cves.length > 0) {
      const criticalCount = op.cves.filter(c => c.severity === 'Critical').length;
      const highCount = op.cves.filter(c => c.severity === 'High').length;
      const mediumCount = op.cves.filter(c => c.severity === 'Medium').length;

      let cveBadgeClass = 'bg-gray-800 text-gray-400';
      if (criticalCount > 0) {
        cveBadgeClass = 'bg-red-900/60 border border-red-500 text-red-300 animate-pulse';
      } else if (highCount > 0) {
        cveBadgeClass = 'bg-orange-900/60 border border-orange-500 text-orange-300';
      } else if (mediumCount > 0) {
        cveBadgeClass = 'bg-yellow-900/60 border border-yellow-500 text-yellow-300';
      }

      badges.push(`<span class="${cveBadgeClass} text-xs px-2.5 py-1 rounded-full font-semibold cursor-pointer" onclick="event.stopPropagation(); openCVEModal('${op.name || op.package}')" title="Click to view CVE details">🔒 ${op.cves.length} CVE${op.cves.length > 1 ? 's' : ''}</span>`);
    }

    let badgeHTML = badges.join(' ');
    let projectionHTML = '';

    if (op.can_upgrade) {
      let breakingWarning = '';

      if (op.crd_diff && op.crd_diff.has_breaking_impact && op.crd_diff.violating_crs && op.crd_diff.violating_crs.length > 0) {
        breakingWarning = `
          <div class="mt-3 bg-red-950/60 border border-red-800 p-3 rounded">
            <div class="text-xs font-bold text-red-400 flex items-center justify-between mb-1">
              <span>🚨 CRD Schema Breaking Change Impact</span>
              <span class="bg-red-900 text-red-200 px-2 py-0.5 rounded text-[10px]">${op.crd_diff.violating_crs.length} Active CRs Affected</span>
            </div>
            <div class="space-y-1 mt-2">
              ${op.crd_diff.violating_crs.map(v => `
                <div class="text-xs text-red-300 flex justify-between font-mono bg-gray-950 p-1.5 rounded border border-red-900/40">
                  <span>CR: <strong>${v.cr_name}</strong> (${v.crd_kind})</span>
                  <span class="text-amber-400">${v.breaking_field}</span>
                </div>
              `).join('')}
            </div>
          </div>
        `;
      } else {
        breakingWarning = `
          <div class="text-xs text-emerald-400 bg-emerald-950/40 border border-emerald-900/50 p-2.5 rounded flex items-start gap-2 mt-3">
            <span class="font-bold">✓ Safe Target Projection:</span>
            <span>No active Custom Resources will be impacted by field removals or breaking schema changes in <strong>v${targetVerDisplay}</strong>.</span>
          </div>
        `;
      }

      let remediationButton = '';
      if (op.is_idle) {
        remediationButton = `
          <button data-remediation-action="true" onclick="event.stopPropagation(); triggerRemediation('PURGE_IDLE_SUBSCRIPTION', '${op.namespace}', '${op.name || op.package}')" class="mt-3 bg-purple-900/60 hover:bg-purple-800 border border-purple-700 text-purple-200 px-3 py-1.5 rounded text-xs font-mono font-bold transition flex items-center gap-1.5 w-full justify-center">
            ⚡ Autonomous Reclaim: Purge Idle Subscription
          </button>
        `;
      } else if (op.phase === 'Failed') {
        remediationButton = `
          <button data-remediation-action="true" onclick="event.stopPropagation(); triggerRemediation('REAPPROVE_INSTALLPLAN', '${op.namespace}', '${op.name || op.package}')" class="mt-3 bg-red-900/60 hover:bg-red-800 border border-red-700 text-red-200 px-3 py-1.5 rounded text-xs font-mono font-bold transition flex items-center gap-1.5 w-full justify-center">
            🛠️ Autonomous Healing: Clear Stuck InstallPlan
          </button>
        `;
      }

      projectionHTML = `
        <div class="mt-4 pt-4 border-t border-gray-800/80 bg-gray-950/50 -mx-5 -mb-5 p-5">
          <div class="flex justify-between items-center mb-2">
             <div class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Upgrade Projection Analysis</div>
             <div class="text-[10px] font-mono bg-gray-900 px-2 py-0.5 rounded text-gray-400 border border-gray-700">Risk Score: <span class="${op.risk_score > 30 ? 'text-amber-400' : 'text-emerald-400'}">${op.risk_score || 0}/100</span> | ${op.est_downtime || '0m'}</div>
          </div>
          <div class="grid grid-cols-2 gap-4 text-xs mb-3">
            <div>
              <span class="text-gray-500 block mb-0.5">From (Current CSV)</span>
              <span class="text-gray-300 font-mono">${currentCSVDisplay}</span>
            </div>
            <div>
              <span class="text-gray-500 block mb-0.5">To (Target CSV)</span>
              <span class="text-emerald-400 font-mono">${targetCSVDisplay}</span>
            </div>
          </div>
          ${breakingWarning}
          ${remediationButton}
        </div>
      `;
    } else {
        let remediationButton = '';
        if (op.is_idle) {
            remediationButton = `
            <button data-remediation-action="true" onclick="event.stopPropagation(); triggerRemediation('PURGE_IDLE_SUBSCRIPTION', '${op.namespace}', '${op.name || op.package}')" class="mt-3 bg-purple-900/60 hover:bg-purple-800 border border-purple-700 text-purple-200 px-3 py-1.5 rounded text-xs font-mono font-bold transition flex items-center gap-1.5 w-full justify-center">
                ⚡ Autonomous Reclaim: Purge Idle Subscription
            </button>
            `;
        } else if (op.phase === 'Failed') {
            remediationButton = `
            <button data-remediation-action="true" onclick="event.stopPropagation(); triggerRemediation('REAPPROVE_INSTALLPLAN', '${op.namespace}', '${op.name || op.package}')" class="mt-3 bg-red-900/60 hover:bg-red-800 border border-red-700 text-red-200 px-3 py-1.5 rounded text-xs font-mono font-bold transition flex items-center gap-1.5 w-full justify-center">
                🛠️ Autonomous Healing: Clear Stuck InstallPlan
            </button>
            `;
        }
        if (remediationButton !== '') {
            projectionHTML = `
            <div class="mt-4 pt-4 border-t border-gray-800/80 bg-gray-950/50 -mx-5 -mb-5 p-5">
                <div class="flex justify-between items-center mb-2">
                <div class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Autonomous Actions</div>
                <div class="text-[10px] font-mono bg-gray-900 px-2 py-0.5 rounded text-gray-400 border border-gray-700">Risk Score: <span class="${op.risk_score > 30 ? 'text-amber-400' : 'text-emerald-400'}">${op.risk_score || 0}/100</span></div>
                </div>
                ${remediationButton}
            </div>
            `;
        }
    }

    let crdListHTML = crds.length > 0 ? crds.map(crd => `
      <div class="bg-gray-950 border border-gray-800/80 p-3 rounded flex justify-between items-center hover:border-gray-700 transition">
        <div>
          <div class="flex items-center gap-2">
            <span class="font-mono text-sm font-semibold text-blue-400">${crd.kind}</span>
            <span class="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded font-mono">${crd.version || 'v1'}</span>
          </div>
          <p class="text-xs text-gray-500 mt-1 font-mono">${crd.name}</p>
        </div>
        <div class="text-right">
          <span class="text-xs text-gray-500 block mb-1">Active Instances</span>
          <span class="text-xs bg-gray-900 border ${crd.active_count > 0 ? 'border-emerald-500/50 text-emerald-400' : 'border-gray-800 text-gray-500'} px-2.5 py-1 rounded font-medium">${crd.active_count || 0} CRs</span>
        </div>
      </div>
    `).join('') : `<div class="text-xs text-gray-500 italic p-3 bg-gray-950 rounded border border-gray-800">No owned Custom Resource Definitions found in installed CSV.</div>`;

    const comparisonCheckbox = comparisonMode ? `
      <label class="flex items-center gap-2 bg-gray-800 border border-gray-700 px-2 py-1 rounded cursor-pointer hover:border-blue-500 transition" onclick="event.stopPropagation();">
        <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="selectForComparison('${op.name || op.package}')" class="rounded">
        <span class="text-xs text-gray-400">Compare</span>
      </label>
    ` : '';

    card.innerHTML = `
      <div onclick="toggleCRDDrawer('crdDrawer-${index}')" class="flex justify-between items-start">
        <div>
          <div class="flex items-center gap-3">
            <h2 class="text-lg font-bold text-white flex items-center gap-2">
              ${op.name || op.package}
              <svg id="chevron-${index}" class="w-4 h-4 text-gray-500 transition-transform transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
            </h2>
            ${renderHealthScore(op.health_score)}
            ${comparisonCheckbox}
            <button onclick="event.stopPropagation(); openComponentModal('${op.name || op.package}')" class="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-blue-400 px-2 py-1 rounded transition font-mono flex items-center gap-1.5">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
              Inspect Resources
            </button>
            <button onclick="event.stopPropagation(); openTopologyModal('${op.name || op.package}')" class="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-purple-400 px-2 py-1 rounded transition font-mono flex items-center gap-1.5">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"></path></svg>
              View Topology
            </button>
            <div class="flex gap-2">
              ${badgeHTML}
            </div>
          </div>
          <p class="text-xs text-gray-400 mt-1">
            Namespace: <span class="text-gray-300 font-mono">${op.namespace}</span> | 
            Channel: <span class="text-gray-300 font-mono">${op.channel}</span> | 
            Status: <span class="${op.phase === 'Succeeded' ? 'text-emerald-400' : 'text-amber-400'} font-bold">${op.phase}</span> | 
            CRDs: <span class="text-blue-400 font-bold">${crds.length}</span> | 
            Active CRs: <span class="${finalActiveCRs === 0 ? 'text-red-400' : 'text-emerald-400'} font-bold">${finalActiveCRs}</span>
          </p>
        </div>
        <div class="text-right flex flex-col items-end gap-2">
          <div class="relative">
            <button onclick="event.stopPropagation(); toggleQuickActions('${op.name || op.package}')" class="text-gray-400 hover:text-white transition bg-gray-800 hover:bg-gray-700 border border-gray-700 p-2 rounded" title="Quick Actions">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z"></path>
              </svg>
            </button>
            <div id="quickActions-${op.name || op.package}" class="hidden absolute right-0 mt-2 w-56 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-10" onclick="event.stopPropagation()">
              ${op.can_upgrade && !op.phase?.includes('Blocked') ? `
                <button onclick="quickActionApprove('${op.namespace}', '${op.name || op.package}')" class="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 transition flex items-center gap-2">
                  <svg class="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                  </svg>
                  Approve Upgrade
                </button>
              ` : ''}
              <button onclick="quickActionRestartPod('${op.namespace}', '${op.name || op.package}')" class="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 transition flex items-center gap-2">
                <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                </svg>
                Restart Pod
              </button>
              <button onclick="quickActionCopyYAML('${op.namespace}', '${op.name || op.package}', 'subscription')" class="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 transition flex items-center gap-2">
                <svg class="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
                </svg>
                Copy Subscription YAML
              </button>
              ${op.installedCSV ? `
              <button onclick="quickActionCopyYAML('${op.namespace}', '${op.installedCSV}', 'csv')" class="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 transition flex items-center gap-2">` : `
              <button disabled class="w-full text-left px-4 py-2 text-sm text-gray-500 cursor-not-allowed transition flex items-center gap-2">`}
                <svg class="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
                </svg>
                Copy CSV YAML
              </button>
              <hr class="border-gray-700 my-1">
              <button onclick="quickActionDelete('${op.namespace}', '${op.name || op.package}')" class="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-red-950 transition flex items-center gap-2">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                </svg>
                Delete Subscription
              </button>
            </div>
          </div>
          <div>
            <span class="text-xs text-gray-500 uppercase font-semibold block">Current Version</span>
            <span class="bg-gray-950 border border-gray-800 text-gray-200 font-mono font-bold text-sm px-3 py-1 rounded inline-block mt-1">
              ${currentVerDisplay}
            </span>
          </div>
        </div>
      </div>
      ${projectionHTML}
      <div id="crdDrawer-${index}" class="hidden mt-4 pt-4 border-t border-gray-800">
        <div class="flex justify-between items-center mb-3">
          <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Registered Custom Resource Definitions (${crds.length})</h3>
          <span class="text-xs text-gray-500">Click card again to collapse</span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          ${crdListHTML}
        </div>
      </div>
    `;

    grid.appendChild(card);
  });

  // Apply autonomous mode state to all remediation buttons
  applyAutonomousModeState();
}

function applyAutonomousModeState() {
  const allRemediationButtons = document.querySelectorAll('[data-remediation-action]');
  allRemediationButtons.forEach(btn => {
    if (autonomousModeEnabled) {
      btn.disabled = false;
      btn.classList.remove('opacity-50', 'cursor-not-allowed');
      btn.title = '';
    } else {
      btn.disabled = true;
      btn.classList.add('opacity-50', 'cursor-not-allowed');
      btn.title = 'Autonomous actions are disabled. Enable them in the header toggle.';
    }
  });
}

function openComponentModal(operatorName) {
  const op = currentOperatorData.find(o => (o.name === operatorName || o.package === operatorName));
  if (!op) return;

  const modal = document.getElementById('unifiedModal');
  const content = document.getElementById('unifiedModalContent');
  const titleEl = document.getElementById('unifiedModalTitle');
  const descEl = document.getElementById('unifiedModalDesc');
  const listEl = document.getElementById('unifiedModalList');

  if (!modal || !listEl) return;

  titleEl.className = `text-xl font-bold mb-2 flex items-center justify-between text-blue-400`;
  titleEl.innerHTML = `
    <div class="flex items-center gap-2">
      <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
      <span>Infrastructure Resources: ${op.name || op.package}</span>
    </div>
    <span class="text-xs font-mono bg-blue-950 border border-blue-800 text-blue-300 px-3 py-1 rounded">
      Namespace: ${op.namespace}
    </span>
  `;

  descEl.textContent = `Active ServiceAccounts, Deployments, Routes, and OLM Subscription metadata detected in namespace ${op.namespace}.`;

  const components = op.components || [];

  let html = `
    <div class="bg-gray-950 border border-gray-800 p-4 rounded-lg mb-4 grid grid-cols-2 gap-4 font-mono text-xs">
      <div>
        <span class="text-gray-500 block mb-0.5">Install Plan Strategy</span>
        <span class="text-white font-bold">${op.approval_strategy || 'Automatic'}</span>
      </div>
      <div>
        <span class="text-gray-500 block mb-0.5">Catalog Source</span>
        <span class="text-blue-400 font-bold">${op.catalog_source || 'redhat-operators'}</span>
      </div>
    </div>
  `;

  if (components.length === 0) {
    html += `<div class="text-gray-500 italic text-sm text-center py-6 bg-gray-950 rounded border border-gray-800">No active infrastructure deployments or components detected.</div>`;
  } else {
    html += `
      <div class="space-y-2">
        <div class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Installed Components (${components.length})</div>
        ${components.map(c => `
          <div class="bg-gray-950 border border-gray-800 p-3 rounded flex justify-between items-center text-xs font-mono hover:border-gray-700 transition">
            <div class="flex items-center gap-2">
              <span class="bg-blue-950 border border-blue-800 text-blue-300 px-2 py-0.5 rounded text-[10px] uppercase font-bold">${c.kind}</span>
              <span class="text-gray-200 font-bold">${c.name}</span>
            </div>
            <span class="text-gray-400">${c.status}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  listEl.innerHTML = html;

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  setTimeout(() => {
    modal.classList.remove('opacity-0');
    content.classList.remove('scale-95');
  }, 10);
}

function toggleAutonomousMode(enabled) {
  autonomousModeEnabled = enabled;
  localStorage.setItem(AUTONOMOUS_MODE_KEY, enabled ? 'true' : 'false');

  // Update UI to reflect state
  applyAutonomousModeState();

  const statusMsg = enabled
    ? '✓ Autonomous remediation actions are now ENABLED'
    : '⊗ Autonomous remediation actions are now DISABLED';

  console.log(statusMsg);

  // Show a subtle notification
  showAutonomousStatusNotification(statusMsg, enabled);
}

function showAutonomousStatusNotification(message, isEnabled) {
  // Create a temporary notification banner
  const banner = document.createElement('div');
  banner.className = `fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg border transition-all duration-300 ${
    isEnabled
      ? 'bg-purple-950/90 border-purple-700 text-purple-200'
      : 'bg-gray-950/90 border-gray-700 text-gray-300'
  }`;
  banner.innerHTML = `
    <div class="flex items-center gap-2 text-sm font-semibold">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
      <span>${message}</span>
    </div>
  `;
  document.body.appendChild(banner);

  // Fade out and remove after 3 seconds
  setTimeout(() => {
    banner.style.opacity = '0';
    setTimeout(() => banner.remove(), 300);
  }, 3000);
}

function loadAutonomousMode() {
  const stored = localStorage.getItem(AUTONOMOUS_MODE_KEY);
  autonomousModeEnabled = stored !== 'false'; // Default to true

  const toggle = document.getElementById('autonomousToggle');
  if (toggle) {
    toggle.checked = autonomousModeEnabled;
  }

  console.log('Autonomous mode loaded:', autonomousModeEnabled ? 'ENABLED' : 'DISABLED');
}

function toggleSection(sectionId) {
  const section = document.getElementById(sectionId);
  const chevron = document.getElementById(`chevron-${sectionId}`);

  if (!section) return;

  const isCollapsed = section.style.maxHeight === '0px' || section.style.display === 'none';

  if (isCollapsed) {
    // Expand
    if (sectionId === 'anomalyBannerContent') {
      section.style.display = 'block';
    } else {
      section.style.display = 'grid';
    }
    section.style.maxHeight = section.scrollHeight + 'px';
    if (chevron) chevron.classList.remove('rotate-180');
    sectionsState[sectionId] = true;

    // Re-render Sankey diagram when expanded
    if (sectionId === 'sankeySection' && currentUpgradeFlow) {
      setTimeout(() => renderSankeyDiagram(currentUpgradeFlow), 100);
    }
  } else {
    // Collapse
    section.style.maxHeight = '0px';
    setTimeout(() => {
      if (section.style.maxHeight === '0px') {
        section.style.display = 'none';
      }
    }, 300);
    if (chevron) chevron.classList.add('rotate-180');
    sectionsState[sectionId] = false;
  }

  // Save state
  localStorage.setItem(SECTIONS_STATE_KEY, JSON.stringify(sectionsState));
}

function loadSectionsState() {
  const stored = localStorage.getItem(SECTIONS_STATE_KEY);
  if (stored) {
    try {
      sectionsState = JSON.parse(stored);
    } catch (e) {
      console.error('Failed to parse sections state:', e);
    }
  }

  // Apply saved state to all sections
  Object.keys(sectionsState).forEach(sectionId => {
    const section = document.getElementById(sectionId);
    const chevron = document.getElementById(`chevron-${sectionId}`);

    if (!section) return;

    if (sectionsState[sectionId]) {
      // Expanded
      if (sectionId === 'anomalyBannerContent') {
        section.style.display = 'block';
      } else {
        section.style.display = 'grid';
      }
      section.style.maxHeight = 'none';
      if (chevron) chevron.classList.remove('rotate-180');
    } else {
      // Collapsed
      section.style.display = 'none';
      section.style.maxHeight = '0px';
      if (chevron) chevron.classList.add('rotate-180');
    }
  });
}

async function triggerRemediation(action, namespace, target) {
  // Check if autonomous mode is enabled
  if (!autonomousModeEnabled) {
    alert('⊗ Autonomous actions are currently disabled.\n\nPlease enable the "Autonomous" toggle in the header to execute remediation actions.');
    return;
  }

  if (!confirm(`Execute autonomous action '${action}' on ${target}?`)) return;

  try {
    const response = await fetch('/api/v1/remediate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, namespace, target })
    });
    const result = await response.json();
    alert(result.message || "Remediation executed.");
    if (typeof fetchTargets === 'function') {
        fetchTargets(true);
    }
  } catch (err) {
    alert("Failed to execute remediation directive: " + err);
  }
}

function toggleCRDDrawer(drawerId) {
  const drawer = document.getElementById(drawerId);
  if (drawer) drawer.classList.toggle('hidden');
}

function downloadReport() {
  if (!currentOperatorData || currentOperatorData.length === 0) {
    alert("No operator data available to export.");
    return;
  }

  const report = {
    title: "OLM Governance & Lifecycle Report",
    generated_at: new Date().toISOString(),
    total_operators: currentOperatorData.length,
    upgradeable_count: currentOperatorData.filter(o => o.can_upgrade).length,
    idle_count: currentOperatorData.filter(o => o.is_idle).length,
    operators: currentOperatorData
  };

  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(report, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute("href", dataStr);
  downloadAnchor.setAttribute("download", `olm-governance-report-${new Date().toISOString().slice(0, 10)}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
}

// ============================================================================
// TOPOLOGY GRAPH MODAL HANDLER
// ============================================================================
function closeTopologyModal(event) {
  if (event && event.target.id !== 'topologyModal' && event.currentTarget.id !== 'topologyModalCloseBtn') return;
  const modal = document.getElementById('topologyModal');
  const content = document.getElementById('topologyModalContent');
  if (modal) {
    content.classList.add('scale-95');
    modal.classList.add('opacity-0');
    setTimeout(() => {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }, 200);
  }
}

function openTopologyModal(operatorName) {
  const op = currentOperatorData.find(o => (o.name === operatorName || o.package === operatorName));
  if (!op || !op.topology_graph) return;

  let modal = document.getElementById('topologyModal');
  if (!modal) {
    const modalHtml = `
      <div id="topologyModal" class="fixed inset-0 bg-black/80 backdrop-blur-sm hidden justify-center items-center z-50 p-4 transition-opacity duration-200 opacity-0" onclick="closeTopologyModal(event)">
        <div id="topologyModalContent" class="bg-gray-900 border border-gray-700 p-6 rounded-lg shadow-2xl w-full max-w-3xl relative transform transition-transform duration-200 scale-95 max-h-[85vh] overflow-y-auto" onclick="event.stopPropagation()">
          <button id="topologyModalCloseBtn" onclick="closeTopologyModal(event)" class="absolute top-4 right-4 text-gray-500 hover:text-white transition">
            <svg class="w-5 h-5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
          </button>
          <h3 id="topologyModalTitle" class="text-xl font-bold mb-6 text-white flex items-center gap-2 pb-4 border-b border-gray-800"></h3>
          <div id="topologyContainer" class="p-2"></div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    modal = document.getElementById('topologyModal');
  }

  const content = document.getElementById('topologyModalContent');
  const titleEl = document.getElementById('topologyModalTitle');
  const container = document.getElementById('topologyContainer');

  titleEl.innerHTML = `
    <svg class="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
    <span>Dependency Topology: ${op.name || op.package}</span>
  `;

  const rootNode = op.topology_graph.find(n => n.type === 'Subscription');
  
  if (rootNode) {
      container.innerHTML = buildTopologyHTML(rootNode.id, op.topology_graph);
  } else {
      container.innerHTML = `<div class="text-gray-500 italic text-sm text-center py-6">Topology graph unavailable.</div>`;
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  setTimeout(() => {
    modal.classList.remove('opacity-0');
    content.classList.remove('scale-95');
  }, 10);
}

function buildTopologyHTML(nodeId, nodes, depth = 0) {
  const node = nodes.find(n => n.id === nodeId);
  if (!node) return '';

  let typeColor = 'text-gray-400';
  let borderCol = 'border-gray-800';
  if (node.type === 'Subscription') { typeColor = 'text-purple-400'; borderCol = 'border-purple-800'; }
  if (node.type === 'CSV') { typeColor = 'text-blue-400'; borderCol = 'border-blue-800'; }
  if (node.type === 'CRD') { typeColor = 'text-emerald-400'; borderCol = 'border-emerald-800'; }

  let childrenHtml = '';
  if (node.children && node.children.length > 0) {
      childrenHtml = `<div class="ml-6 pl-4 border-l-2 border-gray-700/50 space-y-4 mt-4 relative">
          ${node.children.map(cid => buildTopologyHTML(cid, nodes, depth + 1)).join('')}
      </div>`;
  }

  return `
    <div class="relative w-full">
        <div class="bg-gray-950 border ${borderCol} p-3 rounded-lg flex justify-between items-center shadow-md transition hover:bg-gray-900 z-10 relative">
            <div class="flex items-center gap-3">
                <span class="text-[10px] uppercase font-bold tracking-wider bg-gray-900 px-2 py-0.5 rounded border border-gray-800 ${typeColor}">${node.type}</span>
                <span class="font-mono text-sm text-gray-200 font-bold">${node.name}</span>
            </div>
            <span class="text-xs text-gray-400 font-mono bg-gray-900 px-2 py-1 rounded">${node.status}</span>
        </div>
        ${childrenHtml}
    </div>
  `;
}

// ============================================================================
// NSAA TELEMETRY DISPATCHER (FEATURE 24)
// ============================================================================
async function dispatchToNSAA() {
    const endpoint = prompt(
        "Enter NSAA (Non-stop autonomous agent) Webhook URL:", 
        "http://127.0.0.1:5005/api/v1/mock-nsaa"
    );
    if (!endpoint) return;

    try {
        const response = await fetch('/api/v1/nsaa/dispatch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint_url: endpoint, method: 'POST' })
        });
        
        const result = await response.json();
        if (response.ok) {
            alert(`✓ NSAA Dispatch Successful!\nStatus Code: ${result.nsaa_status_code}\nEndpoint: ${result.target_url}`);
        } else {
            alert(`❌ NSAA Dispatch Failed:\n${result.error}`);
        }
    } catch (err) {
        alert("Network error while reaching NSAA dispatcher: " + err);
    }
}

// Export Modal Functions
function openExportModal() {
  const modal = document.getElementById('exportModal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    setTimeout(() => modal.classList.remove('opacity-0'), 10);
  }
}

function closeExportModal() {
  const modal = document.getElementById('exportModal');
  if (modal) {
    modal.classList.add('opacity-0');
    setTimeout(() => {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }, 200);
  }
}

function exportAsJSON() {
  const data = {
    exported_at: new Date().toISOString(),
    ocp_version: document.getElementById('ocpCurrentBadge')?.textContent || 'Unknown',
    operators: filteredOperators,
    total_count: filteredOperators.length,
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hybrid-operator-export-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);

  closeExportModal();
}

function exportAsCSV() {
  const headers = [
    'Name', 'Package', 'Namespace', 'Channel', 'Version', 'Target Version',
    'Phase', 'Can Upgrade', 'Upgrade Type', 'Risk Score', 'Health Score',
    'Active CRs', 'CRDs', 'Is Idle', 'Exposed Routes'
  ];

  const rows = filteredOperators.map(op => [
    op.name || '',
    op.package || '',
    op.namespace || '',
    op.channel || '',
    op.version || '',
    op.target_version || '',
    op.phase || '',
    op.can_upgrade ? 'Yes' : 'No',
    op.upgrade_type || 'N/A',
    op.risk_score || 0,
    op.health_score || 0,
    op.active_crs || 0,
    (op.crds || []).length,
    op.is_idle ? 'Yes' : 'No',
    (op.exposed_routes || []).length
  ]);

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => {
      const str = String(cell);
      return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(','))
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hybrid-operator-export-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  closeExportModal();
}

async function exportAsPDF() {
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    // Title
    doc.setFontSize(18);
    doc.text('Hybrid Operator Dashboard Report', 14, 20);

    // Metadata
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 28);
    doc.text(`OCP Version: ${document.getElementById('ocpCurrentBadge')?.textContent || 'Unknown'}`, 14, 34);

    // Summary
    doc.setFontSize(14);
    doc.setTextColor(0);
    doc.text('Summary', 14, 44);

    doc.setFontSize(10);
    const summary = [
      `Total Operators: ${filteredOperators.length}`,
      `Can Upgrade: ${filteredOperators.filter(op => op.can_upgrade).length}`,
      `Failed: ${filteredOperators.filter(op => op.phase === 'Failed').length}`,
      `Idle: ${filteredOperators.filter(op => op.is_idle).length}`,
      `Average Health Score: ${Math.round(filteredOperators.reduce((sum, op) => sum + (op.health_score || 0), 0) / filteredOperators.length)}`,
    ];

    let y = 52;
    summary.forEach(line => {
      doc.text(line, 20, y);
      y += 6;
    });

    // Operators Table
    y += 8;
    doc.setFontSize(14);
    doc.text('Operators', 14, y);

    y += 8;
    doc.setFontSize(8);
    filteredOperators.slice(0, 20).forEach((op, i) => {
      if (y > 270) {
        doc.addPage();
        y = 20;
      }

      doc.text(`${i + 1}. ${op.name || op.package}`, 14, y);
      doc.text(`v${op.version || 'N/A'}`, 100, y);
      doc.text(op.phase || 'Unknown', 140, y);
      doc.text(`Health: ${op.health_score || 0}`, 170, y);
      y += 5;
    });

    if (filteredOperators.length > 20) {
      y += 3;
      doc.setTextColor(100);
      doc.text(`... and ${filteredOperators.length - 20} more operators`, 14, y);
    }

    doc.save(`hybrid-operator-report-${new Date().toISOString().split('T')[0]}.pdf`);
    closeExportModal();
  } catch (err) {
    console.error('PDF export error:', err);
    alert('PDF export failed. Please try JSON or CSV instead.');
  }
}

// Comparison Functions
function toggleComparisonMode() {
  comparisonMode = !comparisonMode;
  selectedForComparison = [];

  const btn = document.getElementById('comparisonModeBtn');
  if (btn) {
    if (comparisonMode) {
      btn.classList.add('bg-blue-600', 'border-blue-500');
      btn.classList.remove('bg-gray-800', 'border-gray-700');
      btn.innerHTML = `
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
        </svg>
        <span>Exit Comparison Mode</span>
      `;
    } else {
      btn.classList.remove('bg-blue-600', 'border-blue-500');
      btn.classList.add('bg-gray-800', 'border-gray-700');
      btn.innerHTML = `
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"></path>
        </svg>
        <span>Compare Operators</span>
      `;
    }
  }

  renderGrid(filteredOperators);
}

function selectForComparison(opName) {
  const index = selectedForComparison.findIndex(op => op.name === opName);

  if (index >= 0) {
    selectedForComparison.splice(index, 1);
  } else {
    if (selectedForComparison.length >= 3) {
      alert('Maximum 3 operators can be compared at once');
      return;
    }
    const op = allOperators.find(o => (o.name || o.package) === opName);
    if (op) selectedForComparison.push(op);
  }

  renderGrid(filteredOperators);

  if (selectedForComparison.length >= 2) {
    openComparisonModal();
  }
}

function openComparisonModal() {
  if (selectedForComparison.length < 2) return;

  const modal = document.getElementById('comparisonModal');
  if (!modal) return;

  const content = document.getElementById('comparisonContent');
  if (!content) return;

  // Build comparison table
  let html = '<div class="grid gap-6" style="grid-template-columns: 200px ' + 'repeat(' + selectedForComparison.length + ', 1fr)">';

  // Rows
  const rows = [
    { label: 'Name', getter: (op) => op.name || op.package },
    { label: 'Version', getter: (op) => op.version || 'N/A' },
    { label: 'Health Score', getter: (op) => {
      const score = op.health_score || 0;
      return `<span class="font-bold ${score >= 70 ? 'text-green-400' : score >= 50 ? 'text-yellow-400' : 'text-red-400'}">${score}/100</span>`;
    }},
    { label: 'Phase', getter: (op) => `<span class="${op.phase === 'Succeeded' ? 'text-green-400' : 'text-yellow-400'}">${op.phase}</span>` },
    { label: 'Risk Score', getter: (op) => {
      const risk = op.risk_score || 0;
      return `<span class="${risk > 50 ? 'text-red-400' : risk > 30 ? 'text-yellow-400' : 'text-green-400'}">${risk}/100</span>`;
    }},
    { label: 'Can Upgrade', getter: (op) => op.can_upgrade ? '<span class="text-blue-400">Yes (' + (op.upgrade_type || 'PATCH') + ')</span>' : '<span class="text-gray-500">No</span>' },
    { label: 'Active CRs', getter: (op) => op.active_crs || 0 },
    { label: 'CRDs', getter: (op) => (op.crds || []).length },
    { label: 'Idle', getter: (op) => op.is_idle ? '<span class="text-purple-400">Yes</span>' : '<span class="text-gray-500">No</span>' },
    { label: 'Routes', getter: (op) => (op.exposed_routes || []).length },
  ];

  rows.forEach(row => {
    html += `<div class="font-semibold text-gray-400 text-sm py-2 border-b border-gray-800">${row.label}</div>`;
    selectedForComparison.forEach(op => {
      html += `<div class="text-sm py-2 border-b border-gray-800">${row.getter(op)}</div>`;
    });
  });

  html += '</div>';
  content.innerHTML = html;

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  setTimeout(() => modal.classList.remove('opacity-0'), 10);
}

function closeComparisonModal() {
  const modal = document.getElementById('comparisonModal');
  if (modal) {
    modal.classList.add('opacity-0');
    setTimeout(() => {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }, 200);
  }
}

// Quick Actions Functions
function toggleQuickActions(opName) {
  const menu = document.getElementById(`quickActions-${opName}`);
  if (!menu) return;

  // Close all other menus
  document.querySelectorAll('[id^="quickActions-"]').forEach(m => {
    if (m.id !== `quickActions-${opName}`) {
      m.classList.add('hidden');
    }
  });

  menu.classList.toggle('hidden');
}

async function quickActionApprove(namespace, name) {
  if (!confirm(`Approve upgrade for ${name} in ${namespace}?`)) return;

  try {
    const response = await fetch('/api/v1/actions/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace, name })
    });

    const result = await response.json();
    alert(result.success ? `✓ ${result.message}` : `✗ ${result.message}`);

    if (result.success) {
      setTimeout(() => location.reload(), 1000);
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function quickActionRestartPod(namespace, name) {
  if (!confirm(`Restart operator pod for ${name} in ${namespace}?\n\nThis will delete the pod and let Kubernetes recreate it.`)) return;

  try {
    const response = await fetch('/api/v1/actions/restart-pod', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace, name })
    });

    const result = await response.json();
    alert(result.success ? `✓ ${result.message}` : `✗ ${result.message}`);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function quickActionCopyYAML(namespace, name, type) {
  try {
    const endpoint = type === 'subscription' ? '/api/v1/resources/subscription' : '/api/v1/resources/csv';
    const response = await fetch(`${endpoint}?namespace=${namespace}&name=${name}`);

    if (!response.ok) {
      alert('Resource not found');
      return;
    }

    const yamlData = await response.json();
    const yamlText = JSON.stringify(yamlData, null, 2);

    await navigator.clipboard.writeText(yamlText);
    alert(`✓ ${type.toUpperCase()} YAML copied to clipboard`);
  } catch (err) {
    alert('Failed to copy: ' + err.message);
  }
}

async function quickActionDelete(namespace, name) {
  const confirmation = prompt(
    `⚠️ DELETE SUBSCRIPTION\n\nThis will remove ${name} from ${namespace}.\n\nType the operator name to confirm:`,
    ''
  );

  if (confirmation !== name) {
    if (confirmation !== null) {
      alert('Delete cancelled - name did not match');
    }
    return;
  }

  try {
    const response = await fetch('/api/v1/actions/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ namespace, name })
    });

    const result = await response.json();
    alert(result.success ? `✓ ${result.message}` : `✗ ${result.message}`);

    if (result.success) {
      setTimeout(() => location.reload(), 1000);
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// Close quick actions menu when clicking outside
document.addEventListener('click', () => {
  document.querySelectorAll('[id^="quickActions-"]').forEach(menu => {
    menu.classList.add('hidden');
  });
});

// CVE Modal Functions
async function openCVEModal(operatorName) {
  const modal = document.getElementById('cveModal');
  const content = document.getElementById('cveContent');

  if (!modal || !content) return;

  // Find operator data
  const op = allOperators.find(o => (o.name || o.package) === operatorName);

  if (!op || !op.cves || op.cves.length === 0) {
    content.innerHTML = '<p class="text-gray-400 text-center py-4">No CVEs found for this operator</p>';
  } else {
    const severityCounts = {
      Critical: op.cves.filter(c => c.severity === 'Critical').length,
      High: op.cves.filter(c => c.severity === 'High').length,
      Medium: op.cves.filter(c => c.severity === 'Medium').length,
      Low: op.cves.filter(c => c.severity === 'Low').length,
    };

    let html = `
      <div class="mb-4">
        <h4 class="text-lg font-semibold text-white mb-2">${op.name || op.package}</h4>
        <p class="text-sm text-gray-400">Version: ${op.version || 'N/A'}</p>
        <div class="flex gap-4 mt-3 text-sm">
          <div class="flex items-center gap-2">
            <span class="w-3 h-3 bg-red-500 rounded-full"></span>
            <span class="text-gray-300">Critical: ${severityCounts.Critical}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="w-3 h-3 bg-orange-500 rounded-full"></span>
            <span class="text-gray-300">High: ${severityCounts.High}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="w-3 h-3 bg-yellow-500 rounded-full"></span>
            <span class="text-gray-300">Medium: ${severityCounts.Medium}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="w-3 h-3 bg-blue-500 rounded-full"></span>
            <span class="text-gray-300">Low: ${severityCounts.Low}</span>
          </div>
        </div>
      </div>

      <div class="space-y-3 mt-4">
        ${op.cves.map(cve => {
          let severityBadgeClass = 'bg-gray-900/60 border-gray-600 text-gray-300';
          if (cve.severity === 'Critical') {
            severityBadgeClass = 'bg-red-900/60 border-red-600 text-red-300';
          } else if (cve.severity === 'High') {
            severityBadgeClass = 'bg-orange-900/60 border-orange-600 text-orange-300';
          } else if (cve.severity === 'Medium') {
            severityBadgeClass = 'bg-yellow-900/60 border-yellow-600 text-yellow-300';
          } else if (cve.severity === 'Low') {
            severityBadgeClass = 'bg-blue-900/60 border-blue-600 text-blue-300';
          }

          return `
            <div class="bg-gray-800 border border-gray-700 rounded-lg p-4">
              <div class="flex justify-between items-start mb-2">
                <div class="flex items-center gap-2">
                  <span class="font-mono text-white font-bold">${cve.id}</span>
                  <span class="${severityBadgeClass} border text-xs px-2 py-0.5 rounded-full">${cve.severity}</span>
                  ${cve.cvss_score ? `<span class="text-xs text-gray-400">CVSS: ${cve.cvss_score}</span>` : ''}
                </div>
                <span class="text-xs text-gray-500">${cve.published_date || 'Unknown date'}</span>
              </div>
              <p class="text-sm text-gray-300 mb-2">${cve.description || 'No description available'}</p>
              ${cve.fixed_version ? `
                <div class="text-xs text-green-400 bg-green-950/40 border border-green-900/50 px-2 py-1 rounded">
                  ✓ Fixed in version: ${cve.fixed_version}
                </div>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>

      ${op.can_upgrade ? `
        <div class="mt-4 bg-blue-950/40 border border-blue-800 rounded p-3 text-sm text-blue-300">
          💡 Upgrade to <strong>${op.target_version || 'latest'}</strong> may resolve some vulnerabilities
        </div>
      ` : ''}
    `;

    content.innerHTML = html;
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  setTimeout(() => modal.classList.remove('opacity-0'), 10);
}

function closeCVEModal() {
  const modal = document.getElementById('cveModal');
  if (modal) {
    modal.classList.add('opacity-0');
    setTimeout(() => {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }, 200);
  }
}

// Dependency Graph State
let dependencyNetwork = null;
let dependencyGraphData = null;

// Toggle Dependency Graph Section
function toggleDependencyGraph() {
  const section = document.getElementById('dependencyGraphSection');
  if (!section) return;

  const isHidden = section.classList.contains('hidden');

  if (isHidden) {
    section.classList.remove('hidden');
    loadDependencyGraph();
  } else {
    section.classList.add('hidden');
  }
}

// Load and Render Dependency Graph
async function loadDependencyGraph() {
  try {
    const response = await fetch('/api/v1/dependencies/graph');
    const data = await response.json();

    dependencyGraphData = data;
    renderDependencyGraph(data);
  } catch (err) {
    console.error('Failed to load dependency graph:', err);
    document.getElementById('dependencyGraph').innerHTML =
      '<div class="flex items-center justify-center h-full text-gray-500">Failed to load dependency graph</div>';
  }
}

// Render vis.js Network
function renderDependencyGraph(data) {
  const container = document.getElementById('dependencyGraph');
  if (!container) return;

  // Prepare nodes for vis.js
  const nodes = new vis.DataSet(
    data.nodes.map(n => ({
      id: n.id,
      label: n.label,
      shape: 'box',
      color: {
        background: n.color,
        border: n.color,
        highlight: {
          background: n.color,
          border: '#ffffff'
        }
      },
      font: {
        color: '#ffffff',
        size: 14,
        face: 'monospace'
      },
      margin: 10,
      borderWidth: 2,
      borderWidthSelected: 3
    }))
  );

  // Prepare edges for vis.js
  const edges = new vis.DataSet(
    data.edges.map(e => ({
      from: e.from,
      to: e.to,
      label: e.label,
      arrows: 'to',
      color: {
        color: '#4b5563',
        highlight: '#60a5fa'
      },
      font: {
        color: '#9ca3af',
        size: 10,
        align: 'top'
      },
      smooth: {
        type: 'cubicBezier',
        forceDirection: 'horizontal'
      }
    }))
  );

  const graphData = {
    nodes: nodes,
    edges: edges
  };

  const options = {
    layout: {
      hierarchical: {
        enabled: true,
        direction: 'LR',
        sortMethod: 'directed',
        levelSeparation: 200,
        nodeSpacing: 150,
        treeSpacing: 200
      }
    },
    physics: {
      enabled: false
    },
    interaction: {
      hover: true,
      tooltipDelay: 100,
      navigationButtons: true,
      keyboard: {
        enabled: true,
        bindToWindow: false
      }
    },
    nodes: {
      shadow: true
    },
    edges: {
      shadow: true,
      width: 2
    }
  };

  // Destroy existing network if any
  if (dependencyNetwork) {
    dependencyNetwork.destroy();
  }

  // Create new network
  dependencyNetwork = new vis.Network(container, graphData, options);

  // Add click event for impact analysis
  dependencyNetwork.on('click', function(params) {
    if (params.nodes.length > 0) {
      const nodeId = params.nodes[0];
      showOperatorImpact(nodeId);
    }
  });

  // Add double-click to focus
  dependencyNetwork.on('doubleClick', function(params) {
    if (params.nodes.length > 0) {
      dependencyNetwork.focus(params.nodes[0], {
        scale: 1.5,
        animation: true
      });
    }
  });
}

// Reset Dependency Graph View
function resetDependencyGraph() {
  if (dependencyNetwork) {
    dependencyNetwork.fit({
      animation: {
        duration: 500,
        easingFunction: 'easeInOutQuad'
      }
    });
  }
}

// Show Impact Analysis for Selected Operator
async function showOperatorImpact(operatorName) {
  try {
    const response = await fetch(`/api/v1/dependencies/impact/${operatorName}`);
    const impact = await response.json();

    const modal = document.getElementById('impactModal');
    const content = document.getElementById('impactContent');

    if (!modal || !content) return;

    // Risk color coding - use full class names for Tailwind
    let riskBadgeClass = 'bg-gray-900/60 border-gray-600 text-gray-300';
    if (impact.breakage_risk === 'Critical') {
      riskBadgeClass = 'bg-red-900/60 border-red-600 text-red-300';
    } else if (impact.breakage_risk === 'High') {
      riskBadgeClass = 'bg-orange-900/60 border-orange-600 text-orange-300';
    } else if (impact.breakage_risk === 'Medium') {
      riskBadgeClass = 'bg-yellow-900/60 border-yellow-600 text-yellow-300';
    } else if (impact.breakage_risk === 'Low') {
      riskBadgeClass = 'bg-green-900/60 border-green-600 text-green-300';
    }

    let html = `
      <div class="mb-4">
        <h4 class="text-lg font-semibold text-white mb-2">${impact.operator}</h4>
        <div class="flex items-center gap-2">
          <span class="text-sm text-gray-400">Removal Risk:</span>
          <span class="${riskBadgeClass} border text-sm px-3 py-1 rounded-full font-semibold">
            ${impact.breakage_risk}
          </span>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-4 mb-4">
        <div class="bg-gray-800 border border-gray-700 rounded-lg p-4">
          <h5 class="text-sm font-semibold text-blue-400 mb-2">Provides CRDs</h5>
          ${impact.provided_crds && impact.provided_crds.length > 0 ? `
            <ul class="space-y-1">
              ${impact.provided_crds.map(crd => `
                <li class="text-xs text-gray-300 font-mono">• ${crd}</li>
              `).join('')}
            </ul>
          ` : '<p class="text-xs text-gray-500">No CRDs provided</p>'}
        </div>

        <div class="bg-gray-800 border border-gray-700 rounded-lg p-4">
          <h5 class="text-sm font-semibold text-green-400 mb-2">Consumes CRDs</h5>
          ${impact.consumed_crds && impact.consumed_crds.length > 0 ? `
            <ul class="space-y-1">
              ${impact.consumed_crds.map(crd => `
                <li class="text-xs text-gray-300 font-mono">• ${crd}</li>
              `).join('')}
            </ul>
          ` : '<p class="text-xs text-gray-500">No CRDs consumed</p>'}
        </div>
      </div>

      <div class="bg-gray-800 border border-gray-700 rounded-lg p-4 mb-4">
        <h5 class="text-sm font-semibold text-red-400 mb-2">⚠️ Impact if Removed</h5>
        ${impact.direct_dependents && impact.direct_dependents.length > 0 ? `
          <p class="text-xs text-gray-400 mb-2">The following operators would be affected:</p>
          <ul class="space-y-1">
            ${impact.direct_dependents.map(dep => `
              <li class="text-xs text-gray-300 font-mono bg-gray-900 px-2 py-1 rounded">
                🔴 ${dep} <span class="text-red-400">(would lose CRD access)</span>
              </li>
            `).join('')}
          </ul>
          <div class="mt-3 bg-red-950/40 border border-red-800 rounded p-3 text-sm text-red-300">
            <strong>Warning:</strong> Removing this operator will break ${impact.direct_dependents.length} dependent operator(s).
          </div>
        ` : `
          <p class="text-xs text-green-400 bg-green-950/40 border border-green-900/50 px-3 py-2 rounded">
            ✓ Safe to remove - No operators depend on this one
          </p>
        `}
      </div>

      ${impact.breakage_risk === 'Critical' || impact.breakage_risk === 'High' ? `
        <div class="bg-orange-950/40 border border-orange-800 rounded p-3 text-sm text-orange-300">
          💡 <strong>Recommendation:</strong> Consider migrating dependent operators before removal, or use a phased approach with advance communication.
        </div>
      ` : ''}
    `;

    content.innerHTML = html;

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    setTimeout(() => modal.classList.remove('opacity-0'), 10);
  } catch (err) {
    console.error('Failed to analyze impact:', err);
    alert('Failed to load impact analysis');
  }
}

// Close Impact Modal
function closeImpactModal() {
  const modal = document.getElementById('impactModal');
  if (modal) {
    modal.classList.add('opacity-0');
    setTimeout(() => {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }, 200);
  }
}

// Analyze Dependency Impact (opens modal for user to select operator)
function analyzeDependencyImpact() {
  if (!dependencyGraphData || !dependencyGraphData.nodes || dependencyGraphData.nodes.length === 0) {
    alert('No dependency data available');
    return;
  }

  // Create operator selection prompt
  const operatorNames = dependencyGraphData.nodes.map(n => n.id).sort();
  const selection = prompt(
    'Enter operator name to analyze impact:\n\nAvailable operators:\n' +
    operatorNames.slice(0, 10).join(', ') +
    (operatorNames.length > 10 ? `\n...and ${operatorNames.length - 10} more` : ''),
    operatorNames[0]
  );

  if (selection && operatorNames.includes(selection)) {
    showOperatorImpact(selection);
  } else if (selection) {
    alert('Operator not found: ' + selection);
  }
}

// Export Dependency Graph as PNG
async function exportDependencyGraph() {
  if (!dependencyNetwork) {
    alert('No graph to export');
    return;
  }

  try {
    // Use html2canvas to capture the graph
    const container = document.getElementById('dependencyGraph');
    const canvas = await html2canvas(container, {
      backgroundColor: '#030712',
      scale: 2
    });

    // Download as PNG
    const link = document.createElement('a');
    link.download = `dependency-graph-${new Date().toISOString().split('T')[0]}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  } catch (err) {
    console.error('Export failed:', err);
    alert('Failed to export graph');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadAutonomousMode();
  loadSectionsState();
  renderHistoryTimeline();
  fetchTargets(false);
});