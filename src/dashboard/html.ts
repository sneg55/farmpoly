export function loginHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PolyFarm — Login</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --bg:#06080d;--surface:#0c1018;--border:#14192480;
    --text:#c8d6e5;--dim:#4a5568;--accent:#00e5a0;--accent-dim:#00e5a020;
    --red:#ff4757;--yellow:#ffa502;--blue:#3b82f6;
    --glow:0 0 20px #00e5a030,0 0 60px #00e5a010;
  }
  body{
    font-family:'DM Sans',sans-serif;
    background:var(--bg);color:var(--text);
    display:flex;align-items:center;justify-content:center;min-height:100vh;
    position:relative;overflow:hidden;
  }
  body::before{
    content:'';position:fixed;inset:0;
    background:
      repeating-linear-gradient(0deg,transparent,transparent 2px,#00e5a003 2px,#00e5a003 4px),
      radial-gradient(ellipse at 50% 0%,#00e5a008 0%,transparent 60%);
    pointer-events:none;z-index:0;
  }
  .login-box{
    background:var(--surface);border:1px solid var(--border);border-radius:2px;
    padding:40px;width:380px;position:relative;z-index:1;
    box-shadow:var(--glow),0 25px 50px #00000060;
  }
  .login-box::before{
    content:'';position:absolute;top:0;left:0;right:0;height:2px;
    background:linear-gradient(90deg,transparent,var(--accent),transparent);
  }
  .brand{
    font-family:'JetBrains Mono',monospace;font-size:1.5rem;font-weight:700;
    color:var(--accent);letter-spacing:.15em;text-transform:uppercase;margin-bottom:4px;
  }
  .brand-dot{display:inline-block;width:8px;height:8px;background:var(--accent);
    border-radius:1px;margin-right:8px;box-shadow:0 0 8px var(--accent)}
  .login-box .sub{color:var(--dim);font-size:.8rem;margin-bottom:28px;font-family:'JetBrains Mono',monospace;letter-spacing:.02em}
  .login-box label{font-size:.7rem;color:var(--dim);display:block;margin-bottom:6px;
    font-family:'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:.1em}
  .login-box input{
    width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);
    padding:12px 14px;border-radius:2px;font-size:.9rem;margin-bottom:20px;outline:none;
    font-family:'JetBrains Mono',monospace;transition:border-color .2s,box-shadow .2s;
  }
  .login-box input:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-dim)}
  .login-box button{
    width:100%;background:var(--accent);color:var(--bg);border:none;padding:12px;
    border-radius:2px;font-weight:700;font-size:.85rem;cursor:pointer;
    font-family:'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:.1em;
    transition:all .15s;
  }
  .login-box button:hover{box-shadow:0 0 20px #00e5a040;transform:translateY(-1px)}
  .login-box button:disabled{opacity:.4;cursor:not-allowed;transform:none;box-shadow:none}
  .error{color:var(--red);font-size:.8rem;margin-bottom:12px;display:none;font-family:'JetBrains Mono',monospace}
</style>
</head>
<body>
<div class="login-box">
  <div class="brand"><span class="brand-dot"></span>PolyFarm</div>
  <div class="sub">// authenticate to continue</div>
  <div class="error" id="err"></div>
  <label for="token">Auth Token</label>
  <input type="password" id="token" placeholder="Enter token..." autofocus>
  <button id="loginBtn" onclick="doLogin()">Connect</button>
</div>
<script>
document.getElementById('token').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin()});
async function doLogin(){
  const btn=document.getElementById('loginBtn');
  const err=document.getElementById('err');
  const token=document.getElementById('token').value.trim();
  if(!token){err.textContent='Token is required';err.style.display='block';return}
  btn.disabled=true;btn.textContent='Connecting...';err.style.display='none';
  try{
    const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
    if(r.ok){window.location.reload()}
    else{const d=await r.json();err.textContent=d.error||'Authentication failed';err.style.display='block'}
  }catch(e){err.textContent='Network error';err.style.display='block'}
  finally{btn.disabled=false;btn.textContent='Connect'}
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --bg:#06080d;--surface:#0c1018;--surface2:#0f1420;
    --border:#141924;--border-hi:#1e2a3a;
    --text:#c8d6e5;--text-bright:#e8f0fe;--dim:#4a5568;--dim2:#2d3748;
    --accent:#00e5a0;--accent-dim:#00e5a018;--accent-mid:#00e5a050;
    --green:#00e5a0;--red:#ff4757;--yellow:#ffa502;--blue:#5b9bf5;--purple:#a78bfa;
    --mono:'JetBrains Mono',monospace;--sans:'DM Sans',sans-serif;
    --glow:0 0 20px #00e5a015;
  }
  body{
    font-family:var(--sans);background:var(--bg);color:var(--text);
    padding:0;margin:0;position:relative;min-height:100vh;
  }
  body::before{
    content:'';position:fixed;inset:0;
    background:
      repeating-linear-gradient(0deg,transparent,transparent 2px,#00e5a002 2px,#00e5a002 4px),
      radial-gradient(ellipse at 30% 0%,#00e5a006 0%,transparent 50%),
      radial-gradient(ellipse at 70% 100%,#5b9bf504 0%,transparent 50%);
    pointer-events:none;z-index:0;
  }
  .container{max-width:1400px;margin:0 auto;padding:20px 24px;position:relative;z-index:1}

  /* ── Header ── */
  .header{
    display:flex;justify-content:space-between;align-items:flex-start;
    margin-bottom:28px;padding-bottom:20px;border-bottom:1px solid var(--border);
  }
  .brand{font-family:var(--mono);font-size:1.4rem;font-weight:700;color:var(--accent);
    letter-spacing:.15em;text-transform:uppercase;display:flex;align-items:center;gap:10px}
  .brand-dot{width:8px;height:8px;background:var(--accent);border-radius:1px;box-shadow:0 0 10px var(--accent)}
  .header-sub{
    font-family:var(--mono);font-size:.7rem;color:var(--dim);margin-top:6px;
    display:flex;align-items:center;gap:8px;
  }
  .live-indicator{display:flex;align-items:center;gap:5px}
  .live-ring{width:7px;height:7px;border-radius:50%;position:relative}
  .live-ring::before{content:'';position:absolute;inset:-3px;border-radius:50%;
    border:1px solid var(--accent);opacity:0;animation:ring-out 2s ease-out infinite}
  .live-ring-inner{width:7px;height:7px;border-radius:50%;background:var(--accent);
    box-shadow:0 0 6px var(--accent)}
  @keyframes ring-out{0%{transform:scale(.5);opacity:.8}100%{transform:scale(2);opacity:0}}
  .toolbar-right{display:flex;align-items:center;gap:10px}
  .btn-logout{
    background:transparent;color:var(--dim);border:1px solid var(--border);padding:7px 14px;
    border-radius:2px;cursor:pointer;font-family:var(--mono);font-size:.7rem;
    text-transform:uppercase;letter-spacing:.08em;transition:all .2s;
  }
  .btn-logout:hover{border-color:var(--text);color:var(--text)}
  .btn-panic{
    background:transparent;color:var(--red);border:1px solid #ff475730;padding:7px 14px;
    border-radius:2px;font-weight:700;cursor:pointer;font-family:var(--mono);font-size:.7rem;
    text-transform:uppercase;letter-spacing:.08em;transition:all .2s;
  }
  .btn-panic:hover{background:#ff475715;border-color:var(--red);box-shadow:0 0 20px #ff475720}
  .btn-panic:disabled{opacity:.3;cursor:not-allowed;box-shadow:none;background:transparent}

  /* ── Stat Cards ── */
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1px;
    margin-bottom:28px;background:var(--border);border-radius:3px;overflow:hidden;
    box-shadow:var(--glow)}
  .stat{background:var(--surface);padding:18px 20px;position:relative}
  .stat::after{content:'';position:absolute;top:0;left:0;width:3px;height:100%;
    background:var(--accent);opacity:0;transition:opacity .3s}
  .stat:hover::after{opacity:1}
  .stat-label{font-family:var(--mono);font-size:.6rem;color:var(--dim);text-transform:uppercase;
    letter-spacing:.12em;margin-bottom:8px}
  .stat-value{font-family:var(--mono);font-size:1.5rem;font-weight:700;color:var(--text-bright);
    line-height:1}
  .stat-sub{font-family:var(--mono);font-size:.65rem;color:var(--dim);margin-top:6px}
  .stat-value.pnl-pos{color:var(--green)}
  .stat-value.pnl-neg{color:var(--red)}
  .stat-value.pnl-zero{color:var(--dim)}

  /* Status badge */
  .status-badge{
    display:inline-flex;align-items:center;gap:6px;
    font-family:var(--mono);font-size:.8rem;font-weight:700;text-transform:uppercase;
    letter-spacing:.08em;padding:4px 10px;border-radius:2px;
  }
  .badge-running{color:var(--green);background:#00e5a010;border:1px solid #00e5a030}
  .badge-stopped{color:var(--yellow);background:#ffa50210;border:1px solid #ffa50230}
  .badge-panic{color:var(--red);background:#ff475710;border:1px solid #ff475730}
  .badge-none{color:var(--dim);background:var(--surface2);border:1px solid var(--border)}
  .badge-dot{width:6px;height:6px;border-radius:50%}
  .badge-running .badge-dot{background:var(--green);box-shadow:0 0 6px var(--green)}
  .badge-stopped .badge-dot{background:var(--yellow)}
  .badge-panic .badge-dot{background:var(--red);box-shadow:0 0 6px var(--red)}
  .badge-none .badge-dot{background:var(--dim)}

  /* Progress bar */
  .progress-track{height:3px;background:var(--border);border-radius:1px;overflow:hidden;margin-top:8px}
  .progress-fill{height:100%;border-radius:1px;transition:width .6s cubic-bezier(.4,0,.2,1)}
  .fill-accent{background:var(--accent)}
  .fill-green{background:var(--green)}
  .fill-yellow{background:var(--yellow)}
  .fill-blue{background:var(--blue)}

  /* ── Sections ── */
  .section{margin-bottom:24px}
  .section-header{
    display:flex;align-items:center;justify-content:space-between;
    margin-bottom:10px;padding:0 2px;
  }
  .section-title{
    font-family:var(--mono);font-size:.7rem;color:var(--dim);
    text-transform:uppercase;letter-spacing:.12em;display:flex;align-items:center;gap:8px;
  }
  .count-badge{
    font-family:var(--mono);font-size:.6rem;color:var(--accent);
    background:var(--accent-dim);padding:2px 7px;border-radius:2px;font-weight:500;
  }

  /* ── Tables ── */
  .table-wrap{
    background:var(--surface);border:1px solid var(--border);border-radius:3px;
    overflow:hidden;box-shadow:var(--glow);
  }
  table{width:100%;border-collapse:collapse;font-size:.8rem}
  th{
    text-align:left;color:var(--dim);font-weight:500;padding:10px 14px;
    border-bottom:1px solid var(--border);font-family:var(--mono);font-size:.6rem;
    text-transform:uppercase;letter-spacing:.1em;background:var(--surface2);
  }
  td{padding:10px 14px;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:.75rem;transition:background .15s}
  tr:last-child td{border-bottom:none}
  tbody tr:hover td{background:#ffffff04}
  .side-buy{color:var(--green);font-weight:600}
  .side-sell{color:var(--red);font-weight:600}
  .empty{color:var(--dim);padding:32px;text-align:center;font-family:var(--mono);font-size:.75rem;letter-spacing:.03em}
  .mono{font-family:var(--mono);font-size:.7rem;color:var(--dim)}
  .scrollable{max-height:500px;overflow-y:auto}

  /* ── Two-sided / One-sided badges ── */
  .two-sided{color:var(--green);font-weight:600;font-size:.65rem;
    background:#00e5a010;padding:1px 5px;border-radius:2px}
  .one-sided{color:var(--yellow);font-size:.65rem;
    background:#ffa50210;padding:1px 5px;border-radius:2px}

  /* ── Filter / Pagination ── */
  .filter-row{display:flex;align-items:center;gap:12px;margin-bottom:10px}
  .filter-input{
    background:var(--surface);border:1px solid var(--border);color:var(--text);
    padding:8px 14px;border-radius:2px;font-family:var(--mono);font-size:.75rem;
    width:300px;outline:none;transition:border-color .2s,box-shadow .2s;
  }
  .filter-input:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-dim)}
  .filter-input::placeholder{color:var(--dim)}
  .page-controls{
    display:flex;align-items:center;gap:8px;padding:10px 14px;
    background:var(--surface2);font-family:var(--mono);font-size:.65rem;color:var(--dim);
    border-top:1px solid var(--border);
  }
  .page-btn{
    background:var(--surface);border:1px solid var(--border);color:var(--text);
    padding:4px 10px;border-radius:2px;cursor:pointer;font-family:var(--mono);font-size:.65rem;
    transition:all .15s;
  }
  .page-btn:hover{border-color:var(--accent);color:var(--accent)}
  .page-btn:disabled{opacity:.2;cursor:not-allowed;border-color:var(--border);color:var(--dim)}

  /* ── Toast ── */
  .toast{
    position:fixed;bottom:24px;right:24px;
    background:var(--surface);border:1px solid var(--accent);
    padding:12px 20px;border-radius:2px;font-family:var(--mono);font-size:.75rem;
    color:var(--accent);box-shadow:0 0 30px #00e5a020;
    opacity:0;transform:translateY(10px);transition:all .3s;pointer-events:none;
  }
  .toast.show{opacity:1;transform:translateY(0)}

  /* ── Stale section warning ── */
  .stale-warn .table-wrap{border-color:#ffa50230}
  .stale-warn .section-title{color:var(--yellow)}
  .stale-warn .count-badge{color:var(--yellow);background:#ffa50215}

  /* ── Link styling ── */
  a{color:var(--blue);text-decoration:none;transition:color .15s}
  a:hover{color:var(--accent)}

  /* ── Responsive ── */
  @media(max-width:768px){
    .container{padding:12px}
    .stats{grid-template-columns:repeat(2,1fr)}
    .filter-input{width:100%}
    .header{flex-direction:column;gap:12px}
    .toolbar-right{width:100%;justify-content:flex-end}
  }

  /* ── Entry animation ── */
  @keyframes fade-up{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  .section,.stats{animation:fade-up .4s ease-out both}
  .section:nth-child(2){animation-delay:.05s}
  .section:nth-child(3){animation-delay:.1s}
  .section:nth-child(4){animation-delay:.15s}
  .section:nth-child(5){animation-delay:.2s}
  .section:nth-child(6){animation-delay:.25s}
  .section:nth-child(7){animation-delay:.3s}
</style>
</head>
<body>
<div class="container">

<div class="header">
  <div>
    <div class="brand"><span class="brand-dot"></span>PolyFarm</div>
    <div class="header-sub">
      <span class="live-indicator">
        <span class="live-ring"><span class="live-ring-inner"></span></span>
        <span>Live &mdash; 2s refresh</span>
      </span>
    </div>
  </div>
  <div class="toolbar-right">
    <button class="btn-logout" onclick="doLogout()">Logout</button>
    <button class="btn-panic" id="panicBtn" onclick="doPanic()">Panic Cancel All</button>
  </div>
</div>

<div class="stats" id="stats">
  <div class="stat">
    <div class="stat-label">Status</div>
    <div class="stat-value" id="s-status"><span class="status-badge badge-none"><span class="badge-dot"></span>--</span></div>
  </div>
  <div class="stat">
    <div class="stat-label">Budget</div>
    <div class="stat-value" id="s-budget">--</div>
    <div class="stat-sub" id="s-spread"></div>
  </div>
  <div class="stat">
    <div class="stat-label">Orders Placed</div>
    <div class="stat-value" id="s-placed">--</div>
  </div>
  <div class="stat">
    <div class="stat-label">Fill Rate</div>
    <div class="stat-value" id="s-fillrate">--</div>
    <div class="progress-track"><div class="progress-fill fill-accent" id="s-fillbar" style="width:0%"></div></div>
  </div>
  <div class="stat">
    <div class="stat-label">Cancelled</div>
    <div class="stat-value" id="s-cancelled">--</div>
  </div>
  <div class="stat">
    <div class="stat-label">Markets</div>
    <div class="stat-value" id="s-markets">--</div>
  </div>
  <div class="stat">
    <div class="stat-label">Realized P&L</div>
    <div class="stat-value" id="s-pnl">--</div>
    <div class="stat-sub" id="s-pnl-sub"></div>
  </div>
  <div class="stat">
    <div class="stat-label">Inventory Exposure</div>
    <div class="stat-value" id="s-inventory">--</div>
    <div class="stat-sub" id="s-inventory-sub"></div>
  </div>
  <div class="stat">
    <div class="stat-label">Est. Daily Rewards</div>
    <div class="stat-value" id="s-rewards">--</div>
    <div class="stat-sub" id="s-rewards-sub"></div>
  </div>
</div>

<div class="section">
  <div class="section-header">
    <div class="section-title">Live Orders <span class="count-badge" id="live-count">0</span></div>
  </div>
  <div class="table-wrap">
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
  <div class="section-header">
    <div class="section-title">Position Exposure <span class="count-badge" id="inv-count">0</span></div>
  </div>
  <div class="table-wrap">
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

<div class="section stale-warn" id="stale-section" style="display:none">
  <div class="section-header">
    <div class="section-title">Stale Positions <span class="count-badge" id="stale-count">0</span></div>
  </div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr><th>Market</th><th>Side</th><th>Balance</th><th>Est. Value</th><th>Action</th></tr>
      </thead>
      <tbody id="stale-body">
        <tr><td colspan="5" class="empty">No stale positions</td></tr>
      </tbody>
    </table>
  </div>
</div>

<div class="section">
  <div class="section-header">
    <div class="section-title">Markets <span class="count-badge" id="mkt-count">0</span></div>
  </div>
  <div class="filter-row">
    <input class="filter-input" id="mkt-filter" type="text" placeholder="// filter markets...">
    <span style="color:var(--dim);font-family:var(--mono);font-size:.65rem" id="mkt-showing"></span>
  </div>
  <div class="table-wrap">
    <div class="scrollable">
      <table>
        <thead style="position:sticky;top:0;background:var(--surface2);z-index:1">
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
  <div class="section-header">
    <div class="section-title">Hedge History <span class="count-badge" id="hedge-count">0</span></div>
  </div>
  <div class="table-wrap">
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
  <div class="section-header">
    <div class="section-title">Recent Activity <span class="count-badge" id="activity-count">0</span></div>
  </div>
  <div class="table-wrap">
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

</div><!-- .container -->

<div id="toast" class="toast"></div>

<script>
function fmt(n,d=2){return n!=null?Number(n).toFixed(d):'--'}
function fmtUsd(n){if(n==null)return'--';if(n>=1e6)return'$'+(n/1e6).toFixed(1)+'M';if(n>=1e3)return'$'+(n/1e3).toFixed(1)+'K';return'$'+n.toFixed(0)}
function fmtCents(c){if(c==null)return'--';const d=c/100;return(d>=0?'+$':'-$')+Math.abs(d).toFixed(2)}
function fmtTime(ts){if(!ts)return'--';const d=new Date(ts*1000);return d.toLocaleTimeString()}
function shortId(id){return id?id.slice(0,10)+'..':'--'}
function toast(msg,ms=3000){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),ms)}
function esc(s){const d=document.createElement('div');d.textContent=String(s);return d.innerHTML}
function truncQ(q){const s=String(q);return s.length>55?s.slice(0,53)+'..':s}
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
      const qualityBar=rs?'<div class="progress-track" style="margin-top:4px"><div class="progress-fill fill-green" style="width:'+Math.round(rs.spreadQuality*100)+'%"></div></div>':'';
      const share=rs?fmt(rs.bookShare,1)+'%':'--';
      const twoSided=rs?(rs.isTwoSided?'<span class="two-sided">2x</span>':'<span class="one-sided">1x</span>'):'';
      const qHtml = m.slug
        ? '<a href="https://polymarket.com/event/'+esc(m.slug)+'" target="_blank" rel="noopener">'+esc(truncQ(m.question))+'</a>'
        : esc(truncQ(m.question));
      return '<tr>'+
        '<td style="max-width:280px">'+qHtml+'</td>'+
        '<td>'+fmt(m.midpoint)+'</td>'+
        '<td>'+fmtUsd(m.tvl)+'</td>'+
        '<td>$'+fmt(m.reward_rate)+' '+twoSided+'</td>'+
        '<td>'+quality+qualityBar+'</td>'+
        '<td>'+share+'</td>'+
        '<td>'+esc(m.tick_size)+'</td>'+
        '</tr>'}).join('');
  }
  document.getElementById('mkt-page-info').textContent=
    'Page '+(mktPageNum+1)+' / '+totalPages+' ('+filtered.length+' markets)';
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
    const badgeClass=s&&VALID_STATUSES.includes(s.status)?('badge-'+s.status.toLowerCase()):'badge-none';
    document.getElementById('s-status').innerHTML=
      '<span class="status-badge '+badgeClass+'"><span class="badge-dot"></span>'+statusText+'</span>';
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
    pnlEl.className='stat-value '+pnlClass(pnlCents);
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

    // Build condition_id → question lookup from all known markets
    const mktMap=new Map();
    const names=d.marketNames||{};
    for(const cid of Object.keys(names))mktMap.set(cid,names[cid]);
    // Fallback: also include active markets
    for(const m of (d.markets||[]))if(!mktMap.has(m.condition_id))mktMap.set(m.condition_id,m.question);

    // Live orders
    const ob=document.getElementById('orders-body');
    const orders=d.liveOrders||[];
    document.getElementById('live-count').textContent=orders.length;
    if(orders.length===0){
      ob.innerHTML='<tr><td colspan="7" class="empty">No live orders</td></tr>';
    } else {
      ob.innerHTML=orders.map(o=>{
        const q=mktMap.get(o.condition_id);
        const mktLabel=q?esc(truncQ(q)):'<span class="mono">'+esc(shortId(o.condition_id))+'</span>';
        return '<tr>'+
        '<td class="mono">'+esc(shortId(o.order_id))+'</td>'+
        '<td style="max-width:220px">'+mktLabel+'</td>'+
        '<td class="side-'+(o.side==='BUY'?'buy':'sell')+'">'+esc(o.side)+'</td>'+
        '<td>'+fmt(o.price)+'</td>'+
        '<td>'+fmt(o.size,1)+'</td>'+
        '<td>'+esc(o.order_type)+'</td>'+
        '<td>'+fmtTime(o.placed_at)+'</td>'+
        '</tr>'}).join('');
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
        const q=mktMap.get(i.condition_id);
        const invLabel=q?esc(truncQ(q)):'<span class="mono">'+esc(shortId(i.condition_id))+'</span>';
        return '<tr>'+
          '<td style="max-width:220px">'+invLabel+'</td>'+
          '<td class="side-'+(i.side==='NO'?'sell':'buy')+'">'+esc(i.side)+'</td>'+
          '<td>'+fmt(i.minted_amount,1)+'</td>'+
          '<td>'+fmt(i.current_balance,1)+'</td>'+
          '<td class="'+statusColor+'">'+statusLabel+'</td>'+
          '</tr>'}).join('');
    }

    // Stale positions (not in active markets)
    const stale=d.stalePositions||[];
    const staleSec=document.getElementById('stale-section');
    document.getElementById('stale-count').textContent=stale.length;
    if(stale.length>0){
      staleSec.style.display='';
      document.getElementById('stale-body').innerHTML=stale.map(p=>{
        const actionColor=p.suggestedAction==='merge'?'pnl-pos':'pnl-zero';
        return '<tr>'+
          '<td style="max-width:280px">'+esc(truncQ(p.question))+'</td>'+
          '<td class="side-'+(p.side==='YES'?'buy':'sell')+'">'+esc(p.side)+'</td>'+
          '<td>'+fmt(p.balance,1)+'</td>'+
          '<td>$'+fmt(p.estimatedValue)+'</td>'+
          '<td class="'+actionColor+'">'+esc(p.suggestedAction)+'</td>'+
          '</tr>'}).join('');
    } else {
      staleSec.style.display='none';
    }

    // Markets — update data, re-render
    const mkts=d.markets||[];
    document.getElementById('mkt-count').textContent=mkts.length;
    document.getElementById('s-markets').textContent=mkts.length;
    allMarkets=mkts;
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
  btn.disabled=true;btn.textContent='Cancelling...';
  try{
    const r=await fetch('/api/panic',{method:'POST'});
    const d=await r.json();
    toast('Cancelled '+d.cancelled+' orders');
    refresh();
  }catch(e){toast('Panic failed: '+e.message)}
  finally{btn.disabled=false;btn.textContent='Panic Cancel All'}
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
