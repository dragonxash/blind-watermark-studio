# -*- coding: utf-8 -*-
"""
修复：build-tools 之前误取了仓库索引里的第一个 URL（Linux 版），
重新下载 Windows 版并解压到 M:\\android-sdk\\build-tools\\34.0.0
"""
import os
import re
import ssl
import shutil
import zipfile
import urllib.request

PROXY = "http://127.0.0.1:7897"
SDK = r"M:\android-sdk"
REPO = "https://dl.google.com/android/repository/"
DEST = os.path.join(SDK, "build-tools", "34.0.0")


def log(*a):
    print(*a, flush=True)


opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}),
    urllib.request.HTTPSHandler(context=ssl._create_unverified_context()),
)
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def get(url, timeout=600):
    return opener.open(urllib.request.Request(url, headers=UA), timeout=timeout)


# 从索引里精确找出 build-tools;34.0.0 的 windows 归档
log("[1/3] 解析索引，定位 windows 版 ...")
xml = get(REPO + "repository2-3.xml").read().decode("utf-8", "replace")
m = re.search(r'<remotePackage path="build-tools;34\.0\.0".*?</remotePackage>', xml, re.S)
if not m:
    log("!! 索引里找不到 build-tools;34.0.0")
    raise SystemExit(1)
block = m.group(0)

url = None
for arch in re.findall(r"<archive>.*?</archive>", block, re.S):
    if "<host-os>windows</host-os>" in arch:
        u = re.search(r"<url>([^<]+)</url>", arch)
        if u:
            url = u.group(1)
            break
if url is None:
    # 兜底：直接把 linux 名换成 windows
    u = re.search(r"<url>([^<]+)</url>", block)
    url = u.group(1).replace("-linux", "-windows") if u else None
log("   windows 包 =", url)
if not url:
    raise SystemExit("!! 未能确定下载地址")

# 下载
log("[2/3] 下载 ...")
zp = os.path.join(SDK, "_dl", url)
os.makedirs(os.path.dirname(zp), exist_ok=True)
if not (os.path.exists(zp) and os.path.getsize(zp) > 1 << 20):
    with get(REPO + url) as r, open(zp, "wb") as f:
        got = 0
        while True:
            c = r.read(1 << 16)
            if not c:
                break
            f.write(c)
            got += len(c)
            if got % (24 << 20) < (1 << 16):
                log("   %.0f MB" % (got / 1048576.0))
    log("   完成 %.1f MB" % (os.path.getsize(zp) / 1048576.0))
else:
    log("   已存在，跳过")

# 解压替换
log("[3/3] 解压到 build-tools/34.0.0 ...")
if os.path.exists(DEST):
    shutil.rmtree(DEST)
tmp = DEST + "__tmp"
if os.path.exists(tmp):
    shutil.rmtree(tmp)
os.makedirs(tmp, exist_ok=True)
with zipfile.ZipFile(zp) as z:
    z.extractall(tmp)
entries = os.listdir(tmp)
src = tmp
if len(entries) == 1 and os.path.isdir(os.path.join(tmp, entries[0])):
    src = os.path.join(tmp, entries[0])
os.makedirs(os.path.dirname(DEST), exist_ok=True)
shutil.move(src, DEST)
shutil.rmtree(tmp, ignore_errors=True)

log("")
log("==== 校验 ====")
for f in ["aapt2.exe", "aapt.exe", "lib/d8.jar", "lib/apksigner.jar", "zipalign.exe"]:
    fp = os.path.join(DEST, f.replace("/", os.sep))
    log("  %-22s %s" % (f, "OK" if os.path.exists(fp) else "缺失"))
