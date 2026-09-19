# -*- coding: utf-8 -*-
"""
手动安装 platforms;android-34 与 build-tools;34.0.0（绕开已弃用的 sdkmanager），
并下载 Gradle 发行版。
"""
import os
import re
import ssl
import time
import shutil
import zipfile
import urllib.request

PROXY = "http://127.0.0.1:7897"
SDK = r"M:\android-sdk"
GRADLE_DIR = r"M:\gradle"
REPO = "https://dl.google.com/android/repository/"


def log(*a):
    print(*a, flush=True)


opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}),
    urllib.request.HTTPSHandler(context=ssl._create_unverified_context()),
)
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def get(url, timeout=900):
    return opener.open(urllib.request.Request(url, headers=UA), timeout=timeout)


def download(url, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest) and os.path.getsize(dest) > 4096:
        log("   已存在，跳过:", os.path.basename(dest))
        return
    t0 = time.time()
    mark = 0
    with get(url) as r, open(dest, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        got = 0
        while True:
            c = r.read(1 << 16)
            if not c:
                break
            f.write(c)
            got += len(c)
            if got - mark > (16 << 20):
                mark = got
                log("   %.0f / %.0f MB" % (got / 1048576.0, total / 1048576.0))
    log("   完成 %.1f MB / %.0fs" % (os.path.getsize(dest) / 1048576.0, time.time() - t0))


def find_url(xml, pkg_path):
    m = re.search(r'<remotePackage path="%s".*?</remotePackage>' % re.escape(pkg_path), xml, re.S)
    if not m:
        return None
    u = re.search(r"<url>([^<]+)</url>", m.group(0))
    return u.group(1) if u else None


def unzip_into(zip_path, dest_dir):
    """解压 zip，并把其唯一的顶层目录内容搬到 dest_dir"""
    if os.path.exists(dest_dir):
        shutil.rmtree(dest_dir)
    tmp = dest_dir + "__tmp"
    if os.path.exists(tmp):
        shutil.rmtree(tmp)
    os.makedirs(tmp, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(tmp)
    entries = os.listdir(tmp)
    src = tmp
    if len(entries) == 1 and os.path.isdir(os.path.join(tmp, entries[0])):
        src = os.path.join(tmp, entries[0])
    os.makedirs(os.path.dirname(dest_dir), exist_ok=True)
    shutil.move(src, dest_dir)
    shutil.rmtree(tmp, ignore_errors=True)


log("[1/5] 读取 Google 仓库索引 ...")
xml = get(REPO + "repository2-3.xml").read().decode("utf-8", "replace")

log("[2/5] 安装 platforms;android-34 ...")
u = find_url(xml, "platforms;android-34")
log("   url =", u)
if u:
    zp = os.path.join(SDK, "_dl", u)
    download(REPO + u, zp)
    unzip_into(zp, os.path.join(SDK, "platforms", "android-34"))
    log("   android.jar ->", os.path.exists(os.path.join(SDK, "platforms", "android-34", "android.jar")))

log("[3/5] 安装 build-tools;34.0.0 ...")
u = find_url(xml, "build-tools;34.0.0")
log("   url =", u)
if u:
    zp = os.path.join(SDK, "_dl", u)
    download(REPO + u, zp)
    unzip_into(zp, os.path.join(SDK, "build-tools", "34.0.0"))
    log("   aapt2.exe ->", os.path.exists(os.path.join(SDK, "build-tools", "34.0.0", "aapt2.exe")))

log("[4/5] 下载 Gradle 8.9 ...")
gz = os.path.join(GRADLE_DIR, "gradle-8.9-bin.zip")
download("https://services.gradle.org/distributions/gradle-8.9-bin.zip", gz)

log("[5/5] 解压 Gradle ...")
gbat = os.path.join(GRADLE_DIR, "gradle-8.9", "bin", "gradle.bat")
if not os.path.exists(gbat):
    unzip_into(gz, os.path.join(GRADLE_DIR, "gradle-8.9"))
log("   gradle.bat ->", os.path.exists(gbat))

log("")
log("==== 汇总 ====")
for p in ["platforms/android-34/android.jar", "platforms/android-34/core-for-system-modules.jar",
          "build-tools/34.0.0/aapt2.exe", "build-tools/34.0.0/lib/d8.jar",
          "platform-tools/adb.exe", "cmdline-tools/latest/bin/sdkmanager.bat"]:
    fp = os.path.join(SDK, p.replace("/", os.sep))
    log("  %-46s %s" % (p, "OK" if os.path.exists(fp) else "缺失"))
log("  gradle-8.9/bin/gradle.bat                        %s"
    % ("OK" if os.path.exists(gbat) else "缺失"))
