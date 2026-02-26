/* CCM — Frontend Logic */
var currentTab = 'all', selectedTaskId = null, logWs = null, eventsWs = null, tasks = [];

async function api(path, opts) {
    opts = opts || {};
    var res = await fetch(path, Object.assign({ headers: {'Content-Type':'application/json'} }, opts));
    if (!res.ok) { var e = await res.json().catch(function(){return {detail:res.statusText}}); throw new Error(e.detail||'fail'); }
    return res.json();
}

// --- Init ---
document.addEventListener('DOMContentLoaded', function() {
    refreshAll(); connectEvents(); setInterval(refreshAll, 8000);
    document.getElementById('quickInput').addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); quickSend(); }
    });
});

async function refreshAll() { await Promise.all([refreshStatus(), refreshTasks()]); }

// --- Quick input ---
function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

var _sending = false;
async function quickSend() {
    if (_sending) return;
    var el = document.getElementById('quickInput');
    var text = el.value.trim();
    if (!text) return;
    _sending = true;
    el.value = ''; el.style.height = 'auto';
    try { await api('/api/tasks', { method:'POST', body: JSON.stringify({prompt:text}) }); refreshAll(); }
    catch(e) { alert('Failed: '+e.message); }
    finally { _sending = false; }
}

// --- Status ---
async function refreshStatus() {
    try {
        var s = await api('/api/status');
        var t = s.tasks || {};
        document.getElementById('statRunning').textContent = t.running || 0;
        document.getElementById('statQueued').textContent = t.queued || 0;
        document.getElementById('statDone').textContent = (t.completed||0);
        document.getElementById('statFailed').textContent = (t.failed||0);
        renderWorkers(s.workers || []);
    } catch(e) { console.error(e); }
}

function renderWorkers(workers) {
    var el = document.getElementById('workersPanel');
    if (!workers.length) { el.innerHTML = '<div style="padding:4px 0;font-size:12px;color:var(--dim)">No workers</div>'; return; }
    el.innerHTML = workers.map(function(w) {
        var cls = w.status === 'busy' ? ' busy' : '';
        var taskInfo = w.task_id
            ? '<span class="wt">' + esc(w.worktree||'') + '</span> #' + w.task_id + ' ' + esc(w.task_prompt)
            : 'idle';
        return '<div class="worker-card' + cls + '" ' + (w.task_id ? 'onclick="selectTask('+w.task_id+')"' : '') + '>' +
            '<div class="worker-head"><span class="worker-name">W' + w.id + '</span>' +
            '<span class="worker-status ' + w.status + '">' + w.status + '</span></div>' +
            '<div class="worker-task">' + taskInfo + '</div></div>';
    }).join('');
}

// --- Tasks ---
async function refreshTasks() {
    try { tasks = await api('/api/tasks'); renderTasks(); } catch(e) { console.error(e); }
}

function renderTasks() {
    var list = document.getElementById('taskList');
    var filtered;
    if (currentTab === 'all') filtered = tasks;
    else if (currentTab === 'done') filtered = tasks.filter(function(t){return t.status==='completed'||t.status==='failed'||t.status==='cancelled';});
    else filtered = tasks.filter(function(t){return t.status===currentTab;});

    var c = {};
    tasks.forEach(function(t){c[t.status]=(c[t.status]||0)+1;});
    document.getElementById('badgeAll').textContent = tasks.length;

    if (!filtered.length) { list.innerHTML = '<div class="empty-state">No tasks here.</div>'; return; }
    list.innerHTML = filtered.map(function(t) {
        var promptText = t.prompt_short||t.prompt||'';
        // Clean up plan-mode tasks: show goal instead of verbose template
        if (t.mode === 'plan' && promptText.indexOf('GOAL:') !== -1) {
            var goalMatch = promptText.match(/GOAL:\s*\n([\s\S]*?)(\n\nOutput|$)/);
            promptText = goalMatch ? '[Plan] ' + goalMatch[1].trim() : '[Plan] generating...';
        }
        var p = esc(promptText.substring(0,120));
        var active = t.id === selectedTaskId ? ' active' : '';
        var plan = t.plan_group_id ? '<span class="plan-link" onclick="event.stopPropagation();viewPlan('+t.plan_group_id+')">plan#'+t.plan_group_id+'</span>' : '';
        var cost = t.cost_usd ? '$'+t.cost_usd.toFixed(3) : '';
        return '<div class="task-card'+active+'" onclick="selectTask('+t.id+')">' +
            '<div class="task-top"><span class="task-id">#'+t.id+'</span><span class="tag tag-'+t.status+'">'+t.status+'</span></div>' +
            '<div class="task-prompt">'+p+'</div>' +
            '<div class="task-meta">'+plan+(cost?'<span>'+cost+'</span>':'')+'<span>'+timeAgo(t.created_at)+'</span></div></div>';
    }).join('');
}

function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(function(el){el.classList.toggle('active',el.dataset.tab===tab);});
    renderTasks();
}

// --- Log panel ---
async function selectTask(id) {
    // If this is a plan task, open the plan review modal instead
    var task = tasks.find(function(t){return t.id===id;});
    if (task && task.mode === 'plan' && task.plan_group_id) {
        viewPlan(task.plan_group_id);
        return;
    }

    selectedTaskId = id;
    var overlay = document.getElementById('logOverlay');
    var content = document.getElementById('logContent');
    document.getElementById('logTaskId').textContent = id;
    content.innerHTML = '<div style="color:var(--dim);padding:8px">Loading...</div>';
    overlay.style.display = 'flex';

    var task = tasks.find(function(t){return t.id===id;});
    document.getElementById('logCancelBtn').style.display = (task && (task.status==='queued'||task.status==='running')) ? 'inline-block' : 'none';
    var st = document.getElementById('logStatus');
    if (task) { st.className = 'tag tag-'+task.status; st.textContent = task.status; }

    try {
        var d = await api('/api/tasks/'+id);
        content.innerHTML = '';
        (d.logs||[]).forEach(function(l){appendLog(l);});
        if (!d.logs||!d.logs.length) content.innerHTML = '<div style="color:var(--dim);padding:8px;font-style:italic">Waiting for output...</div>';
    } catch(e) { content.innerHTML = '<div class="log-entry error">'+e.message+'</div>'; }

    connectTaskWs(id);
    renderTasks();
    scrollLog();
}

function appendLog(log) {
    var c = document.getElementById('logContent');
    var ph = c.querySelector('[style*="italic"]'); if (ph) ph.remove();
    var div = document.createElement('div');
    var payload;
    try { payload = typeof log.payload==='string' ? JSON.parse(log.payload) : log.payload; }
    catch(e) { payload = {text:log.payload}; }
    var f = fmtLog(log.event_type, payload);
    div.className = 'log-entry ' + f.cls;
    div.innerHTML = f.html;
    c.appendChild(div);
}

function fmtLog(et, p) {
    if (!p) return {cls:'system',html:''};
    var type = p.type || et;

    if (type==='assistant') {
        var txt = '';
        if (p.message && p.message.content) {
            var parts = p.message.content;
            txt = Array.isArray(parts) ? parts.map(function(c){return c.text||'';}).join('') : String(parts);
        } else if (p.content) {
            txt = Array.isArray(p.content) ? p.content.map(function(c){return c.text||'';}).join('') : String(p.content);
        } else if (p.delta && p.delta.text) { txt = p.delta.text; }
        if (txt) return {cls:'assistant', html:'<div class="log-label">Claude</div>'+esc(txt)};
        return {cls:'system',html:''};
    }
    if (type==='tool_use') {
        var name = p.name||p.tool||'?';
        var inp = '';
        if (p.input) {
            var i = p.input;
            if (name==='Bash') inp = i.command||JSON.stringify(i);
            else if (name==='Read') inp = i.file_path||i.path||'';
            else if (name==='Edit'||name==='Write') inp = i.file_path||i.path||'';
            else if (name==='Grep'||name==='Glob') inp = (i.pattern||'')+(i.path?' in '+i.path:'');
            else inp = JSON.stringify(i);
        }
        return {cls:'tool_use', html:'<div class="log-tool-name">'+esc(name)+'</div>'+(inp?'<div class="log-tool-input">'+esc(trunc(inp,250))+'</div>':'')};
    }
    if (type==='tool_result') {
        var r = p.content||p.output||p.text||''; if (typeof r!=='string') r=JSON.stringify(r);
        return {cls:'tool_result', html:'<div class="log-label">Result</div>'+esc(trunc(r,400))};
    }
    if (type==='result') {
        var res = p.result||'';
        var u = p.usage||{};
        var info = (u.input_tokens||u.output_tokens) ? ' ('+((u.input_tokens||0))+' in / '+((u.output_tokens||0))+' out)' : '';
        return {cls:'result', html:'<div class="log-label">Done'+esc(info)+'</div>'+esc(trunc(res,400))};
    }
    if (type==='error') return {cls:'error', html:'<div class="log-label">Error</div>'+esc(p.error||p.message||JSON.stringify(p))};
    if (type==='system' && p.subtype==='init') return {cls:'system', html:'Session started'};
    return {cls:'system', html:esc(trunc(JSON.stringify(p),150))};
}

function scrollLog() { var c=document.getElementById('logContent'); c.scrollTop=c.scrollHeight; }
function closeLog() { document.getElementById('logOverlay').style.display='none'; if(logWs){logWs.close();logWs=null;} selectedTaskId=null; renderTasks(); }

async function cancelTask() {
    if (!selectedTaskId) return;
    try { await api('/api/tasks/'+selectedTaskId,{method:'DELETE'}); closeLog(); refreshAll(); }
    catch(e) { alert(e.message); }
}

// --- WebSocket ---
function connectTaskWs(id) {
    if (logWs) logWs.close();
    var proto = location.protocol==='https:'?'wss:':'ws:';
    logWs = new WebSocket(proto+'//'+location.host+'/ws/logs/'+id);
    logWs.onmessage = function(e) { try { var m=JSON.parse(e.data); appendLog({event_type:m.event_type,payload:m.payload}); scrollLog(); } catch(err){} };
    logWs.onclose = function() { logWs=null; };
}

function connectEvents() {
    var proto = location.protocol==='https:'?'wss:':'ws:';
    eventsWs = new WebSocket(proto+'//'+location.host+'/ws/events');
    eventsWs.onopen = function() {
        document.getElementById('connDot').classList.add('on');
        document.getElementById('connText').textContent = 'connected';
    };
    eventsWs.onmessage = function(e) {
        try {
            var m = JSON.parse(e.data);
            if (m.event_type==='scheduler'||(m.payload&&m.payload.type==='scheduler_status')) {
                refreshStatus();
            }
            if (m.payload&&m.payload.type==='result') {
                refreshAll();
                // Auto-open plan review if a plan task just completed
                checkPlanReady();
            }
        } catch(err){}
    };
    eventsWs.onclose = function() {
        document.getElementById('connDot').classList.remove('on');
        document.getElementById('connText').textContent = 'disconnected';
        setTimeout(connectEvents, 3000);
    };
}

// --- Plan ---
var _lastCheckedPlanIds = {};

async function checkPlanReady() {
    // Look for plan tasks that just completed — check if their plan group is now "reviewing"
    try {
        var planTasks = tasks.filter(function(t){ return t.mode === 'plan' && t.plan_group_id && (t.status === 'completed' || t.status === 'failed'); });
        for (var i = 0; i < planTasks.length; i++) {
            var gid = planTasks[i].plan_group_id;
            if (_lastCheckedPlanIds[gid]) continue;
            var plan = await api('/api/plan/' + gid);
            if (plan.status === 'reviewing') {
                _lastCheckedPlanIds[gid] = true;
                viewPlan(gid);
                return;
            }
        }
    } catch(e) {}
}

function openPlanModal() { document.getElementById('planGoal').value=''; openModal('planModal'); document.getElementById('planGoal').focus(); }

async function submitPlan() {
    var goal = document.getElementById('planGoal').value.trim();
    if (!goal) return;
    try {
        var r = await api('/api/plan',{method:'POST',body:JSON.stringify({goal:goal})});
        closeModal('planModal'); refreshAll();
        // Poll until plan is ready for review (or timeout after 120s)
        var gid = r.group_id;
        var attempts = 0;
        var poll = setInterval(async function(){
            attempts++;
            try {
                var plan = await api('/api/plan/'+gid);
                if (plan.status !== 'planning' || attempts > 60) {
                    clearInterval(poll);
                    viewPlan(gid);
                }
            } catch(e) { clearInterval(poll); }
        }, 2000);
    } catch(e) { alert(e.message); }
}

async function viewPlan(gid) {
    try {
        var plan = await api('/api/plan/'+gid);
        document.getElementById('planDetailGoal').textContent = plan.goal||'';
        var sc = plan.status==='reviewing'?'queued':plan.status==='executing'?'running':plan.status;
        document.getElementById('planDetailStatus').innerHTML = '<span class="tag tag-'+sc+'">'+plan.status+'</span>';
        var sl = document.getElementById('planSteps');
        var steps = plan.plan_steps||[], subs = plan.tasks||[];
        if (steps.length) {
            sl.innerHTML = steps.map(function(s,i){
                var sub = subs.find(function(t){return t.prompt&&t.prompt.indexOf('Step '+(i+1))!==-1;});
                var cls = sub?(sub.status==='completed'?'done':sub.status==='running'?'running':''):'';
                return '<li class="plan-step '+cls+'"><strong>'+esc(s.title||'Step '+(i+1))+'</strong>'+
                    '<div class="step-desc">'+esc(s.description||'')+'</div>'+
                    (sub?'<span class="tag tag-'+sub.status+'">'+sub.status+'</span>':'')+'</li>';
            }).join('');
        } else if (plan.plan_text) {
            sl.innerHTML = '<li class="plan-step"><pre style="white-space:pre-wrap;font-size:12px">'+esc(plan.plan_text)+'</pre></li>';
        } else { sl.innerHTML = '<li class="plan-step" style="color:var(--dim)">Generating plan...</li>'; }
        var acts = document.getElementById('planDetailActions');
        acts.innerHTML = plan.status==='reviewing'
            ? '<button class="btn-sm" onclick="closeModal(\'planDetailModal\')">Close</button><button class="btn-sm primary" onclick="approvePlan('+gid+')">Approve</button>'
            : '<button class="btn-sm" onclick="closeModal(\'planDetailModal\')">Close</button>';
        openModal('planDetailModal');
    } catch(e) { alert(e.message); }
}

async function approvePlan(gid) {
    try { await api('/api/plan/'+gid+'/approve',{method:'POST'}); closeModal('planDetailModal'); refreshAll(); }
    catch(e) { alert(e.message); }
}

// --- Progress ---
async function showProgress() {
    try {
        var entries = await api('/api/progress');
        var el = document.getElementById('progressList');
        el.innerHTML = entries.length ? entries.map(function(e){
            return '<div class="progress-entry"><div class="summary">'+esc(e.summary)+'</div>'+
                (e.lessons?'<div class="lessons">'+esc(e.lessons)+'</div>':'')+
                (e.tags?'<div class="tags">'+esc(e.tags)+'</div>':'')+'</div>';
        }).join('') : '<div class="empty-state">No experience notes yet.</div>';
        openModal('progressModal');
    } catch(e) { alert(e.message); }
}

// --- Voice ---
var recognition = null;
function toggleVoice(btn) {
    if (recognition) { recognition.stop(); recognition=null; btn.classList.remove('recording'); return; }
    var SR = window.SpeechRecognition||window.webkitSpeechRecognition;
    if (!SR) { alert('Speech not supported. Use Chrome/Edge/Safari.'); return; }
    recognition = new SR(); recognition.lang='zh-CN'; recognition.interimResults=false;
    recognition.onresult = function(ev) {
        var text = ev.results[0][0].transcript;
        document.getElementById('quickInput').value = text;
        autoGrow(document.getElementById('quickInput'));
        recognition.stop(); recognition=null; btn.classList.remove('recording');
    };
    recognition.onerror = recognition.onend = function() { recognition=null; btn.classList.remove('recording'); };
    recognition.start(); btn.classList.add('recording');
}

function voiceInto(targetId) {
    var SR = window.SpeechRecognition||window.webkitSpeechRecognition;
    if (!SR) { alert('Speech not supported.'); return; }
    var r = new SR(); r.lang='zh-CN'; r.interimResults=false;
    r.onresult = function(ev) { document.getElementById(targetId).value = ev.results[0][0].transcript; };
    r.start();
}

// --- Modal ---
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

document.addEventListener('keydown', function(e) {
    if (e.key==='Escape') {
        document.querySelectorAll('.modal-overlay.open').forEach(function(m){m.classList.remove('open');});
        closeLog();
    }
    if (e.ctrlKey && e.key==='Enter') {
        if (document.getElementById('planModal').classList.contains('open')) submitPlan();
    }
});

// --- Util ---
function esc(s) { var d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }
function trunc(s,n) { s=String(s||''); return s.length>n?s.substring(0,n)+'...':s; }
function timeAgo(d) {
    if(!d)return'';
    var diff=Math.floor((new Date()-new Date(d+'Z'))/1000);
    if(diff<60)return'now'; if(diff<3600)return Math.floor(diff/60)+'m';
    if(diff<86400)return Math.floor(diff/3600)+'h'; return Math.floor(diff/86400)+'d';
}
