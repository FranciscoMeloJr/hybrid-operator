// ============================================================================
// OPERATOR COMPONENT & SUB/CSV INSPECTOR
// ============================================================================
function openComponentModal(operatorName) {
  const op = currentOperatorData.find(o => (o.name === operatorName || o.package === operatorName));
  if (!op) return;

  const modal = document.getElementById('unifiedModal');
  const titleEl = document.getElementById('unifiedModalTitle');
  const descEl = document.getElementById('unifiedModalDesc');
  const listEl = document.getElementById('unifiedModalList');

  if (!modal || !listEl) return;

  titleEl.className = `text-xl font-bold mb-2 flex items-center justify-between text-blue-400`;
  titleEl.innerHTML = `
    <span>Infrastructure Components: ${op.name || op.package}</span>
    <span class="text-xs font-mono bg-blue-950 border border-blue-800 text-blue-300 px-3 py-1 rounded">
      Namespace: ${op.namespace}
    </span>
  `;

  descEl.textContent = `Installed ServiceAccounts, Deployments, CSV permissions, and Subscription configuration.`;

  const components = op.components || [];
  const sas = op.service_accounts || [];

  listEl.innerHTML = `
    <!-- Subscription & CSV Meta Panel -->
    <div class="bg-gray-950 border border-gray-800 p-4 rounded-lg mb-4 grid grid-cols-2 gap-4 font-mono text-xs">
      <div>
        <span class="text-gray-500 block">Approval Strategy</span>
        <span class="text-white font-bold">${op.approval_strategy || 'Automatic'}</span>
      </div>
      <div>
        <span class="text-gray-500 block">Catalog Source</span>
        <span class="text-blue-400 font-bold">${op.catalog_source || 'redhat-operators'}</span>
      </div>
    </div>

    <!-- Infrastructure Component List -->
    <div class="space-y-2">
      <div class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Detected Resources (${components.length})</div>
      ${components.map(c => `
        <div class="bg-gray-950 border border-gray-800 p-3 rounded flex justify-between items-center text-xs font-mono">
          <div class="flex items-center gap-2">
            <span class="bg-blue-900/60 border border-blue-700 text-blue-300 px-2 py-0.5 rounded text-[10px] uppercase font-bold">${c.kind}</span>
            <span class="text-gray-200 font-bold">${c.name}</span>
          </div>
          <span class="text-gray-400">${c.status}</span>
        </div>
      `).join('')}
    </div>
  `;

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  setTimeout(() => {
    modal.classList.remove('opacity-0');
  }, 10);
}