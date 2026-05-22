const API_KEY = 'REPLACE_WITH_SECRET_KEY';

function cors(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return new Response(response.body, { status: response.status, headers });
}

function cyclePhase(dayInCycle, cycleLength = 28) {
  if (dayInCycle <= 5) return 'menstruácia';
  if (dayInCycle <= 13) return 'folikulárna fáza';
  if (dayInCycle <= 16) return 'ovulácia';
  if (dayInCycle <= cycleLength) return 'luteálna fáza';
  return 'neznáma fáza';
}

function headacheRisk(dayInCycle, cycleLength = 28) {
  // High risk: day before/during period (hormonal drop) and ovulation
  const daysBeforePeriod = cycleLength - dayInCycle;
  if (daysBeforePeriod <= 2 || dayInCycle <= 2) return 'vysoká';
  if (dayInCycle >= 13 && dayInCycle <= 15) return 'stredná';
  return 'nízka';
}

function sleepQualityLabel(minutes, hrv) {
  if (!minutes) return null;
  const hours = minutes / 60;
  if (hours < 5) return 'zlý';
  if (hours < 6.5) return 'krátky';
  if (hours >= 7 && hrv && hrv > 40) return 'výborný';
  if (hours >= 7) return 'dobrý';
  return 'priemerný';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    // POST /sync — from iOS Shortcut
    if (request.method === 'POST' && url.pathname === '/sync') {
      const authHeader = request.headers.get('Authorization') || '';
      if (authHeader !== `Bearer ${API_KEY}`) {
        return cors(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));
      }
      try {
        const body = await request.json();
        const today = body.date || new Date().toISOString().split('T')[0];

        let cycleDay = body.cycle_day || null;
        let cycleLength = body.cycle_length_avg || 28;
        if (!cycleDay && body.last_period_start) {
          const diff = Math.floor((new Date(today) - new Date(body.last_period_start)) / 86400000);
          cycleDay = (diff % cycleLength) + 1;
        }

        const quality = sleepQualityLabel(body.sleep_duration_minutes, body.hrv);

        await env.DB.prepare(`
          INSERT INTO health_logs (date, sleep_duration_minutes, sleep_start, sleep_end, sleep_quality,
            cycle_day, last_period_start, cycle_length_avg, hrv, resting_hr, steps, active_energy, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          today,
          body.sleep_duration_minutes || null,
          body.sleep_start || null,
          body.sleep_end || null,
          quality,
          cycleDay,
          body.last_period_start || null,
          cycleLength,
          body.hrv || null,
          body.resting_hr || null,
          body.steps || null,
          body.active_energy || null,
          body.notes || null
        ).run();

        return cors(new Response(JSON.stringify({ ok: true, date: today, cycle_day: cycleDay, sleep_quality: quality }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        }));
      } catch (e) {
        return cors(new Response(JSON.stringify({ error: e.message }), { status: 500 }));
      }
    }

    // MCP endpoint — for Alex
    if (request.method === 'POST' && url.pathname === '/mcp') {
      try {
        const body = await request.json();

        if (body.method === 'tools/list') {
          return cors(new Response(JSON.stringify({
            jsonrpc: '2.0', id: body.id,
            result: {
              tools: [{
                name: 'health_check',
                description: 'Vráti aktuálny zdravotný stav Simi — spánok, fáza cyklu, riziko bolesti hlavy, HRV. Volaj vždy keď Simi spomína únavu, bolesť hlavy, náladu alebo keď ju chceš lepšie chápať.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    days: { type: 'number', description: 'Koľko posledných dní zobraziť (default 1)' }
                  }
                }
              }]
            }
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }

        if (body.method === 'tools/call' && body.params?.name === 'health_check') {
          const days = body.params?.arguments?.days || 1;
          const rows = await env.DB.prepare(
            'SELECT * FROM health_logs ORDER BY date DESC LIMIT ?'
          ).bind(days).all();

          if (!rows.results.length) {
            return cors(new Response(JSON.stringify({
              jsonrpc: '2.0', id: body.id,
              result: { content: [{ type: 'text', text: 'Žiadne zdravotné dáta ešte nie sú zaznamenané.' }] }
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
          }

          const lines = rows.results.map(r => {
            const cycleLen = r.cycle_length_avg || 28;
            const phase = r.cycle_day ? cyclePhase(r.cycle_day, cycleLen) : null;
            const risk = r.cycle_day ? headacheRisk(r.cycle_day, cycleLen) : null;
            const sleepHours = r.sleep_duration_minutes ? (r.sleep_duration_minutes / 60).toFixed(1) : null;

            const parts = [`📅 ${r.date}`];
            if (sleepHours) parts.push(`Spánok: ${sleepHours}h (${r.sleep_quality || '?'})`);
            if (r.sleep_start && r.sleep_end) parts.push(`  zaspala ${r.sleep_start.slice(11, 16)}, vstala ${r.sleep_end.slice(11, 16)}`);
            if (r.cycle_day) parts.push(`Cyklus: deň ${r.cycle_day} — ${phase}`);
            if (risk) parts.push(`Riziko bolesti hlavy: ${risk}`);
            if (r.hrv) parts.push(`HRV: ${r.hrv}`);
            if (r.resting_hr) parts.push(`Pokojový tep: ${r.resting_hr}`);
            if (r.steps) parts.push(`Kroky: ${r.steps}`);
            return parts.join('\n');
          });

          return cors(new Response(JSON.stringify({
            jsonrpc: '2.0', id: body.id,
            result: { content: [{ type: 'text', text: lines.join('\n\n') }] }
          }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }

        return cors(new Response(JSON.stringify({
          jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      } catch (e) {
        return cors(new Response(JSON.stringify({
          jsonrpc: '2.0', id: 1, error: { code: -32700, message: e.message }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
    }

    return cors(new Response('simi-health-sync', { status: 200 }));
  }
};
