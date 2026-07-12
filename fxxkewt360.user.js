// ==UserScript==
// @name         FxxkEWT360
// @namespace    https://github.com/Gtd232/FxxkEWT360
// @version      4.6
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
    let quickFinishRunning = false;
    let checkPassPromise = null;

    let settings = {
        autoCheck: true,
        autoMute: true,
        playbackSpeed: '1',
        autoSD: true,
        autoNext: true,
        preventPause: true,
        accelerateWatchTime: false,
        quickFinishWatchTime: false
    };

    let targetSpeed = 1;
    const officialSpeeds = [0.8, 1, 1.2, 1.5, 2];
    const PAGE_STAY_EVENT = '$$_page_stay';
    const PAGE_STAY_TRIGGER = 'scroll';
    const patchedBizPoints = new WeakSet();
    const quickFinishBizPointReports = new WeakSet();
    const BIZ_POINT_PLAYING = 2;
    const BIZ_POINT_WATCH = 1;

    const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
    if (originalDescriptor) {
        Object.defineProperty(HTMLMediaElement.prototype, 'playbackRate', {
            get: function() {
                if (officialSpeeds.includes(targetSpeed)) {
                    return targetSpeed;
                }
                return 1;
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

    function showFirstRunNotice() {
        if (localStorage.getItem('fxxkewt_first_run_notice_shown') === '1') return;
        localStorage.setItem('fxxkewt_first_run_notice_shown', '1');

        alert([
            'FxxkEWT360 使用注意事项',
            '',
            '1. 使用"一键完成"前，请先播放当前视频，等待页面原生上报组件初始化。一键完成会直接触发当前课程的页面原生上报，请刷新页面确认结果。',
            '2. 开启倍速后若不勾选"倍速同步看课时长", 可能会导致实际看课时长大幅变短，这在后台会有体现; 即使勾选了也请慎用倍速功能。',
            '3. 请谨慎使用处于测试状态的功能，这些功能可能不会按照预期工作。',
            '',
            'Made with ❤️ by Gtd232',
            'Contributors: Gtd232, Alan6234(34LiuNian)',
            'GitHub：https://github.com/Gtd232/FxxkEWT360'
        ].join('\n'));
    }

    function reportUsageTimeCompensation(duration) {
        const reportedDuration = Math.round(Number(duration));
        if (!Number.isFinite(reportedDuration) || reportedDuration <= 0) return;

        const properties = {
            duration: reportedDuration,
            triggerTiming: PAGE_STAY_TRIGGER
        };
        if (window.aplus && typeof window.aplus.record === 'function') {
            window.aplus.record(PAGE_STAY_EVENT, 'OTHER', properties);
            return;
        }

        window.aplus_queue = window.aplus_queue || [];
        window.aplus_queue.push({
            action: 'aplus.record',
            arguments: [PAGE_STAY_EVENT, 'OTHER', properties]
        });
    }

    function patchWatchTimeReporter(bizPoint) {
        if (!bizPoint || typeof bizPoint.createParams !== 'function' || patchedBizPoints.has(bizPoint)) return;

        const originalCreateParams = bizPoint.createParams;
        bizPoint.createParams = function patchedCreateParams(action, status, stayTime, mediaTime) {
            const physicalDuration = Number(stayTime);
            const mediaDuration = Number(mediaTime);
            const shouldAccelerate = quickFinishBizPointReports.has(bizPoint)
                ? settings.quickFinishWatchTime
                : settings.accelerateWatchTime;
            const reportedStayTime = shouldAccelerate &&
                Number.isFinite(physicalDuration) && Number.isFinite(mediaDuration)
                ? Math.max(physicalDuration, mediaDuration)
                : stayTime;
            if (shouldAccelerate && Number.isFinite(physicalDuration)) {
                reportUsageTimeCompensation(Number(reportedStayTime) - physicalDuration);
            }
            return originalCreateParams.call(this, action, status, reportedStayTime, mediaTime);
        };
        patchedBizPoints.add(bizPoint);
    }

    function syncReportSpeed(rep) {
        if (!rep) return;

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

    document.addEventListener('play', (e) => {
        if (e.target && e.target.tagName === 'VIDEO') {
            if (settings.autoMute) {
                e.target.volume = 0;
                e.target.muted = true;
                console.log("[FxxkEWT360] 检测到视频播放 已自动静音");
            }
            const el = document.querySelector('#video_player_box') || e.target;
            const component = findReactStateNode(el, node => node.report);
            if (component) {
                syncReportSpeed(component.report);
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

    function findReactStateNode(el, predicate) {
        let fiber = getReactFiber(el);
        while (fiber) {
            if (fiber.stateNode && predicate(fiber.stateNode)) {
                return fiber.stateNode;
            }
            fiber = fiber.return;
        }
        return null;
    }

    function getPlayerComponent() {
        const video = document.querySelector('video');
        const el = document.querySelector('#video_player_box') || video;
        return findReactStateNode(el, node => node.report && typeof node.report.report === 'function');
    }

    function getActiveCheckComponent() {
        const button = document.querySelector('[data-ac="check-pass"]');
        return button ? findReactStateNode(button, node => typeof node.toCheck === 'function') : null;
    }

    function getNativeProgress(reporter) {
        const duration = Number(reporter.videoDuration);
        const requiredDuration = Number(reporter.videoDurationLimit);
        let playedDuration = Number(reporter.videoPlayedDuration);

        if (typeof reporter.calcTime === 'function') {
            const progress = reporter.calcTime();
            if (progress && Number.isFinite(progress.timeTotal)) {
                playedDuration = Math.max(playedDuration, progress.timeTotal);
            }
        }

        if (!Number.isFinite(duration) || duration <= 0 ||
            !Number.isFinite(requiredDuration) || requiredDuration <= 0 ||
            !Number.isFinite(playedDuration) || playedDuration < 0) {
            throw new Error('页面原生进度数据尚未就绪');
        }

        const homeworkId = Number(reporter.homeworkId);
        const lessonId = Number(reporter.lessonId);
        if (!Number.isFinite(homeworkId) || homeworkId <= 0 ||
            !Number.isFinite(lessonId) || lessonId <= 0) {
            throw new Error('页面原生课程上下文无效');
        }

        return {
            duration,
            playedDuration,
            target: Math.min(duration, Math.max(playedDuration, requiredDuration))
        };
    }

    function getBizPointContext(component, reporter) {
        const player = component.oEplayer;
        const internalPlayer = player && player._player;
        if (!player || !internalPlayer || typeof internalPlayer.bizPoint !== 'function' ||
            (typeof internalPlayer.usingPlugin === 'function' && !internalPlayer.usingPlugin('bizPoint'))) {
            throw new Error('页面原生看课时长组件尚未就绪');
        }

        const bizPoint = internalPlayer.bizPoint();
        const options = bizPoint && bizPoint._options;
        const isSchoolVideo = reporter.isXBvideo === true;
        if (!bizPoint || typeof bizPoint.upload !== 'function' || !options ||
            Number(options.videoType) !== (isSchoolVideo ? 6 : 1) ||
            String(options.videoBizCode) !== (isSchoolVideo ? '1014' : '1013') ||
            Number(options.lessonId) !== Number(reporter.lessonId)) {
            throw new Error('页面原生看课时长上下文无效');
        }
        if (bizPoint._isFirstPlayStatus !== BIZ_POINT_PLAYING) {
            throw new Error('请先开始播放当前视频');
        }
        if (typeof player.getPosition !== 'function' || typeof player.seek !== 'function') {
            throw new Error('页面原生播放器接口不完整');
        }

        patchWatchTimeReporter(bizPoint);
        return { player, bizPoint };
    }

    function getReadyQuickFinishContext() {
        const component = getPlayerComponent();
        if (!component) {
            throw new Error('无法定位页面原生进度组件');
        }

        const reporter = component.report;
        const isSchoolVideo = reporter.isXBvideo === true;
        if (!isSchoolVideo && reporter.reportEnabled !== true) {
            throw new Error('页面原生进度上报未启用或尚未就绪');
        }

        const context = {
            component,
            reporter,
            homeworkId: Number(reporter.homeworkId),
            lessonId: Number(reporter.lessonId),
            mode: isSchoolVideo ? 'school' : 'compensation',
            ...getNativeProgress(reporter)
        };

        if (isSchoolVideo || settings.quickFinishWatchTime) {
            Object.assign(context, getBizPointContext(component, reporter));
        }
        return context;
    }

    function assertSameReportContext(before, after) {
        if (before.reporter !== after.reporter ||
            before.homeworkId !== after.homeworkId ||
            before.lessonId !== after.lessonId ||
            before.mode !== after.mode ||
            before.bizPoint !== after.bizPoint) {
            throw new Error('等待期间课程已切换，请重新操作');
        }
    }

    function executeCheckPass(component) {
        if (!checkPassPromise) {
            checkPassPromise = Promise.resolve()
                .then(() => component.toCheck())
                .finally(() => {
                    checkPassPromise = null;
                });
        }
        return checkPassPromise;
    }

    async function passActiveCheck() {
        const component = getActiveCheckComponent();
        if (!component && !checkPassPromise) return false;

        await (checkPassPromise || executeCheckPass(component));
        return true;
    }

    async function uploadQuickFinishProgress(context) {
        const { player, bizPoint, playedDuration, target } = context;
        const reportedDuration = target - playedDuration;
        if (reportedDuration <= 0) return false;

        const currentPosition = Number(player.getPosition());
        if (!Number.isFinite(currentPosition) || currentPosition < 0) {
            throw new Error('页面原生播放位置无效');
        }

        player.seek(target / 1000);

        let uploadPromise;
        quickFinishBizPointReports.add(bizPoint);
        try {
            uploadPromise = bizPoint.upload(
                BIZ_POINT_PLAYING,
                BIZ_POINT_WATCH,
                0,
                reportedDuration
            );
        } finally {
            quickFinishBizPointReports.delete(bizPoint);
        }
        await uploadPromise;
        return true;
    }

    async function quickFinish() {
        if (quickFinishRunning) return;

        const button = document.getElementById('fxxkewt-quickfinish');
        const originalText = button ? button.textContent : '';
        quickFinishRunning = true;
        if (button) {
            button.disabled = true;
            button.textContent = '处理中...';
        }

        try {
            const initialContext = getReadyQuickFinishContext();
            await passActiveCheck();
            const reportContext = getReadyQuickFinishContext();
            assertSameReportContext(initialContext, reportContext);

            const { reporter, target, mode } = reportContext;
            let reportTriggered = true;
            if (mode === 'school') {
                reportTriggered = await uploadQuickFinishProgress(reportContext);
            } else {
                const reportPromise = reporter.report(target);
                reporter.reportEnabled = false;
                if (reporter.timeInterval) {
                    clearInterval(reporter.timeInterval);
                    reporter.timeInterval = null;
                }
                await reportPromise;
                if (settings.quickFinishWatchTime) {
                    await uploadQuickFinishProgress(reportContext);
                }
            }

            console.log('[FxxkEWT360] 已触发页面原生进度上报', {
                lessonId: reporter.lessonId,
                homeworkId: reporter.homeworkId,
                mode,
                target,
                watchTimeSynced: settings.quickFinishWatchTime
            });
            alert(reportTriggered
                ? '已触发页面原生进度上报，请稍后刷新进度确认'
                : '页面原生进度已达到完成阈值，请刷新进度确认');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('[FxxkEWT360] 一键完成失败', error);
            alert(`一键完成失败：${message}`);
        } finally {
            quickFinishRunning = false;
            if (button) {
                button.disabled = false;
                button.textContent = originalText;
            }
        }
    }

    function checkpass() {
        if (!settings.autoCheck || quickFinishRunning || checkPassPromise) return;
        const component = getActiveCheckComponent();
        if (!component) return;

        console.log("[FxxkEWT360] 检测到认真度检查 正在调用页面原生接口");
        executeCheckPass(component).catch(error => {
            console.error("[FxxkEWT360] 页面原生过检失败", error);
        });
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
        const component = findReactStateNode(el, node => node.oEplayer);
        if (component) {
            const p = component.oEplayer;
            if (typeof p.checkRate === 'function' && p.checkRate.name !== 'dummyCheckRate') {
                p.checkRate = function dummyCheckRate() { return false; };
            }
            const internalPlayer = p._player;
            if (internalPlayer && typeof internalPlayer.bizPoint === 'function' &&
                (typeof internalPlayer.usingPlugin !== 'function' || internalPlayer.usingPlugin('bizPoint'))) {
                patchWatchTimeReporter(internalPlayer.bizPoint());
            }
            syncReportSpeed(component.report);
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
                #fxxkewt-more-toggle {
                    width: 100%;
                    padding: 6px 0;
                    border: 0;
                    border-top: 1px solid #bbb;
                    background: transparent;
                    color: #333;
                    font-size: 12px;
                    text-align: left;
                    cursor: pointer;
                }
                #fxxkewt-more-toggle span {
                    float: right;
                }
                #fxxkewt-more-tools[hidden] {
                    display: none;
                }
                #fxxkewt-quickfinish {
                    width: 100%;
                    padding: 6px;
                    border: 1px solid #888;
                    background: #ddd;
                    color: #000;
                    font-size: 12px;
                    cursor: pointer;
                }
                #fxxkewt-quickfinish:disabled {
                    cursor: wait;
                    opacity: 0.65;
                }
                .fxxkewt-warning {
                    margin-top: 6px;
                    color: #a33;
                    font-size: 10px;
                    line-height: 1.4;
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
                        <span>自动连播</span>
                        <input type="checkbox" id="fxxkewt-autoNext" ${settings.autoNext ? 'checked' : ''}>
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
                            <option value="16" ${settings.playbackSpeed === '16' ? 'selected' : ''}>16.0X</option>
                        </select>
                    </div>
                    <button type="button" id="fxxkewt-more-toggle" aria-expanded="false">
                        更多工具<span>+</span>
                    </button>
                    <div id="fxxkewt-more-tools" hidden>
                        <div class="fxxkewt-row">
                            <span>自动静音</span>
                            <input type="checkbox" id="fxxkewt-autoMute" ${settings.autoMute ? 'checked' : ''}>
                        </div>
                        <div class="fxxkewt-row">
                            <span>自动标清</span>
                            <input type="checkbox" id="fxxkewt-autoSD" ${settings.autoSD ? 'checked' : ''}>
                        </div>
                        <div class="fxxkewt-row">
                            <span>禁止暂停</span>
                            <input type="checkbox" id="fxxkewt-preventPause" ${settings.preventPause ? 'checked' : ''}>
                        </div>
                        <div class="fxxkewt-row">
                            <span>倍速同步看课时长(测试)</span>
                            <input type="checkbox" id="fxxkewt-accelerateWatchTime" ${settings.accelerateWatchTime ? 'checked' : ''}>
                        </div>
                        <div class="fxxkewt-row">
                            <span>一键完成同步看课时长(测试)</span>
                            <input type="checkbox" id="fxxkewt-quickFinishWatchTime" ${settings.quickFinishWatchTime ? 'checked' : ''}>
                        </div>
                        <button type="button" id="fxxkewt-quickfinish">一键完成当前视频(测试)</button>
                        <div class="fxxkewt-warning">
                        直接触发当前课程的页面原生上报，请刷新页面确认结果。
                        <br>
                        开启倍速后若不勾选"倍速同步看课时长", 可能会导致实际看课时长变短，这在后台会有体现; 即使勾选了也请慎用倍速功能。
                        <br>
                        慎用测试功能，测试功能可能会未按预期工作。
                        </div>
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
            panel.querySelector('#fxxkewt-accelerateWatchTime').onchange = (e) => {
                settings.accelerateWatchTime = e.target.checked;
                saveSettings();
                setSpeed();
            };
            panel.querySelector('#fxxkewt-quickFinishWatchTime').onchange = (e) => {
                settings.quickFinishWatchTime = e.target.checked;
                saveSettings();
            };

            const moreToggle = panel.querySelector('#fxxkewt-more-toggle');
            const moreTools = panel.querySelector('#fxxkewt-more-tools');
            moreToggle.onclick = () => {
                const expanded = moreToggle.getAttribute('aria-expanded') !== 'true';
                moreToggle.setAttribute('aria-expanded', String(expanded));
                moreToggle.querySelector('span').textContent = expanded ? '-' : '+';
                moreTools.hidden = !expanded;
            };
            panel.querySelector('#fxxkewt-quickfinish').onclick = quickFinish;

            makeDraggable(panel, panel.querySelector('#fxxkewt-header'));
            console.log("[FxxkEWT360] 设置面板创建成功");
            showFirstRunNotice();
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
