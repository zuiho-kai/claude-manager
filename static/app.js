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

    // Collect plan group representatives (prefer mode='plan' task per group)
    var planReps = {}; // group_id → task
    tasks.forEach(function(t) {
        if (!t.plan_group_id) return;
        if (t.mode === 'plan') { planReps[t.plan_group_id] = t; }
        else if (!planReps[t.plan_group_id]) { planReps[t.plan_group_id] = t; }
    });

    // Filter: normal tasks + one rep per plan group
    var visible = tasks.filter(function(t) {
        if (!t.plan_group_id) return true;
        return planReps[t.plan_group_id] && planReps[t.plan_group_id].id === t.id;
    });

    var filtered;
    if (currentTab === 'all') filtered = visible;
    else if (currentTab === 'done') filtered = visible.filter(function(t){
        // For plan reps, use plan_status if available
        var st = t.plan_group_id ? (t.plan_status || t.status) : t.status;
        return st==='completed'||st==='failed'||st==='cancelled';
    });
    else filtered = visible.filter(function(t){
        var st = t.plan_group_id ? (t.plan_status || t.status) : t.status;
        return st===currentTab;
    });

    document.getElementById('badgeAll').textContent = visible.length;

    if (!filtered.length) { list.innerHTML = '<div class="empty-state">No tasks here.</div>'; return; }
    list.innerHTML = filtered.map(function(t) {
        var isPlan = !!t.plan_group_id;
        var displayStatus = isPlan ? (t.plan_status || t.status) : t.status;
        var promptText = isPlan
            ? (t.plan_goal || t.plan_status || '[Plan]')
            : (t.prompt_short || t.prompt || '');

        // Clean up plan-mode tasks: show goal instead of verbose template
        if (!isPlan && t.mode === 'plan' && promptText.indexOf('GOAL:') !== -1) {
            var goalMatch = promptText.match(/GOAL:\s*\n([\s\S]*?)(\n\nOutput|$)/);
            promptText = goalMatch ? '[Plan] ' + goalMatch[1].trim() : '[Plan] generating...';
        }

        var p = esc(promptText.substring(0, 120));
        var active = t.id === selectedTaskId ? ' active' : '';
        var cost = t.cost_usd ? '$'+t.cost_usd.toFixed(3) : '';
        var clickFn = isPlan
            ? 'openPlanDetail(' + t.plan_group_id + ')'
            : 'selectTask(' + t.id + ')';
        var planBadge = isPlan ? '<span class="tag tag-planning" style="font-size:9px">PLAN</span> ' : '';
        return '<div class="task-card'+active+'" onclick="'+clickFn+'">' +
            '<div class="task-top"><span class="task-id">'+planBadge+(isPlan?'plan#'+t.plan_group_id:'#'+t.id)+'</span><span class="tag tag-'+displayStatus+'">'+displayStatus+'</span></div>' +
            '<div class="task-prompt">'+p+'</div>' +
            '<div class="task-meta">'+(cost?'<span>'+cost+'</span>':'')+'<span>'+timeAgo(t.created_at)+'</span></div></div>';
    }).join('');
}

function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(function(el){el.classList.toggle('active',el.dataset.tab===tab);});
    renderTasks();
}

// --- Log panel ---
async function selectTask(id) {
    // If this is a plan rep card, open plan detail instead
    var task = tasks.find(function(t){return t.id===id;});
    if (task && task.plan_group_id) {
        openPlanDetail(task.plan_group_id);
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
var _discussGroupId = null;

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

function openPlanModal() {
    document.getElementById('planGoal').value='';
    document.getElementById('planGoalPhase').style.display='';
    document.getElementById('planDiscussPhase').style.display='none';
    _discussGroupId = null;
    openModal('planModal');
    document.getElementById('planGoal').focus();
}

async function submitPlan() {
    var goal = document.getElementById('planGoal').value.trim();
    if (!goal) return;
    var btn = document.querySelector('#planGoalPhase .primary');
    btn.disabled = true; btn.textContent = '生成中...';
    try {
        var r = await api('/api/plan',{method:'POST',body:JSON.stringify({goal:goal})});
        _discussGroupId = r.group_id;

        // Switch to discussion phase
        document.getElementById('planGoalPhase').style.display='none';
        document.getElementById('planDiscussPhase').style.display='';
        var msgs = document.getElementById('discussMessages');
        msgs.innerHTML = '';

        if (r.done) {
            // Claude already has enough info, go straight to generate
            appendDiscussMsg('assistant', r.first_question);
            await triggerGenerate();
        } else {
            appendDiscussMsg('assistant', r.first_question, r.options);
            document.getElementById('discussInput').focus();
        }
    } catch(e) { alert(e.message); }
    finally { btn.disabled = false; btn.textContent = '开始'; }
}

function appendDiscussMsg(role, text, options) {
    var msgs = document.getElementById('discussMessages');

    if (role === 'assistant' && options && options.length) {
        // Question text as standalone line
        var qDiv = document.createElement('div');
        qDiv.className = 'discuss-question';
        qDiv.textContent = text;
        msgs.appendChild(qDiv);

        // Options list
        var listDiv = document.createElement('div');
        listDiv.className = 'discuss-select';
        listDiv._options = options;
        listDiv._selectedIdx = 0;

        options.forEach(function(opt, idx) {
            var item = document.createElement('div');
            item.className = 'discuss-select-item' + (idx === 0 ? ' selected' : '');
            item.setAttribute('data-idx', idx);
            var recText = idx === 0 ? ' (Recommended)' : '';
            item.innerHTML =
                '<span class="select-cursor">❯</span>' +
                '<span class="select-num">' + (idx + 1) + '.</span>' +
                '<div class="select-content">' +
                    '<span class="select-label">' + esc(opt.label) + recText + '</span>' +
                    (opt.description ? '<span class="select-desc">' + esc(opt.description) + '</span>' : '') +
                '</div>';
            item.onclick = function() {
                selectOption(listDiv, idx);
                // Single click sends immediately
                confirmOption(listDiv);
            };
            listDiv.appendChild(item);
        });

        // Separator
        var sep = document.createElement('div');
        sep.className = 'discuss-separator';
        sep.textContent = '────────────────────────────────────────';
        listDiv.appendChild(sep);

        // Custom input action
        var customNum = options.length + 1;
        var customItem = document.createElement('div');
        customItem.className = 'discuss-select-item action-item';
        customItem.setAttribute('data-idx', customNum - 1);
        customItem.setAttribute('data-custom', 'true');
        customItem.innerHTML =
            '<span class="select-cursor">❯</span>' +
            '<span class="select-num">' + customNum + '.</span>' +
            '<div class="select-content"><span class="select-label">自定义输入</span></div>';
        customItem.onclick = function() {
            listDiv.remove();
            document.getElementById('discussInputRow').style.display = 'flex';
            document.getElementById('discussInput').focus();
        };
        listDiv.appendChild(customItem);

        // Skip action
        var skipNum = customNum + 1;
        var skipItem = document.createElement('div');
        skipItem.className = 'discuss-select-item action-item';
        skipItem.innerHTML =
            '<span class="select-cursor">❯</span>' +
            '<span class="select-num">' + skipNum + '.</span>' +
            '<div class="select-content"><span class="select-label">跳过讨论，直接生成计划</span></div>';
        skipItem.onclick = function() {
            listDiv.remove();
            skipDiscuss();
        };
        listDiv.appendChild(skipItem);

        msgs.appendChild(listDiv);
    } else if (role === 'user') {
        var uDiv = document.createElement('div');
        uDiv.className = 'discuss-user-answer';
        uDiv.textContent = '> ' + text;
        msgs.appendChild(uDiv);
    } else {
        // Plain assistant message (e.g. summary, generating...)
        var div = document.createElement('div');
        div.className = 'discuss-question';
        div.textContent = text;
        msgs.appendChild(div);
    }

    msgs.scrollTop = msgs.scrollHeight;
    document.getElementById('discussInputRow').style.display = 'none';
}

function selectOption(listDiv, idx) {
    listDiv._selectedIdx = idx;
    listDiv.querySelectorAll('.discuss-select-item').forEach(function(el) {
        el.classList.toggle('selected', parseInt(el.getAttribute('data-idx')) === idx);
    });
}

function confirmOption(listDiv) {
    var idx = listDiv._selectedIdx;
    var label = listDiv._options[idx].label;
    listDiv.remove();
    document.getElementById('discussInput').value = label;
    sendDiscuss();
}

function pickOption(label) {
    document.querySelectorAll('.discuss-select').forEach(function(el) { el.remove(); });
    document.getElementById('discussInput').value = label;
    sendDiscuss();
}

var _discussSending = false;
async function sendDiscuss() {
    if (_discussSending || !_discussGroupId) return;
    var input = document.getElementById('discussInput');
    var text = input.value.trim();
    if (!text) return;
    _discussSending = true;
    input.value = ''; input.style.height = 'auto';

    appendDiscussMsg('user', text);

    // Remove any remaining option lists
    document.querySelectorAll('.discuss-select').forEach(function(el) { el.remove(); });

    // Show loading
    var msgs = document.getElementById('discussMessages');
    var loading = document.createElement('div');
    loading.className = 'discuss-loading';
    loading.textContent = 'Claude is thinking...';
    msgs.appendChild(loading);
    msgs.scrollTop = msgs.scrollHeight;

    try {
        var r = await api('/api/plan/'+_discussGroupId+'/discuss',{method:'POST',body:JSON.stringify({message:text})});
        loading.remove();
        appendDiscussMsg('assistant', r.reply, r.options);

        if (r.done) {
            await triggerGenerate();
        } else {
            document.getElementById('discussInput').focus();
        }
    } catch(e) {
        loading.remove();
        appendDiscussMsg('assistant', 'Error: ' + e.message);
    }
    finally { _discussSending = false; }
}

async function skipDiscuss() {
    if (!_discussGroupId) return;
    await triggerGenerate();
}

async function triggerGenerate() {
    if (!_discussGroupId) return;
    var gid = _discussGroupId;

    // Show generating state
    appendDiscussMsg('assistant', 'Generating plan...');
    document.getElementById('discussInput').disabled = true;

    try {
        await api('/api/plan/'+gid+'/generate',{method:'POST'});
        closeModal('planModal');
        refreshAll();

        // Poll until plan is ready for review
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
    finally { document.getElementById('discussInput').disabled = false; }
}

var _currentPlanGid = null;
var _currentPlanSteps = [];
var _planDetailLogWs = null;

async function openPlanDetail(gid) {
    _currentPlanGid = gid;
    try {
        var data = await api('/api/plan/' + gid + '/full');
        var group = data.group;
        var discussions = data.discussions || [];
        var steps = data.plan_steps || [];
        var execTasks = data.tasks || [];
        _currentPlanSteps = steps;

        // Header
        document.getElementById('planDetailGoal').textContent = group.goal || '';
        var sc = group.status === 'reviewing' ? 'queued' : group.status === 'executing' ? 'running' : group.status;
        document.getElementById('planDetailStatus').innerHTML = '<span class="tag tag-' + sc + '">' + group.status + '</span>';

        // Discussion section
        var discussEl = document.getElementById('planDetailDiscuss');
        if (discussions.length) {
            discussEl.innerHTML = discussions.map(function(m) {
                return '<div class="plan-detail-discuss-msg ' + esc(m.role) + '">' +
                    (m.role === 'user' ? '> ' : '') + esc(m.content) + '</div>';
            }).join('');
            // Start collapsed
            discussEl.classList.add('collapsed');
            document.getElementById('toggleDiscuss').textContent = '▸';
        } else {
            discussEl.innerHTML = '<span style="color:var(--dim);font-size:11px">No discussion recorded.</span>';
        }

        // Plan steps
        var sl = document.getElementById('planSteps');
        if (steps.length && group.status === 'reviewing') {
            sl.innerHTML = steps.map(function(s, i) {
                return '<li class="plan-step" data-step="' + i + '">' +
                    '<div style="display:flex;justify-content:space-between;align-items:center">' +
                    '<strong contenteditable="true" class="step-title" data-idx="' + i + '">' + esc(s.title || 'Step ' + (i+1)) + '</strong>' +
                    '<button class="btn-sm danger" style="padding:2px 6px;font-size:10px" onclick="removeStep(' + i + ')">✕</button></div>' +
                    '<div contenteditable="true" class="step-desc step-desc-edit" data-idx="' + i + '">' + esc(s.description || '') + '</div>' +
                    '</li>';
            }).join('') +
            '<li class="plan-step" style="text-align:center;cursor:pointer;color:var(--accent)" onclick="addStep()">+ Add step</li>';
        } else if (steps.length) {
            sl.innerHTML = steps.map(function(s, i) {
                var sub = execTasks[i] || execTasks.find(function(t) { return t.prompt && t.prompt.indexOf('Step ' + (i+1)) !== -1; });
                var cls = sub ? (sub.status === 'completed' ? 'done' : sub.status === 'running' ? 'running' : '') : '';
                var icon = sub ? (sub.status === 'completed' ? ' ✓' : sub.status === 'running' ? ' ⟳' : ' ·') : '';
                return '<li class="plan-step ' + cls + '"><strong>' + esc(s.title || 'Step ' + (i+1)) + icon + '</strong>' +
                    '<div class="step-desc">' + esc(s.description || '') + '</div>' +
                    (sub ? '<span class="tag tag-' + sub.status + '">' + sub.status + '</span>' : '') + '</li>';
            }).join('');
        } else {
            sl.innerHTML = '<li class="plan-step" style="color:var(--dim)">Generating plan...</li>';
        }

        // Execution log section — show if executing/completed
        var logSection = document.getElementById('planDetailLogSection');
        var logEl = document.getElementById('planDetailLog');
        if (group.status === 'executing' || group.status === 'completed') {
            logSection.style.display = '';
            // Find the currently running execute task
            var runningTask = execTasks.find(function(t) { return t.status === 'running'; })
                || execTasks.slice().reverse().find(function(t) { return t.status === 'completed'; });
            if (runningTask) {
                logEl.textContent = 'Loading log for step task #' + runningTask.id + '...';
                try {
                    var td = await api('/api/tasks/' + runningTask.id);
                    logEl.textContent = '';
                    (td.logs || []).forEach(function(l) {
                        var payload;
                        try { payload = typeof l.payload === 'string' ? JSON.parse(l.payload) : l.payload; } catch(e) { payload = {text: l.payload}; }
                        var f = fmtLog(l.event_type, payload);
                        if (f.html) {
                            var d = document.createElement('div');
                            d.innerHTML = f.html;
                            logEl.appendChild(d);
                        }
                    });
                    logEl.scrollTop = logEl.scrollHeight;
                    // Stream live if running
                    if (runningTask.status === 'running') {
                        connectPlanLogWs(runningTask.id, logEl);
                    }
                } catch(e) { logEl.textContent = 'Could not load log.'; }
            } else {
                logSection.style.display = 'none';
            }
        } else {
            logSection.style.display = 'none';
        }

        // Actions
        var acts = document.getElementById('planDetailActions');
        acts.innerHTML = group.status === 'reviewing'
            ? '<button class="btn-sm" onclick="closePlanDetail()">Close</button><button class="btn-sm primary" onclick="saveThenApprove(' + gid + ')">Approve</button>'
            : '<button class="btn-sm" onclick="closePlanDetail()">Close</button>';

        openModal('planDetailModal');
    } catch(e) { alert(e.message); }
}

function closePlanDetail() {
    closeModal('planDetailModal');
    if (_planDetailLogWs) { _planDetailLogWs.close(); _planDetailLogWs = null; }
}

function connectPlanLogWs(taskId, logEl) {
    if (_planDetailLogWs) _planDetailLogWs.close();
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    _planDetailLogWs = new WebSocket(proto + '//' + location.host + '/ws/logs/' + taskId);
    _planDetailLogWs.onmessage = function(e) {
        try {
            var m = JSON.parse(e.data);
            var payload;
            try { payload = typeof m.payload === 'string' ? JSON.parse(m.payload) : m.payload; } catch(err) { payload = m.payload; }
            var f = fmtLog(m.event_type, payload);
            if (f.html) {
                var d = document.createElement('div');
                d.innerHTML = f.html;
                logEl.appendChild(d);
                logEl.scrollTop = logEl.scrollHeight;
            }
        } catch(err) {}
    };
    _planDetailLogWs.onclose = function() { _planDetailLogWs = null; };
}

function toggleSection(id) {
    var el = document.getElementById(id);
    var tog = document.getElementById('toggle' + id.replace('planDetail', ''));
    if (el.classList.contains('collapsed')) {
        el.classList.remove('collapsed');
        if (tog) tog.textContent = '▾';
    } else {
        el.classList.add('collapsed');
        if (tog) tog.textContent = '▸';
    }
}

// Keep viewPlan as alias for backward compat (checkPlanReady uses it)
function viewPlan(gid) { openPlanDetail(gid); }

function removeStep(idx) {
    _currentPlanSteps.splice(idx, 1);
    viewPlan(_currentPlanGid);
}

function addStep() {
    _currentPlanSteps.push({title: 'New step', description: 'Describe what to do', prompt: ''});
    viewPlan(_currentPlanGid);
}

function collectEditedSteps() {
    // Read back edited titles and descriptions from contenteditable elements
    var titles = document.querySelectorAll('.step-title[data-idx]');
    var descs = document.querySelectorAll('.step-desc-edit[data-idx]');
    titles.forEach(function(el) {
        var i = parseInt(el.dataset.idx);
        if (_currentPlanSteps[i]) _currentPlanSteps[i].title = el.textContent.trim();
    });
    descs.forEach(function(el) {
        var i = parseInt(el.dataset.idx);
        if (_currentPlanSteps[i]) {
            _currentPlanSteps[i].description = el.textContent.trim();
            // Update prompt to match description if prompt was auto-generated
            if (!_currentPlanSteps[i].prompt || _currentPlanSteps[i].prompt === _currentPlanSteps[i].description) {
                _currentPlanSteps[i].prompt = el.textContent.trim();
            }
        }
    });
}

async function saveThenApprove(gid) {
    collectEditedSteps();
    // Save edited plan back to server before approving
    try {
        await api('/api/plan/'+gid+'/update', {
            method: 'POST',
            body: JSON.stringify({steps: _currentPlanSteps})
        });
    } catch(e) {
        // If update endpoint doesn't exist yet, just approve with original
    }
    approvePlan(gid);
}

async function approvePlan(gid) {
    try { await api('/api/plan/'+gid+'/approve',{method:'POST'}); closePlanDetail(); refreshAll(); }
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
        if (document.getElementById('planModal').classList.contains('open')) {
            if (document.getElementById('planGoalPhase').style.display !== 'none') submitPlan();
        }
    }
});

// Enter to send discuss message
document.addEventListener('DOMContentLoaded', function() {
    var di = document.getElementById('discussInput');
    if (di) di.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDiscuss(); }
    });
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
