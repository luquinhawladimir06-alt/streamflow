document.addEventListener('DOMContentLoaded', () => {
  const errorScreen = document.getElementById('error-screen');
  const adminContent = document.getElementById('admin-content');
  
  const totalConnectionsEl = document.getElementById('total-connections');
  const totalStreamsEl = document.getElementById('total-streams');
  const streamsTbody = document.getElementById('streams-tbody');

  async function fetchStats() {
    try {
      const res = await fetch('/api/admin/stats');
      
      if (res.status === 403 || res.status === 401) {
        // Not admin
        errorScreen.style.display = 'block';
        adminContent.style.display = 'none';
        return;
      }

      const data = await res.json();
      
      errorScreen.style.display = 'none';
      adminContent.style.display = 'block';

      totalConnectionsEl.textContent = data.totalConnections || 0;
      totalStreamsEl.textContent = data.activeStreamsCount || 0;

      // Update table
      streamsTbody.innerHTML = '';
      if (data.streams && data.streams.length > 0) {
        data.streams.forEach(s => {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td style="font-family: monospace; font-size: 1.1rem; color: var(--purple-400);">${s.streamId}</td>
            <td><strong>${s.viewersCount}</strong> assistindo</td>
            <td><span class="status-badge">🟢 Ao Vivo</span></td>
            <td>
              <a href="/live/${s.streamId}" target="_blank" class="btn btn-secondary btn-sm" style="padding: 4px 12px; font-size: 0.8rem;">Assistir</a>
            </td>
          `;
          streamsTbody.appendChild(tr);
        });
      } else {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="4" style="text-align: center; color: var(--text-muted); padding: 32px;">Nenhuma transmissão ativa no momento.</td>`;
        streamsTbody.appendChild(tr);
      }
    } catch (err) {
      console.error('Erro ao buscar stats:', err);
    }
  }

  // Fetch immediately and then every 5 seconds
  fetchStats();
  setInterval(fetchStats, 5000);
});
