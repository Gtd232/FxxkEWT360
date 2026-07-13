// ==UserScript==
// @name         FxxkEWT360
// @namespace    https://github.com/Gtd232/FxxkEWT360
// @version      5.0
// @description  逃避升学e网通
// @author       Gtd232
// @match        *://*.ewt360.com/*
// @run-at       document-start
// @require      https://cdn.jsdelivr.net/npm/mux.js@6.3.0/dist/mux.min.js
// @require      https://cdn.jsdelivr.net/npm/mp4box@0.5.4/dist/mp4box.all.min.js
// @grant        unsafeWindow
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
    let screenshotCaptureRunning = false;
    let screenshotExportRunning = false;
    let videoDownloadRunning = false;
    let screenshotSequence = 0;
    let screenshotStatusTimer = null;
    const screenshots = [];

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

    function getCapturableVideo() {
        const videos = Array.from(document.querySelectorAll('video')).filter(video =>
            video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2
        );
        if (videos.length === 0) return null;

        return videos.sort((a, b) => {
            const aVisible = a.getClientRects().length > 0 ? 1 : 0;
            const bVisible = b.getClientRects().length > 0 ? 1 : 0;
            const aPlaying = !a.paused && !a.ended ? 1 : 0;
            const bPlaying = !b.paused && !b.ended ? 1 : 0;
            return (bPlaying - aPlaying) || (bVisible - aVisible);
        })[0];
    }

    function formatVideoTime(seconds) {
        const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const secs = totalSeconds % 60;
        return [hours, minutes, secs].map(value => String(value).padStart(2, '0')).join('-');
    }

    function sanitizeDownloadName(name) {
        const sanitized = String(name || '')
            .replace(/[\\/:*?"<>|]/g, '-')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/\.(mp4|m4v|mov|webm|mkv|flv|ts)$/i, '');
        return (sanitized || 'ewt-video').slice(0, 100);
    }

    function getHttpMediaUrl(value) {
        if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return '';
        try {
            return new URL(value, location.href).href;
        } catch(e) {
            return '';
        }
    }

    function getCurrentVideoDownloadInfo() {
        const video = getCapturableVideo() || document.querySelector('video');
        if (!video) throw new Error('未找到当前视频');

        const playerElement = document.querySelector('#video_player_box') || video;
        const component = findReactStateNode(playerElement, node => node.oEplayer);
        const outerPlayer = component && component.oEplayer;
        const player = outerPlayer && outerPlayer._player;
        let tech = null;
        let definition = null;
        try {
            tech = player && typeof player.tech === 'function' ? player.tech(true) : null;
            definition = player && typeof player.definition === 'function'
                ? player.definition().showClarity()
                : null;
        } catch(e) {}

        const adapter = tech && (tech._adapter || tech.sourceHandler_);
        let metadata = null;
        let hls = null;
        try {
            metadata = adapter && typeof adapter.getVideoBasicInfo === 'function'
                ? adapter.getVideoBasicInfo()
                : null;
            hls = adapter && typeof adapter.getHlsInstance === 'function'
                ? adapter.getHlsInstance()
                : null;
        } catch(e) {}

        const playInfo = metadata && (
            (metadata.data && metadata.data.videoPlayInfo) ||
            metadata.videoPlayInfo ||
            metadata.playInfo
        );
        const basicInfo = metadata && (
            (metadata.data && metadata.data.videoBasicInfo) ||
            metadata.videoBasicInfo ||
            metadata.basicInfo
        );
        const hlsLevelIndex = hls && Number.isInteger(hls.currentLevel) && hls.currentLevel >= 0
            ? hls.currentLevel
            : (hls && Number.isInteger(hls.nextLoadLevel) ? hls.nextLoadLevel : -1);
        const hlsLevel = hls && Array.isArray(hls.levels) && hlsLevelIndex >= 0
            ? hls.levels[hlsLevelIndex]
            : null;
        const hlsLevelUrl = hlsLevel && (Array.isArray(hlsLevel.url) ? hlsLevel.url[0] : hlsLevel.url);
        const url = getHttpMediaUrl(
            hlsLevelUrl || (playInfo && (playInfo.playUrl || playInfo.PlayURL))
        );
        if (!url) {
            throw new Error('播放器尚未提供当前视频地址，请开始播放后重试');
        }

        const format = String(
            (playInfo && (playInfo.format || playInfo.Format)) || ''
        ).toLowerCase();
        const pathname = new URL(url).pathname.toLowerCase();
        const isHls = format.includes('m3u8') || format.includes('mpegurl') ||
            format.includes('hls') || pathname.endsWith('.m3u8');

        const extensionMatch = pathname.match(/\.([a-z0-9]{2,5})$/i);
        const supportedExtensions = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'flv', 'ts'];
        const extension = !isHls && extensionMatch && supportedExtensions.includes(extensionMatch[1].toLowerCase())
            ? extensionMatch[1].toLowerCase()
            : 'mp4';
        let quality = '';
        try {
            quality = outerPlayer && typeof outerPlayer.getDefinition === 'function'
                ? outerPlayer.getDefinition()
                : (definition && definition.name) || '';
        } catch(e) {}
        const title = sanitizeDownloadName(
            (basicInfo && (basicInfo.name || basicInfo.title || basicInfo.Name || basicInfo.Title)) ||
            document.title
        );
        const qualitySuffix = quality ? `-${sanitizeDownloadName(quality)}` : '';

        return {
            url,
            filenameBase: `${title}${qualitySuffix}`,
            extension,
            isHls
        };
    }

    function updateVideoDownloadButton() {
        const button = document.getElementById('fxxkewt-video-download');
        if (!button) return;
        button.disabled = videoDownloadRunning;
        button.textContent = videoDownloadRunning ? '正在下载当前视频...' : '下载当前视频';
    }

    function fetchVideoResource(url) {
        const sourceUrl = new URL(url);
        return fetch(sourceUrl.href, {
            credentials: sourceUrl.origin === location.origin ? 'include' : 'omit'
        });
    }

    function parseHlsAttributes(line) {
        const attributes = {};
        const content = line.slice(line.indexOf(':') + 1);
        const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
        let match;
        while ((match = pattern.exec(content))) {
            attributes[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '');
        }
        return attributes;
    }

    async function resolveHlsPlaylist(url, depth = 0) {
        // if (depth > 3) throw new Error('HLS 播放列表嵌套层级过深');
        const response = await fetchVideoResource(url);
        if (!response.ok) throw new Error(`HLS 播放列表请求失败 (${response.status})`);
        const text = await response.text();
        if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('HLS 播放列表格式无效');
        const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

        const variants = [];
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
            const attributes = parseHlsAttributes(lines[i]);
            const nextLine = lines.slice(i + 1).find(line => !line.startsWith('#'));
            if (nextLine) {
                variants.push({
                    url: new URL(nextLine, url).href,
                    bandwidth: Number(attributes.BANDWIDTH) || 0
                });
            }
        }
        if (variants.length > 0) {
            variants.sort((a, b) => b.bandwidth - a.bandwidth);
            return resolveHlsPlaylist(variants[0].url, depth + 1);
        }

        if (!lines.includes('#EXT-X-ENDLIST')) {
            throw new Error('无法完整下载');
        }
        if (lines.some(line => line.startsWith('#EXT-X-BYTERANGE:'))) {
            throw new Error('当前 HLS 使用字节范围分片，暂不支持合并');
        }

        let mediaSequence = 0;
        for (const line of lines) {
            if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
                mediaSequence = Number(line.split(':')[1]) || 0;
            }
        }

        const segments = [];
        let currentKeyInfo = null;
        let segmentIndex = 0;
        let usesFragmentedMp4 = false;

        for (const line of lines) {
            if (line.startsWith('#EXT-X-KEY:')) {
                const attrs = parseHlsAttributes(line);
                const method = String(attrs.METHOD || '').toUpperCase();
                if (method && method !== 'NONE') {
                    if (method !== 'AES-128') {
                        throw new Error(`不支持的加密方式: ${method}`);
                    }
                    const keyUri = attrs.URI ? new URL(attrs.URI, url).href : null;
                    const rawIv = attrs.IV ? attrs.IV : null;
                    currentKeyInfo = {
                        keyUri,
                        rawIv
                    };
                } else {
                    currentKeyInfo = null;
                }
            } else if (line.startsWith('#EXT-X-MAP:')) {
                const mapUri = parseHlsAttributes(line).URI;
                if (mapUri) {
                    segments.push({
                        url: new URL(mapUri, url).href,
                        keyInfo: currentKeyInfo ? { ...currentKeyInfo } : null,
                        sequenceNumber: 0
                    });
                    usesFragmentedMp4 = true;
                }
            } else if (!line.startsWith('#')) {
                const seq = mediaSequence + segmentIndex;
                segments.push({
                    url: new URL(line, url).href,
                    keyInfo: currentKeyInfo ? { ...currentKeyInfo } : null,
                    sequenceNumber: seq
                });
                if (/\.(m4s|mp4)(?:$|\?)/i.test(line)) usesFragmentedMp4 = true;
                segmentIndex++;
            }
        }

        if (segments.length === 0) throw new Error('HLS 播放列表中没有可下载分片');
        return {
            segments,
            container: usesFragmentedMp4 ? 'fmp4' : 'mpegts'
        };
    }

    function getMuxJs() {
        return typeof muxjs !== 'undefined' ? muxjs : null;
    }

    function getMp4Box() {
        return typeof MP4Box !== 'undefined' ? MP4Box : null;
    }

    function compressMp4TableRuns(values) {
        const counts = [];
        const entries = [];
        for (const value of values) {
            const lastIndex = entries.length - 1;
            if (lastIndex >= 0 && entries[lastIndex] === value) {
                counts[lastIndex]++;
            } else {
                entries.push(value);
                counts.push(1);
            }
        }
        return { counts, entries };
    }

    function convertFragmentedMp4ToProgressive(fragmentedBuffer) {
        const mp4box = getMp4Box();
        if (!mp4box || typeof mp4box.createFile !== 'function') {
            throw new Error('标准 MP4 生成组件未加载');
        }

        fragmentedBuffer.fileStart = 0;
        const file = mp4box.createFile(true);
        let parseError = null;
        file.onError = error => {
            parseError = error;
        };
        file.appendBuffer(fragmentedBuffer);
        file.flush();
        if (parseError) throw new Error(`MP4 数据解析失败: ${parseError}`);
        if (!file.ftyp || !file.moov || !Array.isArray(file.moov.traks)) {
            throw new Error('转封装结果缺少 MP4 索引');
        }

        const mvexIndex = file.moov.boxes.indexOf(file.moov.mvex);
        if (mvexIndex >= 0) file.moov.boxes.splice(mvexIndex, 1);
        delete file.moov.mvex;

        const inputBytes = new Uint8Array(fragmentedBuffer);
        const records = [];
        let totalMediaSize = 0;
        let movieDuration = 0;
        let hasVideoSamples = false;

        for (const track of file.moov.traks) {
            const samples = Array.isArray(track.samples) ? track.samples : [];
            if (samples.length === 0) continue;
            const stbl = track.mdia && track.mdia.minf && track.mdia.minf.stbl;
            if (!stbl || !stbl.stts || !stbl.stsc || !stbl.stco || !stbl.stsz) {
                throw new Error('MP4 轨道索引不完整');
            }

            if (track.mdia.hdlr && track.mdia.hdlr.handler === 'vide') {
                hasVideoSamples = true;
            }
            const mediaDuration = samples[samples.length - 1].dts + samples[samples.length - 1].duration;
            track.mdia.mdhd.duration = mediaDuration;
            track.tkhd.duration = Math.ceil(
                mediaDuration * file.moov.mvhd.timescale / track.mdia.mdhd.timescale
            );
            movieDuration = Math.max(movieDuration, track.tkhd.duration);

            const durationRuns = compressMp4TableRuns(samples.map(sample => sample.duration));
            stbl.stts.sample_counts = durationRuns.counts;
            stbl.stts.sample_deltas = durationRuns.entries;
            stbl.stsz.sample_sizes = samples.map(sample => sample.size);
            stbl.stsc.first_chunk = [1];
            stbl.stsc.samples_per_chunk = [1];
            stbl.stsc.sample_description_index = [1];
            stbl.stco.chunk_offsets = new Array(samples.length).fill(0);

            const compositionOffsets = samples.map(sample => sample.cts - sample.dts);
            if (compositionOffsets.some(offset => offset !== 0)) {
                if (compositionOffsets.some(offset => offset < 0)) {
                    throw new Error('当前视频使用了不受支持的负合成时间偏移');
                }
                const offsetRuns = compressMp4TableRuns(compositionOffsets);
                const ctts = stbl.ctts || stbl.add('ctts');
                ctts.version = 0;
                ctts.flags = 0;
                ctts.sample_counts = offsetRuns.counts;
                ctts.sample_offsets = offsetRuns.entries;
            }

            const syncSamples = samples
                .map((sample, index) => sample.is_sync ? index + 1 : 0)
                .filter(Boolean);
            if (syncSamples.length > 0 && syncSamples.length < samples.length) {
                const stss = stbl.stss || stbl.add('stss');
                stss.version = 0;
                stss.flags = 0;
                stss.sample_numbers = syncSamples;
            }

            samples.forEach((sample, index) => {
                records.push({
                    track,
                    sample,
                    index,
                    time: sample.dts / track.mdia.mdhd.timescale,
                    relativeOffset: 0
                });
                totalMediaSize += sample.size;
            });
        }

        if (!hasVideoSamples) throw new Error('TS 转 MP4 后没有检测到视频轨');
        if (records.length === 0 || totalMediaSize === 0) {
            throw new Error('TS 转 MP4 未生成媒体数据');
        }
        file.moov.mvhd.duration = movieDuration;
        records.sort((a, b) =>
            a.time - b.time || a.track.tkhd.track_id - b.track.tkhd.track_id
        );

        const mediaData = new Uint8Array(totalMediaSize);
        let mediaOffset = 0;
        for (const record of records) {
            const sampleEnd = record.sample.offset + record.sample.size;
            if (record.sample.offset < 0 || sampleEnd > inputBytes.byteLength) {
                throw new Error('MP4 视频样本位置无效');
            }
            record.relativeOffset = mediaOffset;
            mediaData.set(inputBytes.subarray(record.sample.offset, sampleEnd), mediaOffset);
            mediaOffset += record.sample.size;
        }

        file.boxes = [file.ftyp, file.moov];
        const headerSize = file.getBuffer().byteLength;
        const mdatDataStart = headerSize + 8;
        if (mdatDataStart + mediaData.byteLength > 0xffffffff) {
            throw new Error('视频过大，无法生成标准 MP4 索引');
        }
        for (const record of records) {
            record.track.mdia.minf.stbl.stco.chunk_offsets[record.index] =
                mdatDataStart + record.relativeOffset;
        }
        file.add('mdat').data = mediaData;
        return new Blob([file.getBuffer()], { type: 'video/mp4' });
    }

    async function transmuxTsToMp4(parts) {
        const mux = getMuxJs();
        if (!mux || !mux.mp4 || typeof mux.mp4.Transmuxer !== 'function') {
            throw new Error('MP4 转封装组件未加载');
        }
        if (!parts.length) throw new Error('没有可转换的 TS 分片');

        const outputParts = [];
        let initSegmentAdded = false;
        let mediaSegmentCount = 0;
        let transmuxError = null;
        const transmuxer = new mux.mp4.Transmuxer({
            keepOriginalTimestamps: false,
            remux: true
        });
        transmuxer.on('data', segment => {
            if (!initSegmentAdded && segment.initSegment) {
                outputParts.push(segment.initSegment);
                initSegmentAdded = true;
            }
            if (segment.data) {
                outputParts.push(segment.data);
                mediaSegmentCount++;
            }
        });
        transmuxer.on('error', error => {
            transmuxError = error instanceof Error ? error : new Error(String(error));
        });

        for (let index = 0; index < parts.length; index++) {
            transmuxer.push(new Uint8Array(parts[index]));
            if (transmuxError) throw transmuxError;
            transmuxer.flush();
            if (transmuxError) throw transmuxError;

            const completed = index + 1;
            updateScreenshotUI(`正在将 TS 转封装为 MP4 ${completed}/${parts.length}...`);
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        if (!initSegmentAdded || mediaSegmentCount === 0) {
            throw new Error('TS 转 MP4 未生成有效数据');
        }
        updateScreenshotUI('正在生成标准 MP4 索引...');
        await new Promise(resolve => setTimeout(resolve, 0));
        const fragmentedBuffer = await new Blob(outputParts, { type: 'video/mp4' }).arrayBuffer();
        return convertFragmentedMp4ToProgressive(fragmentedBuffer);
    }

    async function downloadHlsVideo(url, filenameBase) {
        updateScreenshotUI('正在解析 HLS 视频分片...');
        const playlist = await resolveHlsPlaylist(url);

        const parts = new Array(playlist.segments.length);
        let nextIndex = 0;
        let completed = 0;

        const keyPromises = new Map();

        function getCryptoKey(keyUri) {
            if (keyPromises.has(keyUri)) return keyPromises.get(keyUri);
            const promise = (async () => {
                const response = await fetchVideoResource(keyUri);
                if (!response.ok) throw new Error(`无法获取解密密钥 (${response.status})`);
                const encryptedKey = new Uint8Array(await response.arrayBuffer());

                const enModuleInstance = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).enModule;
                if (!enModuleInstance || typeof enModuleInstance.generateKey !== 'function') {
                    throw new Error('页面解密组件尚未就绪');
                }
                const generatedKey = enModuleInstance.generateKey(encryptedKey);
                if (!generatedKey) throw new Error('页面解密组件未返回密钥');
                const keyBytes = generatedKey.buffer
                    ? new Uint8Array(generatedKey.buffer, generatedKey.byteOffset, generatedKey.byteLength)
                    : new Uint8Array(generatedKey);
                if (![16, 24, 32].includes(keyBytes.byteLength)) {
                    throw new Error(`页面解密组件返回了无效密钥长度 (${keyBytes.byteLength})`);
                }

                return await crypto.subtle.importKey(
                    "raw",
                    keyBytes.slice().buffer,
                    { name: "AES-CBC" },
                    false,
                    ["decrypt"]
                );
            })();
            keyPromises.set(keyUri, promise);
            return promise;
        }

        function parseIv(hexString) {
            const rawHex = hexString.startsWith('0x') ? hexString.slice(2) : hexString;
            if (!/^[0-9a-f]+$/i.test(rawHex) || rawHex.length > 32) {
                throw new Error('HLS 清单中的 IV 无效');
            }
            const hex = rawHex.padStart(32, '0');
            const bytes = new Uint8Array(16);
            for (let i = 0; i < bytes.length; i++) {
                bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
            }
            return bytes;
        }

        async function decryptSegment(data, keyInfo, sequenceNumber) {
            if (!keyInfo.keyUri) throw new Error('HLS 清单缺少密钥地址');
            const cryptoKey = await getCryptoKey(keyInfo.keyUri);
            const iv = keyInfo.rawIv ? parseIv(keyInfo.rawIv) : new Uint8Array(16);
            if (!keyInfo.rawIv) {
                new DataView(iv.buffer).setUint32(12, sequenceNumber, false);
            }
            return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
        }

        async function worker() {
            while (nextIndex < playlist.segments.length) {
                const index = nextIndex++;
                const segment = playlist.segments[index];
                const response = await fetchVideoResource(segment.url);
                if (!response.ok) throw new Error(`视频分片 ${index + 1} 下载失败 (${response.status})`);
                let data = await response.arrayBuffer();
                if (segment.keyInfo) {
                    try {
                        data = await decryptSegment(data, segment.keyInfo, segment.sequenceNumber);
                    } catch (err) {
                        const errText = err instanceof Error ? (err.stack || err.message) : String(err);
                        throw new Error(`视频分片 ${index + 1} 解密失败: ${errText}`);
                    }
                }
                parts[index] = data;
                completed++;
                updateScreenshotUI(`正在下载视频分片 ${completed}/${playlist.segments.length}`);
            }
        }

        const workerCount = Math.min(4, playlist.segments.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        let blob;
        if (playlist.container === 'mpegts') {
            updateScreenshotUI('正在将 TS 转封装为 MP4...');
            blob = await transmuxTsToMp4(parts);
        } else {
            blob = new Blob(parts, { type: 'video/mp4' });
        }
        return {
            blob,
            filename: `${filenameBase}.mp4`
        };
    }

    function saveVideoBlob(blob, filename) {
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    }

    async function downloadCurrentVideo() {
        if (videoDownloadRunning) return;
        videoDownloadRunning = true;
        updateVideoDownloadButton();

        try {
            const info = getCurrentVideoDownloadInfo();
            let blob;
            let filename;
            if (info.isHls) {
                ({ blob, filename } = await downloadHlsVideo(info.url, info.filenameBase));
            } else {
                updateScreenshotUI('正在获取当前视频文件...');
                const response = await fetchVideoResource(info.url);
                if (!response.ok) throw new Error(`视频请求失败 (${response.status})`);
                blob = await response.blob();
                filename = `${info.filenameBase}.${info.extension}`;
            }
            if (!blob.size) throw new Error('下载到的视频文件为空');
            saveVideoBlob(blob, filename);
            const sizeMb = (blob.size / 1024 / 1024).toFixed(1);
            updateScreenshotUI(`已下载 ${filename} (${sizeMb} MB)`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            updateScreenshotUI(`视频下载失败：${message}`, true);
            console.error('[FxxkEWT360] 当前视频下载失败', error);
        } finally {
            videoDownloadRunning = false;
            updateVideoDownloadButton();
        }
    }

    function updateScreenshotUI(message, isError = false) {
        const exportButton = document.getElementById('fxxkewt-screenshot-export');
        const previewButton = document.getElementById('fxxkewt-screenshot-preview');
        const clearButton = document.getElementById('fxxkewt-screenshot-clear');
        const status = document.getElementById('fxxkewt-screenshot-status');
        if (exportButton) {
            exportButton.textContent = `打包导出 (${screenshots.length})`;
            exportButton.disabled = screenshots.length === 0 || screenshotExportRunning;
        }
        if (previewButton) {
            previewButton.textContent = `预览截图 (${screenshots.length})`;
            previewButton.disabled = screenshots.length === 0;
        }
        if (clearButton) clearButton.disabled = screenshots.length === 0 || screenshotExportRunning;
        if (status && message !== undefined) {
            if (screenshotStatusTimer !== null) clearTimeout(screenshotStatusTimer);
            status.textContent = message;
            status.classList.toggle('is-error', isError);
            status.style.visibility = 'visible';
            status.setAttribute('aria-hidden', 'false');
            screenshotStatusTimer = setTimeout(() => {
                status.style.visibility = 'hidden';
                status.setAttribute('aria-hidden', 'true');
                screenshotStatusTimer = null;
            }, 5000);
        }
    }

    function canvasToPngBlob(canvas) {
        return new Promise((resolve, reject) => {
            try {
                canvas.toBlob(blob => {
                    if (blob) {
                        resolve(blob);
                    } else {
                        reject(new Error('浏览器未能生成截图'));
                    }
                }, 'image/png');
            } catch (error) {
                reject(error);
            }
        });
    }

    async function captureVideoScreenshot(video = getCapturableVideo()) {
        if (screenshotCaptureRunning) return;
        if (!video) {
            updateScreenshotUI('视频尚未加载，无法截图', true);
            return;
        }

        screenshotCaptureRunning = true;
        try {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('浏览器不支持画面捕获');

            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const blob = await canvasToPngBlob(canvas);
            const index = ++screenshotSequence;
            const videoTime = Number(video.currentTime) || 0;
            const name = `screenshot-${String(index).padStart(3, '0')}-${formatVideoTime(videoTime)}.png`;
            screenshots.push({
                id: index,
                name,
                blob,
                previewUrl: URL.createObjectURL(blob),
                capturedAt: new Date(),
                videoTime
            });
            updateScreenshotUI(`已截取 ${canvas.width}x${canvas.height}，位置 ${formatVideoTime(videoTime).split('-').join(':')}`);
            renderScreenshotPreview();
            console.log('[FxxkEWT360] 视频截图已暂存', { name, videoTime, width: canvas.width, height: canvas.height });
        } catch (error) {
            const isSecurityError = error && error.name === 'SecurityError';
            const message = isSecurityError
                ? '视频源禁止跨域截图'
                : (error instanceof Error ? error.message : String(error));
            updateScreenshotUI(`截图失败：${message}`, true);
            console.error('[FxxkEWT360] 视频截图失败', error);
        } finally {
            screenshotCaptureRunning = false;
        }
    }

    const crc32Table = (() => {
        const table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let value = i;
            for (let bit = 0; bit < 8; bit++) {
                value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
            }
            table[i] = value >>> 0;
        }
        return table;
    })();

    function calculateCrc32(bytes) {
        let crc = 0xffffffff;
        for (const byte of bytes) {
            crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        }
        return (crc ^ 0xffffffff) >>> 0;
    }

    function getDosDateTime(date) {
        const year = Math.max(1980, date.getFullYear());
        return {
            time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
            date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
        };
    }

    function createZipHeader(length) {
        return { bytes: new Uint8Array(length), view: null };
    }

    async function createScreenshotZip(entries) {
        const encoder = new TextEncoder();
        const localParts = [];
        const centralParts = [];
        let localOffset = 0;

        for (const screenshot of entries) {
            const nameBytes = encoder.encode(screenshot.name);
            const data = new Uint8Array(await screenshot.blob.arrayBuffer());
            const crc = calculateCrc32(data);
            const dos = getDosDateTime(screenshot.capturedAt);
            const local = createZipHeader(30 + nameBytes.length);
            local.view = new DataView(local.bytes.buffer);
            local.view.setUint32(0, 0x04034b50, true);
            local.view.setUint16(4, 20, true);
            local.view.setUint16(6, 0x0800, true);
            local.view.setUint16(8, 0, true);
            local.view.setUint16(10, dos.time, true);
            local.view.setUint16(12, dos.date, true);
            local.view.setUint32(14, crc, true);
            local.view.setUint32(18, data.length, true);
            local.view.setUint32(22, data.length, true);
            local.view.setUint16(26, nameBytes.length, true);
            local.view.setUint16(28, 0, true);
            local.bytes.set(nameBytes, 30);
            localParts.push(local.bytes, data);

            const central = createZipHeader(46 + nameBytes.length);
            central.view = new DataView(central.bytes.buffer);
            central.view.setUint32(0, 0x02014b50, true);
            central.view.setUint16(4, 20, true);
            central.view.setUint16(6, 20, true);
            central.view.setUint16(8, 0x0800, true);
            central.view.setUint16(10, 0, true);
            central.view.setUint16(12, dos.time, true);
            central.view.setUint16(14, dos.date, true);
            central.view.setUint32(16, crc, true);
            central.view.setUint32(20, data.length, true);
            central.view.setUint32(24, data.length, true);
            central.view.setUint16(28, nameBytes.length, true);
            central.view.setUint16(30, 0, true);
            central.view.setUint16(32, 0, true);
            central.view.setUint16(34, 0, true);
            central.view.setUint16(36, 0, true);
            central.view.setUint32(38, 0, true);
            central.view.setUint32(42, localOffset, true);
            central.bytes.set(nameBytes, 46);
            centralParts.push(central.bytes);
            localOffset += local.bytes.length + data.length;
        }

        const centralSize = centralParts.reduce((size, part) => size + part.length, 0);
        const end = createZipHeader(22);
        end.view = new DataView(end.bytes.buffer);
        end.view.setUint32(0, 0x06054b50, true);
        end.view.setUint16(4, 0, true);
        end.view.setUint16(6, 0, true);
        end.view.setUint16(8, entries.length, true);
        end.view.setUint16(10, entries.length, true);
        end.view.setUint32(12, centralSize, true);
        end.view.setUint32(16, localOffset, true);
        end.view.setUint16(20, 0, true);
        return new Blob([...localParts, ...centralParts, end.bytes], { type: 'application/zip' });
    }

    async function exportScreenshots() {
        if (screenshots.length === 0 || screenshotExportRunning) return;
        const entries = screenshots.slice();
        screenshotExportRunning = true;
        updateScreenshotUI('正在打包截图...');

        try {
            const zip = await createScreenshotZip(entries);
            const now = new Date();
            const timestamp = [
                now.getFullYear(),
                String(now.getMonth() + 1).padStart(2, '0'),
                String(now.getDate()).padStart(2, '0'),
                '-',
                String(now.getHours()).padStart(2, '0'),
                String(now.getMinutes()).padStart(2, '0'),
                String(now.getSeconds()).padStart(2, '0')
            ].join('');
            const url = URL.createObjectURL(zip);
            const link = document.createElement('a');
            link.href = url;
            link.download = `FxxkEWT360-screenshots-${timestamp}.zip`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            updateScreenshotUI(`已导出 ${entries.length} 张截图`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            updateScreenshotUI(`导出失败：${message}`, true);
            console.error('[FxxkEWT360] 截图打包失败', error);
        } finally {
            screenshotExportRunning = false;
            updateScreenshotUI();
        }
    }

    function downloadScreenshot(screenshot) {
        const url = URL.createObjectURL(screenshot.blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = screenshot.name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        updateScreenshotUI(`已导出 ${screenshot.name}`);
    }

    function deleteScreenshot(id) {
        const index = screenshots.findIndex(screenshot => screenshot.id === id);
        if (index === -1) return;
        const [removed] = screenshots.splice(index, 1);
        URL.revokeObjectURL(removed.previewUrl);
        updateScreenshotUI(`已删除 ${removed.name}`);
        renderScreenshotPreview();
    }

    function renderScreenshotPreview() {
        const grid = document.getElementById('fxxkewt-preview-grid');
        if (!grid) return;
        grid.replaceChildren();

        if (screenshots.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'fxxkewt-preview-empty';
            empty.textContent = '暂无截图';
            grid.appendChild(empty);
            return;
        }

        for (const screenshot of screenshots) {
            const item = document.createElement('article');
            item.className = 'fxxkewt-preview-item';

            const image = document.createElement('img');
            image.src = screenshot.previewUrl;
            image.alt = `视频截图 ${formatVideoTime(screenshot.videoTime).split('-').join(':')}`;

            const name = document.createElement('div');
            name.className = 'fxxkewt-preview-name';
            name.textContent = screenshot.name;
            name.title = screenshot.name;

            const actions = document.createElement('div');
            actions.className = 'fxxkewt-preview-actions';

            const exportButton = document.createElement('button');
            exportButton.type = 'button';
            exportButton.textContent = '单独导出';
            exportButton.dataset.action = 'export';
            exportButton.dataset.id = String(screenshot.id);

            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.textContent = '删除';
            deleteButton.dataset.action = 'delete';
            deleteButton.dataset.id = String(screenshot.id);

            actions.append(exportButton, deleteButton);
            item.append(image, name, actions);
            grid.appendChild(item);
        }
    }

    function setScreenshotPreviewOpen(open) {
        const overlay = document.getElementById('fxxkewt-preview-overlay');
        if (!overlay) return;
        overlay.hidden = !open;
        overlay.setAttribute('aria-hidden', String(!open));
        overlay.style.setProperty('display', open ? 'flex' : 'none', 'important');
    }

    function openScreenshotPreview() {
        const overlay = document.getElementById('fxxkewt-preview-overlay');
        if (!overlay || screenshots.length === 0) return;
        renderScreenshotPreview();
        setScreenshotPreviewOpen(true);
        overlay.querySelector('#fxxkewt-preview-close').focus();
    }

    function closeScreenshotPreview() {
        setScreenshotPreviewOpen(false);
    }

    function clearScreenshots() {
        for (const screenshot of screenshots) {
            URL.revokeObjectURL(screenshot.previewUrl);
        }
        screenshots.length = 0;
        updateScreenshotUI('已清空暂存截图');
        renderScreenshotPreview();
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

    function keepPanelInViewport(panel) {
        const rect = panel.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        if (rect.right > viewportWidth) {
            panel.style.left = 'auto';
            panel.style.right = '20px';
        }
        if (rect.bottom > viewportHeight) {
            panel.style.top = '100px';
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
                .fxxkewt-action-button {
                    width: 100%;
                    padding: 6px;
                    margin: 4px 0;
                    border: 1px solid #888;
                    background: #ddd;
                    color: #000;
                    font-size: 12px;
                    cursor: pointer;
                }
                .fxxkewt-screenshot-actions {
                    display: grid;
                    grid-template-columns: 3fr 1fr;
                    gap: 4px;
                    margin: 4px 0;
                }
                .fxxkewt-screenshot-actions button {
                    margin: 0;
                }
                #fxxkewt-screenshot-status {
                    min-height: 12px;
                    margin: 4px 0;
                    font-size: 10px;
                    color: #444;
                    text-align: center;
                    word-break: break-all;
                }
                #fxxkewt-screenshot-status.is-error {
                    color: #a22;
                    font-weight: bold;
                }
                #fxxkewt-preview-overlay[hidden] {
                    display: none !important;
                }
                #fxxkewt-preview-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100vw;
                    height: 100vh;
                    background: rgba(0, 0, 0, 0.4);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 999999999;
                    box-sizing: border-box;
                }
                #fxxkewt-preview-dialog {
                    display: flex;
                    flex-direction: column;
                    width: min(760px, calc(100vw - 24px));
                    max-height: calc(100vh - 24px);
                    background: #f4f4f4;
                    border: 1px solid #777;
                }
                #fxxkewt-preview-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    flex: 0 0 auto;
                    padding: 9px 12px;
                    background: #ccc;
                    border-bottom: 1px solid #999;
                    font-size: 14px;
                }
                #fxxkewt-preview-close {
                    width: 28px;
                    height: 28px;
                    padding: 0;
                    border: 0;
                    background: transparent;
                    color: #111;
                    font-size: 22px;
                    line-height: 28px;
                    cursor: pointer;
                }
                #fxxkewt-preview-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
                    gap: 10px;
                    min-height: 100px;
                    padding: 10px;
                    overflow: auto;
                }
                .fxxkewt-preview-item {
                    min-width: 0;
                    padding: 6px;
                    background: #fff;
                    border: 1px solid #aaa;
                }
                .fxxkewt-preview-item img {
                    display: block;
                    width: 100%;
                    aspect-ratio: 16 / 9;
                    object-fit: contain;
                    background: #111;
                }
                .fxxkewt-preview-name {
                    margin: 6px 0;
                    overflow: hidden;
                    color: #333;
                    font-size: 11px;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }
                .fxxkewt-preview-actions {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 6px;
                }
                .fxxkewt-preview-actions button {
                    min-height: 30px;
                    border: 1px solid #888;
                    background: #ddd;
                    color: #111;
                    font-size: 12px;
                    cursor: pointer;
                }
                .fxxkewt-preview-actions button[data-action="delete"] {
                    border-color: #a66;
                    color: #8a2222;
                }
                .fxxkewt-preview-empty {
                    align-self: center;
                    justify-self: center;
                    color: #666;
                    font-size: 13px;
                }
                @media (max-width: 480px) {
                    #fxxkewt-preview-grid {
                        grid-template-columns: 1fr;
                    }
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
                        <button type="button" id="fxxkewt-video-download" class="fxxkewt-action-button">下载当前视频</button>
                        <button type="button" id="fxxkewt-screenshot-capture" class="fxxkewt-action-button">截取视频画面 (⌘-S)</button>
                        <button type="button" id="fxxkewt-screenshot-preview" class="fxxkewt-action-button" disabled>预览管理 (0)</button>
                        <div class="fxxkewt-screenshot-actions">
                            <button type="button" id="fxxkewt-screenshot-export" class="fxxkewt-action-button" disabled>打包导出 (0)</button>
                            <button type="button" id="fxxkewt-screenshot-clear" class="fxxkewt-action-button" disabled>清空</button>
                        </div>
                        <div id="fxxkewt-screenshot-status" role="status" aria-live="polite"></div>
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

            const previewOverlay = document.createElement('div');
            previewOverlay.id = 'fxxkewt-preview-overlay';
            previewOverlay.hidden = true;
            previewOverlay.setAttribute('aria-hidden', 'true');
            previewOverlay.style.setProperty('display', 'none', 'important');
            previewOverlay.innerHTML = `
                <div id="fxxkewt-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="fxxkewt-preview-title">
                    <div id="fxxkewt-preview-header">
                        <strong id="fxxkewt-preview-title">截图预览</strong>
                        <button type="button" id="fxxkewt-preview-close" title="关闭" aria-label="关闭">×</button>
                    </div>
                    <div id="fxxkewt-preview-grid"></div>
                </div>
            `;
            document.body.appendChild(previewOverlay);
            keepPanelInViewport(panel);
            window.addEventListener('resize', () => keepPanelInViewport(panel));

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
            panel.querySelector('#fxxkewt-video-download').onclick = downloadCurrentVideo;
            panel.querySelector('#fxxkewt-screenshot-capture').onclick = () => captureVideoScreenshot();
            panel.querySelector('#fxxkewt-screenshot-preview').onclick = openScreenshotPreview;
            panel.querySelector('#fxxkewt-screenshot-export').onclick = exportScreenshots;
            panel.querySelector('#fxxkewt-screenshot-clear').onclick = clearScreenshots;
            previewOverlay.querySelector('#fxxkewt-preview-close').onclick = closeScreenshotPreview;
            previewOverlay.onclick = event => {
                if (event.target === previewOverlay) closeScreenshotPreview();
            };
            previewOverlay.querySelector('#fxxkewt-preview-grid').onclick = event => {
                const button = event.target.closest('button[data-action]');
                if (!button) return;
                const screenshot = screenshots.find(item => item.id === Number(button.dataset.id));
                if (!screenshot) return;
                if (button.dataset.action === 'export') {
                    downloadScreenshot(screenshot);
                } else if (button.dataset.action === 'delete') {
                    deleteScreenshot(screenshot.id);
                }
            };
            updateScreenshotUI();
            renderScreenshotPreview();

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

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            closeScreenshotPreview();
            return;
        }
        if (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 's') {
            if (!document.querySelector('video')) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            captureVideoScreenshot();
        }
    }, true);

    setTimeout(initPanel, 100);
    setInterval(() => {
        checkpass();
        autoPlayNext();
        setSpeed();
    }, 2000);
})();
