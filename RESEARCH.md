# 研究升学e网通

此前已有相关的自动过检脚本, 但是现在已经失效, ewt 做了更新.
https://github.com/ZNink/EWT360-Helper/blob/main/main.user.js
```javascript
checkAndClick() {
        try {
            const checkButton = document.querySelector('span.btn-DOCWn');
            if (checkButton && checkButton.textContent.trim() === '点击通过检查') {
                if (checkButton.dataset.checkClicked) return;
                checkButton.dataset.checkClicked = 'true';
                checkButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                DebugLogger.log('AutoCheckPass', '已自动通过检查');
                setTimeout(() => delete checkButton.dataset.checkClicked, 3000);
            }
        } catch (error) {
            DebugLogger.error('AutoCheckPass', '过检出错', error);
        }
    }
}
```

然而在 ewt 更新后这个脚本就无法使用了, 原因是ewt 会调用`event.isTrusted`来看点击事件是由用户发起的还是由程序发起的.
```javascript
if (!e.isTrusted) {
    if (!ed) {
        var t, s, o;
        ed = !0,
        U.ZP.warn({
            type: "UNTRUSTED_EVENT",
            desc: "【学生看课使用插件】认真度检测-模拟点击通过",
            message: "检测到对认真度检测的模拟点击，event.isTrusted=false",
            lessonId: (null == (t = this.props) ? void 0 : t.lessonId) || "",
            homeworkId: (null == (s = this.props) ? void 0 : s.homeworkId) || "",
            url: null == (o = window.location) ? void 0 : o.href
        }, U.vY.student_watch_class_anticheat)
    }
    e.preventDefault(),
    e.stopPropagation(),
    e.stopImmediatePropagation();
    return
}
this.toCheck()
```
(吐槽一句看这个desc和message感觉像ai写的 这么看这个ai有点**小可爱**)



这个`event.isTrusted`来自于浏览器(<https://developer.mozilla.org/en-US/docs/Web/API/Event/isTrusted>)
因此`event.isTrusted`无法通过`Object.defineProperty`来覆写,实践:
```html
<script>
  const ev = new Event('click');
  try {
    Object.defineProperty(ev, 'isTrusted', { value: true });
  } catch(e) {
    document.write('defineProperty error: ' + e.message);
  }
  document.addEventListener('click', e => document.write(' isTrusted: ' + e.isTrusted));
  document.dispatchEvent(ev);
</script>
```
运行结果为
```text
defineProperty error: Cannot redefine property: isTrusted isTrusted: false
```

这样开起来确实有点棘手,因为浏览器的东西仅是通过 userscript 难以解决(不过也确实有解决办法 详见<https://learn.scriptcat.org/油猴教程/番外篇/实战秒杀isTrust验证/> 这是利用 Proxy 实现的)

继续观察, 发现 API `https://gateway.ewt360.com/api/homeworkprod/homework/student/reportVideoPoint` 的 payload是
```json
{"schoolId":xxx,"homeworkId":xxx,"lessonId":xxx,"type":2,"interactivePointId":null,"platform":1,"seriousCheckResult":2}
```
并且在请求头中也没发现签名.

然而发送这个请求需要去点击按钮, 利用`click()`点击按钮无法通过`e.isTrusted`  那么可以强行隐藏这些元素去手动发起请求
又或者 劫持**第二个**`seriousCheckResult`为`0`的请求 将其修改为`2` 然而 也需要去隐藏"没认真听课"的弹窗

这不优雅.

所以我们可以想到另外的思路
既然if语句中是靠`!e.isTrusted`来实现的 我们可以劫持这个js 把`!e.isTrusted`统统替换为`false` 这样子ewt前端会始终认为点击事件是trusted的
但是这也不优雅  
```javascript
// @run-at       document-start

(function() {
    'use strict';

    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.tagName === 'SCRIPT' && node.src && (node.src.includes('homework-play-video') || node.src.includes('2871'))) {
                    node.remove(); 
                    console.log('成功拦截原脚本标签:' + node.src);
                    
                    fetch(node.src)
                        .then(response => response.text())
                        .then(code => {
                            const modifiedCode = code.replace(/!e\.isTrusted/g, 'false');
                            console.log('替换 !e.isTrusted 完成');
                            const newScript = document.createElement('script');
                            newScript.textContent = modifiedCode;
                            document.head.appendChild(newScript);
                        })
                        .catch(err => console.error("失败", err));
                }
            }
        }
    });
    
    observer.observe(document.documentElement, { childList: true, subtree: true });
})();
```

不过这个会多请求一遍 直接替换也并不优雅


终于想到了一个elegant的方案!
遍历react fiber 树用`toClick()`点击 这绕过了`isTrusted`
详见代码




### 倍速
前端代码里有这么一段
```javascript
_defineProperty$1(this, "checkRate", ( () => {
    const e = this._player;
    if (!e)
        return !1;
    try {
        var t;
        const r = null === (t = e.tech(!0)) || void 0 === t ? void 0 : t.el();
        if (r && (delete r.playbackRate,
        delete r.playbackRate,
        delete r.playbackRate,
        r.playbackRate && r.playbackRate > 2))
            return this.triggerError(makeError(ErrorEnum.PLAY_RATE, {
                baseRate: r.playbackRate,
                showRate: e.playbackRate(),
                message: "请勿使用播放倍率修改插件！"
            })),
            r.playbackRate = 1,
            !0
    } catch (e2) {}
    return !1
}
```





