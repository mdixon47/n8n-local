#!/usr/bin/env python3
"""Build the local Templates gallery from workflows tagged `template` in n8n.

Usage (from the project root):
  python3 -I templates-api/build.py                 # runs ./n8nctl.sh export first
  python3 -I templates-api/build.py --export DIR    # use an existing export

Reads an `n8nctl.sh export` folder (workflows/*.json), keeps workflows carrying
the `template` tag, and writes templates-api/data/ for server.py. Tags named
`tpl: <Category>` become gallery categories. The running server picks up the
new catalog on its next request; no restart needed.

Each template is cleaned before it is served, because the gallery answers
without a login: credentials, pinned data, static data, webhook ids and
instance-specific settings are removed. Prints counts only, never contents.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "templates-api", "data")
NODES_JSON = "/home/node/.cache/n8n/public/types/nodes.json"  # served to the editor as /types/nodes.json
CATEGORY_PREFIX = "tpl: "
ICONS = {"Gmail & Email": "✉️", "Discord": "💬", "Social Media": "📣", "Drive & Sheets": "📁", "OpenAI & LLMs": "✨"}


def die(msg):
    sys.exit(f"build.py: {msg}")


def newest_export():
    subprocess.run([os.path.join(ROOT, "n8nctl.sh"), "export"], cwd=ROOT, check=True)
    base = os.environ.get("N8N_EXPORT_DIR", os.path.join(ROOT, "exports"))
    dirs = sorted(d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d, "workflows")))
    if not dirs:
        die(f"no export found under {base}")
    return os.path.join(base, dirs[-1])


def node_metadata():
    """displayName/icon per node type, from the running n8n container."""
    files = []
    for f in ("compose.yml", "compose.override.yml"):
        p = os.path.join(ROOT, "n8n", f)
        if os.path.exists(p):
            files += ["-f", p]
    try:
        cid = subprocess.run(["docker", "compose", *files, "ps", "-q", "n8n"], capture_output=True, text=True, check=True).stdout.strip()
        raw = subprocess.run(["docker", "exec", cid, "cat", NODES_JSON], capture_output=True, check=True).stdout
        types = json.loads(raw)
    except (subprocess.CalledProcessError, json.JSONDecodeError, FileNotFoundError) as exc:
        print(f"warning: node metadata unavailable ({type(exc).__name__}); cards will show type names", file=sys.stderr)
        return {}
    meta = {}
    for t in types:
        versions = t.get("version", 1)
        top = max(versions) if isinstance(versions, list) else versions
        prev = meta.get(t["name"])
        if prev and prev["_v"] >= top:
            continue
        icon = t.get("icon")
        meta[t["name"]] = {
            "_v": top,
            "displayName": t.get("displayName") or t["name"],
            "icon": icon if isinstance(icon, str) else None,
            # Relative to the n8n origin; the editor prefixes its own base URL and picks light/dark.
            "iconUrl": t.get("iconUrl"),
            "iconColor": t.get("iconColor"),
            "group": t.get("group") or ["transform"],
            "defaults": {k: v for k, v in (t.get("defaults") or {}).items() if k in ("name", "color")},
            "categories": ((t.get("codex") or {}).get("categories")) or [],
        }
    return meta


def stable_id(n8n_id):
    """Numeric template id derived from the n8n workflow id, so links survive rebuilds."""
    return int(hashlib.sha1(n8n_id.encode()).hexdigest()[:7], 16)


def first_sticky(nodes):
    notes = [n for n in nodes if n.get("type") == "n8n-nodes-base.stickyNote" and (n.get("parameters") or {}).get("content")]
    notes.sort(key=lambda n: tuple(n.get("position") or [0, 0])[::-1])
    return notes[0]["parameters"]["content"].strip() if notes else ""


def clean(wf):
    nodes = []
    for n in wf["nodes"]:
        n = {k: v for k, v in n.items() if k not in ("credentials", "webhookId")}
        nodes.append(n)
    settings = {"executionOrder": (wf.get("settings") or {}).get("executionOrder", "v1")}
    return {"nodes": nodes, "connections": wf.get("connections") or {}, "settings": settings, "meta": {}}


def card_nodes(type_counts, meta):
    out = []
    for i, (ntype, _) in enumerate(sorted(type_counts.items())):
        if ntype == "n8n-nodes-base.stickyNote":
            continue
        m = meta.get(ntype, {})
        short = ntype.split(".")[-1]
        out.append({
            "id": i + 1,
            "name": ntype,
            "displayName": m.get("displayName", short),
            "icon": m.get("icon"),
            "iconUrl": m.get("iconUrl"),
            "iconColor": m.get("iconColor"),
            "group": json.dumps(m.get("group", ["transform"])),
            "defaults": m.get("defaults") or {"name": m.get("displayName", short)},
            "typeVersion": m.get("_v", 1),
            "codex": {"data": {"categories": m.get("categories", [])}},
            "nodeCategories": [],
        })
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--export", help="existing n8nctl export folder (default: run ./n8nctl.sh export)")
    ap.add_argument("--tag", default="template", help="tag that marks a workflow as a template (default: template)")
    args = ap.parse_args()

    export = os.path.abspath(args.export) if args.export else newest_export()
    src = os.path.join(export, "workflows")
    if not os.path.isdir(src):
        die(f"{src} not found; pass an n8nctl export folder")
    meta = node_metadata()

    picked = []
    for f in sorted(os.listdir(src)):
        if not f.endswith(".json"):
            continue
        with open(os.path.join(src, f), encoding="utf-8") as fh:
            wf = json.load(fh)
        tags = [t.get("name", "") for t in (wf.get("tags") or [])]
        if args.tag in tags and not wf.get("isArchived"):
            picked.append((wf, tags))
    if not picked:
        die(f"no workflows tagged '{args.tag}' in {export}")

    cat_names = sorted({t[len(CATEGORY_PREFIX):] for _, tags in picked for t in tags if t.startswith(CATEGORY_PREFIX)})
    if any(not any(t.startswith(CATEGORY_PREFIX) for t in tags) for _, tags in picked):
        cat_names.append("Other")
    categories = [{"id": i + 1, "name": n, "icon": ICONS.get(n, "🏷️")} for i, n in enumerate(cat_names)]
    cat_id = {c["name"]: c["id"] for c in categories}

    stage = tempfile.mkdtemp(prefix=".build-", dir=os.path.dirname(OUT))
    os.makedirs(os.path.join(stage, "workflows"))
    templates, seen = [], set()
    for wf, tags in picked:
        tid = stable_id(wf["id"])
        if tid in seen:
            die(f"template id collision for workflow {wf['id']}; rename or retag one of them")
        seen.add(tid)
        cleaned = clean(wf)
        counts = {}
        for n in cleaned["nodes"]:
            counts[n["type"]] = counts.get(n["type"], 0) + 1
        cats = [cat_id[t[len(CATEGORY_PREFIX):]] for t in tags if t.startswith(CATEGORY_PREFIX)] or [cat_id["Other"]]
        templates.append({
            "id": tid,
            "name": wf["name"],
            "description": (wf.get("description") or "").strip() or first_sticky(wf["nodes"]),
            "createdAt": wf.get("createdAt") or "",
            "categoryIds": cats,
            "nodeCount": len(cleaned["nodes"]),
            "nodeTypeCounts": counts,
            "nodes": card_nodes(counts, meta),
        })
        with open(os.path.join(stage, "workflows", f"{tid}.json"), "w", encoding="utf-8") as fh:
            json.dump(cleaned, fh, ensure_ascii=False)
    templates.sort(key=lambda t: t["name"].lower())
    with open(os.path.join(stage, "catalog.json"), "w", encoding="utf-8") as fh:
        json.dump({"categories": categories, "templates": templates}, fh, ensure_ascii=False)

    # Swap in the new data: workflows first, catalog last (the server reloads on catalog change).
    os.makedirs(OUT, exist_ok=True)
    old_wf = os.path.join(OUT, "workflows")
    if os.path.isdir(old_wf):
        shutil.rmtree(old_wf)
    os.replace(os.path.join(stage, "workflows"), old_wf)
    os.replace(os.path.join(stage, "catalog.json"), os.path.join(OUT, "catalog.json"))
    shutil.rmtree(stage, ignore_errors=True)
    for dp, dirs, files in os.walk(OUT):
        os.chmod(dp, 0o755)
        for f in files:
            os.chmod(os.path.join(dp, f), 0o644)

    print(f"Built {len(templates)} templates in {len(categories)} categories from {export}")
    for c in categories:
        print(f"  {c['name']}: {sum(c['id'] in t['categoryIds'] for t in templates)}")
    print(f"  node metadata: {'from n8n' if meta else 'unavailable'}")


if __name__ == "__main__":
    main()
