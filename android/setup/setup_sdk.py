# -*- coding: utf-8 -*-
"""
下载并配置 Android SDK 到 M:\\android-sdk
（只装编译 APK 必需的组件，不含模拟器）
"""
import os
import re
import ssl
import sys
import time
import shutil
import zipfile
import subprocess
import urllib.request

PROXY = "http://127.0.0.1:7897"
SDK_ROOT = r"M:\android-sdk"
CMDTOOLS = os.path.join(SDK_ROOT, "cmdline-tools", "latest")
JAVA_HOME = r"C:\Program Files\Microsoft\jdk-21.0.9.10-hotspot"


def log(*a):
    print(*a, flush=True)


opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}),
    urllib.request.HTTPSHandler(context=ssl._create_unverified_context()),
)
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def get(url, timeout=300):
    return opener.open(urllib.request.Request(url, headers=UA), timeout=timeout)


def download(url, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    t0 = time.time()
    with get(url) as r, open(dest, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        got = 0
        mark = 0
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            if total and got - mark > (8 << 20):
                mark = got
                log("   %.1f / %.1f MB" % (got / 1048576.0, total / 1048576.0))
    log("   完成 %.1f MB，用时 %.0fs" % (os.path.getsize(dest) / 1048576.0, time.time() - t0))


# ---------------------------------------------------------------- 1. 找版本
log("[1/5] 读取 Google 仓库索引 ...")
xml = get("https://dl.google.com/android/repository/repository2-3.xml").read().decode("utf-8", "replace")
names = re.findall(r"commandlinetools-win-(\d+)_latest\.zip", xml)
if not names:
    log("!! 未找到 commandlinetools，索引长度 =", len(xml))
    sys.exit(1)
ver = max(int(n) for n in names)
zipname = "commandlinetools-win-%d_latest.zip" % ver
log("   最新版:", zipname)

# ---------------------------------------------------------------- 2. 下载
log("[2/5] 下载 commandline-tools ...")
zip_path = os.path.join(SDK_ROOT, zipname)
if os.path.exists(zip_path) and os.path.getsize(zip_path) > 10 << 20:
    log("   已存在，跳过")
else:
    download("https://dl.google.com/android/repository/" + zipname, zip_path)

# ---------------------------------------------------------------- 3. 解压
log("[3/5] 解压 ...")
sm = os.path.join(CMDTOOLS, "bin", "sdkmanager.bat")
if not os.path.exists(sm):
    tmp = os.path.join(SDK_ROOT, "_unzip")
    if os.path.exists(tmp):
        shutil.rmtree(tmp)
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(tmp)
    src = os.path.join(tmp, "cmdline-tools")
    os.makedirs(os.path.dirname(CMDTOOLS), exist_ok=True)
    if os.path.exists(CMDTOOLS):
        shutil.rmtree(CMDTOOLS)
    shutil.move(src, CMDTOOLS)
    shutil.rmtree(tmp, ignore_errors=True)
log("   sdkmanager:", sm, "->", os.path.exists(sm))

env = dict(os.environ)
env["JAVA_HOME"] = JAVA_HOME
env["ANDROID_HOME"] = SDK_ROOT
env["ANDROID_SDK_ROOT"] = SDK_ROOT

# ---------------------------------------------------------------- 4. 许可
log("[4/5] 接受许可协议 ...")
r = subprocess.run([sm, "--licenses"], env=env, input="y\n" * 200,
                   text=True, capture_output=True)
log("   rc =", r.returncode)

# ---------------------------------------------------------------- 5. 装组件
log("[5/5] 安装 SDK 组件 ...")
for p in ["platform-tools", "platforms;android-34", "build-tools;34.0.0"]:
    log("   >>", p)
    r = subprocess.run([sm, p], env=env, input="y\n" * 200, text=True, capture_output=True)
    log("      rc =", r.returncode)
    out = ((r.stdout or "") + (r.stderr or "")).strip().splitlines()
    for line in out[-3:]:
        log("      ", line)

log("")
log("==== 结果 ====")
log("ANDROID_HOME =", SDK_ROOT)
for d in ["cmdline-tools/latest/bin", "platform-tools", "platforms/android-34", "build-tools/34.0.0"]:
    p = os.path.join(SDK_ROOT, d.replace("/", os.sep))
    log("  %-28s %s" % (d, "OK" if os.path.exists(p) else "缺失"))
