export function loginHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PolyFarm — Login</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  :root{--bg:#0a0e17;--surface:#131926;--border:#1e2a3a;--text:#e2e8f0;--dim:#64748b;--blue:#3b82f6;--red:#ef4444}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    background:var(--bg);color:var(--text);display:flex;align-items:center;justify-content:center;min-height:100vh}
  .login-box{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px;width:340px}
  .login-box h1{font-size:1.3rem;margin-bottom:4px}
  .login-box .sub{color:var(--dim);font-size:.85rem;margin-bottom:20px}
  .login-box label{font-size:.8rem;color:var(--dim);display:block;margin-bottom:4px}
  .login-box input{width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);
    padding:10px 12px;border-radius:6px;font-size:.9rem;margin-bottom:16px;outline:none}
  .login-box input:focus{border-color:var(--blue)}
  .login-box button{width:100%;background:var(--blue);color:#fff;border:none;padding:10px;
    border-radius:6px;font-weight:600;font-size:.9rem;cursor:pointer;transition:opacity .15s}
  .login-box button:hover{opacity:.85}
  .login-box button:disabled{opacity:.5;cursor:not-allowed}
  .error{color:var(--red);font-size:.85rem;margin-bottom:12px;display:none}
</style>
</head>
<body>
<div class="login-box">
  <h1>PolyFarm</h1>
  <div class="sub">Enter your dashboard token to continue</div>
  <div class="error" id="err"></div>
  <label for="token">Auth Token</label>
  <input type="password" id="token" placeholder="Enter token..." autofocus>
  <button id="loginBtn" onclick="doLogin()">Sign In</button>
</div>
<script>
document.getElementById('token').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin()});
async function doLogin(){
  const btn=document.getElementById('loginBtn');
  const err=document.getElementById('err');
  const token=document.getElementById('token').value.trim();
  if(!token){err.textContent='Token is required';err.style.display='block';return}
  btn.disabled=true;btn.textContent='Signing in...';err.style.display='none';
  try{
    const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
    if(r.ok){window.location.reload()}
    else{const d=await r.json();err.textContent=d.error||'Login failed';err.style.display='block'}
  }catch(e){err.textContent='Network error';err.style.display='block'}
  finally{btn.disabled=false;btn.textContent='Sign In'}
}
</script>
</body>
</html>`;
}

export function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PolyFarm Dashboard</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --bg:#0a0e17;--surface:#131926;--border:#1e2a3a;
    --text:#e2e8f0;--dim:#64748b;--green:#22c55e;--red:#ef4444;
    --yellow:#eab308;--blue:#3b82f6;--purple:#a855f7;
  }
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    background:var(--bg);color:var(--text);padding:20px;max-width:1200px;margin:0 auto}
  h1{font-size:1.5rem;margin-bottom:4px}
  .subtitle{color:var(--dim);font-size:.85rem;margin-bottom:24px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:24px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px}
  .card-label{font-size:.75rem;color:var(--dim);text-transform:uppercase;letter-spacing:.05em}
  .card-value{font-size:1.6rem;font-weight:700;margin-top:4px}
  .card-sub{font-size:.8rem;color:var(--dim);margin-top:2px}
  .status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
  .dot-running{background:var(--green);box-shadow:0 0 6px var(--green)}
  .dot-stopped{background:var(--yellow)}
  .dot-panic{background:var(--red);box-shadow:0 0 6px var(--red)}
  .dot-none{background:var(--dim)}
  table{width:100%;border-collapse:collapse;font-size:.85rem}
  th{text-align:left;color:var(--dim);font-weight:500;padding:8px 12px;
    border-bottom:1px solid var(--border);font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
  td{padding:8px 12px;border-bottom:1px solid var(--border)}
  .side-buy{color:var(--green);font-weight:600}
  .side-sell{color:var(--red);font-weight:600}
  .section{margin-bottom:24px}
  .section-title{font-size:1rem;font-weight:600;margin-bottom:12px;display:flex;align-items:center;gap:8px}
  .badge{font-size:.7rem;background:var(--border);padding:2px 8px;border-radius:10px;color:var(--dim);font-weight:400}
  .btn-panic{background:var(--red);color:#fff;border:none;padding:10px 24px;border-radius:8px;
    font-weight:600;cursor:pointer;font-size:.9rem;transition:opacity .15s}
  .btn-panic:hover{opacity:.85}
  .btn-panic:disabled{opacity:.4;cursor:not-allowed}
  .btn-logout{background:transparent;color:var(--dim);border:1px solid var(--border);padding:8px 16px;
    border-radius:6px;cursor:pointer;font-size:.8rem;transition:all .15s}
  .btn-logout:hover{border-color:var(--text);color:var(--text)}
  .toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
  .toolbar-right{display:flex;align-items:center;gap:12px}
  .live-dot{width:6px;height:6px;background:var(--green);border-radius:50%;display:inline-block;
    margin-right:6px;animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  .empty{color:var(--dim);padding:24px;text-align:center}
  .scrollable{max-height:500px;overflow-y:auto}
  .mono{font-family:'SF Mono',Menlo,monospace;font-size:.8rem}
  .filter-row{display:flex;align-items:center;gap:12px;margin-bottom:8px}
  .filter-input{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:6px 12px;
    border-radius:6px;font-size:.85rem;width:260px;outline:none}
  .filter-input:focus{border-color:var(--blue)}
  .page-controls{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:.8rem;color:var(--dim)}
  .page-btn{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:4px 10px;
    border-radius:4px;cursor:pointer;font-size:.8rem}
  .page-btn:hover{border-color:var(--blue)}
  .page-btn:disabled{opacity:.3;cursor:not-allowed}
  .pnl-pos{color:var(--green)}
  .pnl-neg{color:var(--red)}
  .pnl-zero{color:var(--dim)}
  .progress-bar{height:4px;background:var(--border);border-radius:2px;overflow:hidden;margin-top:6px}
  .progress-fill{height:100%;border-radius:2px;transition:width .5s}
  .fill-blue{background:var(--blue)}
  .fill-green{background:var(--green)}
  .fill-yellow{background:var(--yellow)}
  .two-sided{color:var(--green);font-weight:600}
  .one-sided{color:var(--yellow)}
  .toast{position:fixed;bottom:24px;right:24px;background:var(--surface);border:1px solid var(--border);
    padding:12px 20px;border-radius:8px;font-size:.85rem;opacity:0;transition:opacity .3s;pointer-events:none}
  .toast.show{opacity:1}
</style>
</head>
<body>

<div class="toolbar">
  <div>
    <h1>PolyFarm</h1>
    <div class="subtitle"><span class="live-dot"></span>Dashboard auto-refreshes every 2s</div>
  </div>
  <div class="toolbar-right">
    <button class="btn-logout" onclick="doLogout()">Logout</button>
    <button class="btn-panic" id="panicBtn" onclick="doPanic()">PANIC CANCEL ALL</button>
  </div>
</div>

<div class="grid" id="stats">
  <div class="card">
    <div class="card-label">Status</div>
    <div class="card-value" id="s-status"><span class="status-dot dot-none"></span><span class="status-text">--</span></div>
  </div>
  <div class="card">
    <div class="card-label">Budget</div>
    <div class="card-value" id="s-budget">--</div>
    <div class="card-sub" id="s-spread"></div>
  </div>
  <div class="card">
    <div class="card-label">Orders Placed</div>
    <div class="card-value" id="s-placed">--</div>
  </div>
  <div class="card">
    <div class="card-label">Fill Rate</div>
    <div class="card-value" id="s-fillrate">--</div>
    <div class="progress-bar"><div class="progress-fill fill-blue" id="s-fillbar" style="width:0%"></div></div>
  </div>
  <div class="card">
    <div class="card-label">Cancelled</div>
    <div class="card-value" id="s-cancelled">--</div>
  </div>
  <div class="card">
    <div class="card-label">Markets</div>
    <div class="card-value" id="s-markets">--</div>
  </div>
  <div class="card">
    <div class="card-label">Realized P&L</div>
    <div class="card-value" id="s-pnl">--</div>
    <div class="card-sub" id="s-pnl-sub"></div>
  </div>
  <div class="card">
    <div class="card-label">Inventory Exposure</div>
    <div class="card-value" id="s-inventory">--</div>
    <div class="card-sub" id="s-inventory-sub"></div>
  </div>
  <div class="card">
    <div class="card-label">Est. Daily Rewards</div>
    <div class="card-value" id="s-rewards">--</div>
    <div class="card-sub" id="s-rewards-sub"></div>
  </div>
</div>

<div class="section">
  <div class="section-title">Live Orders <span class="badge" id="live-count">0</span></div>
  <div class="card" style="padding:0;overflow-x:auto">
    <table>
      <thead>
        <tr><th>ID</th><th>Market</th><th>Side</th><th>Price</th><th>Size</th><th>Type</th><th>Placed</th></tr>
      </thead>
      <tbody id="orders-body">
        <tr><td colspan="7" class="empty">No live orders</td></tr>
      </tbody>
    </table>
  </div>
</div>

<div class="section">
  <div class="section-title">Position Exposure <span class="badge" id="inv-count">0</span></div>
  <div class="card" style="padding:0;overflow-x:auto">
    <table>
      <thead>
        <tr><th>Market</th><th>Side</th><th>Minted</th><th>Current</th><th>Status</th></tr>
      </thead>
      <tbody id="inv-body">
        <tr><td colspan="5" class="empty">No inventory positions</td></tr>
      </tbody>
    </table>
  </div>
</div>

<div class="section">
  <div class="section-title">Markets <span class="badge" id="mkt-count">0</span></div>
  <div class="filter-row">
    <input class="filter-input" id="mkt-filter" type="text" placeholder="Filter markets...">
    <span style="color:var(--dim);font-size:.8rem" id="mkt-showing"></span>
  </div>
  <div class="card" style="padding:0;overflow-x:auto">
    <div class="scrollable">
      <table>
        <thead style="position:sticky;top:0;background:var(--surface);z-index:1">
          <tr><th>Question</th><th>Midpoint</th><th>TVL</th><th>Reward/day</th><th>Spread Quality</th><th>Book Share</th><th>Tick</th></tr>
        </thead>
        <tbody id="markets-body">
          <tr><td colspan="7" class="empty">No markets discovered</td></tr>
        </tbody>
      </table>
    </div>
    <div class="page-controls">
      <button class="page-btn" id="mkt-prev" onclick="mktPage(-1)">&laquo; Prev</button>
      <span id="mkt-page-info">--</span>
      <button class="page-btn" id="mkt-next" onclick="mktPage(1)">Next &raquo;</button>
    </div>
  </div>
</div>

<div class="section">
  <div class="section-title">Hedge History <span class="badge" id="hedge-count">0</span></div>
  <div class="card" style="padding:0;overflow-x:auto">
    <div class="scrollable">
      <table>
        <thead>
          <tr><th>Time</th><th>Fill Side</th><th>Fill Price</th><th>Hedge Price</th><th>Merge Amt</th><th>P&L</th><th>Status</th></tr>
        </thead>
        <tbody id="hedge-body">
          <tr><td colspan="7" class="empty">No hedge activity</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<div class="section">
  <div class="section-title">Recent Activity <span class="badge" id="activity-count">0</span></div>
  <div class="card" style="padding:0;overflow-x:auto">
    <table>
      <thead>
        <tr><th>ID</th><th>Side</th><th>Price</th><th>Size</th><th>Status</th><th>Time</th></tr>
      </thead>
      <tbody id="activity-body">
        <tr><td colspan="6" class="empty">No recent activity</td></tr>
      </tbody>
    </table>
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
function fmt(n,d=2){return n!=null?Number(n).toFixed(d):'--'}
function fmtUsd(n){if(n==null)return'--';if(n>=1e6)return'$'+(n/1e6).toFixed(1)+'M';if(n>=1e3)return'$'+(n/1e3).toFixed(1)+'K';return'$'+n.toFixed(0)}
function fmtCents(c){if(c==null)return'--';const d=c/100;return(d>=0?'+':'')+d.toFixed(2)}
function fmtTime(ts){if(!ts)return'--';const d=new Date(ts*1000);return d.toLocaleTimeString()}
function shortId(id){return id?id.slice(0,10)+'..':'--'}
function toast(msg,ms=3000){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),ms)}
function esc(s){const d=document.createElement('div');d.textContent=String(s);return d.innerHTML}
function truncQ(q){const s=String(q);return s.length>50?s.slice(0,48)+'..':s}
function pnlClass(cents){return cents>0?'pnl-pos':cents<0?'pnl-neg':'pnl-zero'}
function hedgeStatusClass(s){if(s==='HEDGED')return'pnl-pos';if(s==='HEDGE_FAILED'||s==='MERGE_FAILED')return'pnl-neg';return'pnl-zero'}

let allMarkets=[];
let rewardMap=new Map();
let mktPageNum=0;
const MKT_PER_PAGE=50;

function renderMarkets(){
  const filter=document.getElementById('mkt-filter').value.toLowerCase();
  const filtered=filter?allMarkets.filter(m=>m.question.toLowerCase().includes(filter)):allMarkets;
  const totalPages=Math.max(1,Math.ceil(filtered.length/MKT_PER_PAGE));
  if(mktPageNum>=totalPages)mktPageNum=totalPages-1;
  if(mktPageNum<0)mktPageNum=0;
  const start=mktPageNum*MKT_PER_PAGE;
  const page=filtered.slice(start,start+MKT_PER_PAGE);
  const mb=document.getElementById('markets-body');
  document.getElementById('mkt-showing').textContent=
    filter?('Showing '+filtered.length+' of '+allMarkets.length):'';
  if(page.length===0){
    mb.innerHTML='<tr><td colspan="7" class="empty">No markets match filter</td></tr>';
  } else {
    mb.innerHTML=page.map(m=>{
      const rs=rewardMap.get(m.condition_id);
      const quality=rs?fmt(rs.spreadQuality*100,0)+'%':'--';
      const qualityBar=rs?'<div class="progress-bar"><div class="progress-fill fill-green" style="width:'+Math.round(rs.spreadQuality*100)+'%"></div></div>':'';
      const share=rs?fmt(rs.bookShare,1)+'%':'--';
      const twoSided=rs?(rs.isTwoSided?'<span class="two-sided">2x</span>':'<span class="one-sided">1x</span>'):'';
      const qHtml = m.slug
        ? '<a href="https://polymarket.com/event/'+esc(m.slug)+'" target="_blank" rel="noopener" style="color:var(--blue);text-decoration:none">'+esc(truncQ(m.question))+'</a>'
        : esc(truncQ(m.question));
      return '<tr>'+
        '<td>'+qHtml+'</td>'+
        '<td>'+fmt(m.midpoint)+'</td>'+
        '<td>'+fmtUsd(m.tvl)+'</td>'+
        '<td>$'+fmt(m.reward_rate)+' '+twoSided+'</td>'+
        '<td>'+quality+qualityBar+'</td>'+
        '<td>'+share+'</td>'+
        '<td>'+esc(m.tick_size)+'</td>'+
        '</tr>'}).join('');
  }
  document.getElementById('mkt-page-info').textContent=
    'Page '+(mktPageNum+1)+' of '+totalPages+' ('+filtered.length+' markets)';
  document.getElementById('mkt-prev').disabled=mktPageNum===0;
  document.getElementById('mkt-next').disabled=mktPageNum>=totalPages-1;
}
function mktPage(dir){mktPageNum+=dir;renderMarkets()}
document.getElementById('mkt-filter').addEventListener('input',function(){mktPageNum=0;renderMarkets()});

async function refresh(){
  try{
    const r=await fetch('/api/status');
    if(r.status===401){window.location.reload();return}
    const d=await r.json();
    const s=d.session;
    const VALID_STATUSES=['RUNNING','STOPPED','PANIC'];
    const statusText=s&&VALID_STATUSES.includes(s.status)?s.status:'NO SESSION';
    const dotClass=s&&VALID_STATUSES.includes(s.status)?('dot-'+s.status.toLowerCase()):'dot-none';
    const sEl=document.getElementById('s-status');
    const dot=sEl.querySelector('.status-dot')||document.createElement('span');
    dot.className='status-dot '+dotClass;
    if(!sEl.querySelector('.status-dot'))sEl.prepend(dot);
    const txt=sEl.querySelector('.status-text')||document.createElement('span');
    txt.className='status-text';txt.textContent=statusText;
    if(!sEl.querySelector('.status-text'))sEl.appendChild(txt);
    document.getElementById('s-budget').textContent=s?('$'+fmt(s.budget_usdc)):'--';
    document.getElementById('s-spread').textContent=s?(s.spread_cents+'c spread'):'';
    document.getElementById('s-placed').textContent=s?s.orders_placed:'0';
    document.getElementById('s-cancelled').textContent=s?s.orders_cancelled:'0';
    const filled=s?s.orders_filled:0;
    const placed=s?s.orders_placed:0;
    const rate=placed>0?((filled/placed)*100):0;
    document.getElementById('s-fillrate').textContent=fmt(rate,1)+'%';
    document.getElementById('s-fillbar').style.width=Math.min(rate,100)+'%';

    // P&L summary
    const pnl=d.pnlSummary||{};
    const pnlCents=pnl.realizedCents||0;
    const pnlEl=document.getElementById('s-pnl');
    pnlEl.textContent=fmtCents(pnlCents);
    pnlEl.className='card-value '+pnlClass(pnlCents);
    document.getElementById('s-pnl-sub').textContent=
      (pnl.totalHedged||0)+' hedged, '+(pnl.totalFailed||0)+' failed';

    // Inventory exposure
    document.getElementById('s-inventory').textContent='$'+fmt(pnl.inventoryUsdc||0);
    document.getElementById('s-inventory-sub').textContent=
      (pnl.inventoryCount||0)+' positions';

    // Estimated daily rewards
    const scores=d.rewardScores||[];
    const totalDaily=scores.reduce((s,r)=>s+r.estimatedDaily,0);
    document.getElementById('s-rewards').textContent='$'+fmt(totalDaily)+'/day';
    const twoSidedCount=scores.filter(r=>r.isTwoSided).length;
    document.getElementById('s-rewards-sub').textContent=
      twoSidedCount+'/'+scores.length+' two-sided';

    // Build reward map for markets table
    rewardMap=new Map();
    for(const rs of scores)rewardMap.set(rs.conditionId,rs);

    // Live orders
    const ob=document.getElementById('orders-body');
    const orders=d.liveOrders||[];
    document.getElementById('live-count').textContent=orders.length;
    if(orders.length===0){
      ob.innerHTML='<tr><td colspan="7" class="empty">No live orders</td></tr>';
    } else {
      ob.innerHTML=orders.map(o=>'<tr>'+
        '<td class="mono">'+esc(shortId(o.order_id))+'</td>'+
        '<td>'+esc(shortId(o.condition_id))+'</td>'+
        '<td class="side-'+(o.side==='BUY'?'buy':'sell')+'">'+esc(o.side)+'</td>'+
        '<td>'+fmt(o.price)+'</td>'+
        '<td>'+fmt(o.size,1)+'</td>'+
        '<td>'+esc(o.order_type)+'</td>'+
        '<td>'+fmtTime(o.placed_at)+'</td>'+
        '</tr>').join('');
    }

    // Position exposure (inventory)
    const inv=d.inventory||[];
    document.getElementById('inv-count').textContent=inv.length;
    const invBody=document.getElementById('inv-body');
    if(inv.length===0){
      invBody.innerHTML='<tr><td colspan="5" class="empty">No inventory positions</td></tr>';
    } else {
      invBody.innerHTML=inv.map(i=>{
        const ratio=i.minted_amount>0?(i.current_balance/i.minted_amount):0;
        const statusLabel=ratio>0.9?'Full':ratio>0?'Partial':'Consumed';
        const statusColor=ratio>0.9?'pnl-pos':ratio>0?'pnl-zero':'pnl-neg';
        return '<tr>'+
          '<td class="mono">'+esc(shortId(i.condition_id))+'</td>'+
          '<td class="side-'+(i.side==='NO'?'sell':'buy')+'">'+esc(i.side)+'</td>'+
          '<td>'+fmt(i.minted_amount,1)+'</td>'+
          '<td>'+fmt(i.current_balance,1)+'</td>'+
          '<td class="'+statusColor+'">'+statusLabel+'</td>'+
          '</tr>'}).join('');
    }

    // Markets — update data, re-render if count changed or first load
    const mkts=d.markets||[];
    document.getElementById('mkt-count').textContent=mkts.length;
    document.getElementById('s-markets').textContent=mkts.length;
    if(mkts.length!==allMarkets.length||allMarkets.length===0){
      allMarkets=mkts;
    } else {
      allMarkets=mkts;
    }
    renderMarkets();

    // Hedge history
    const hedges=d.hedges||[];
    document.getElementById('hedge-count').textContent=hedges.length;
    const hb=document.getElementById('hedge-body');
    if(hedges.length===0){
      hb.innerHTML='<tr><td colspan="7" class="empty">No hedge activity</td></tr>';
    } else {
      hb.innerHTML=hedges.map(h=>'<tr>'+
        '<td>'+fmtTime(h.created_at)+'</td>'+
        '<td class="side-'+(h.fill_side==='BUY'?'buy':'sell')+'">'+esc(h.fill_side)+'</td>'+
        '<td>'+fmt(h.fill_price)+'</td>'+
        '<td>'+(h.hedge_price!=null?fmt(h.hedge_price):'--')+'</td>'+
        '<td>'+fmt(h.merge_amount,1)+'</td>'+
        '<td class="'+pnlClass(h.pnl_cents)+'">'+fmtCents(h.pnl_cents)+'</td>'+
        '<td class="'+hedgeStatusClass(h.status)+'">'+esc(h.status)+'</td>'+
        '</tr>').join('');
    }

    // Recent activity (cancelled/filled)
    const ab=document.getElementById('activity-body');
    const acts=d.recentOrders||[];
    document.getElementById('activity-count').textContent=acts.length;
    if(acts.length===0){
      ab.innerHTML='<tr><td colspan="6" class="empty">No recent activity</td></tr>';
    } else {
      ab.innerHTML=acts.map(o=>'<tr>'+
        '<td class="mono">'+esc(shortId(o.order_id))+'</td>'+
        '<td class="side-'+(o.side==='BUY'?'buy':'sell')+'">'+esc(o.side)+'</td>'+
        '<td>'+fmt(o.price)+'</td>'+
        '<td>'+fmt(o.size,1)+'</td>'+
        '<td>'+esc(o.status)+'</td>'+
        '<td>'+fmtTime(o.cancelled_at||o.placed_at)+'</td>'+
        '</tr>').join('');
    }
  }catch(e){console.error('refresh error',e)}
}

async function doPanic(){
  if(!confirm('Cancel ALL orders immediately?'))return;
  const btn=document.getElementById('panicBtn');
  btn.disabled=true;btn.textContent='CANCELLING...';
  try{
    const r=await fetch('/api/panic',{method:'POST'});
    const d=await r.json();
    toast('Cancelled '+d.cancelled+' orders');
    refresh();
  }catch(e){toast('Panic failed: '+e.message)}
  finally{btn.disabled=false;btn.textContent='PANIC CANCEL ALL'}
}

async function doLogout(){
  try{await fetch('/api/logout',{method:'POST'});window.location.reload()}catch(e){toast('Logout failed')}
}

refresh();
setInterval(refresh,2000);
</script>
</body>
</html>`;
}
