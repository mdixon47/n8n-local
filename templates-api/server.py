"""Local templates API for the n8n editor's built-in Templates page.

n8n's editor sends its Templates link to n8n.io unless N8N_TEMPLATES_HOST
points somewhere else; with a custom host it opens the in-app gallery and the
browser fetches template data from that host. This server answers the same
endpoints as api.n8n.io, serving the workflows that build.py extracted (those
tagged `template` in this instance).

Standard library only. Reads data/catalog.json and data/workflows/<id>.json,
reloading the catalog when build.py rewrites it. Read-only: GET and OPTIONS.

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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

DATA_DIR = os.environ.get("TEMPLATES_DATA_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
PORT = int(os.environ.get("TEMPLATES_PORT", "8080"))
CATALOG = os.path.join(DATA_DIR, "catalog.json")
EDITOR_PORT = int(os.environ.get("TEMPLATES_EDITOR_PORT", "5678"))

AUTHOR = {"id": 0, "name": "This n8n instance", "username": "local", "bio": "", "verified": False, "links": "[]", "avatar": ""}

_cache = {"mtime": None, "catalog": {"categories": [], "templates": []}, "by_id": {}}


def catalog():
    try:
        mtime = os.stat(CATALOG).st_mtime
    except FileNotFoundError:
        return _cache["catalog"], _cache["by_id"]
    if mtime != _cache["mtime"]:
        with open(CATALOG, encoding="utf-8") as fh:
            data = json.load(fh)
        _cache.update(mtime=mtime, catalog=data, by_id={t["id"]: t for t in data["templates"]})
    return _cache["catalog"], _cache["by_id"]


def load_workflow(tid):
    path = os.path.join(DATA_DIR, "workflows", f"{tid}.json")
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None


def category_refs(t, cats):
    names = {c["id"]: c["name"] for c in cats}
    return [{"id": cid, "name": names[cid]} for cid in t["categoryIds"] if cid in names]


def listing(t):
    return {
        "id": t["id"],
        "name": t["name"],
        "totalViews": 0,
        "price": 0,
        "purchaseUrl": None,
        "user": AUTHOR,
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
        "user": AUTHOR,
        "nodes": t["nodes"],
        "categories": category_refs(t, cats),
        "image": [],
    }


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

    def do_OPTIONS(self):
        self.send_response(204)
        if self.cors():
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            requested = self.headers.get("Access-Control-Request-Headers")
            if requested:
                self.send_header("Access-Control-Allow-Headers", requested)
            if self.headers.get("Access-Control-Request-Private-Network") == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parts = urlsplit(self.path)
        segs = [s for s in parts.path.split("/") if s]
        if segs[:1] == ["api"]:
            segs = segs[1:]
        qs = parse_qs(parts.query, keep_blank_values=True)
        try:
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
        if segs == ["templates", "collections"]:
            return self.send_json(200, {"collections": []})
        if segs == ["templates", "search"]:
            return self.send_json(200, search(qs))
        if len(segs) == 3 and segs[2].isdigit() and segs[:2] in (["templates", "workflows"], ["workflows", "templates"]):
            tid = int(segs[2])
            t = by_id.get(tid)
            wf = load_workflow(tid) if t else None
            if not wf:
                return self.send_json(404, {"message": "Template not found"})
            if segs[0] == "templates":
                return self.send_json(200, {"workflow": detail(t, wf, cat["categories"])})
            return self.send_json(200, {"id": t["id"], "name": t["name"], "workflow": wf})
        return self.send_json(404, {"message": "Not found"})

    def log_message(self, fmt, *args):
        # Method, path and status only: no headers, so cookies never reach the log.
        sys.stderr.write("%s %s %s\n" % (self.command, urlsplit(self.path).path, args[1] if len(args) > 1 else "-"))


if __name__ == "__main__":
    cat, _ = catalog()
    print(f"templates API on :{PORT}, {len(cat['templates'])} templates in {len(cat['categories'])} categories", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
