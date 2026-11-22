# Installs the pinned Bitwarden Password Manager extension into the browser-prompt signed-in image
# (see Dockerfile). Runs once at image build time, only after the owner's explicit two-press consent
# in the plugin's settings. Python's standard library plus the image's own Chromium.
#   1. Downloads the release zip named in bitwarden.json from Bitwarden's GitHub releases (https only,
#      also on redirects) and refuses it unless its size and SHA-256 match the pin.
#   2. Extracts it (regular files only, no absolute or .. paths) and checks the manifest: the pinned
#      version, Manifest V3, no update_url. Nothing in it is changed.
#   3. Packs it into a CRX with Chromium itself, signed with this install's key: the plugin makes it
#      once and keeps it in its state directory; the build gets it only as a BuildKit secret
#      (/run/secrets/bitwarden-key, mounted for this step only, never in a layer), so the extension's
#      id stays the same across images and pins and Bitwarden's local data survives them. The id must
#      be the one the plugin expects (BITWARDEN_ID). /opt/bitwarden then holds only the CRX, a local
#      update manifest (file://, the same version: Chromium never updates it from anywhere) and the pin
#      record, root-owned and read-only.
#   4. Applies policy-overlay.json to Chromium's managed policy and force-installs exactly that id
#      from the local update manifest; every other extension stays blocked (ExtensionInstallBlocklist
#      "*"). Force-installed, Bitwarden can reload itself (it does after every lock); an extension
#      loaded with --load-extension cannot (it disappears until the browser restarts).
import hashlib, io, json, os, shutil, stat, struct, subprocess, sys, urllib.request, zipfile

here = sys.argv[1]
pin = json.load(open(os.path.join(here, "bitwarden.json")))
overlay = json.load(open(os.path.join(here, "policy-overlay.json")))
target = "/opt/bitwarden"
work = "/tmp/bp-bitwarden-build"
source = os.path.join(work, "bitwarden")
key_secret = "/run/secrets/bitwarden-key"
expected_id = os.environ.get("BITWARDEN_ID", "")
if len(expected_id) != 32 or any(c not in "abcdefghijklmnop" for c in expected_id):
    sys.exit("refusing: BITWARDEN_ID is missing or not an extension id")
if not os.path.isfile(key_secret):
    sys.exit("refusing: the signing key secret is missing (the plugin passes it with docker build --secret)")
policy_file = "/etc/chromium/policies/managed/policies.json"

prefix = "https://github.com/bitwarden/clients/releases/download/browser-v%s/" % pin["version"]
if not pin["url"].startswith(prefix) or not pin["url"].endswith(".zip"):
    sys.exit("refusing: the pinned URL is not a Bitwarden browser release zip on GitHub")

class HttpsOnly(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.startswith("https://"):
            raise urllib.error.URLError("refusing a redirect away from https")
        return super().redirect_request(req, fp, code, msg, headers, newurl)

opener = urllib.request.build_opener(HttpsOnly)
with opener.open(urllib.request.Request(pin["url"], headers={"User-Agent": "browser-prompt-image-build"}), timeout=300) as response:
    data = response.read(pin["size"] + 1)
if len(data) != pin["size"]:
    sys.exit("refusing: the download is %d bytes, the pin says %d" % (len(data), pin["size"]))
digest = hashlib.sha256(data).hexdigest()
if digest != pin["sha256"]:
    sys.exit("refusing: SHA-256 %s does not match the pin %s" % (digest, pin["sha256"]))

try:
    os.makedirs(source)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for info in archive.infolist():
            name = info.filename
            if name.startswith("/") or "\\" in name or ".." in name.split("/"):
                sys.exit("refusing: unsafe path in the archive: %r" % name)
            mode = (info.external_attr >> 16) & 0o170000
            if mode and mode not in (stat.S_IFREG, stat.S_IFDIR):
                sys.exit("refusing: not a regular file in the archive: %r" % name)
            path = os.path.join(source, name)
            if name.endswith("/"):
                os.makedirs(path, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as out:
                out.write(archive.read(info))

    manifest = json.load(open(os.path.join(source, "manifest.json"), encoding="utf-8-sig"))
    if manifest.get("version") != pin["version"] or manifest.get("manifest_version") != 3:
        sys.exit("refusing: unexpected manifest version")
    if "update_url" in manifest or "key" in manifest:
        sys.exit("refusing: the release zip carries an update_url or a key")

    # Pack with the image's Chromium and this install's key (read from the secret; Chromium writes no
    # key file when it is given one, and any key file next to the CRX is removed anyway).
    crx_file = source + ".crx"
    key_file = source + ".pem"
    try:
        subprocess.run(
            ["chromium", "--headless=new", "--no-sandbox", "--user-data-dir=" + os.path.join(work, "profile"), "--pack-extension=" + source, "--pack-extension-key=" + key_secret],
            check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300,
        )
        if not os.path.exists(crx_file):
            sys.exit("refusing: Chromium did not pack the extension")
        crx = open(crx_file, "rb").read()
    finally:
        if os.path.exists(key_file):
            os.remove(key_file)
    if crx[:4] != b"Cr24" or struct.unpack("<I", crx[4:8])[0] != 3:
        sys.exit("refusing: not a CRX3 file")

    def varint(b, i):
        r = s = 0
        while True:
            c = b[i]; i += 1; r |= (c & 0x7f) << s; s += 7
            if not c & 0x80:
                return r, i

    def fields(b):
        i, out = 0, []
        while i < len(b):
            k, i = varint(b, i)
            if k & 7 == 2:
                n, i = varint(b, i); out.append((k >> 3, b[i:i + n])); i += n
            else:
                v, i = varint(b, i); out.append((k >> 3, v))
        return out

    header = crx[12:12 + struct.unpack("<I", crx[8:12])[0]]
    crx_id = [v for f, v in fields([v for f, v in fields(header) if f == 10000][0]) if f == 1][0]
    ext_id = "".join(chr(97 + (b >> 4)) + chr(97 + (b & 15)) for b in crx_id)
    # The packed archive holds exactly the release's files.
    with zipfile.ZipFile(io.BytesIO(crx[12 + len(header):])) as packed, zipfile.ZipFile(io.BytesIO(data)) as release:
        want = {i.filename: release.read(i) for i in release.infolist() if not i.filename.endswith("/")}
        got = {i.filename: packed.read(i) for i in packed.infolist() if not i.filename.endswith("/")}
        if want != got:
            sys.exit("refusing: the packed extension differs from the release")

    if ext_id != expected_id:
        sys.exit("refusing: the packed extension's id %s is not the expected %s" % (ext_id, expected_id))
    os.makedirs(target)
    shutil.copyfile(crx_file, os.path.join(target, "bitwarden.crx"))
    with open(os.path.join(target, "updates.xml"), "w") as out:
        out.write(
            "<?xml version='1.0' encoding='UTF-8'?>\n"
            "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n"
            "  <app appid='%s'><updatecheck codebase='file:///opt/bitwarden/bitwarden.crx' version='%s' /></app>\n"
            "</gupdate>\n" % (ext_id, pin["version"])
        )
    with open(os.path.join(target, "browser-prompt-pin.json"), "w") as out:
        json.dump({"version": pin["version"], "sha256": digest, "id": ext_id, "url": pin["url"]}, out)
    for name in os.listdir(target):
        os.chmod(os.path.join(target, name), 0o644)
    os.chmod(target, 0o755)
finally:
    # The work directory (the unpacked release, Chromium's packing profile) never stays in the image.
    shutil.rmtree(work, ignore_errors=True)

policy = json.load(open(policy_file))
policy.update(overlay["set"])
# Bitwarden's inline menu and notification frames use per-session dynamic ids
# (chrome-extension://<random>/overlay/...), which no allowlist entry can name: extension pages are
# not blocked by URL. Every other extension is blocked, and the agent's access to extension pages is
# refused by the plugin's DevTools and MCP filters.
for name, values in overlay["drop"].items():
    policy[name] = [v for v in policy.get(name, []) if v not in values]
for name, values in overlay["append"].items():
    policy[name] = list(policy.get(name, [])) + [v for v in values if v not in policy.get(name, [])]
policy["ExtensionInstallAllowlist"] = [ext_id]
policy["ExtensionInstallForcelist"] = ["%s;file:///opt/bitwarden/updates.xml" % ext_id]
with open(policy_file, "w") as out:
    json.dump(policy, out, indent=2)
os.chmod(policy_file, 0o644)
print("installed Bitwarden %s as %s (sha256 %s)" % (pin["version"], ext_id, digest))
