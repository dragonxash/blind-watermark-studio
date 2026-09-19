/*!
 * 浏览器自检脚本（仅用于自动化验证，不进入正式交付页面）
 * 在真实 Chrome 中走一遍：载入图片 -> 合成 -> 分离 -> 检测
 */
(function () {
  'use strict';

  var errors = [];
  window.addEventListener('error', function (e) { errors.push('JS错误: ' + e.message); });
  window.addEventListener('unhandledrejection', function (e) {
    errors.push('未捕获 Promise: ' + (e.reason && e.reason.message || e.reason));
  });

  var PASS = [], FAIL = [];
  function ok(name, cond, extra) {
    (cond ? PASS : FAIL).push(name + (extra ? '  [' + extra + ']' : ''));
  }
  function waitFor(fn, ms, label) {
    var t0 = Date.now();
    return new Promise(function (res, rej) {
      (function loop() {
        var v = false;
        try { v = fn(); } catch (e) { v = false; }
        if (v) return res(v);
        if (Date.now() - t0 > ms) return rej(new Error('等待超时: ' + label));
        setTimeout(loop, 50);
      })();
    });
  }

  function makePhoto(w, h) {
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var g = cv.getContext('2d');
    var grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#2b5f9e');
    grad.addColorStop(0.5, '#8fb8dc');
    grad.addColorStop(1, '#3f5a3a');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#e8d6a8';
    g.beginPath(); g.arc(w * 0.7, h * 0.28, h * 0.09, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#42523f';
    g.beginPath();
    g.moveTo(0, h);
    for (var x = 0; x <= w; x += 4) g.lineTo(x, h * 0.68 + h * 0.06 * Math.sin(x / 40));
    g.lineTo(w, h); g.closePath(); g.fill();
    var id = g.getImageData(0, 0, w, h), d = id.data;
    for (var i = 0; i < d.length; i += 4) {
      var n = (Math.random() - 0.5) * 16;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    g.putImageData(id, 0, 0);
    return cv;
  }
  function makeMark(w, h) {
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var g = cv.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff';
    g.font = 'bold ' + Math.round(h * 0.66) + 'px Arial';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('TEST', w / 2, h / 2);
    return cv;
  }
  function canvasToFile(cv, name) {
    return new Promise(function (res) {
      cv.toBlob(function (b) { res(new File([b], name, { type: 'image/png' })); }, 'image/png');
    });
  }
  function dataURLToFile(url, name) {
    return fetch(url).then(function (r) { return r.blob(); })
      .then(function (b) { return new File([b], name, { type: 'image/png' }); });
  }
  function dropInto(slotName, file) {
    var el = document.querySelector('[data-slot="' + slotName + '"]');
    var dt = new DataTransfer();
    dt.items.add(file);
    el.dispatchEvent(new DragEvent('drop', {
      dataTransfer: dt, bubbles: true, cancelable: true
    }));
  }
  function filled(slotName) {
    return document.querySelector('[data-slot="' + slotName + '"]').classList.contains('filled');
  }

  async function run() {
    var tAll = Date.now();
    try {
      ok('BWM 核心库已加载', typeof window.BWM === 'object' && typeof BWM.encode === 'function');
      ok('三个面板均在 DOM 中', document.querySelectorAll('.panel').length === 3);
      ok('槽位数量正确', document.querySelectorAll('.slot').length === 7);

      /* ---------- 素材：原图只生成一次，三个面板复用同一张 ---------- */
      var photoCv = makePhoto(256, 256);
      var markCv = makeMark(72, 36);

      /* ---------- 合成 ---------- */
      var t0 = Date.now();
      dropInto('enc-img', await canvasToFile(photoCv, 'photo.png'));
      dropInto('enc-wm', await canvasToFile(markCv, 'mark.png'));
      await waitFor(function () { return filled('enc-img') && filled('enc-wm'); }, 8000, '槽位填充');
      ok('拖拽上传生效', true);

      var btn = document.getElementById('btn-run-encode');
      ok('合成按钮已启用', !btn.disabled);
      btn.click();
      await waitFor(function () {
        return document.getElementById('res-encode').classList.contains('on')
          && document.getElementById('img-encode-out').src.indexOf('data:image') === 0;
      }, 40000, '合成完成');
      var encStats = document.getElementById('stat-encode').textContent.replace(/\s+/g, ' ').trim();
      ok('合成完成并出图', true, (Date.now() - t0) + 'ms');
      ok('合成指标已渲染', /PSNR/.test(encStats), encStats.slice(0, 80));

      var encUrl = document.getElementById('img-encode-out').src;

      /* ---------- 填充分离 / 检测 的槽位 ---------- */
      dropInto('dec-img', await canvasToFile(photoCv, 'orig.png'));
      dropInto('dec-wm', await dataURLToFile(encUrl, 'encoded.png'));
      dropInto('det-target', await dataURLToFile(encUrl, 'encoded.png'));
      dropInto('det-origin', await canvasToFile(photoCv, 'orig.png'));
      await waitFor(function () {
        return filled('dec-img') && filled('dec-wm')
          && filled('det-target') && filled('det-origin');
      }, 10000, '分离/检测槽位填充');

      var btn2 = document.getElementById('btn-run-decode');
      var btn3 = document.getElementById('btn-run-detect');
      ok('分离按钮已启用', !btn2.disabled);
      ok('检测按钮已启用', !btn3.disabled);

      /* ---------- 检测 ---------- */
      btn3.click();
      await waitFor(function () {
        return document.getElementById('res-detect').classList.contains('on');
      }, 40000, '检测完成');
      var verdict = document.getElementById('det-verdict').textContent.replace(/\s+/g, ' ').trim();
      var detStats = document.getElementById('stat-detect').textContent.replace(/\s+/g, ' ').trim();
      ok('检测已产出结论', verdict.length > 0, verdict.slice(0, 60));
      ok('检测指标已渲染', /能量比/.test(detStats), detStats.slice(0, 70));
      var ratio = parseFloat((detStats.match(/能量比\s*>?\s*([\d.]+)/) || [])[1]);
      ok('检测判据有效（> 3 判为有水印）', isFinite(ratio) && ratio >= 3, 'ratio=' + ratio);

      /* ---------- 分离（依赖原图，放到最后跑） ---------- */
      t0 = Date.now();
      btn2.click();
      await waitFor(function () {
        return document.getElementById('res-decode').classList.contains('on')
          && document.getElementById('img-decode-out').src.indexOf('data:image') === 0;
      }, 40000, '分离完成');
      ok('分离完成并出图', true, (Date.now() - t0) + 'ms');

      // 增强显示切换
      var enh = document.getElementById('btn-enh-decode');
      ok('增强显示按钮已渲染', !!enh && enh.textContent === '增强显示');
      enh.click();
      ok('切换到增强视图', enh.textContent === '查看原始');
      enh.click();
      ok('切回原始视图', enh.textContent === '增强显示');

      /* ---------- 参数联动 ---------- */
      var a = document.getElementById('opt-alpha');
      a.value = '6';
      a.dispatchEvent(new Event('input'));
      ok('alpha 滑块联动显示', document.getElementById('opt-alpha-val').textContent === '6.0');
      var sel = document.getElementById('opt-transform');
      sel.value = 'channel';
      sel.dispatchEvent(new Event('change'));
      ok('模式说明随选择更新', /高质量/.test(document.getElementById('mode-note').textContent));
      sel.value = 'numpy';
      sel.dispatchEvent(new Event('change'));

      /* ---------- Tab 切换 ---------- */
      document.querySelector('.tab[data-tab="decode"]').click();
      ok('Tab 切换生效', document.getElementById('panel-decode').classList.contains('active'));
      document.querySelector('.tab[data-tab="encode"]').click();

      /* ---------- 边界：水印过大 ---------- */
      dropInto('enc-wm', await canvasToFile(makeMark(300, 200), 'huge.png'));
      await waitFor(function () {
        var el = document.querySelector('[data-slot="enc-wm"]');
        return el.classList.contains('filled') && /300\s*×\s*200/.test(el.textContent);
      }, 8000, '大图水印载入');
      document.getElementById('btn-run-encode').click();
      await waitFor(function () {
        var t = document.getElementById('toast');
        return t.classList.contains('on') && /尺寸过大/.test(t.textContent);
      }, 10000, '超限提示');
      ok('水印超限有友好报错', true,
        document.getElementById('toast').textContent.replace(/\s+/g, ' ').slice(0, 64));

      /* ---------- 诊断：PNG 往返与检测判据 ---------- */
      async function urlToID(url, w, h) {
        var im = await new Promise(function (res, rej) {
          var i = new Image();
          i.onload = function () { res(i); };
          i.onerror = rej;
          i.src = url;
        });
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        var g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(im, 0, 0);
        return g.getImageData(0, 0, w, h);
      }
      var oidSrc = photoCv.getContext('2d', { willReadFrequently: true })
        .getImageData(0, 0, 256, 256);
      var oidRT = await urlToID(photoCv.toDataURL('image/png'), 256, 256);
      var rtDiff = 0, rtMax = 0;
      for (var z1 = 0; z1 < oidSrc.data.length; z1++) {
        var dz1 = Math.abs(oidSrc.data[z1] - oidRT.data[z1]);
        if (dz1) rtDiff++;
        if (dz1 > rtMax) rtMax = dz1;
      }
      ok('PNG canvas 往返无损', rtDiff === 0, '差异通道=' + rtDiff + ' 最大=' + rtMax);

      var tid = await urlToID(encUrl, 256, 256);
      var pxDiff = 0, pxMax = 0, sumAbs = 0;
      for (var z2 = 0; z2 < tid.data.length; z2++) {
        var dz2 = Math.abs(tid.data[z2] - oidSrc.data[z2]);
        if (dz2) pxDiff++;
        if (dz2 > pxMax) pxMax = dz2;
        sumAbs += dz2;
      }
      ok('合成图与原图确有差异', pxDiff > 0,
        '差异通道=' + pxDiff + '/' + tid.data.length + ' 最大=' + pxMax + ' 平均=' + (sumAbs / tid.data.length).toFixed(3));

      var oPl = BWM.rgbaToPlanes(oidSrc.data, 256, 256, { r: 255, g: 255, b: 255 });
      var tPl = BWM.rgbaToPlanes(tid.data, 256, 256, { r: 255, g: 255, b: 255 });
      var detX = await BWM.detectPair(oPl, tPl, { seed: 20160930, alpha: 3, transform: 'numpy' });
      ok('直接复算 detectPair', true,
        'eRe=' + detX.eRe.toExponential(3) + ' eIm=' + detX.eIm.toExponential(3)
        + ' ratio=' + detX.ratio.toExponential(3));

      /* ---------- 诊断：逐项独立容错 ---------- */
      async function diag(name, fn) {
        try {
          var msg = await fn();
          ok(name, true, msg);
        } catch (ex) {
          FAIL.push(name + '  [异常: ' + (ex && ex.message) + ']');
        }
      }

      await diag('D1 纯数据 detectPair（无关图，ratio 应≈1）', async function () {
        function lcg(s) { return function () { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }
        function randPlanes(r) {
          var out = [];
          for (var c = 0; c < 3; c++) {
            var p = new Float64Array(256 * 256);
            for (var i = 0; i < 256 * 256; i++) p[i] = Math.floor(r() * 256);
            out.push(p);
          }
          return { w: 256, h: 256, planes: out };
        }
        var r1 = lcg(11), r2 = lcg(22);
        var d = await BWM.detectPair(randPlanes(r1), randPlanes(r2),
          { seed: 20160930, alpha: 3, transform: 'numpy' });
        return 'eRe=' + d.eRe.toExponential(3) + ' eIm=' + d.eIm.toExponential(3)
          + ' ratio=' + d.ratio.toFixed(4);
      });

      await diag('D2 单像素 +1 扰动（ratio 应≈1）', async function () {
        var one = new Float64Array(oPl.planes[0].length);
        one.set(oPl.planes[0]);
        one[100] += 1;
        var d = await BWM.detectPair(oPl,
          { w: 256, h: 256, planes: [one, oPl.planes[1], oPl.planes[2]] },
          { seed: 20160930, alpha: 3, transform: 'numpy' });
        return 'eRe=' + d.eRe.toExponential(3) + ' eIm=' + d.eIm.toExponential(3)
          + ' ratio=' + d.ratio.toFixed(4);
      });

      await diag('D3 空间域差异 D 的统计', async function () {
        var N = 256 * 256, nz = 0, symMax = 0, diffCount = 0;
        for (var i = 0; i < N; i++) {
          for (var c = 0; c < 3; c++) {
            var dv = tPl.planes[c][i] - oPl.planes[c][i];
            if (dv !== 0) nz++;
            var rv = tPl.planes[c][N - 1 - i] - oPl.planes[c][N - 1 - i];
            if (Math.abs(dv - rv) > symMax) symMax = Math.abs(dv - rv);
            if (dv !== 0 && dv !== rv) diffCount++;
          }
        }
        return '非零通道=' + nz + ' 与翻转位置不等=' + diffCount + ' 最大不匹配=' + symMax;
      });

      await diag('D4 频域差绝对值上界', async function () {
        var N = 256 * 256;
        var x1 = BWM.planesToComplex(oPl.planes, 256, 256);
        var x2 = BWM.planesToComplex(tPl.planes, 256, 256);
        await BWM.transformImage(x1, 256, 256, false, 'numpy');
        await BWM.transformImage(x2, 256, 256, false, 'numpy');
        var mxRe = 0, mxIm = 0, cntIm = 0;
        for (var c = 0; c < 3; c++) {
          for (var k = 0; k < N; k++) {
            var rr = Math.abs(x2.re[c][k] - x1.re[c][k]);
            var ii = Math.abs(x2.im[c][k] - x1.im[c][k]);
            if (rr > mxRe) mxRe = rr;
            if (ii > mxIm) mxIm = ii;
            if (ii > 1e-6) cntIm++;
          }
        }
        return 'maxRe=' + mxRe.toExponential(3) + ' maxIm=' + mxIm.toExponential(3)
          + ' 虚部非零个数=' + cntIm;
      });

      /* ---------- 高质量模式（每通道空间 FFT）也能出图 ---------- */
      document.querySelector('.tab[data-tab="encode"]').click();
      dropInto('enc-wm', await canvasToFile(markCv, 'mark.png'));
      await waitFor(function () {
        var el = document.querySelector('[data-slot="enc-wm"]');
        return /72\s*×\s*36/.test(el.textContent);
      }, 8000, '恢复水印图');
      var sel2 = document.getElementById('opt-transform');
      sel2.value = 'channel';
      sel2.dispatchEvent(new Event('change'));
      document.getElementById('res-encode').classList.remove('on');
      document.getElementById('btn-run-encode').click();
      await waitFor(function () {
        return document.getElementById('res-encode').classList.contains('on');
      }, 40000, 'channel 模式合成');
      var chStats = document.getElementById('stat-encode').textContent.replace(/\s+/g, ' ');
      var chPsnr = parseFloat((chStats.match(/PSNR([\d.]+)/) || [])[1]);
      ok('高质量模式可合成且画质更好', isFinite(chPsnr) && chPsnr > 50, 'PSNR=' + chPsnr);
      sel2.value = 'numpy';
      sel2.dispatchEvent(new Event('change'));

      await diag('D5 解码水印的内容分布（水印 72×36 应只落在左上角）', async function () {
        var d5 = await BWM.decode(oPl, tPl,
          { seed: 20160930, alpha: 3, transform: 'numpy', quantize: 'round' });
        function regionMean(x0, x1, y0, y1) {
          var s = 0, n = 0;
          for (var c = 0; c < 3; c++) {
            for (var y = y0; y < y1; y++) {
              for (var x = x0; x < x1; x++) { s += d5.wm.planes[c][y * 256 + x]; n++; }
            }
          }
          return n ? s / n : 0;
        }
        // 导出解码结果供目视核验
        var pcv = document.createElement('canvas');
        pcv.width = 256; pcv.height = 256;
        pcv.getContext('2d').putImageData(
          new ImageData(BWM.planesToRgba(d5.wm), 256, 256), 0, 0);
        var holder = document.createElement('div');
        holder.id = 'decoded-png';
        holder.style.display = 'none';
        holder.textContent = '<<<PNG>>>' + pcv.toDataURL('image/png') + '<<<PNGEND>>>';
        document.body.appendChild(holder);

        return '水印区(0-72,0-36)均值=' + regionMean(0, 72, 0, 36).toFixed(1)
          + ' 右侧(72-144,0-36)=' + regionMean(72, 144, 0, 36).toFixed(1)
          + ' 左下(0-72,128-164)=' + regionMean(0, 72, 128, 164).toFixed(1)
          + ' 右下(184-256,220-256)=' + regionMean(184, 256, 220, 256).toFixed(1);
      });

    } catch (e) {
      FAIL.push('执行异常: ' + (e && e.message));
    }

    /* ---------- 按 hash 停在指定面板，便于逐屏截图 ---------- */
    var want = (location.hash || '').replace(/^#/, '');
    if (['encode', 'decode', 'detect'].indexOf(want) >= 0) {
      var tb = document.querySelector('.tab[data-tab="' + want + '"]');
      if (tb) tb.click();
      window.scrollTo(0, 0);
    }

    var div = document.createElement('div');
    div.id = 'selftest-result';
    div.textContent = '<<<SELFTEST_START>>>'
      + ' PASS=' + PASS.length + ' FAIL=' + FAIL.length
      + ' 错误=' + errors.length
      + '\n通过: ' + PASS.join('\n      ')
      + '\n失败: ' + (FAIL.length ? FAIL.join('\n      ') : '（无）')
      + '\n运行时错误: ' + (errors.length ? errors.join('\n      ') : '（无）')
      + ' 总耗时=' + (Date.now() - tAll) + 'ms'
      + '<<<SELFTEST_END>>>';
    document.body.appendChild(div);
  }

  window.addEventListener('load', function () { setTimeout(run, 200); });
})();
