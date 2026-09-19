/*!
 * 盲水印工坊 — 界面逻辑
 */
(function () {
  'use strict';

  var BWM = window.BWM;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ==================== 通用 UI ==================== */
  var toastEl = $('#toast'), toastTimer = null;
  function toast(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('err', !!isErr);
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 3200);
  }

  function setBusy(btn, busy, label) {
    if (busy) {
      if (!btn.dataset.orig) btn.dataset.orig = btn.textContent;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>' + (label || '处理中…');
    } else {
      btn.disabled = false;
      if (btn.dataset.orig) btn.textContent = btn.dataset.orig;
    }
  }

  function makeProgress(id) {
    var el = $(id);
    var fill = el.querySelector('.fill'), txt = el.querySelector('.txt');
    var t0 = 0;
    el.classList.add('on');
    fill.style.width = '0%';
    t0 = Date.now();
    txt.textContent = '处理中…';
    return {
      tick: function (p) {
        p = Math.max(0, Math.min(1, p || 0));
        fill.style.width = (p * 100).toFixed(1) + '%';
        txt.textContent = '处理中 ' + Math.round(p * 100) + '%　已用 '
          + ((Date.now() - t0) / 1000).toFixed(1) + ' s';
        return new Promise(function (r) { setTimeout(r, 0); });
      },
      done: function (msg) {
        fill.style.width = '100%';
        txt.textContent = (msg || '完成') + '　用时 ' + ((Date.now() - t0) / 1000).toFixed(2) + ' s';
        setTimeout(function () { el.classList.remove('on'); }, 1400);
      },
      fail: function () { el.classList.remove('on'); }
    };
  }

  function isPow2(n) { return n > 0 && (n & (n - 1)) === 0; }
  function sizeNote(w, h) {
    var px = w * h;
    if (px > 9e6) return '超大图，可能需 10 秒以上';
    if (px > 2.5e6) return '较大，约需数秒';
    if (!isPow2(w) || !isPow2(h)) return '尺寸非 2 的幂，FFT 会偏慢';
    return '';
  }

  /* ==================== 图片槽位 ==================== */
  var slots = {};

  /** 哪些槽位装的是「会参与 FFT 的载体图」——只有它们才需要尺寸提示 */
  var FFT_SLOTS = ['enc-img', 'dec-img', 'dec-wm', 'det-target', 'det-origin'];

  function initSlot(name) {
    var el = document.querySelector('[data-slot="' + name + '"]');
    var s = { name: name, el: el, data: null, ph: el.innerHTML, fft: FFT_SLOTS.indexOf(name) >= 0 };
    slots[name] = s;

    el.addEventListener('click', function (ev) {
      if (ev.target.closest('.clear')) return;
      pickFile(s);
    });
    el.addEventListener('dragover', function (e) { e.preventDefault(); el.classList.add('drag'); });
    el.addEventListener('dragleave', function () { el.classList.remove('drag'); });
    el.addEventListener('drop', function (e) {
      e.preventDefault();
      el.classList.remove('drag');
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(s, f);
    });
    return s;
  }

  function pickFile(s) {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = function () { if (inp.files[0]) loadFile(s, inp.files[0]); };
    inp.click();
  }

  function loadFile(s, file) {
    if (!/^image\//.test(file.type)) { toast('请选择图片文件', true); return; }
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      setSlotSource(s, img, file.name);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      toast('图片解码失败', true);
    };
    img.src = url;
  }

  /** source 可以是 HTMLImageElement / HTMLCanvasElement / ImageBitmap */
  function setSlotSource(s, source, name) {
    var w = source.width, h = source.height;
    if (!w || !h) { toast('图片尺寸无效', true); return; }
    if (w * h > 4e7) { toast('图片过大（超过 4000 万像素），请先缩小', true); return; }
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0);
    s.data = {
      w: w, h: h, name: name || '',
      imageData: ctx.getImageData(0, 0, w, h),
      canvas: cv
    };
    renderSlot(s);
    updateButtons();
  }

  function renderSlot(s) {
    var el = s.el, d = s.data;
    if (!d) { el.classList.remove('filled'); el.innerHTML = s.ph; return; }
    el.classList.add('filled');

    var sc = Math.min(1, 340 / Math.max(d.w, d.h));
    var t = document.createElement('canvas');
    t.width = Math.max(1, Math.round(d.w * sc));
    t.height = Math.max(1, Math.round(d.h * sc));
    t.getContext('2d').drawImage(d.canvas, 0, 0, t.width, t.height);

    var note = s.fft ? sizeNote(d.w, d.h) : '';
    el.innerHTML =
      '<img class="thumb" alt="">' +
      '<span class="tag">' + (s.el.dataset.label || '') + '</span>' +
      '<button class="clear" title="移除">×</button>' +
      '<div class="meta"><span>' + d.w + ' × ' + d.h + ' px</span>' +
      (note ? '<span class="warn">' + note + '</span>' : '<span></span>') +
      '</div>';
    el.querySelector('.thumb').src = t.toDataURL('image/png');
    el.querySelector('.clear').addEventListener('click', function (ev) {
      ev.stopPropagation();
      s.data = null;
      renderSlot(s);
      updateButtons();
    });
  }

  function slotImageData(s) {
    // 返回绘制到 canvas 的原始尺寸 ImageData，供切片使用
    return s.data;
  }

  function toPlanes(s, backdrop) {
    var bd = backdrop === 'white' ? { r: 255, g: 255, b: 255 }
      : backdrop === 'black' ? { r: 0, g: 0, b: 0 } : null;
    return BWM.rgbaToPlanes(s.imageData.data, s.w, s.h, bd);
  }

  /* ==================== 输出 ==================== */
  function planesToCanvas(planes, w, h) {
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var rgba = BWM.planesToRgba({ w: w, h: h, planes: planes });
    cv.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
    return cv;
  }

  /** 按最长边缩放出一个用于显示的 canvas */
  function renderScale(canvas, maxSide) {
    var sc = Math.min(1, (maxSide || 900) / Math.max(canvas.width, canvas.height));
    if (sc >= 1) return canvas;
    var out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(canvas.width * sc));
    out.height = Math.max(1, Math.round(canvas.height * sc));
    var c = out.getContext('2d');
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(canvas, 0, 0, out.width, out.height);
    return out;
  }

  function showResult(imgEl, canvas, maxSide) {
    imgEl.src = renderScale(canvas, maxSide).toDataURL('image/png');
  }

  /**
   * 对比度增强：以中位数当噪声底、99.5 分位当白点做线性拉伸。
   * 分离出的水印往往压在一层灰噪声上，拉伸后水印轮廓明显得多。
   */
  function enhanceCanvas(src) {
    var w = src.width, h = src.height, n = w * h;
    var ctx = src.getContext('2d', { willReadFrequently: true });
    var d = ctx.getImageData(0, 0, w, h).data;
    var hist = new Uint32Array(256), i, v;
    for (i = 0; i < n; i++) {
      v = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3 | 0;
      hist[v]++;
    }
    var cum = 0, lo = 0, hi = 255;
    for (i = 0; i < 256; i++) { cum += hist[i]; if (cum >= n * 0.5) { lo = i; break; } }
    cum = 0;
    for (i = 0; i < 256; i++) { cum += hist[i]; if (cum >= n * 0.995) { hi = i; break; } }
    if (hi <= lo) hi = lo + 1;

    var out = document.createElement('canvas');
    out.width = w; out.height = h;
    var octx = out.getContext('2d');
    var oid = octx.createImageData(w, h);
    var scale = 255 / (hi - lo);
    for (i = 0; i < n; i++) {
      for (var c = 0; c < 3; c++) {
        v = (d[i * 4 + c] - lo) * scale;
        oid.data[i * 4 + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
      oid.data[i * 4 + 3] = 255;
    }
    octx.putImageData(oid, 0, 0);
    return out;
  }

  function downloadCanvas(canvas, filename) {
    canvas.toBlob(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 1500);
    }, 'image/png');
  }

  function diffStats(a, b, n) {
    var sum2 = 0, mx = 0, c, i, d;
    for (c = 0; c < 3; c++) {
      var A = a[c], B = b[c];
      for (i = 0; i < n; i++) {
        d = A[i] - B[i];
        sum2 += d * d;
        if (d < 0) d = -d;
        if (d > mx) mx = d;
      }
    }
    var mse = sum2 / (n * 3);
    return { max: mx, mse: mse, psnr: mse > 0 ? 10 * Math.log10(65025 / mse) : Infinity };
  }

  function statHTML(items) {
    return items.map(function (it) {
      var cls = it.tone ? ' ' + it.tone : '';
      return '<dl class="stat' + cls + '"><dt>' + it.k + '</dt><dd>'
        + it.v + (it.u ? '<small>' + it.u + '</small>' : '') + '</dd></dl>';
    }).join('');
  }

  /** 判据比值可能极端大（虚部被压到数值零），这里做可读化处理 */
  function fmtRatio(r) {
    if (!isFinite(r)) return '∞';
    if (r >= 1000) return '> 1000';
    return r.toFixed(2);
  }

  /* ==================== 参数 ==================== */
  var alphaEl = $('#opt-alpha'), alphaVal = $('#opt-alpha-val');
  alphaEl.addEventListener('input', function () {
    alphaVal.textContent = Number(alphaEl.value).toFixed(1);
  });
  $('#opt-seed').addEventListener('change', function () {
    var v = parseInt(this.value, 10);
    if (!isFinite(v) || v < 0) this.value = 20160930;
  });

  var MODE_NOTES = {
    numpy: '<b>兼容原作</b>：复刻 <code>np.fft.fft2</code> 对 <code>(H,W,3)</code> 的默认变换轴（宽度轴 + 通道轴），'
      + '结果可与 Python 版 <code>bwmforpy3.py</code> 互相解出。检测判据灵敏，但图像改动相对大一些。',
    channel: '<b>高质量</b>：每个颜色通道独立做空间二维 FFT，图像改动极小（PSNR 通常 55 dB 以上），肉眼完全无感。'
      + '<b>代价是</b>：只有本工具能解出，Python 原作脚本解不出来。'
  };
  function refreshModeNote() {
    $('#mode-note').innerHTML = MODE_NOTES[$('#opt-transform').value] || '';
  }
  $('#opt-transform').addEventListener('change', refreshModeNote);
  refreshModeNote();

  function getOpts() {
    var seed = parseInt($('#opt-seed').value, 10);
    if (!isFinite(seed) || seed < 0) seed = 20160930;
    return {
      seed: seed,
      alpha: parseFloat(alphaEl.value) || 3,
      transform: $('#opt-transform').value,
      backdrop: $('#opt-backdrop').value,
      oldSeed: false
    };
  }

  /* ==================== Tab ==================== */
  var activeTab = 'encode';
  $$('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      activeTab = t.dataset.tab;
      $$('.tab').forEach(function (x) { x.classList.toggle('active', x === t); });
      $$('.panel').forEach(function (p) {
        p.classList.toggle('active', p.id === 'panel-' + activeTab);
      });
    });
  });

  /* ==================== 粘贴 ==================== */
  document.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') === 0) {
        var f = items[i].getAsFile();
        var order = {
          encode: ['enc-img', 'enc-wm'],
          decode: ['dec-img', 'dec-wm'],
          detect: ['det-target', 'det-origin', 'det-cand']
        }[activeTab] || [];
        for (var k = 0; k < order.length; k++) {
          if (!slots[order[k]].data) { loadFile(slots[order[k]], f); e.preventDefault(); return; }
        }
        toast('当前面板的槽位已填满');
        return;
      }
    }
  });

  /* ==================== 按钮状态 ==================== */
  function updateButtons() {
    $('#btn-run-encode').disabled = !(slots['enc-img'].data && slots['enc-wm'].data);
    $('#btn-run-decode').disabled = !(slots['dec-img'].data && slots['dec-wm'].data);
    $('#btn-run-detect').disabled = !slots['det-target'].data;
  }

  /* ==================== 示例图 ==================== */
  function samplePhoto(w, h) {
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var g = cv.getContext('2d');
    var sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#2f6fb5');
    sky.addColorStop(0.45, '#7fb0dd');
    sky.addColorStop(0.62, '#e8c9a0');
    sky.addColorStop(1, '#4d5a44');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);

    g.fillStyle = 'rgba(255,242,210,.92)';
    g.beginPath(); g.arc(w * 0.76, h * 0.26, h * 0.075, 0, Math.PI * 2); g.fill();

    function ridge(base, amp, color) {
      g.fillStyle = color;
      g.beginPath();
      g.moveTo(0, h);
      for (var x = 0; x <= w; x += 4) {
        var y = base + amp * Math.sin(x / 96) + amp * 0.5 * Math.sin(x / 33 + 1.7)
          + amp * 0.25 * Math.sin(x / 17 + 0.6);
        g.lineTo(x, y);
      }
      g.lineTo(w, h); g.closePath(); g.fill();
    }
    ridge(h * 0.60, h * 0.055, '#4a5f52');
    ridge(h * 0.70, h * 0.04, '#3b4c40');
    ridge(h * 0.82, h * 0.03, '#2c3a31');

    // 细颗粒，模拟真实照片的高频细节
    var id = g.getImageData(0, 0, w, h), d = id.data;
    for (var i = 0; i < d.length; i += 4) {
      var n = (Math.random() - 0.5) * 14;
      d[i] = Math.max(0, Math.min(255, d[i] + n));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
    }
    g.putImageData(id, 0, 0);
    return cv;
  }

  function sampleWatermark(w, h) {
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var g = cv.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = 'bold ' + Math.round(h * 0.62) + 'px "Segoe UI", Arial, sans-serif';
    g.fillText('BWM', w / 2, h / 2 + h * 0.03);
    g.lineWidth = Math.max(2, Math.round(h * 0.045));
    g.strokeStyle = '#fff';
    g.strokeRect(g.lineWidth, g.lineWidth, w - g.lineWidth * 2, h - g.lineWidth * 2);
    return cv;
  }

  $('#btn-sample').addEventListener('click', function () {
    setSlotSource(slots['enc-img'], samplePhoto(640, 480), 'sample-photo.png');
    setSlotSource(slots['enc-wm'], sampleWatermark(180, 84), 'sample-mark.png');
    toast('已载入示例图片，可直接点「开始合成」');
  });

  /* ==================== 合成 ==================== */
  $('#btn-run-encode').addEventListener('click', async function () {
    var o = getOpts();
    var is = slots['enc-img'].data, ws = slots['enc-wm'].data;
    if (!is || !ws) return;
    var btn = this, ui = makeProgress('#prog-encode');
    setBusy(btn, true, '合成中…');
    try {
      var img = toPlanes(is, o.backdrop);
      var wm = toPlanes(ws, o.backdrop);
      var Hh = Math.floor(img.h / 2);
      if (wm.h >= Hh || wm.w >= img.w) {
        throw new Error('水印尺寸过大：高需 < ' + Hh + '，宽需 < ' + img.w
          + '（当前水印 ' + wm.w + '×' + wm.h + '）');
      }
      var r = await BWM.encode(img, wm, o, ui.tick);

      var n = img.w * img.h, q = r.float.planes.map(function (p) {
        var a = new Float64Array(p.length);
        for (var i = 0; i < p.length; i++) a[i] = BWM.clampRound(p[i]);
        return a;
      });

      var cv = planesToCanvas(q, img.w, img.h);
      var st = diffStats(q, img.planes, n);
      showResult($('#img-encode-out'), cv);
      $('#stat-encode').innerHTML = statHTML([
        { k: '输出尺寸', v: img.w + '×' + img.h },
        { k: 'PSNR', v: st.psnr.toFixed(2), u: 'dB', tone: st.psnr > 45 ? 'good' : st.psnr > 38 ? '' : 'warn' },
        { k: '最大像素偏差', v: st.max.toFixed(0) },
        { k: 'RMS 误差', v: Math.sqrt(st.mse).toFixed(2) }
      ]);
      var warn = $('#encode-warn');
      if (st.psnr <= 38) {
        warn.hidden = false;
        warn.innerHTML = '<b>画质提示</b>：当前强度下 PSNR 为 ' + st.psnr.toFixed(2)
          + ' dB，肉眼可能有轻微察觉。可把 <code>alpha</code> 调小、或改用「高质量」模式。';
      } else { warn.hidden = true; }

      $('#res-encode').classList.add('on');
      $('#btn-dl-encode').onclick = function () {
        downloadCanvas(cv, 'encoded-' + Date.now() + '.png');
      };
      ui.done();
    } catch (e) {
      ui.fail();
      toast(e.message || String(e), true);
    } finally {
      setBusy(btn, false);
    }
  });

  /* ==================== 分离 ==================== */
  $('#btn-run-decode').addEventListener('click', async function () {
    var o = getOpts();
    var is = slots['dec-img'].data, ws = slots['dec-wm'].data;
    if (!is || !ws) return;
    if (is.w !== ws.w || is.h !== ws.h) {
      toast('两张图尺寸必须一致（当前 ' + is.w + '×' + is.h + ' 与 ' + ws.w + '×' + ws.h + '）', true);
      return;
    }
    var btn = this, ui = makeProgress('#prog-decode');
    setBusy(btn, true, '分离中…');
    try {
      var img = toPlanes(is, o.backdrop);
      var imgWm = toPlanes(ws, o.backdrop);
      var r = await BWM.decode(img, imgWm, Object.assign({}, o, { quantize: 'round' }), ui.tick);

      var cv = planesToCanvas(r.wm.planes, img.w, img.h);
      var n = img.w * img.h;
      // 水印实际落点：左上角 1/4 区域内的对比度，用来判断分离是否有效
      var half = Math.floor(img.h / 2), hw = Math.floor(img.w / 2);
      var lo = -1, hi = -1, c, i, j;
      for (c = 0; c < 3; c++) {
        for (i = 0; i < half; i++) {
          for (j = 0; j < hw; j++) {
            var v = r.wm.planes[c][i * img.w + j];
            if (lo < 0 || v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
      }
      showResult($('#img-decode-out'), cv);
      $('#stat-decode').innerHTML = statHTML([
        { k: '输出尺寸', v: img.w + '×' + img.h },
        { k: '内容区动态范围', v: (hi - lo).toFixed(0), u: '/255', tone: (hi - lo) > 60 ? 'good' : 'warn' },
        { k: '内容区最亮', v: hi.toFixed(0) },
        { k: '内容区最暗', v: Math.max(0, lo).toFixed(0) }
      ]);
      $('#decode-note').innerHTML = '若左上角能看出水印轮廓（可能带对角双影和条纹噪点），说明分离成功。'
        + '噪点来自算法本身的固有损失，可用<b>「增强显示」</b>把压在灰噪声上的轮廓拉出来（只影响预览，下载的始终是原始数据）。'
        + '想核对具体内容，可到<b>「检测」</b>面板把原图、含水印图和候选水印一起放进去，会给出互相关分数。';

      // 原始 / 增强 两种视图切换
      var viewCanvas = renderScale(cv, 900);
      var enhCanvas = enhanceCanvas(viewCanvas);
      var showRaw = true;
      var paint = function () {
        $('#img-decode-out').src = (showRaw ? viewCanvas : enhCanvas).toDataURL('image/png');
        $('#btn-enh-decode').textContent = showRaw ? '增强显示' : '查看原始';
      };
      paint();
      $('#btn-enh-decode').onclick = function () { showRaw = !showRaw; paint(); };

      $('#res-decode').classList.add('on');
      $('#btn-dl-decode').onclick = function () {
        downloadCanvas(cv, 'watermark-' + Date.now() + '.png');
      };
      ui.done();
    } catch (e) {
      ui.fail();
      toast(e.message || String(e), true);
    } finally {
      setBusy(btn, false);
    }
  });

  /* ==================== 检测 ==================== */
  function drawRadial(rs) {
    var cv = $('#radial-canvas');
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);

    var padL = 62, padR = 18, padT = 18, padB = 34;
    var iw = W - padL - padR, ih = H - padT - padB;
    var prof = Array.prototype.slice.call(rs.profile);
    var logs = prof.map(function (v) { return Math.log10(Math.max(v, 1e-12)); });
    var lo = Math.min.apply(null, logs), hi = Math.max.apply(null, logs);
    if (hi - lo < 3) { hi = lo + 3; }
    var pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;

    function X(i) { return padL + iw * (i / (prof.length - 1)); }
    function Y(lg) { return padT + ih * (1 - (lg - lo) / (hi - lo)); }

    ctx.strokeStyle = '#e2e6ec';
    ctx.fillStyle = '#8b94a1';
    ctx.font = '11px system-ui, sans-serif';
    ctx.lineWidth = 1;
    for (var t = 0; t <= 4; t++) {
      var lg = lo + (hi - lo) * t / 4;
      var y = Y(lg);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + iw, y); ctx.stroke();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(Math.pow(10, lg).toExponential(1), padL - 8, y);
    }
    for (var x = 0; x <= 5; x++) {
      var xx = padL + iw * x / 5;
      ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, padT + ih); ctx.stroke();
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText((x / 5).toFixed(1), xx, padT + ih + 8);
    }
    ctx.textAlign = 'center'; ctx.fillText('归一化空间频率', padL + iw / 2, H - 12);
    ctx.save();
    ctx.translate(14, padT + ih / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'middle';
    ctx.fillText('径向平均功率', 0, 0);
    ctx.restore();

    ctx.strokeStyle = '#1a5fd0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (var i = 0; i < prof.length; i++) {
      var px = X(i), py = Y(logs[i]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // 低频谱外推基线
    var nf = Math.max(4, Math.floor(prof.length / 3));
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (i = 0; i < nf; i++) {
      var lx = Math.log10((i + 1) / prof.length);
      sx += lx; sy += logs[i]; sxx += lx * lx; sxy += lx * logs[i];
    }
    var den = nf * sxx - sx * sx;
    var slope = den !== 0 ? (nf * sxy - sx * sy) / den : 0;
    var inter = (sy - slope * sx) / nf;
    ctx.strokeStyle = '#b45309';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (i = 0; i < prof.length; i++) {
      var gx = Math.log10((i + 1) / prof.length);
      var gl = inter + slope * gx;
      if (i === 0) ctx.moveTo(X(i), Y(gl)); else ctx.lineTo(X(i), Y(gl));
    }
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#5a626e';
    ctx.font = '11.5px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('—— 实测功率谱', padL + 8, padT + 4);
    ctx.fillStyle = '#b45309';
    ctx.fillText('---- 低频段拟合（自然图像基线）', padL + 8, padT + 20);

    // 高频段超出基线的倍数
    var tail = Math.max(1, Math.floor(prof.length * 0.15));
    var sumA = 0, sumB = 0;
    for (i = prof.length - tail; i < prof.length; i++) {
      sumA += logs[i];
      sumB += inter + slope * Math.log10((i + 1) / prof.length);
    }
    return Math.pow(10, (sumA - sumB) / tail);
  }

  $('#btn-run-detect').addEventListener('click', async function () {
    var o = getOpts();
    var ts = slots['det-target'].data;
    if (!ts) return;
    var os = slots['det-origin'].data;
    var cs = slots['det-cand'].data;
    var btn = this, ui = makeProgress('#prog-detect');
    setBusy(btn, true, '检测中…');
    $('#res-detect').classList.remove('on');
    $('#det-preview-wrap').hidden = true;
    $('#det-radial-wrap').hidden = true;

    try {
      var target = toPlanes(ts, o.backdrop);

      if (os) {
        /* ---- 精确检测 ---- */
        if (os.w !== ts.w || os.h !== ts.h) {
          throw new Error('原图与待检图尺寸不一致（' + os.w + '×' + os.h
            + ' 与 ' + ts.w + '×' + ts.h + '）');
        }
        var origin = toPlanes(os, o.backdrop);
        var det = await BWM.detectPair(origin, target, o, function (p) {
          return ui.tick(p * 0.5);
        });
        var dec = await BWM.decode(origin, target,
          Object.assign({}, o, { quantize: 'round' }),
          function (p) { return ui.tick(0.5 + p * 0.5); });

        var ratio = det.ratio;
        var verdict, cls, icon, title, sub;
        if (ratio >= 3) {
          cls = 'yes'; icon = '●'; title = '检测到盲水印';
          sub = '频谱残差被强制成实值，符合本算法嵌入水印的特征。';
        } else if (ratio >= 1.8) {
          cls = 'maybe'; icon = '●'; title = '疑似存在水印';
          sub = '指标高于阈值但不够显著，可能是 alpha 很小，或图片被重压缩过。';
        } else {
          cls = 'no'; icon = '●'; title = '未检测到水印';
          sub = '残差的实部与虚部能量相当，与"无水印"的噪声特征一致。';
        }
        var v = $('#det-verdict');
        v.className = 'verdict ' + cls;
        v.querySelector('.ic').textContent = icon;
        v.querySelector('div').innerHTML = title + '<small>' + sub + '</small>';

        var cv = planesToCanvas(dec.wm.planes, ts.w, ts.h);
        showResult($('#img-detect-out'), cv);
        $('#det-preview-wrap').hidden = false;
        $('#btn-dl-detect').onclick = function () {
          downloadCanvas(cv, 'watermark-' + Date.now() + '.png');
        };

        var stats = [
          { k: '实部/虚部能量比', v: fmtRatio(ratio), tone: ratio >= 3 ? 'good' : ratio >= 1.8 ? 'warn' : 'bad' },
          { k: '残差实部能量', v: det.eRe.toExponential(2) },
          { k: '残差虚部能量', v: det.eIm.toExponential(2) },
          { k: '判据阈值', v: '≥ 3.0', u: '判为有水印' }
        ];

        if (cs) {
          if (cs.h > ts.h / 2 || cs.w > ts.w) {
            toast('候选水印过大，已跳过互相关比对', true);
          } else {
            var cand = toPlanes(cs, o.backdrop);
            var A = [], B = [];
            for (var c = 0; c < 3; c++) {
              for (var i = 0; i < cand.h; i++) {
                for (var j = 0; j < cand.w; j++) {
                  A.push(dec.wm.planes[c][i * ts.w + j]);
                  B.push(cand.planes[c][i * cand.w + j]);
                }
              }
            }
            var ncc = BWM.ncc(A, B);
            stats.push({
              k: '候选水印互相关', v: ncc.toFixed(3),
              tone: ncc > 0.5 ? 'good' : ncc > 0.25 ? 'warn' : 'bad'
            });
            if (ncc > 0.5) {
              v.className = 'verdict yes';
              v.querySelector('div').innerHTML = '确认是这张水印'
                + '<small>与候选水印的归一化互相关达 ' + ncc.toFixed(3) + '（> 0.5 视为同一张）。</small>';
            }
          }
        }

        $('#stat-detect').innerHTML = statHTML(stats);
        $('#det-note').innerHTML = '判据说明：水印只叠加在频域的<b>实部</b>上，所以「含水印图频谱 − 原图频谱」是纯实数的；'
          + '若图中没有水印，这个差值就只剩量化与压缩噪声，实部与虚部能量相当，比值落在 1 附近。'
          + '实测：无关图约 <code>1.00</code>，含水印图普遍在 <code>10</code> 以上，无损往返时甚至可达 <code>10³</code> 量级。'
          + '该比值与 <code>alpha</code> 正相关；图片若经过 JPEG 重压缩、缩放或裁剪，水印会受损，比值将明显下降。';
      } else {
        /* ---- 无原图：启发式盲检 ---- */
        var rs = await BWM.radialSpectrum(target, ui.tick);
        var excess = drawRadial(rs);
        $('#det-radial-wrap').hidden = false;

        var v2 = $('#det-verdict');
        var cls2, title2, sub2;
        if (excess >= 4) {
          cls2 = 'maybe'; title2 = '高频存在异常能量';
          sub2 = '径向功率谱的高频段比自然图像基线高约 ' + excess.toFixed(1) + ' 倍，值得进一步核查。';
        } else {
          cls2 = 'no'; title2 = '未见明显异常';
          sub2 = '高频段与自然图像基线偏差约 ' + excess.toFixed(1) + ' 倍，属正常范围。';
        }
        v2.className = 'verdict ' + cls2;
        v2.querySelector('.ic').textContent = '●';
        v2.querySelector('div').innerHTML = title2 + '<small>' + sub2 + '</small>';
        $('#stat-detect').innerHTML = statHTML([
          { k: '高频超出基线', v: excess.toFixed(2), u: '倍' },
          { k: '采样环带数', v: rs.bins },
          { k: '判定依据', v: '启发式' }
        ]);
        $('#det-note').innerHTML = '<b>盲检只是参考，不能作为判定依据。</b>'
          + '这套算法本质是加法式频域水印，<b>必须拿到原图才能可靠判定</b>：'
          + '没有原图时，"原图的频谱"完全未知，任何统计特征都可能被图像自身的纹理和噪声淹没。'
          + '如果手上有原图，请放进第二个槽位做精确检测。';
      }
      $('#res-detect').classList.add('on');
      ui.done();
    } catch (e) {
      ui.fail();
      toast(e.message || String(e), true);
    } finally {
      setBusy(btn, false);
    }
  });

  /* ==================== 初始化 ==================== */
  ['enc-img', 'enc-wm', 'dec-img', 'dec-wm', 'det-target', 'det-origin', 'det-cand']
    .forEach(initSlot);

  var LABELS = {
    'enc-img': '载体图', 'enc-wm': '水印图',
    'dec-img': '原始载体图', 'dec-wm': '含水印图',
    'det-target': '待检图', 'det-origin': '原图', 'det-cand': '候选水印'
  };
  Object.keys(LABELS).forEach(function (k) { slots[k].el.dataset.label = LABELS[k]; });

  updateButtons();
})();
