let currentOperatorData = [];
let statusChartInstance = null;
let channelChartInstance = null;
let countdown = 60;
let timerId = null;
let currentInterval = 60;
const CIRCUMFERENCE = 62.83; // 2 * pi * r (where r=10)

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
      fetchTargets();
    } else {
      updateTimerUI();
    }
  }, 1000);
}

async function fetchTargets() {
  try {
    const response = await fetch('/api/v1/catalog/targets');
    if (response.status === 401) {
      window.location.href = '/login';
      return;
    }
    const data = await response.json();
    
    currentOperatorData = data.operators || [];
    
    // Strictly use the live data from the Go Operator, fallback to "Unknown" if missing
    const ocpCurrent = data.ocp_current_version || "Unknown";
    const ocpNext = data.ocp_next_version || "Unknown";
    
    if (document.getElementById('ocpCurrentBadge')) {
        document.getElementById('ocpCurrentBadge').textContent = `OCP v${ocpCurrent}`;
    }
    if (document.getElementById('ocpNextBadge')) {
        document.getElementById('ocpNextBadge').textContent = `Target v${ocpNext}`;
    }

    updateMetrics(currentOperatorData);
    renderCharts(currentOperatorData);
    renderGrid(currentOperatorData);

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

  switch(type) {
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
      desc = 'Operators installed multiple times across different namespaces causing OLM split-brain.';
      const pkgCounts = {};
      currentOperatorData.forEach(op => { 
        const pkg = getNormalizedPackageName(op);
        pkgCounts[pkg] = (pkgCounts[pkg] || 0) + 1; 
      });
      ops = currentOperatorData.filter(op => pkgCounts[getNormalizedPackageName(op)] > 1);
      color = 'text-red-400';
      borderClass = 'hover:border-red-500/50';
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
  }

  titleEl.className = `text-xl font-bold mb-2 flex items-center gap-2 ${color}`;
  titleEl.innerHTML = title;
  descEl.textContent = desc;

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

// ============================================================================
// CHARTS & GRID RENDERING
// ============================================================================
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
    card.className = 'bg-gray-900 border border-gray-800 rounded-lg p-5 shadow-lg transition hover:border-blue-600/60 cursor-pointer';

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

      projectionHTML = `
        <div class="mt-4 pt-4 border-t border-gray-800/80 bg-gray-950/50 -mx-5 -mb-5 p-5">
          <div class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Upgrade Projection Analysis</div>
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
        </div>
      `;
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

    card.innerHTML = `
      <div onclick="toggleCRDDrawer('crdDrawer-${index}')" class="flex justify-between items-start">
        <div>
          <div class="flex items-center gap-3">
            <h2 class="text-lg font-bold text-white flex items-center gap-2">
              ${op.name || op.package}
              <svg id="chevron-${index}" class="w-4 h-4 text-gray-500 transition-transform transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
            </h2>
            <button onclick="event.stopPropagation(); openComponentModal('${op.name || op.package}')" class="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-blue-400 px-2 py-1 rounded transition font-mono flex items-center gap-1.5">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
              Inspect Resources
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
        <div class="text-right">
          <span class="text-xs text-gray-500 uppercase font-semibold block">Current Version</span>
          <span class="bg-gray-950 border border-gray-800 text-gray-200 font-mono font-bold text-sm px-3 py-1 rounded inline-block mt-1">
            ${currentVerDisplay}
          </span>
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
// INSPECT RESOURCES MODAL HANDLER
// ============================================================================
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

document.addEventListener('DOMContentLoaded', fetchTargets);