// ==UserScript==
// @name         FxxkEWT360
// @namespace    https://github.com/Gtd232/FxxkEWT360
// @version      4.5
// @description  逃避升学e网通
// @author       Gtd232
// @match        *://*.ewt360.com/*
// @run-at       document-start
// ==/UserScript==


(function() {
    'use strict';

    const orgVisibilityState = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState').get;

    Object.defineProperty(Document.prototype, 'visibilityState', {
        get: () => 'visible',
        configurable: true
    });

    Object.defineProperty(Document.prototype, 'hidden', {
        get: () => false,
        configurable: true
    });

    const originalAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, options) {
        if (type === 'visibilitychange') {
            const wrappedListener = function(event) {
                if (orgVisibilityState.call(document) === 'visible') {
                    if (typeof listener === 'function') {
                        listener.call(this, event);
                    } else if (listener && typeof listener.handleEvent === 'function') {
                        listener.handleEvent(event);
                    }
                }
            };
            if (!this._visibilityListeners) {
                this._visibilityListeners = new Map();
            }
            this._visibilityListeners.set(listener, wrappedListener);
            return originalAddEventListener.call(this, type, wrappedListener, options);
        }
        return originalAddEventListener.apply(this, arguments);
    };

    const originalRemoveEventListener = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.removeEventListener = function(type, listener, options) {
        if (type === 'visibilitychange' && this._visibilityListeners) {
            const wrapped = this._visibilityListeners.get(listener);
            if (wrapped) {
                this._visibilityListeners.delete(listener);
                return originalRemoveEventListener.call(this, type, wrapped, options);
            }
        }
        return originalRemoveEventListener.apply(this, arguments);
    };

    let isSwitching = false;
    let ShuakeFinished = false;

    // ====== 一键完成: 捕获 token 和参数 ======
    let capturedToken = null;
    let capturedApiData = {};

    // 拦截 fetch: 仅捕获 gateway.ewt360.com 的 token 和作业数据
    const origFetch = window.fetch;
    window.fetch = function(input, init) {
        const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
        const isEwt = url.includes('gateway.ewt360.com') || url.includes('bfe.ewt360.com');
        if (isEwt && init && init.headers) {
            let headers = init.headers;
            if (headers instanceof Headers) {
                let t = headers.get('token');
                if (t) capturedToken = t;
            } else if (typeof headers === 'object' && !Array.isArray(headers)) {
                let t = headers['token'] || headers['Token'];
                if (t) capturedToken = t;
            }
        }
        return origFetch.apply(this, arguments).then(response => {
            if (!isEwt) return response;
            const ct = response.headers.get('content-type') || '';
            if (ct.includes('json')) {
                const clone = response.clone();
                clone.text().then(text => {
                    try {
                        const data = JSON.parse(text);
                        if (data && data.data) {
                            const d = data.data;
                            if (d.finishPlayTime) capturedApiData.finishPlayTime = d.finishPlayTime;
                            if (d.lessonTime) capturedApiData.lessonTime = d.lessonTime;
                            if (d.percent !== undefined) capturedApiData.percent = d.percent;
                            if (d.schoolId) capturedApiData.schoolId = d.schoolId;
                            if (d.lessonId) capturedApiData.lessonId = d.lessonId;
                        }
                    } catch(e) {}
                }).catch(() => {});
            }
            return response;
        });
    };

    function getPageParams() {
        const hash = window.location.hash || '';
        const qs = hash.split('?')[1] || '';
        const params = new URLSearchParams(qs);
        const lessonId = params.get('lessonId') || params.get('lessonid') || '';
        const homeworkId = params.get('homeworkId') || params.get('homeworkid') || '';
        const vidType = params.get('videoType');
        const contentType = vidType ? parseInt(vidType) : (capturedApiData.contentType || 0);
        const schoolId = capturedApiData.schoolId || params.get('schoolId') || '';
        return { lessonId, homeworkId, contentType, schoolId };
    }

    function quickFinish() {
        const p = getPageParams();
        const token = capturedToken;
        const lessonId = parseInt(p.lessonId);
        const homeworkId = parseInt(p.homeworkId);
        const schoolId = parseInt(p.schoolId) || 0;

        if (!lessonId || !homeworkId || isNaN(lessonId) || isNaN(homeworkId)) {
            console.error("[FxxkEWT360] quickFinish: missing/invalid lessonId or homeworkId", p);
            alert("一键完成失败：无法获取课程参数，请确认已在视频播放页面");
            return;
        }
        if (!schoolId || isNaN(schoolId)) {
            console.error("[FxxkEWT360] quickFinish: missing schoolId");
            alert("一键完成失败：无法获取学校信息");
            return;
        }
        if (!token) {
            console.warn("[FxxkEWT360] quickFinish: no token, API上报跳过");
        }

        const reportedLessonId = p.contentType === 11 ? lessonId + 2000000 : lessonId;
        console.log("[FxxkEWT360] quickFinish", {lessonId, homeworkId, schoolId, contentType:p.contentType, hasToken:!!token});

        if (token) {
            fetch('https://gateway.ewt360.com/api/homeworkprod/homework/student/reportVideoPoint', {
                method: 'POST',
                headers: {'Content-Type': 'application/json', 'token': token},
                body: JSON.stringify({schoolId, homeworkId, lessonId:reportedLessonId, type:2, interactivePointId:null, platform:1, seriousCheckResult:0})
            }).then(r=>r.json()).then(d=>console.log("[FxxkEWT360] reportVideoPoint:",d)).catch(e=>console.error(e));
        }
        const video = document.querySelector('video');
        if (video && video.duration) {
            video.muted = true;
            video.currentTime = video.duration * 0.99;
            video.play().then(() => {
                if (originalDescriptor) { try { originalDescriptor.set.call(video, 16); } catch(e) {} }
                video.playbackRate = 16;
            });
        }
        const checkBox = document.querySelector('[class*="video_earnest_check"]');
        if (checkBox) checkBox.style.display = 'none';
    }

    let settings = { autoCheck: true, autoMute: true, playbackSpeed: '1', autoSD: true, autoNext: true, preventPause: true };
    let targetSpeed = 1;
    const officialSpeeds = [0.8, 1, 1.2, 1.5, 2, 16];
    const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
    if (originalDescriptor) {
        Object.defineProperty(HTMLMediaElement.prototype, 'playbackRate', {
            get: function() { if (Number.isFinite(targetSpeed) && targetSpeed > 0) return targetSpeed; return 1; },
            set: function(val) { originalDescriptor.set.call(this, targetSpeed); },
            configurable: true
        });
    }
    try {
        const stored = localStorage.getItem('fxxkewt_settings');
        if (stored) { settings = {...settings, ...JSON.parse(stored)}; targetSpeed = parseFloat(settings.playbackSpeed) || 1; }
    } catch(e) {}

    function saveSettings() { try { localStorage.setItem('fxxkewt_settings', JSON.stringify(settings)); } catch(e) {} }

    document.addEventListener('play', (e) => {
        if (e.target && e.target.tagName === 'VIDEO') {
            if (settings.autoMute) { e.target.volume = 0; e.target.muted = true; }
            const el = document.querySelector('#video_player_box') || e.target;
            if (el) {
                let fiber = getReactFiber(el);
                while (fiber) {
                    if (fiber.stateNode && fiber.stateNode.report) {
                        const rep = fiber.stateNode.report;
                        rep.videoRate = targetSpeed;
                        rep.currentPlayedRate = targetSpeed;
                        if (rep.start && rep.start.name !== 'dummyStart') {
                            const originalStart = rep.start;
                            rep.start = function dummyStart(opts) { if (opts) opts.videoRate = targetSpeed; return originalStart.call(this, opts); };
                        }
                        if (rep.setVideoRate && rep.setVideoRate.name !== 'dummySetVideoRate') {
                            const originalSetVideoRate = rep.setVideoRate;
                            rep.setVideoRate = function dummySetVideoRate(rate) { return originalSetVideoRate.call(this, targetSpeed); };
                        }
                        break;
                    }
                    fiber = fiber.return;
                }
            }
        }
    }, true);

    document.addEventListener('pause', (e) => {
        if (!settings.preventPause) return;
        if (e.target && e.target.tagName === 'VIDEO') {
            if (e.target.ended) return;
            e.target.play().catch(() => {});
        }
    }, true);

    function getReactFiber(el) {
        if (!el) return null;
        const key = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
        return key ? el[key] : null;
    }

    function checkpass() {
        if (!settings.autoCheck) return;
        const btn = document.querySelector('[data-ac="check-pass"]');
        if (!btn) return;
        let fiber = getReactFiber(btn);
        if (!fiber) { console.error("[FxxkEWT360] no fiber"); return; }
        let ok = false;
        while (fiber) {
            if (fiber.stateNode && typeof fiber.stateNode.toCheck === 'function') {
                fiber.stateNode.toCheck(); ok = true; break;
            }
            fiber = fiber.return;
        }
        console.log("[FxxkEWT360] " + (ok ? "checkpass ok" : "checkpass fail"));
    }

    function selectLesson(el) {
        let fiber = getReactFiber(el);
        if (!fiber) return false;
        while (fiber) {
            const props = fiber.memoizedProps;
            if (props) {
                const funcKey = Object.keys(props).find(k => typeof props[k] === 'function');
                const lessonKey = Object.keys(props).find(k => props[k] && typeof props[k] === 'object' && (props[k].contentId || props[k].lessonId || props[k].title));
                if (funcKey && lessonKey) { props[funcKey](props[lessonKey]); return true; }
            }
            fiber = fiber.return;
        }
        return false;
    }

    function autoPlayNext() {
        if (!settings.autoNext) return;
        const hasReplay = Array.from(document.querySelectorAll('span, div, button')).some(el => el.textContent.trim() === '重新观看' && el.offsetParent !== null);
        const video = document.querySelector('video');
        const isFinished = hasReplay || (video && video.ended);
        if (!isFinished) { if (isSwitching) isSwitching = false; return; }
        if (isSwitching) return;
        const lessons = Array.from(document.querySelectorAll('[data-ac="lesson-item"]'));
        if (lessons.length === 0) return;
        const activeIndex = lessons.findIndex(el => el.classList.contains('active-EI2Hl') || el.className.includes('active'));
        if (activeIndex === -1) return;
        let next = null;
        for (let i = activeIndex + 1; i < lessons.length; i++) { if (!lessons[i].querySelector('[class*="finished"]')) { next = lessons[i]; break; } }
        if (!next) { for (let i = 0; i < activeIndex; i++) { if (!lessons[i].querySelector('[class*="finished"]')) { next = lessons[i]; break; } } }
        if (next) {
            isSwitching = true;
            console.log("[FxxkEWT360] switching to", next.textContent.trim());
            if (!selectLesson(next)) isSwitching = false;
        } else {
            if (!ShuakeFinished) { alert("本次刷课已完毕!"); ShuakeFinished = true; }
        }
    }

    function setSpeed() {
        targetSpeed = parseFloat(settings.playbackSpeed) || 1;
        const video = document.querySelector('video');
        if (video) { if (originalDescriptor) { try { originalDescriptor.set.call(video, targetSpeed); } catch(e) {} } if (settings.autoMute) { try { video.volume=0; video.muted=true; } catch(e) {} } }
        const el = document.querySelector('#video_player_box') || video;
        if (el) {
            let fiber = getReactFiber(el);
            while (fiber) {
                if (fiber.stateNode && fiber.stateNode.oEplayer) {
                    const p = fiber.stateNode.oEplayer;
                    if (typeof p.checkRate === 'function' && p.checkRate.name !== 'dummyCheckRate') { p.checkRate = function dummyCheckRate() { return false; }; }
                    if (p._player) {
                        const bp = p._player.bizPoint();
                        if (bp && bp.createParams && bp.createParams.name !== 'dummyCreateParams') {
                            const orig = bp.createParams;
                            bp.createParams = function dummyCreateParams(action, status, stayTime, mediaTime) {
                                const mult = targetSpeed > 1 ? targetSpeed : 1;
                                return orig.call(this, action, status, Math.max(stayTime * mult, mediaTime));
                            };
                        }
                    }
                    const rep = fiber.stateNode.report;
                    if (rep) {
                        rep.videoRate = targetSpeed; rep.currentPlayedRate = targetSpeed;
                        if (rep.start && rep.start.name !== 'dummyStart') { const o=rep.start; rep.start=function dummyStart(opts){if(opts)opts.videoRate=targetSpeed;return o.call(this,opts);}; }
                        if (rep.setVideoRate && rep.setVideoRate.name !== 'dummySetVideoRate') { const o=rep.setVideoRate; rep.setVideoRate=function dummySetVideoRate(rate){return o.call(this,targetSpeed);}; }
                    }
                    break;
                }
                fiber = fiber.return;
            }
        }
        if (settings.autoSD) {
            const items = Array.from(document.querySelectorAll('.vjs-menu-item'));
            const sd = items.find(el => { const t=el.querySelector('.vjs-menu-item-text'); return t && t.textContent.trim() === '标清'; });
            if (sd && !sd.classList.contains('vjs-selected')) sd.click();
        }
    }

    function makeDraggable(el, handle) {
        let pos1=0,pos2=0,pos3=0,pos4=0;
        handle.onmousedown = function dragMouseDown(e) {
            e=e||window.event; if(e.button!==0||e.target.tagName==='A')return; e.preventDefault();
            pos3=e.clientX;pos4=e.clientY;
            document.onmouseup=function(){document.onmouseup=null;document.onmousemove=null;try{localStorage.setItem('fxxkewt_panel_pos',JSON.stringify({top:el.style.top,left:el.style.left}));}catch(e){}};
            document.onmousemove=function(e){e=e||window.event;e.preventDefault();pos1=pos3-e.clientX;pos2=pos4-e.clientY;pos3=e.clientX;pos4=e.clientY;el.style.top=(el.offsetTop-pos2)+"px";el.style.left=(el.offsetLeft-pos1)+"px";el.style.right='auto';};
        };
    }

    function initPanel() {
        try {
            if (document.getElementById('fxxkewt-panel') || !document.body) { if(!document.body)setTimeout(initPanel,100); return; }
            const s = document.createElement('style');
            s.textContent = '#fxxkewt-panel{position:fixed;top:100px;right:20px;width:200px;background:#eee;border:1px solid #999;color:#000;font-family:sans-serif;font-size:12px;z-index:99999999}#fxxkewt-header{padding:5px;background:#ccc;cursor:move;font-weight:bold;display:flex;justify-content:space-between;user-select:none}#fxxkewt-header a{color:blue;text-decoration:none}#fxxkewt-body{padding:10px}.fxxkewt-row{margin:8px 0;display:flex;justify-content:space-between;align-items:center}.fxxkewt-select{font-size:12px}';
            (document.head||document.documentElement).appendChild(s);
            const panel = document.createElement('div');
            panel.id = 'fxxkewt-panel';
            try { const pos=localStorage.getItem('fxxkewt_panel_pos'); if(pos){const p=JSON.parse(pos);panel.style.top=p.top||'100px';if(p.left&&p.left!=='auto'){panel.style.left=p.left;panel.style.right='auto';}else{panel.style.right='20px';}}else{panel.style.top='100px';panel.style.right='20px';} } catch(e){panel.style.top='100px';panel.style.right='20px';}
            panel.innerHTML = '<div id="fxxkewt-header"><span>FxxkEWT360 </span><span style="font-style:italic;">by Gtd232</span><a href="https://github.com/Gtd232/FxxkEWT360" target="_blank">GitHub</a></div><div id="fxxkewt-body">' +
                '<div class="fxxkewt-row"><span>自动过检</span><input type="checkbox" id="fxxkewt-autoCheck" '+(settings.autoCheck?'checked':'')+'></div>' +
                '<div class="fxxkewt-row"><span>自动静音</span><input type="checkbox" id="fxxkewt-autoMute" '+(settings.autoMute?'checked':'')+'></div>' +
                '<div class="fxxkewt-row"><span>自动标清</span><input type="checkbox" id="fxxkewt-autoSD" '+(settings.autoSD?'checked':'')+'></div>' +
                '<div class="fxxkewt-row"><span>自动连播</span><input type="checkbox" id="fxxkewt-autoNext" '+(settings.autoNext?'checked':'')+'></div>' +
                '<div class="fxxkewt-row"><span>禁止暂停</span><input type="checkbox" id="fxxkewt-preventPause" '+(settings.preventPause?'checked':'')+'></div>' +
                '<div class="fxxkewt-row"><span>倍速选择</span><select class="fxxkewt-select" id="fxxkewt-speed">' +
                '<option value="0.8"'+(settings.playbackSpeed==='0.8'?' selected':'')+'>0.8X</option>' +
                '<option value="1"'+(settings.playbackSpeed==='1'?' selected':'')+'>1.0X</option>' +
                '<option value="1.2"'+(settings.playbackSpeed==='1.2'?' selected':'')+'>1.2X</option>' +
                '<option value="1.5"'+(settings.playbackSpeed==='1.5'?' selected':'')+'>1.5X</option>' +
                '<option value="2"'+(settings.playbackSpeed==='2'?' selected':'')+'>2.0X</option>' +
                '<option value="4"'+(settings.playbackSpeed==='4'?' selected':'')+'>4.0X</option>' +
                '<option value="8"'+(settings.playbackSpeed==='8'?' selected':'')+'>8.0X</option>' +
                '<option value="16"'+(settings.playbackSpeed==='16'?' selected':'')+'>16.0X</option></select></div>' +
                '<div style="font-size:10px;color:#666;margin-top:10px;border-top:1px dashed #ccc;padding-top:5px;line-height:1.3;">不建议开启倍速播放, 这会使得在统计时实际看课时长缩短</div>' +
                '<div style="margin-top:10px;border-top:1px dashed #ccc;padding-top:6px;">' +
                '<div id="fxxkewt-tools-toggle" style="font-size:11px;color:#888;cursor:pointer;text-align:center;user-select:none;">[+] !!!终极方案!!!</div>' +
                '<div id="fxxkewt-tools-extra" style="display:none;margin-top:6px;">' +
                '<div style="font-size:10px;color:#c00;line-height:1.4;margin-bottom:6px;padding:4px;background:#fff0f0;border-radius:2px;">[!] 一键完成会直接上报通过、拖进度条到末尾，可能被后台发现异常，仅在需要时使用</div>' +
                '<button id="fxxkewt-quickfinish" style="width:100%;padding:4px 0;background:#ddd;color:#333;border:1px solid #bbb;border-radius:2px;cursor:pointer;font-size:11px;">一键完成当前视频</button></div></div></div>';
            document.body.appendChild(panel);
            panel.querySelector('#fxxkewt-autoCheck').onchange=e=>{settings.autoCheck=e.target.checked;saveSettings();};
            panel.querySelector('#fxxkewt-autoMute').onchange=e=>{settings.autoMute=e.target.checked;saveSettings();};
            panel.querySelector('#fxxkewt-autoSD').onchange=e=>{settings.autoSD=e.target.checked;saveSettings();setSpeed();};
            panel.querySelector('#fxxkewt-autoNext').onchange=e=>{settings.autoNext=e.target.checked;saveSettings();};
            panel.querySelector('#fxxkewt-preventPause').onchange=e=>{settings.preventPause=e.target.checked;saveSettings();};
            panel.querySelector('#fxxkewt-speed').onchange=e=>{settings.playbackSpeed=e.target.value;saveSettings();setSpeed();};
            makeDraggable(panel, panel.querySelector('#fxxkewt-header'));
            panel.querySelector('#fxxkewt-tools-toggle').onclick=()=>{
                const e=document.getElementById('fxxkewt-tools-extra'),t=document.getElementById('fxxkewt-tools-toggle');
                if(e.style.display==='none'){e.style.display='block';t.textContent='[-] !!!终极方案!!!';}else{e.style.display='none';t.textContent='[+] !!!终极方案!!!';}
            };
            panel.querySelector('#fxxkewt-quickfinish').onclick=quickFinish;
            console.log("[FxxkEWT360] panel ok");
        } catch(e) { console.error("[FxxkEWT360] panel err", e); }
    }

    setTimeout(initPanel, 100);
    setInterval(() => { checkpass(); autoPlayNext(); setSpeed(); }, 2000);
})();