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

    // 拦截 fetch 捕获 token 和 API 返回数据
    const origFetch = window.fetch;
    window.fetch = function(input, init) {
        // 从请求头捕获 token
        if (init && init.headers) {
            let headers = init.headers;
            if (headers instanceof Headers) {
                let t = headers.get('token');
                if (t) capturedToken = t;
            } else if (typeof headers === 'object' && !Array.isArray(headers)) {
                let t = headers['token'] || headers['Token'];
                if (t) capturedToken = t;
            }
        } else if (typeof input === 'string' && init === undefined) {
            // fetch(url) 没有 init 参数，跳过
        }
        return origFetch.apply(this, arguments).then(response => {
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
        return {
            lessonId: params.get('lessonId') || params.get('lessonid'),
            homeworkId: params.get('homeworkId') || params.get('homeworkid'),
            contentType: parseInt(params.get('videoType')) || 11,
            schoolId: capturedApiData.schoolId || params.get('schoolId') || 21446,
        };
    }

    function quickFinish() {
        const p = getPageParams();
        const token = capturedToken;

        if (!token) {
            // 尝试从 localStorage 或其他地方拿 token
            console.warn("[FxxkEWT360] ⚠ 未捕获到 token，尝试从页面数据获取...");
        }

        const reportedLessonId = p.contentType === 11 ? parseInt(p.lessonId) + 2000000 : parseInt(p.lessonId);
        const schoolId = parseInt(p.schoolId);

        console.log("[FxxkEWT360] 🚀 一键完成启动", {
            lessonId: p.lessonId, homeworkId: p.homeworkId,
            reportedLessonId, schoolId, contentType: p.contentType,
            hasToken: !!token
        });

        // 1. 上报认真检测通过（如果弹窗存在）
        if (token) {
            fetch('https://gateway.ewt360.com/api/homeworkprod/homework/student/reportVideoPoint', {
                method: 'POST',
                headers: {'Content-Type': 'application/json', 'token': token},
                body: JSON.stringify({
                    schoolId: schoolId,
                    homeworkId: parseInt(p.homeworkId),
                    lessonId: reportedLessonId,
                    type: 2,
                    interactivePointId: null,
                    platform: 1,
                    seriousCheckResult: 0
                })
            }).then(r => r.json()).then(d => {
                console.log("[FxxkEWT360] ✅ 认真检测上报结果:", d);
            }).catch(e => {
                console.error("[FxxkEWT360] ❌ 认真检测上报失败:", e);
            });
        }

        // 2. 把视频拖到末尾并快速播放触发完成
        const video = document.querySelector('video');
        if (video && video.duration) {
            console.log(`[FxxkEWT360] 视频总长: ${Math.round(video.duration)}s，跳转到 99%`);
            video.muted = true;
            video.currentTime = video.duration * 0.99;
            video.play().then(() => {
                // 设超高倍速快速播完
                if (originalDescriptor) {
                    try { originalDescriptor.set.call(video, 16); } catch(e) {}
                }
                video.playbackRate = 16;
                // 监听播完
                video.addEventListener('ended', function onEnd() {
                    video.removeEventListener('ended', onEnd);
                    console.log("[FxxkEWT360] ✅ 视频播放完毕，等待自动连播...");
                }, {once: true});
            });
            // 如果播放被暂停则恢复
            video.addEventListener('pause', function onPause() {
                if (!video.ended) video.play().catch(() => {});
            }, {once: true});
        } else {
            console.warn("[FxxkEWT360] 未找到 video 元素或视频尚未加载");
        }

        // 3. 尝试隐藏可能存在的认真检测弹窗
        const checkBox = document.querySelector('[class*="video_earnest_check"]');
        if (checkBox) checkBox.style.display = 'none';
    }

    let settings = {
        autoCheck: true,
        autoMute: true,
        playbackSpeed: '1',
        autoSD: true,
        autoNext: true,
        preventPause: true
    };

    let targetSpeed = 1;

    const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
    if (originalDescriptor) {
        Object.defineProperty(HTMLMediaElement.prototype, 'playbackRate', {
            get: function() {
                return targetSpeed;
            },
            set: function(val) {
                originalDescriptor.set.call(this, targetSpeed);
            },
            configurable: true
        });
    }

    try {
        const stored = localStorage.getItem('fxxkewt_settings');
        if (stored) {
            settings = { ...settings, ...JSON.parse(stored) };
            targetSpeed = parseFloat(settings.playbackSpeed) || 1;
        }
    } catch(e) {}

    function saveSettings() {
        try {
            localStorage.setItem('fxxkewt_settings', JSON.stringify(settings));
        } catch(e) {}
    }

    document.addEventListener('play', (e) => {
        if (e.target && e.target.tagName === 'VIDEO') {
            if (settings.autoMute) {
                e.target.volume = 0;
                e.target.muted = true;
                console.log("[FxxkEWT360] 检测到视频播放 已自动静音");
            }
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
                            rep.start = function dummyStart(opts) {
                                if (opts) {
                                    opts.videoRate = targetSpeed;
                                }
                                return originalStart.call(this, opts);
                            };
                        }
                        if (rep.setVideoRate && rep.setVideoRate.name !== 'dummySetVideoRate') {
                            const originalSetVideoRate = rep.setVideoRate;
                            rep.setVideoRate = function dummySetVideoRate(rate) {
                                return originalSetVideoRate.call(this, targetSpeed);
                            };
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
        const checkpass_btn = document.querySelector('[data-ac="check-pass"]');
        if (!checkpass_btn) return;

        console.log("[FxxkEWT360] 已定位到按钮", checkpass_btn);

        let fiber = getReactFiber(checkpass_btn);
        if (!fiber) {
            console.error("[FxxkEWT360] 未能在该节点上找到 React Fiber 属性");
            return;
        }

        let success = false;
        while (fiber) {
            if (fiber.stateNode && typeof fiber.stateNode.toCheck === 'function') {
                console.log("[FxxkEWT360] 检测到 Class 组件实例 正在调用 toCheck()");
                fiber.stateNode.toCheck();
                success = true;
                break;
            }
            fiber = fiber.return;
        }

        if (success) {
            console.log("[FxxkEWT360] 已成功过检");
        } else {
            console.error("[FxxkEWT360] 未能找到可调用的 React 接口");
        }
    }

    function selectLesson(el) {
        let fiber = getReactFiber(el);
        if (!fiber) return false;

        while (fiber) {
            const props = fiber.memoizedProps;
            if (props) {
                const funcKey = Object.keys(props).find(k => typeof props[k] === 'function');
                const lessonKey = Object.keys(props).find(k => props[k] && typeof props[k] === 'object' && (props[k].contentId || props[k].lessonId || props[k].title));
                
                if (funcKey && lessonKey) {
                    console.log(`[FxxkEWT360] 找到切换课程函数 ${funcKey} 和数据 ${lessonKey} ,执行切换`);
                    props[funcKey](props[lessonKey]);
                    return true;
                }
            }
            fiber = fiber.return;
        }
        return false;
    }

    function autoPlayNext() {
        if (!settings.autoNext) return;
        const spans = Array.from(document.querySelectorAll('span, div, button'));
        const hasReplay = spans.some(el => el.textContent.trim() === '重新观看' && el.offsetParent !== null);
        const video = document.querySelector('video');
        const isFinished = hasReplay || (video && video.ended);

        if (!isFinished) {
            if (isSwitching) {
                console.log("[FxxkEWT360] 检测到新视频已开始 重置切换标记");
                isSwitching = false;
            }
            return;
        }

        if (isSwitching) return;

        const lessons = Array.from(document.querySelectorAll('[data-ac="lesson-item"]'));
        if (lessons.length === 0) return;

        const activeIndex = lessons.findIndex(el => el.classList.contains('active-EI2Hl') || el.className.includes('active'));
        if (activeIndex === -1) return;

        let nextLesson = null;

        for (let i = activeIndex + 1; i < lessons.length; i++) {
            const isDone = lessons[i].querySelector('[class*="finished"]');
            if (!isDone) {
                nextLesson = lessons[i];
                break;
            }
        }

        if (!nextLesson) {
            for (let i = 0; i < activeIndex; i++) {
                const isDone = lessons[i].querySelector('[class*="finished"]');
                if (!isDone) {
                    nextLesson = lessons[i];
                    break;
                }
            }
        }

        if (nextLesson) {
            isSwitching = true;
            console.log("[FxxkEWT360] 检测到当前课程已播放完毕 准备自动切换到下一节未完成课程", nextLesson.textContent.trim());
            const success = selectLesson(nextLesson);
            if (success) {
                console.log("[FxxkEWT360] 自动切换下一节课");
            } else {
                console.error("[FxxkEWT360] 自动切换下一节课失败 未能成功提取 React 回调");
                isSwitching = false;
            }
        } else {
            console.log("[FxxkEWT360] 所有课程已播放完毕 未发现未完成的课程");
            if (!ShuakeFinished) {
                alert("本次刷课已完毕!")
                ShuakeFinished = true;
            }
        }
    }

    function setSpeed() {
        targetSpeed = parseFloat(settings.playbackSpeed) || 1;
        const video = document.querySelector('video');
        if (video) {
            if (originalDescriptor) {
                try {
                    originalDescriptor.set.call(video, targetSpeed);
                } catch(e) {}
            }
            if (settings.autoMute) {
                try {
                    video.volume = 0;
                    video.muted = true;
                } catch(e) {}
            }
        }

        const el = document.querySelector('#video_player_box') || video;
        if (el) {
            let fiber = getReactFiber(el);
            while (fiber) {
                if (fiber.stateNode && fiber.stateNode.oEplayer) {
                    const p = fiber.stateNode.oEplayer;
                    if (typeof p.checkRate === 'function' && p.checkRate.name !== 'dummyCheckRate') {
                        p.checkRate = function dummyCheckRate() { return false; };
                    }
                    if (p._player) {
                        const bp = p._player.bizPoint();
                        if (bp && bp.createParams && bp.createParams.name !== 'dummyCreateParams') {
                            const originalCreateParams = bp.createParams;
                            bp.createParams = function dummyCreateParams(action, status, stayTime, mediaTime) {
                                const mult = targetSpeed > 1 ? targetSpeed : 1;
                                const newStayTime = Math.max(stayTime * mult, mediaTime);
                                return originalCreateParams.call(this, action, status, newStayTime, mediaTime);
                            };
                        }
                    }
                    const rep = fiber.stateNode.report;
                    if (rep) {
                        rep.videoRate = targetSpeed;
                        rep.currentPlayedRate = targetSpeed;
                        if (rep.start && rep.start.name !== 'dummyStart') {
                            const originalStart = rep.start;
                            rep.start = function dummyStart(opts) {
                                if (opts) {
                                    opts.videoRate = targetSpeed;
                                }
                                return originalStart.call(this, opts);
                            };
                        }
                        if (rep.setVideoRate && rep.setVideoRate.name !== 'dummySetVideoRate') {
                            const originalSetVideoRate = rep.setVideoRate;
                            rep.setVideoRate = function dummySetVideoRate(rate) {
                                return originalSetVideoRate.call(this, targetSpeed);
                            };
                        }
                    }
                    break;
                }
                fiber = fiber.return;
            }
        }

        if (settings.autoSD) {
            const items = Array.from(document.querySelectorAll('.vjs-menu-item'));
            const sdItem = items.find(el => {
                const textEl = el.querySelector('.vjs-menu-item-text');
                return textEl && textEl.textContent.trim() === '标清';
            });
            if (sdItem && !sdItem.classList.contains('vjs-selected')) {
                console.log("[FxxkEWT360] 检测到当前非标清线路 正在自动点击标清按钮");
                sdItem.click();
            }
        }
    }

    function makeDraggable(el, handle) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
        handle.onmousedown = dragMouseDown;

        function dragMouseDown(e) {
            e = e || window.event;
            if (e.button !== 0 || e.target.tagName === 'A') return;
            e.preventDefault();
            pos3 = e.clientX;
            pos4 = e.clientY;
            document.onmouseup = closeDragElement;
            document.onmousemove = elementDrag;
        }

        function elementDrag(e) {
            e = e || window.event;
            e.preventDefault();
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            
            el.style.top = (el.offsetTop - pos2) + "px";
            el.style.left = (el.offsetLeft - pos1) + "px";
            el.style.right = 'auto';
        }

        function closeDragElement() {
            document.onmouseup = null;
            document.onmousemove = null;
            try {
                localStorage.setItem('fxxkewt_panel_pos', JSON.stringify({ top: el.style.top, left: el.style.left }));
            } catch(e) {}
        }
    }

    function initPanel() {
        try {
            if (document.getElementById('fxxkewt-panel')) return;
            if (!document.body) {
                setTimeout(initPanel, 100);
                return;
            }

            console.log("[FxxkEWT360] 开始创建设置面板");

            const style = document.createElement('style');
            style.textContent = `
                #fxxkewt-panel {
                    position: fixed;
                    top: 100px;
                    right: 20px;
                    width: 200px;
                    background: #eee;
                    border: 1px solid #999;
                    color: #000;
                    font-family: sans-serif;
                    font-size: 12px;
                    z-index: 99999999;
                }
                #fxxkewt-header {
                    padding: 5px;
                    background: #ccc;
                    cursor: move;
                    font-weight: bold;
                    display: flex;
                    justify-content: space-between;
                    user-select: none;
                }
                #fxxkewt-header a {
                    color: blue;
                    text-decoration: none;
                }
                #fxxkewt-body {
                    padding: 10px;
                }
                .fxxkewt-row {
                    margin: 8px 0;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                .fxxkewt-select {
                    font-size: 12px;
                }
            `;
            (document.head || document.documentElement).appendChild(style);

            const panel = document.createElement('div');
            panel.id = 'fxxkewt-panel';
            
            try {
                const pos = localStorage.getItem('fxxkewt_panel_pos');
                if (pos) {
                    const parsed = JSON.parse(pos);
                    panel.style.top = parsed.top || '100px';
                    if (parsed.left && parsed.left !== 'auto') {
                        panel.style.left = parsed.left;
                        panel.style.right = 'auto';
                    } else {
                        panel.style.right = '20px';
                    }
                } else {
                    panel.style.top = '100px';
                    panel.style.right = '20px';
                }
            } catch(e) {
                panel.style.top = '100px';
                panel.style.right = '20px';
            }

            panel.innerHTML = `
                <div id="fxxkewt-header">
                    <span>FxxkEWT360 </span><span style="font-style: italic;">by Gtd232</span>
                    <a href="https://github.com/Gtd232/FxxkEWT360" target="_blank">GitHub</a>
                </div>
                <div id="fxxkewt-body">
                    <div class="fxxkewt-row">
                        <span>自动过检</span>
                        <input type="checkbox" id="fxxkewt-autoCheck" ${settings.autoCheck ? 'checked' : ''}>
                    </div>
                    <div class="fxxkewt-row">
                        <span>自动静音</span>
                        <input type="checkbox" id="fxxkewt-autoMute" ${settings.autoMute ? 'checked' : ''}>
                    </div>
                    <div class="fxxkewt-row">
                        <span>自动标清</span>
                        <input type="checkbox" id="fxxkewt-autoSD" ${settings.autoSD ? 'checked' : ''}>
                    </div>
                    <div class="fxxkewt-row">
                        <span>自动连播</span>
                        <input type="checkbox" id="fxxkewt-autoNext" ${settings.autoNext ? 'checked' : ''}>
                    </div>
                    <div class="fxxkewt-row">
                        <span>禁止暂停</span>
                        <input type="checkbox" id="fxxkewt-preventPause" ${settings.preventPause ? 'checked' : ''}>
                    </div>
                    <div class="fxxkewt-row">
                        <span>倍速选择</span>
                        <select class="fxxkewt-select" id="fxxkewt-speed">
                            <option value="0.8" ${settings.playbackSpeed === '0.8' ? 'selected' : ''}>0.8X</option>
                            <option value="1" ${settings.playbackSpeed === '1' ? 'selected' : ''}>1.0X</option>
                            <option value="1.2" ${settings.playbackSpeed === '1.2' ? 'selected' : ''}>1.2X</option>
                            <option value="1.5" ${settings.playbackSpeed === '1.5' ? 'selected' : ''}>1.5X</option>
                            <option value="2" ${settings.playbackSpeed === '2' ? 'selected' : ''}>2.0X</option>
                            <option value="4" ${settings.playbackSpeed === '4' ? 'selected' : ''}>4.0X</option>
                            <option value="8" ${settings.playbackSpeed === '8' ? 'selected' : ''}>8.0X</option>
                            <option value="16" ${settings.playbackSpeed === '16' ? 'selected' : ''}>16X</option>
                        </select>
                    </div>
                    <div style="font-size: 10px; color: #666; margin-top: 10px; border-top: 1px dashed #ccc; padding-top: 5px; line-height: 1.3;">
                        不建议开启倍速播放, 这会使得在统计时实际看课时长缩短
                    </div>
                    <div style="margin-top: 12px; border-top: 2px solid #c00; padding-top: 8px;">
                        <button id="fxxkewt-quickfinish" style="width:100%;padding:6px 0;background:#c00;color:#fff;border:none;border-radius:3px;cursor:pointer;font-weight:bold;font-size:13px;">
                            🚀 一键完成当前视频
                        </button>
                    </div>
                </div>
            `;
            document.body.appendChild(panel);

            panel.querySelector('#fxxkewt-autoCheck').onchange = (e) => {
                settings.autoCheck = e.target.checked;
                saveSettings();
            };
            panel.querySelector('#fxxkewt-autoMute').onchange = (e) => {
                settings.autoMute = e.target.checked;
                saveSettings();
            };
            panel.querySelector('#fxxkewt-autoSD').onchange = (e) => {
                settings.autoSD = e.target.checked;
                saveSettings();
                setSpeed();
            };
            panel.querySelector('#fxxkewt-autoNext').onchange = (e) => {
                settings.autoNext = e.target.checked;
                saveSettings();
            };
            panel.querySelector('#fxxkewt-preventPause').onchange = (e) => {
                settings.preventPause = e.target.checked;
                saveSettings();
            };
            panel.querySelector('#fxxkewt-speed').onchange = (e) => {
                settings.playbackSpeed = e.target.value;
                saveSettings();
                setSpeed();
            };

            makeDraggable(panel, panel.querySelector('#fxxkewt-header'));

            panel.querySelector('#fxxkewt-quickfinish').onclick = quickFinish;
            console.log("[FxxkEWT360] 设置面板创建成功");
        } catch(e) {
            console.error("[FxxkEWT360] initPanel 发生异常", e);
        }
    }

    setTimeout(initPanel, 100);
    setInterval(() => {
        checkpass();
        autoPlayNext();
        setSpeed();
    }, 2000);
})();