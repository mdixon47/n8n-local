"""Local templates API for the n8n editor's built-in Templates page.

n8n's editor sends its Templates link to n8n.io unless N8N_TEMPLATES_HOST
points somewhere else; with a custom host it opens the in-app gallery and the
browser fetches template data from that host. This server answers the same
endpoints as api.n8n.io, serving the workflows that build.py extracted (those
tagged `template` in this instance).

It also serves the ideas page (web/index.html at /, with its assets), the
prompt generator page (web/prompts.html at /prompts, which posts a goal to the
ai-prompt-generator webhook on the editor's port), the
node icons build.py copied into data/icons/, and web/editor-hook.js, which
n8n loads into the editor (EXTERNAL_FRONTEND_HOOKS_URLS) so that links to
n8n.io/workflows open the ideas page instead.

n8n.io's public library is passed through too (TEMPLATES_UPSTREAM, default
https://api.n8n.io/api; empty turns it off): /api/n8nio/search and
/api/n8nio/categories for the ideas page, and a template id that is not a
local one is fetched from n8n.io for /templates/workflows/<id> and
/workflows/templates/<id>. That is what lets the editor's own import route,
/workflows/templates/<id>, import any n8n.io template. Upstream requests carry
no browser headers (no cookies), go only to that one host, and are cached in
memory for 4 hours.

n8n.io templates sometimes use CUSTOM.<name>: a node the author loaded from
a local folder, which no other n8n has. When exactly one installed community
node type ends in .<name> (data/node-types.json, written by build.py),
templates are handed over with that type instead, so they import ready to
run. Rebuild with build.py after installing a community package.

n8n.io templates imported from the ideas page are also stored, so they stay
on the Templates page: the page sends POST /api/local/library/<id>, and the
server fetches that template from n8n.io itself (the request carries no
workflow), cleans it like build.py does, and writes library/<id>.json
(TEMPLATES_LIBRARY_DIR). Stored templates are listed with the local ones under
"From n8n.io", described with build.py's describe(), and imported from the
stored copy, so they work with TEMPLATES_UPSTREAM off. One that a workflow
tagged `template` came from is left out, since it is already listed. To
remove one, delete its file. editor-hook.js sends the same POST from the
editor when a workflow is created from a template there. That POST is the
only request that changes anything; it is accepted only from this server's
own pages and from the editor (see do_POST).

Standard library only. Reads data/catalog.json and data/workflows/<id>.json,
reloading the catalog when build.py rewrites it.

Requests from the editor carry the browser's cookies (withCredentials), which
include the n8n session cookie when both share a hostname. Nothing here logs
or stores headers; the access log records method, path, and status only.

Only the editor may read responses from a browser: CORS headers are sent for
origins on the editor's port (TEMPLATES_EDITOR_PORT, default 5678) whose host
is this machine, a .local name, or a private address. A page on any other site
gets no CORS headers, so the browser keeps the response from it.
"""

import ipaddress
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # python -I leaves the script's folder off the path
import build  # noqa: E402  describe() and clean(), shared with the gallery build

DATA_DIR = os.environ.get("TEMPLATES_DATA_DIR", os.path.join(HERE, "data"))
PORT = int(os.environ.get("TEMPLATES_PORT", "8080"))
CATALOG = os.path.join(DATA_DIR, "catalog.json")
WEB_DIR = os.path.join(HERE, "web")
ICON_DIR = os.path.join(DATA_DIR, "icons")
EDITOR_PORT = int(os.environ.get("TEMPLATES_EDITOR_PORT", "5678"))
PAGE_CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
            "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
# The prompt generator posts to n8n's webhook itself, on the editor's port.
PROMPTS_CSP = PAGE_CSP.replace("connect-src 'self'", f"connect-src 'self' http://*:{EDITOR_PORT} https://*:{EDITOR_PORT}")
# Files of the ideas page, by URL path: (file, type[, CSP]). Nothing outside this list is served from web/.
WEB_FILES = {
    "": ("index.html", "text/html; charset=utf-8"),
    "index.html": ("index.html", "text/html; charset=utf-8"),
    "app.js": ("app.js", "text/javascript; charset=utf-8"),
    "app.css": ("app.css", "text/css; charset=utf-8"),
    "ideas.json": ("ideas.json", "application/json; charset=utf-8"),
    "editor-hook.js": ("editor-hook.js", "text/javascript; charset=utf-8"),
    "prompts": ("prompts.html", "text/html; charset=utf-8", PROMPTS_CSP),
    "prompts.html": ("prompts.html", "text/html; charset=utf-8", PROMPTS_CSP),
    "prompts.js": ("prompts.js", "text/javascript; charset=utf-8"),
    "prompts.css": ("prompts.css", "text/css; charset=utf-8"),
}
UPSTREAM = os.environ.get("TEMPLATES_UPSTREAM", "https://api.n8n.io/api").rstrip("/")
UPSTREAM_TTL = 4 * 3600
UPSTREAM_MAX_BYTES = 8 * 1024 * 1024
NODE_TYPES = os.path.join(DATA_DIR, "node-types.json")
NODE_META = os.path.join(DATA_DIR, "node-meta.json")
IMPORTED = os.path.join(DATA_DIR, "imported.json")
LIBRARY_DIR = os.environ.get("TEMPLATES_LIBRARY_DIR", os.path.join(HERE, "library"))
LIBRARY_MAX = 500
LIBRARY_CATEGORY = {"name": "From n8n.io", "icon": "🌐"}

AUTHOR = {"id": 0, "name": "This n8n instance", "username": "local", "bio": "", "verified": False, "links": "[]", "avatar": ""}

_cache = {"mtime": None, "catalog": {"categories": [], "templates": []}, "by_id": {}}
_gen = [0]  # bumped whenever a file behind catalog() is reread


def local_catalog():
    """Workflows tagged `template`, as build.py wrote them."""
    try:
        mtime = os.stat(CATALOG).st_mtime
    except FileNotFoundError:
        return _cache["catalog"], _cache["by_id"]
    if mtime != _cache["mtime"]:
        with open(CATALOG, encoding="utf-8") as fh:
            data = json.load(fh)
        _cache.update(mtime=mtime, catalog=data, by_id={t["id"]: t for t in data["templates"]})
        _gen[0] += 1
    return _cache["catalog"], _cache["by_id"]


_json_cache = {}


def cached_json(path, default):
    """A JSON file written by build.py; reread when it changes."""
    try:
        mtime = os.stat(path).st_mtime
    except FileNotFoundError:
        return default
    hit = _json_cache.get(path)
    if not hit or hit[0] != mtime:
        with open(path, encoding="utf-8") as fh:
            hit = (mtime, json.load(fh))
        _json_cache[path] = hit
        _gen[0] += 1
    return hit[1]


_lib = {"key": None, "records": {}}
_lib_lock = threading.Lock()


def library_records():
    """Stored n8n.io templates by id, from library/<id>.json; reread when the folder changes."""
    try:
        names = sorted(f for f in os.listdir(LIBRARY_DIR) if f.endswith(".json") and f[:-5].isdigit())
        # The file list too: on HFS+ the folder's mtime only has whole seconds.
        key = (os.stat(LIBRARY_DIR).st_mtime, tuple(names))
    except FileNotFoundError:
        return {}
    if key != _lib["key"]:
        records = {}
        for f in names:
            try:
                with open(os.path.join(LIBRARY_DIR, f), encoding="utf-8") as fh:
                    records[int(f[:-5])] = json.load(fh)
            except (OSError, ValueError) as exc:
                print(f"library: skipped {f} ({type(exc).__name__})", file=sys.stderr, flush=True)
        _lib.update(key=key, records=records)
        _gen[0] += 1
    return _lib["records"]


def map_workflow(wf):
    """Copy of a stored workflow with CUSTOM.* node types mapped (see custom_map)."""
    mapping = custom_map()
    if not any(n.get("type") in mapping for n in wf["nodes"]):
        return wf
    return dict(wf, nodes=[dict(n, type=mapping[n["type"]]) if n.get("type") in mapping else n for n in wf["nodes"]])


def library_entry(rec, cat_id, meta, types, imported):
    """Catalog entry for a stored template, in the shape build.py writes."""
    t = {
        "id": rec["id"],
        "name": rec["name"],
        "description": rec.get("description") or "",
        "createdAt": rec.get("createdAt") or "",
        "updatedAt": rec.get("savedAt") or "",
        "categoryIds": [cat_id],
        "templateId": rec["id"],
        "source": "n8nio",
        "author": rec.get("author") or "",
        **build.describe(map_workflow(rec["workflow"]), meta),
    }
    if imported.get(str(rec["id"])):
        t["workflowId"] = imported[str(rec["id"])]
    build.add_icon_paths(t["nodes"], types)
    # n8n.io's names for node types this n8n does not have.
    upstream_nodes = {n.get("name"): n for n in rec.get("nodes") or []}
    for n in t["nodes"]:
        up = upstream_nodes.get(n["name"])
        if up and n["name"] not in meta:
            n["displayName"] = up.get("displayName") or n["displayName"]
            n["icon"] = up.get("icon") or n["icon"]
    return t


_combined = {"gen": None, "value": None}


def catalog():
    """Local templates plus stored n8n.io ones that are not already among them."""
    local, local_by_id = local_catalog()
    records = library_records()
    meta, types, imported = cached_json(NODE_META, {}), node_types(), cached_json(IMPORTED, {})
    if _combined["gen"] != _gen[0]:
        taken = set(local_by_id) | {t.get("templateId") for t in local["templates"]}
        cat_id = max((c["id"] for c in local["categories"]), default=0) + 1
        extra = []
        for tid, rec in records.items():
            if tid in taken:
                continue
            try:
                extra.append(library_entry(rec, cat_id, meta, types, imported))
            except (KeyError, TypeError, AttributeError) as exc:
                print(f"library: skipped {tid}.json ({type(exc).__name__}: {exc})", file=sys.stderr, flush=True)
        if extra:
            data = {"categories": local["categories"] + [dict(LIBRARY_CATEGORY, id=cat_id)],
                    "templates": sorted(local["templates"] + extra, key=lambda t: t["name"].lower())}
            value = (data, {t["id"]: t for t in data["templates"]})
        else:
            value = (local, local_by_id)
        _combined.update(gen=_gen[0], value=value)
    return _combined["value"]


def load_workflow(tid):
    path = os.path.join(DATA_DIR, "workflows", f"{tid}.json")
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        rec = library_records().get(tid)
        return map_workflow(rec["workflow"]) if rec else None


class LibraryError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def store_template(tid):
    """Fetch n8n.io template `tid`, clean it and write library/<tid>.json. Returns (record, stored now)."""
    with _lib_lock:
        rec = library_records().get(tid)
        if rec:
            return rec, False
        if tid in local_catalog()[1]:
            raise LibraryError(409, "a local template already has this id")
        if len(library_records()) >= LIBRARY_MAX:
            raise LibraryError(507, f"the library is full ({LIBRARY_MAX} templates); delete some files from it")
        try:
            data = upstream(f"/templates/workflows/{tid}")
        except UpstreamError as exc:
            raise LibraryError(502, str(exc)) from None
        w = data.get("workflow") if isinstance(data, dict) else None
        wf = w.get("workflow") if isinstance(w, dict) else None
        nodes = wf.get("nodes") if isinstance(wf, dict) else None
        if not isinstance(nodes, list) or not all(isinstance(n, dict) and isinstance(n.get("type"), str)
                                                  and isinstance(n.get("name"), str) for n in nodes):
            raise LibraryError(404, "n8n.io has no importable workflow with this id")
        if (w.get("price") or 0) > 0 or w.get("purchaseUrl"):
            raise LibraryError(403, "paid templates cannot be stored")
        user = w.get("user") if isinstance(w.get("user"), dict) else {}
        rec = {
            "id": tid,
            "name": str(w.get("name") or f"Template {tid}")[:300],
            "description": str(w.get("description") or ""),
            "createdAt": str(w.get("createdAt") or ""),
            "savedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "author": str(user.get("name") or user.get("username") or ""),
            "source": f"https://n8n.io/workflows/{tid}",
            "nodes": [{"name": n.get("name"), "displayName": n.get("displayName"), "icon": n.get("icon")}
                      for n in w.get("nodes") or [] if isinstance(n, dict)],
            "workflow": build.clean(wf),
        }
        path = os.path.join(LIBRARY_DIR, f"{tid}.json")
        try:
            with open(path + ".tmp", "w", encoding="utf-8") as fh:
                json.dump(rec, fh, ensure_ascii=False)
            os.replace(path + ".tmp", path)
        except OSError as exc:
            try:
                os.unlink(path + ".tmp")
            except OSError:
                pass
            raise LibraryError(503, f"the library folder is not writable ({type(exc).__name__})") from None
        print(f"library: stored template {tid}", file=sys.stderr, flush=True)
    return rec, True


def category_refs(t, cats):
    names = {c["id"]: c["name"] for c in cats}
    return [{"id": cid, "name": names[cid]} for cid in t["categoryIds"] if cid in names]


def author(t):
    if t.get("source") == "n8nio":
        return dict(AUTHOR, name=t.get("author") or "n8n.io community", username="n8n.io")
    return AUTHOR


def listing(t):
    return {
        "id": t["id"],
        "name": t["name"],
        "totalViews": 0,
        "price": 0,
        "purchaseUrl": None,
        "user": author(t),
        "description": t["description"],
        "createdAt": t["createdAt"],
        "nodes": t["nodes"],
    }


def detail(t, wf, cats):
    return {
        "id": t["id"],
        "name": t["name"],
        "views": 0,
        "recentViews": 0,
        "totalViews": 0,
        "createdAt": t["createdAt"],
        "description": t["description"],
        "workflow": wf,
        "lastUpdatedBy": None,
        "workflowInfo": {"nodeCount": t["nodeCount"], "nodeTypes": {k: {"count": v} for k, v in t["nodeTypeCounts"].items()}},
        "status": "published",
        "reviewStatus": "approved",
        "readyToDemo": None,
        "user": author(t),
        "nodes": t["nodes"],
        "categories": category_refs(t, cats),
        "image": [],
    }


def node_types():
    """Node types this n8n has, from build.py; reloaded when the file changes."""
    return cached_json(NODE_TYPES, {}).get("types", {})


def custom_map():
    """CUSTOM.<name> -> the one installed community type ending in .<name>, when there is exactly one.

    n8n's own nodes are never targets: a custom node that shares a built-in
    node's name is a different node."""
    by_name = {}
    for t in node_types():
        if not t.startswith(("CUSTOM.", "n8n-nodes-base.", "@n8n/")):
            by_name.setdefault(t.rsplit(".", 1)[-1], []).append(t)
    return {f"CUSTOM.{name}": hits[0] for name, hits in by_name.items() if len(hits) == 1}


def map_custom_nodes(data):
    """Copy of an upstream template answer with CUSTOM.* node types mapped (see custom_map)."""
    mapping = custom_map()
    raw = json.dumps(data)
    if "CUSTOM." not in raw or not mapping:
        return data
    data = json.loads(raw)  # never change the cached object
    def fix_nodes(nodes, key):
        for n in nodes or []:
            if isinstance(n, dict) and n.get(key) in mapping:
                n[key] = mapping[n[key]]
    root = data.get("workflow") if isinstance(data.get("workflow"), dict) else {}
    fix_nodes(root.get("nodes"), "type")                                   # /workflows/templates/<id>
    inner = root.get("workflow") if isinstance(root.get("workflow"), dict) else {}
    fix_nodes(inner.get("nodes"), "type")                                  # /templates/workflows/<id>
    fix_nodes(root.get("nodes"), "name")                                   # its node list
    info = (root.get("workflowInfo") or {}).get("nodeTypes")
    if isinstance(info, dict):
        root["workflowInfo"]["nodeTypes"] = {mapping.get(k, k): v for k, v in info.items()}
    return data


_upstream_cache = {}
_upstream_lock = threading.Lock()


class UpstreamError(Exception):
    pass


def upstream(path, params=None):
    """GET UPSTREAM + path as JSON, cached. Raises UpstreamError."""
    if not UPSTREAM:
        raise UpstreamError("n8n.io library is turned off (TEMPLATES_UPSTREAM is empty)")
    url = UPSTREAM + path + (("?" + urlencode(params)) if params else "")
    now = time.time()
    with _upstream_lock:
        hit = _upstream_cache.get(url)
        if hit and now - hit[0] < UPSTREAM_TTL:
            return hit[1]
    req = urllib.request.Request(url, headers={"User-Agent": "n8n-local-templates/1", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read(UPSTREAM_MAX_BYTES + 1)
    except urllib.error.HTTPError as exc:
        raise UpstreamError(f"n8n.io answered HTTP {exc.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise UpstreamError(f"n8n.io is unreachable ({type(exc).__name__})") from None
    if len(raw) > UPSTREAM_MAX_BYTES:
        raise UpstreamError("n8n.io answer too large")
    try:
        data = json.loads(raw)
    except ValueError:
        raise UpstreamError("n8n.io answer is not JSON") from None
    with _upstream_lock:
        if len(_upstream_cache) > 300:
            for key in sorted(_upstream_cache, key=lambda k: _upstream_cache[k][0])[:100]:
                del _upstream_cache[key]
        _upstream_cache[url] = (now, data)
    return data


def upstream_search(qs):
    """n8n.io search, trimmed to what the ideas page shows."""
    def one(key, default="", limit=200):
        return (qs.get(key, [default])[0] or default)[:limit]
    params = {"page": one("page", "1", 4), "rows": one("rows", "24", 3), "search": one("q")}
    if not (params["page"].isdigit() and params["rows"].isdigit() and 1 <= int(params["rows"]) <= 60):
        raise ValueError("page must be a number and rows 1 to 60")
    if one("category"):
        params["category"] = one("category")
    data = upstream("/templates/search", params)
    out = []
    for w in data.get("workflows") or []:
        user = w.get("user") or {}
        out.append({
            "id": w.get("id"),
            "name": w.get("name") or "",
            "description": (w.get("description") or "")[:600],
            "createdAt": w.get("createdAt") or "",
            "totalViews": w.get("totalViews") or 0,
            "price": w.get("price") or 0,
            "purchaseUrl": w.get("purchaseUrl"),
            "author": user.get("name") or user.get("username") or "",
            "nodes": [{"name": n.get("name"), "displayName": n.get("displayName"), "icon": n.get("icon"),
                       "iconData": n.get("iconData")} for n in (w.get("nodes") or [])],
        })
    filters = {f.get("field_name"): f.get("counts") or [] for f in data.get("filters") or []}
    return {"total": data.get("totalWorkflows") or 0, "workflows": out, "categories": filters.get("categories", [])}


def multi(qs, key):
    """Accept key=a,b and key[]=a&key[]=b, the two forms the editor sends."""
    out = []
    for raw in qs.get(key, []) + qs.get(f"{key}[]", []):
        out += [p.strip() for p in raw.split(",") if p.strip()]
    return out


def search(qs):
    cat, by_id = catalog()
    cats = {str(c["id"]): c["id"] for c in cat["categories"]}
    cats.update({c["name"].lower(): c["id"] for c in cat["categories"]})
    want_cats = {cats[c.lower()] for c in multi(qs, "category") if c.lower() in cats}
    want_nodes = set(multi(qs, "nodes") + multi(qs, "apps"))
    combine_and = (qs.get("combineWith", ["or"])[0] or "or").lower() == "and"
    text = (qs.get("search", [""])[0] or "").strip().lower()

    hits = []
    for t in cat["templates"]:
        if want_cats and not want_cats.intersection(t["categoryIds"]):
            continue
        if want_nodes:
            have = set(t["nodeTypeCounts"])
            if combine_and and not want_nodes <= have:
                continue
            if not combine_and and not want_nodes & have:
                continue
        if text and text not in t["name"].lower() and text not in t["description"].lower():
            continue
        hits.append(t)

    sort = (qs.get("sort", [""])[0] or "").lower()
    if sort.startswith("createdat"):
        hits.sort(key=lambda t: t["createdAt"], reverse=sort.endswith("desc"))

    try:
        rows = max(1, min(100, int(qs.get("rows", ["20"])[0])))
        page = max(1, int(qs.get("page", ["1"])[0]))
    except ValueError:
        rows, page = 20, 1
    chunk = hits[(page - 1) * rows : page * rows]
    return {"totalWorkflows": len(hits), "workflows": [listing(t) for t in chunk], "filters": []}


def editor_origin(origin, host_header):
    """True when `origin` can be the n8n editor on the home network."""
    try:
        o = urlsplit(origin)
        port = o.port or (443 if o.scheme == "https" else 80)
    except ValueError:
        return False
    if o.scheme not in ("http", "https") or not o.hostname or port != EDITOR_PORT:
        return False
    name = o.hostname.lower()
    if name == "localhost" or name.endswith(".local"):
        return True
    if host_header and name == (urlsplit("//" + host_header).hostname or "").lower():
        return True
    try:
        ip = ipaddress.ip_address(name)
    except ValueError:
        return False
    return ip.is_loopback or ip.is_private or ip.is_link_local


class Handler(BaseHTTPRequestHandler):
    server_version = "n8n-local-templates/1"

    def cors(self):
        self.send_header("Vary", "Origin")
        origin = self.headers.get("Origin")
        if origin and editor_origin(origin, self.headers.get("Host")):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Credentials", "true")
            return True
        return False

    def send_json(self, status, body):
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def send_file(self, path, ctype, csp):
        try:
            with open(path, "rb") as fh:
                payload = fh.read()
        except FileNotFoundError:
            return self.send_json(404, {"message": "Not found"})
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", csp)
        self.end_headers()
        self.wfile.write(payload)

    def static(self, segs):
        """Ideas page files and copied node icons; True if the path was one of them."""
        key = "/".join(segs)
        if key in WEB_FILES:
            name, ctype, *csp = WEB_FILES[key]
            self.send_file(os.path.join(WEB_DIR, name), ctype, csp[0] if csp else PAGE_CSP)
            return True
        if segs[:1] == ["icons"] and len(segs) > 1 and key.endswith((".svg", ".png")):
            path = os.path.realpath(os.path.join(DATA_DIR, *segs))
            if not path.startswith(os.path.realpath(ICON_DIR) + os.sep):
                self.send_json(404, {"message": "Not found"})
                return True
            ctype = "image/svg+xml" if key.endswith(".svg") else "image/png"
            # An SVG opened on its own must not run script.
            self.send_file(path, ctype, "default-src 'none'; style-src 'unsafe-inline'")
            return True
        return False

    @staticmethod
    def library_path(segs):
        """[<id>] for /local/library/<id> (after any api/ prefix), else None."""
        if segs[:1] == ["api"]:
            segs = segs[1:]
        if len(segs) == 3 and segs[:2] == ["local", "library"] and segs[2].isdigit() and len(segs[2]) <= 9:
            return int(segs[2])
        return None

    def do_OPTIONS(self):
        self.send_response(204)
        if self.cors():
            # POST only where editor-hook.js stores a template.
            segs = [s for s in urlsplit(self.path).path.split("/") if s]
            self.send_header("Access-Control-Allow-Methods",
                             "GET, POST, OPTIONS" if self.library_path(segs) is not None else "GET, OPTIONS")
            requested = self.headers.get("Access-Control-Request-Headers")
            if requested:
                self.send_header("Access-Control-Allow-Headers", requested)
            if self.headers.get("Access-Control-Request-Private-Network") == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        parts = urlsplit(self.path)
        tid = self.library_path([s for s in parts.path.split("/") if s])
        if tid is None:
            return self.send_json(404, {"message": "Not found"})
        # Only this server's own pages and the editor (editor-hook.js). A JSON
        # body makes any other site's request preflight first, and do_OPTIONS
        # sends CORS headers to the editor only; a stated Origin must be one
        # of the two.
        origin = self.headers.get("Origin")
        host = self.headers.get("Host")
        if origin and urlsplit(origin).netloc.lower() != (host or "").lower() and not editor_origin(origin, host):
            return self.send_json(403, {"message": "Only the ideas page and the editor can store templates"})
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            return self.send_json(415, {"message": "Send Content-Type: application/json"})
        length = self.headers.get("Content-Length") or "0"
        if not length.isdigit() or int(length) > 1024:
            return self.send_json(413, {"message": "No body is needed"})
        self.rfile.read(int(length))
        try:
            rec, stored = store_template(tid)
            return self.send_json(201 if stored else 200, {"id": rec["id"], "name": rec["name"], "stored": stored})
        except LibraryError as exc:
            return self.send_json(exc.status, {"message": str(exc)})
        except Exception as exc:  # keep serving; report without request details
            print(f"error handling {parts.path}: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
            return self.send_json(500, {"message": "Internal error"})

    def do_GET(self):
        parts = urlsplit(self.path)
        segs = [s for s in parts.path.split("/") if s]
        qs = parse_qs(parts.query, keep_blank_values=True)
        try:
            if segs[:1] != ["api"] and self.static(segs):
                return
            if segs[:1] == ["api"]:
                segs = segs[1:]
            self.route(segs, qs)
        except Exception as exc:  # keep serving; report without request details
            print(f"error handling {parts.path}: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
            self.send_json(500, {"message": "Internal error"})

    def route(self, segs, qs):
        cat, by_id = catalog()
        if segs == ["health"]:
            return self.send_json(200, {"status": "OK"})
        if segs == ["templates", "categories"]:
            return self.send_json(200, {"categories": [
                {"id": c["id"], "name": c["name"], "displayName": None, "icon": c["icon"], "parent": None}
                for c in cat["categories"]
            ]})
        if segs == ["local", "catalog"]:
            # The whole catalog, for the ideas page (it filters in the browser).
            return self.send_json(200, cat)
        if segs == ["local", "node-types"]:
            # Node types this n8n has, written by build.py: lets the page flag
            # n8n.io templates that need a node that is not installed here.
            return self.send_json(200, {"types": node_types(), "customMap": custom_map()})
        if segs[:1] == ["n8nio"]:
            try:
                if segs == ["n8nio", "search"]:
                    return self.send_json(200, upstream_search(qs))
                if segs == ["n8nio", "categories"]:
                    return self.send_json(200, upstream("/templates/categories"))
            except UpstreamError as exc:
                return self.send_json(502, {"message": str(exc)})
            except ValueError as exc:
                return self.send_json(400, {"message": str(exc)})
            return self.send_json(404, {"message": "Not found"})
        if segs == ["templates", "collections"]:
            return self.send_json(200, {"collections": []})
        if segs == ["templates", "search"]:
            return self.send_json(200, search(qs))
        if len(segs) == 3 and segs[2].isdigit() and segs[:2] in (["templates", "workflows"], ["workflows", "templates"]):
            tid = int(segs[2])
            t = by_id.get(tid)
            wf = load_workflow(tid) if t else None
            if not wf:
                # Not one of ours: hand over n8n.io's answer as it is, so the
                # editor's detail page and import route work for its library.
                try:
                    return self.send_json(200, map_custom_nodes(upstream(f"/{segs[0]}/{segs[1]}/{tid}")))
                except UpstreamError as exc:
                    return self.send_json(404, {"message": f"Template not found ({exc})"})
            if segs[0] == "templates":
                return self.send_json(200, {"workflow": detail(t, wf, cat["categories"])})
            return self.send_json(200, {"id": t["id"], "name": t["name"], "workflow": wf})
        return self.send_json(404, {"message": "Not found"})

    def log_message(self, fmt, *args):
        # Method, path and status only: no headers, so cookies never reach the log.
        sys.stderr.write("%s %s %s\n" % (self.command, urlsplit(self.path).path, args[1] if len(args) > 1 else "-"))


if __name__ == "__main__":
    cat, _ = catalog()
    print(f"templates API on :{PORT}, {len(cat['templates'])} templates in {len(cat['categories'])} categories"
          f" ({len(library_records())} stored from n8n.io)", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
