async function fetchTargets() {
    const grid = document.getElementById('operatorGrid');
    grid.innerHTML = '<div class="text-center text-blue-400 py-10">Fetching live targets from Python Brain...</div>';
    
    try {
        const res = await fetch('/api/v1/catalog/targets');
        const data = await res.json();
        
        if (!data.operators || data.operators.length === 0) {
            grid.innerHTML = '<div class="text-center text-gray-500 py-10">No operators monitored yet.</div>';
            return;
        }

        grid.innerHTML = data.operators.map(op => `
            <div class="bg-gray-900 border border-gray-800 p-4 rounded-lg flex justify-between items-center">
                <div>
                    <h2 class="font-bold text-white text-lg">${op.subscription}</h2>
                    <p class="text-sm text-gray-400">Namespace: ${op.namespace} | Channel: ${op.channel}</p>
                </div>
                <div class="text-right">
                    <p class="text-xs text-gray-500 uppercase tracking-wider mb-1">Target Version</p>
                    <span class="font-mono ${op.canUpgrade ? 'text-emerald-400' : 'text-blue-400'} font-bold bg-gray-950 px-3 py-1 rounded border border-gray-800">
                        ${op.targetVersion || op.installedVersion}
                    </span>
                </div>
            </div>
        `).join('');

    } catch (err) {
        grid.innerHTML = `<div class="text-center text-red-500 py-10">Error connecting to Brain API: ${err.message}</div>`;
    }
}

// Auto-load on start
document.addEventListener('DOMContentLoaded', fetchTargets);