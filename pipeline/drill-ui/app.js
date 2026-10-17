const form = document.querySelector('form'), message = document.querySelector('#message');
const statuses = { SHELTER_STATUS: { OPEN:'開放', FULL:'額滿', CLOSED:'未開放' }, ROAD_STATUS:{ OPEN:'開放', CLOSED:'封閉', PARTIAL:'部分受阻' }, SUPPLY_STATUS:{ AVAILABLE:'供應中', PAUSED:'暫停', EXHAUSTED:'已發完', CLOSED:'已結束', UNKNOWN:'未知' } };
let events = [], lastRender = '';
function statusOptions() { form.elements.status.replaceChildren(...Object.entries(statuses[form.elements.type.value]).map(([value,text]) => new Option(text,value))); }
function render() {
  const filtered = events.filter(e => e.attributes.area_id.includes(document.querySelector('#filter').value.trim()));
  document.querySelector('#count').textContent = `${filtered.length} 筆演練資料；目前有效 ${filtered.filter(e => Date.parse(e.expires_at) > Date.now()).length} 筆`;
  const signature = JSON.stringify(filtered.map(e => [e.event_id, e.event_version, e.payload_hash, Date.parse(e.expires_at) <= Date.now()]));
  if (signature === lastRender) return;
  lastRender = signature;
  document.querySelector('#events').replaceChildren(...filtered.map(e => {
    const article = document.createElement('article'), title = document.createElement('h3'), detail = document.createElement('p'), time = document.createElement('p'), edit = document.createElement('button');
    title.textContent = e.attributes.name;
    detail.textContent = `${e.attributes.area_id} · ${statuses[e.event_type]?.[e.attributes.status] ?? '未知'} · 第 ${e.event_version} 版`;
    time.textContent = `${Date.parse(e.expires_at) <= Date.now() ? '已過期 · ' : ''}發布 ${new Date(e.issued_at).toLocaleString()}；到期 ${new Date(e.expires_at).toLocaleString()}`;
    edit.textContent = '載入表單更新'; edit.onclick = () => {
      form.elements.type.value = e.event_type; statusOptions();
      const values = { id:e.event_id, name:e.attributes.name, area:e.attributes.area_id, lon:e.geometry.coordinates[0], lat:e.geometry.coordinates[1], status:e.attributes.status, quantity:e.attributes.quantity ?? e.attributes.available ?? '', items:(e.attributes.items ?? []).join(', '), address:e.attributes.address ?? '', opening_hours:e.attributes.opening_hours ?? '' };
      for (const [key,value] of Object.entries(values)) form.elements[key].value = value;
    };
    article.append(title,detail,time,edit); return article;
  }));
}
async function refresh() { const response = await fetch('/api/state'); if (!response.ok) throw new Error('無法取得資料'); events = (await response.json()).events; render(); }
form.elements.type.onchange = statusOptions; document.querySelector('#filter').oninput = render;
form.onsubmit = async event => {
  event.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
  try {
    const input = Object.fromEntries(new FormData(form));
    for (const field of ['lon','lat','ttl_minutes']) input[field] = Number(input[field]);
    input.quantity = input.quantity.trim() === '' ? null : Number(input.quantity);
    input.items = input.items.split(/[,，]/).map(s => s.trim()).filter(Boolean);
    for (const field of ['address','opening_hours']) if (!input[field].trim()) delete input[field];
    const response = await fetch('/api/events', { method:'POST', headers:{ 'Content-Type':'application/json', 'X-Drill-Console':'1' }, body:JSON.stringify(input) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    message.textContent = `已發布第 ${result.version} 版；請讓手機 A 載入新版。`; await refresh();
  } catch (error) { message.textContent = error.message; } finally { button.disabled = false; }
};
statusOptions(); refresh().catch(error => message.textContent = error.message); setInterval(render, 10000);
