let currentOperatorData = [];

async function fetchTargets() {
  try {
    const response = await fetch('/api/v1/catalog/targets');
    const data = await response.json();
    
    currentOperatorData = data.operators || [];
    updateMetrics(currentOperatorData);
    renderGrid(currentOperatorData);
  } catch (error) {
    console.error("Error fetching operator data:", error);
    document.getElementById('operatorGrid').innerHTML = `
      <div class="bg-red-950 border border-red-800 text-red-300 p-4 rounded-lg text-center">
        Failed to communicate with Go sensor backend.
      </div>
    `;
  }
}

function updateMetrics(operators) {
  const total = operators.length;
  const upgradeable = operators.filter(op => op.can_upgrade).length;
  const majorRisk = operators.filter(op => op.can_upgrade && op.upgrade_type === 'MAJOR').length;
  const upToDate = total - upgradeable;

  document.getElementById('metricTotal').textContent = total;
  document.getElementById('metricUpToDate').textContent = upToDate;
  document.getElementById('metricUpgradeable').textContent = upgradeable;
  document.getElementById('metricMajorRisk').textContent = majorRisk;
}

function renderGrid(operators) {
  const grid = document.getElementById('operatorGrid');
  grid.innerHTML = '';

  if (operators.length === 0) {
    grid.innerHTML = `<div class="text-center text-gray-500 py-10">No operator subscriptions found in cluster.</div>`;
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

    let badgeHTML = `<span class="bg-gray-800 text-gray-400 text-xs px-2.5 py-1 rounded-full font-medium">Up to date</span>`;
    
    if (op.can_upgrade) {
      if (op.upgrade_type === 'MAJOR') {
        badgeHTML = `<span class="bg-amber-900/60 border border-amber-500 text-amber-300 text-xs px-2.5 py-1 rounded-full font-semibold animate-pulse">Update: MAJOR</span>`;
      } else if (op.upgrade_type === 'MINOR') {
        badgeHTML = `<span class="bg-blue-900/60 border border-blue-500 text-blue-300 text-xs px-2.5 py-1 rounded-full font-semibold">Update: MINOR</span>`;
      } else {
        badgeHTML = `<span class="bg-emerald-900/60 border border-emerald-500 text-emerald-300 text-xs px-2.5 py-1 rounded-full font-semibold">Update: PATCH</span>`;
      }
    }

    let projectionHTML = '';
    if (op.can_upgrade) {
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
          <div class="text-xs text-amber-400 bg-amber-950/40 border border-amber-900/50 p-2.5 rounded flex items-start gap-2">
            <span class="font-bold">⚠️ Recommendation:</span>
            <span>Proceeding with a <strong>${op.upgrade_type}</strong> upgrade from ${currentVerDisplay} to v${targetVerDisplay}. CRD schema breaking changes are possible. Proceed with caution.</span>
          </div>
        </div>
      `;
    }

    let crdListHTML = '';
    if (crds.length > 0) {
      crdListHTML = crds.map(crd => `
        <div class="bg-gray-950 border border-gray-800/80 p-3 rounded flex justify-between items-center hover:border-gray-700 transition">
          <div>
            <div class="flex items-center gap-2">
              <span class="font-mono text-sm font-semibold text-blue-400">${crd.kind}</span>
              <span class="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded font-mono">${crd.version || 'v1'}</span>
            </div>
            <p class="text-xs text-gray-500 mt-1 font-mono">${crd.name}</p>
            ${crd.description ? `<p class="text-xs text-gray-400 mt-1 line-clamp-1">${crd.description}</p>` : ''}
          </div>
          <span class="text-xs bg-gray-900 border border-gray-800 text-gray-300 px-2.5 py-1 rounded font-medium">CRD</span>
        </div>
      `).join('');
    } else {
      crdListHTML = `<div class="text-xs text-gray-500 italic p-3 bg-gray-950 rounded border border-gray-800">No owned Custom Resource Definitions found in installed CSV.</div>`;
    }

    card.innerHTML = `
      <div onclick="toggleCRDDrawer('crdDrawer-${index}')" class="flex justify-between items-start">
        <div>
          <div class="flex items-center gap-3">
            <h2 class="text-lg font-bold text-white flex items-center gap-2">
              ${op.name || op.package}
              <svg id="chevron-${index}" class="w-4 h-4 text-gray-500 transition-transform transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
            </h2>
            ${badgeHTML}
          </div>
          <p class="text-xs text-gray-400 mt-1">
            Namespace: <span class="text-gray-300 font-mono">${op.namespace}</span> | 
            Channel: <span class="text-gray-300 font-mono">${op.channel}</span> | 
            CRDs: <span class="text-blue-400 font-bold">${crds.length}</span>
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

      <!-- Expandable CRD Drawer -->
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
  if (drawer) {
    drawer.classList.toggle('hidden');
  }
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

document.addEventListener('DOMContentLoaded', fetchTargets);