# Installs the pinned Bitwarden Password Manager extension into the browser-prompt signed-in image
# (see Dockerfile). Runs once at image build time, only after the owner's explicit two-press consent
# in the plugin's settings. Python's standard library only.
#   1. Downloads the release zip named in bitwarden.json from Bitwarden's GitHub releases (https only)
#      and refuses it unless its size and SHA-256 match the pin.
#   2. Extracts it to /opt/bitwarden (regular files only, no absolute or .. paths), root-owned and
#      read-only for the browser user, so Chromium (which loads it unpacked with
#      --load-extension, see chromium-start.sh) can never update or change it.
#   3. Checks the manifest (pinned version, Manifest V3, no update_url), adds the Chrome Web Store's
#      public key for the extension so it gets its usual id, and gives Bitwarden's own "Lock vault"
#      command a shortcut (the daemon presses it through the desktop when the owner releases control).
#   4. Applies policy-overlay.json to Chromium's managed policy.
import base64, hashlib, io, json, os, stat, sys, urllib.request, zipfile

here = sys.argv[1]
pin = json.load(open(os.path.join(here, "bitwarden.json")))
overlay = json.load(open(os.path.join(here, "policy-overlay.json")))
target = "/opt/bitwarden"
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

os.makedirs(target, exist_ok=False)
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    for info in archive.infolist():
        name = info.filename
        if name.startswith("/") or "\\" in name or ".." in name.split("/"):
            sys.exit("refusing: unsafe path in the archive: %r" % name)
        mode = (info.external_attr >> 16) & 0o170000
        if mode and mode not in (stat.S_IFREG, stat.S_IFDIR):
            sys.exit("refusing: not a regular file in the archive: %r" % name)
        path = os.path.join(target, name)
        if name.endswith("/"):
            os.makedirs(path, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as out:
            out.write(archive.read(info))

manifest_path = os.path.join(target, "manifest.json")
manifest = json.load(open(manifest_path, encoding="utf-8-sig"))
if manifest.get("version") != pin["version"] or manifest.get("manifest_version") != 3:
    sys.exit("refusing: unexpected manifest version")
if "update_url" in manifest:
    sys.exit("refusing: the release zip carries an update_url")
key = base64.b64decode(pin["key"])
ext_id = "".join(chr(97 + (b >> 4)) + chr(97 + (b & 15)) for b in hashlib.sha256(key).digest()[:16])
if ext_id != pin["id"]:
    sys.exit("refusing: the pinned key does not give the pinned extension id")
manifest["key"] = pin["key"]
commands = manifest.get("commands") or {}
if "lock_vault" not in commands:
    sys.exit("refusing: this Bitwarden version has no lock_vault command")
commands["lock_vault"]["suggested_key"] = {"default": pin["lockShortcut"], "linux": pin["lockShortcut"]}
used = [c for c in commands.values() if c.get("suggested_key")]
if len(used) > 4:
    sys.exit("refusing: more than 4 suggested shortcuts")
for name, command in commands.items():
    if name != "lock_vault" and pin["lockShortcut"] in (command.get("suggested_key") or {}).values():
        sys.exit("refusing: the lock shortcut is taken by %s" % name)
with open(manifest_path, "w") as out:
    json.dump(manifest, out, indent=2)
with open(os.path.join(target, "browser-prompt-pin.json"), "w") as out:
    json.dump({"version": pin["version"], "sha256": digest, "id": ext_id, "url": pin["url"]}, out)

for root, dirs, files in os.walk(target):
    os.chmod(root, 0o755)
    for name in files:
        os.chmod(os.path.join(root, name), 0o644)

policy = json.load(open(policy_file))
for name in overlay["remove"]:
    policy.pop(name, None)
policy.update(overlay["set"])
for name, values in overlay["append"].items():
    policy[name] = list(policy.get(name, [])) + [v for v in values if v not in policy.get(name, [])]
with open(policy_file, "w") as out:
    json.dump(policy, out, indent=2)
os.chmod(policy_file, 0o644)
print("installed Bitwarden %s (%s), sha256 %s" % (pin["version"], ext_id, digest))
