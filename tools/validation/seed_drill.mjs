// Start `npm run drill:serve` first. This updates only the local exercise ledger.
const status = process.argv[2] ?? 'OPEN';
if (!['OPEN', 'FULL', 'CLOSED'].includes(status)) throw new Error('Usage: node tools/validation/seed_drill.mjs OPEN|FULL|CLOSED');
const base = 'http://127.0.0.1:8788';
for (const event of [
  { id: 'exercise:b', type: 'SHELTER_STATUS', status, name: '演練避難所 B', lon: 121.592, lat: 25.060, quantity: status === 'OPEN' ? 20 : 0 },
  { id: 'supply:one', type: 'SUPPLY_STATUS', status: 'AVAILABLE', name: '演練物資站', lon: 121.593, lat: 25.061, quantity: null, items: ['飲用水', '乾糧'] },
]) {
  const response = await fetch(`${base}/api/events`, { method: 'POST',
    headers: { Origin: base, 'X-Drill-Console': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ area: 'neihu.xihu', ttl_minutes: 120, ...event }) });
  const state = await response.json();
  if (!response.ok) throw new Error(state.error);
  console.log(`${event.id}: ${event.status}, ledger v${state.version}`);
}
