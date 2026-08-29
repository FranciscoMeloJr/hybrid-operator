// ============================================================================
// CRD SCHEMA DIFF & SANKEY FLOW INSPECTOR
// ============================================================================

function renderCRDDiffModal(operatorName) {
  const op = currentOperatorData.find(o => (o.name === operatorName || o.package === operatorName));
  if (!op) return;

  const modal = document.getElementById('crdDiffModal');
  const titleEl = document.getElementById('crdDiffTitle');
  const flowContainer = document.getElementById('crdFlowContainer');
  const tableContainer = document.getElementById('crdComparisonTable');

  if (!modal || !flowContainer || !tableContainer) return;

  const crds = op.crds || [];
  const diffData = op.crd_diff || { violating_crs: [], removed_fields: [], type_mutations: [] };

  // Set Modal Title & Header
  titleEl.innerHTML = `
    <div class="flex items-center gap-3">
      <span class="text-white font-bold text-lg">${op.name || op.package}</span>
      <span class="bg-blue-950 border border-blue-800 text-blue-300 font-mono text-xs px-2.5 py-1 rounded">
        ${op.version || 'Current'} ➔ v${op.target_version || 'Target'}
      </span>
    </div>
  `;

  // Render Visual Flow Node Pipeline (Sankey Flow Diagram)
  renderFlowDiagram(flowContainer, op, diffData);

  // Render Spec-Field-by-Spec-Field Comparison Table
  renderSpecFieldComparison(tableContainer, crds, diffData);

  // Display Modal
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function renderFlowDiagram(container, op, diffData) {
  const isBreaking = diffData.has_breaking_impact;
  const violatingCount = diffData.violating_crs ? diffData.violating_crs.length : 0;

  container.innerHTML = `
    <div class="bg-gray-950 border border-gray-800 p-5 rounded-lg mb-6">
      <div class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-4">CRD Schema Migration Flow</div>
      
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6 items-center">
        <!-- Source Schema Node -->
        <div class="bg-gray-900 border border-blue-500/50 p-4 rounded-lg text-center shadow">
          <span class="text-xs text-blue-400 font-mono block uppercase">Source Version</span>
          <span class="text-lg font-bold text-white block mt-1">${op.installedCSV || op.version}</span>
          <span class="text-xs text-gray-400 mt-2 block font-mono">${(op.crds || []).length} Owned CRDs</span>
        </div>

        <!-- Dynamic Sankey Connection Flow -->
        <div class="flex flex-col items-center justify-center">
          <div class="w-full bg-gray-800 h-1.5 rounded-full relative overflow-hidden">
            <div class="absolute inset-y-0 left-0 ${isBreaking ? 'bg-red-500 animate-pulse' : 'bg-emerald-500'} w-full"></div>
          </div>
          <span class="text-xs font-mono font-bold mt-2 ${isBreaking ? 'text-red-400' : 'text-emerald-400'}">
            ${isBreaking ? `⚠️ ${violatingCount} Field Violations` : '✓ 100% Schema Compatible'}
          </span>
        </div>

        <!-- Target Schema Node -->
        <div class="bg-gray-900 border ${isBreaking ? 'border-red-500/50' : 'border-emerald-500/50'} p-4 rounded-lg text-center shadow">
          <span class="text-xs ${isBreaking ? 'text-red-400' : 'text-emerald-400'} font-mono block uppercase">Target Version</span>
          <span class="text-lg font-bold text-white block mt-1">v${op.target_version}</span>
          <span class="text-xs text-gray-400 mt-2 block font-mono">${op.target_csv || 'Target CSV'}</span>
        </div>
      </div>
    </div>
  `;
}

function renderSpecFieldComparison(container, crds, diffData) {
  const violatingCRs = diffData.violating_crs || [];
  
  if (violatingCRs.length === 0) {
    container.innerHTML = `
      <div class="bg-emerald-950/30 border border-emerald-800/60 p-4 rounded-lg text-emerald-300 text-xs flex items-center gap-3">
        <svg class="w-5 h-5 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
        <div>
          <strong class="block text-white text-sm">No Spec Field Breaches Detected</strong>
          <span>All specs and custom resource instances defined on the cluster remain fully compatible with target CRD OpenAPI v3 schemas.</span>
        </div>
      </div>
    `;
    return;
  }

  let tableRows = violatingCRs.map(v => `
    <tr class="border-b border-gray-800 hover:bg-gray-900/50 transition">
      <td class="p-3 font-mono text-xs text-blue-400 font-semibold">${v.crd_kind}</td>
      <td class="p-3 font-mono text-xs text-gray-200">${v.cr_name}</td>
      <td class="p-3 font-mono text-xs text-red-400 font-bold"><code>${v.breaking_field}</code></td>
      <td class="p-3 text-xs text-gray-400">${v.reason}</td>
    </tr>
  `).join('');

  container.innerHTML = `
    <div class="overflow-x-auto border border-gray-800 rounded-lg">
      <table class="w-full text-left border-collapse">
        <thead class="bg-gray-950 text-gray-400 font-mono text-xs border-b border-gray-800">
          <tr>
            <th class="p-3">CRD Kind</th>
            <th class="p-3">Active CR Instance</th>
            <th class="p-3">Removed Spec Field</th>
            <th class="p-3">Impact Detail</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-800 bg-gray-900/30">
          ${tableRows}
        </tbody>
      </table>
    </div>
  `;
}

function closeCRDDiffModal() {
  const modal = document.getElementById('crdDiffModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}