#!/usr/bin/env python3
"""Build the local Templates gallery from workflows tagged `template` in n8n.

Usage (from the project root):
  python3 -I templates-api/build.py                 # runs ./n8nctl.sh export first
  python3 -I templates-api/build.py --export DIR    # use an existing export

Reads an `n8nctl.sh export` folder (workflows/*.json), keeps workflows carrying
the `template` tag, and writes templates-api/data/ for server.py. Tags named
`tpl: <Category>` become gallery categories. The running server picks up the
new catalog on its next request; no restart needed.

Besides what the editor's in-app gallery reads, each catalog entry carries
what the ideas page (templates-api/web/) filters on: trigger kinds, the apps
used, the apps that need a credential, an AI flag, and node types this n8n
does not have (disabled, removed, or from an uninstalled community package). Node
icons are copied into data/icons/, because n8n serves its own only to
signed-in users. data/node-types.json lists every node type this n8n has,
with its icon, so the page can do the same for n8n.io templates.

Each template is cleaned before it is served, because the gallery answers
without a login: credentials, pinned data, static data, webhook ids and
instance-specific settings are removed. Prints counts only, never contents.
"""

import argparse
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "templates-api", "data")
NODES_JSON = "/home/node/.cache/n8n/public/types/nodes.json"  # served to the editor as /types/nodes.json
CATEGORY_PREFIX = "tpl: "
ICONS = {"Gmail & Email": "✉️", "Discord": "💬", "Social Media": "📣", "Drive & Sheets": "📁", "OpenAI & LLMs": "✨"}
LANGCHAIN = "@n8n/n8n-nodes-langchain."

# Trigger node type -> kind shown on the ideas page. Other triggers are "App event".
TRIGGER_KINDS = {
    "n8n-nodes-base.manualTrigger": "Manual",
    "n8n-nodes-base.webhook": "Webhook",
    "n8n-nodes-base.scheduleTrigger": "Schedule",
    "n8n-nodes-base.cron": "Schedule",
    "n8n-nodes-base.interval": "Schedule",
    "n8n-nodes-base.formTrigger": "Form",
    "n8n-nodes-base.executeWorkflowTrigger": "Sub-workflow",
    "n8n-nodes-base.errorTrigger": "Error",
    LANGCHAIN + "chatTrigger": "Chat",
    LANGCHAIN + "manualChatTrigger": "Chat",
}
TRIGGER_ORDER = ["App event", "Schedule", "Webhook", "Form", "Chat", "Sub-workflow", "Error", "Manual"]
# LangChain building blocks that are not an outside service.
GENERIC_LANGCHAIN = ("agent", "chain", "memoryBuffer", "outputParser", "textSplitter", "tool", "informationExtractor",
                     "sentimentAnalysis", "textClassifier", "code", "documentDefaultDataLoader", "vectorStoreInMemory",
                     "retriever", "manualChatTrigger", "chatTrigger", "mcpTrigger", "embeddingsInMemory", "memoryManager")


def die(msg):
    sys.exit(f"build.py: {msg}")


def newest_export():
    subprocess.run([os.path.join(ROOT, "n8nctl.sh"), "export"], cwd=ROOT, check=True)
    base = os.environ.get("N8N_EXPORT_DIR", os.path.join(ROOT, "exports"))
    dirs = sorted(d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d, "workflows")))
    if not dirs:
        die(f"no export found under {base}")
    return os.path.join(base, dirs[-1])


def n8n_container():
    files = []
    for f in ("compose.yml", "compose.override.yml"):
        p = os.path.join(ROOT, "n8n", f)
        if os.path.exists(p):
            files += ["-f", p]
    try:
        return subprocess.run(["docker", "compose", *files, "ps", "-q", "n8n"], capture_output=True, text=True, check=True).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


def node_metadata():
    """displayName/icon per node type, from the running n8n container."""
    try:
        cid = n8n_container()
        if not cid:
            raise FileNotFoundError("n8n is not running")
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
            "needsCredential": any(c.get("required") for c in t.get("credentials") or []),
        }
    return meta


def stable_id(n8n_id):
    """Numeric template id derived from the n8n workflow id, so links survive rebuilds."""
    return int(hashlib.sha1(n8n_id.encode()).hexdigest()[:7], 16)


def first_sticky(nodes):
    notes = [n for n in nodes if n.get("type") == "n8n-nodes-base.stickyNote" and (n.get("parameters") or {}).get("content")]
    notes.sort(key=lambda n: tuple(n.get("position") or [0, 0])[::-1])
    return notes[0]["parameters"]["content"].strip() if notes else ""


def is_trigger(ntype, meta):
    return ntype in TRIGGER_KINDS or "trigger" in meta.get(ntype, {}).get("group", []) or ntype.lower().endswith("trigger")


def trigger_kinds(types, meta):
    kinds = {TRIGGER_KINDS.get(t, "App event") for t in types if is_trigger(t, meta)}
    return [k for k in TRIGGER_ORDER if k in kinds]


def app_name(ntype, meta):
    """The outside service a node talks to, or None for core and AI building-block nodes."""
    if ntype == "n8n-nodes-base.stickyNote" or ntype in TRIGGER_KINDS:
        return None
    m = meta.get(ntype, {})
    short = ntype.split(".")[-1]
    if ntype.startswith(LANGCHAIN):
        if short.startswith(GENERIC_LANGCHAIN):
            return None
    elif not m or "Core Nodes" in m.get("categories", []):
        return None
    name = m.get("displayName", short)
    for suffix in (" Trigger", " Chat Model", " Chat Memory", " Vector Store", " Tool", " Model"):
        if name.endswith(suffix):
            name = name[: -len(suffix)]
    if name.startswith("Embeddings "):
        name = name[len("Embeddings "):]
    return name.strip() or None


def icon_paths(url):
    """Icon URL(s) from nodes.json -> list of 'icons/<package>/<path>' strings."""
    vals = url.values() if isinstance(url, dict) else [url]
    return [v for v in vals if isinstance(v, str) and v.startswith("icons/") and v.endswith((".svg", ".png")) and ".." not in v]


def copy_icons(urls, dest_root):
    """Copy node icons out of the n8n container into dest_root. Returns the set copied."""
    if not urls:
        return set()
    by_pkg = {}
    for u in sorted(urls):
        rest = u[len("icons/"):]
        pkg, path = ("/".join(rest.split("/")[:2]), "/".join(rest.split("/")[2:])) if rest.startswith("@") else (rest.split("/")[0], "/".join(rest.split("/")[1:]))
        by_pkg.setdefault(pkg, []).append(path)
    copied = set()
    cid = n8n_container()
    if not cid:
        return copied
    for pkg, paths in by_pkg.items():
        try:
            root = subprocess.run(["docker", "exec", "-w", "/usr/local/lib/node_modules/n8n", cid, "node", "-p",
                                   f"require('path').dirname(require.resolve('{pkg}/package.json'))"],
                                  capture_output=True, text=True, check=True).stdout.strip().splitlines()[-1]
            raw = subprocess.run(["docker", "exec", "-w", root, cid, "tar", "-cf", "-", *paths],
                                 capture_output=True, check=False).stdout
        except (subprocess.CalledProcessError, IndexError):
            print(f"warning: icons for {pkg} unavailable", file=sys.stderr)
            continue
        dest = os.path.join(dest_root, pkg)
        with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
            for member in tar.getmembers():
                name = member.name
                if not member.isfile() or name.startswith("/") or ".." in name.split("/") or name not in paths:
                    continue
                target = os.path.join(dest, name)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with tar.extractfile(member) as src, open(target, "wb") as out:
                    out.write(src.read())
                copied.add(f"icons/{pkg}/{name}")
    return copied


def flow(wf, meta):
    """Display names along the main connections from the first trigger, e.g. Webhook -> AI Agent."""
    types = {n["name"]: n["type"] for n in wf["nodes"]}
    conns = wf.get("connections") or {}
    start = [n["name"] for n in wf["nodes"] if is_trigger(n["type"], meta)][:1]
    out, seen, queue = [], set(start), list(start)
    while queue and len(out) < 6:
        name = queue.pop(0)
        label = meta.get(types.get(name, ""), {}).get("displayName") or name
        if label not in out:
            out.append(label)
        for branch in (conns.get(name) or {}).get("main") or []:
            for c in branch or []:
                if c.get("node") in types and c["node"] not in seen:
                    seen.add(c["node"])
                    queue.append(c["node"])
    return out if len(out) > 1 else []


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
        apps = sorted({a for a in (app_name(t, meta) for t in counts) if a})
        # From n8n's node definitions: templates arrive with their credentials stripped.
        needs = sorted({a for a in (app_name(t, meta) for t in counts if meta.get(t, {}).get("needsCredential")) if a})
        templates.append({
            "id": tid,
            "name": wf["name"],
            "description": (wf.get("description") or "").strip() or first_sticky(wf["nodes"]),
            "createdAt": wf.get("createdAt") or "",
            "updatedAt": wf.get("updatedAt") or "",
            "categoryIds": cats,
            "nodeCount": sum(1 for n in cleaned["nodes"] if n["type"] != "n8n-nodes-base.stickyNote"),
            "nodeTypeCounts": counts,
            "nodes": card_nodes(counts, meta),
            "workflowId": wf["id"],
            "triggers": trigger_kinds(counts, meta),
            "flow": flow(wf, meta),
            "apps": apps,
            "needsCredentials": needs,
            "ai": any(t.startswith(LANGCHAIN) or "AI" in meta.get(t, {}).get("categories", []) for t in counts),
            "missingNodes": sorted(t for t in counts if meta and t not in meta and t != "n8n-nodes-base.stickyNote"),
        })
        with open(os.path.join(stage, "workflows", f"{tid}.json"), "w", encoding="utf-8") as fh:
            json.dump(cleaned, fh, ensure_ascii=False)
    templates.sort(key=lambda t: t["name"].lower())
    # Icons for every node type, not only the ones used here: n8n.io templates use others.
    wanted = {p for m in meta.values() for p in icon_paths(m.get("iconUrl"))}
    copied = copy_icons(wanted, os.path.join(stage, "icons"))
    types = {}
    for name, m in meta.items():
        url = m.get("iconUrl")
        light = url.get("light") if isinstance(url, dict) else url
        dark = url.get("dark") if isinstance(url, dict) else None
        types[name] = {k: v for k, v in {
            "displayName": m["displayName"],
            "icon": m.get("icon"),
            "iconPath": light if light in copied else None,
            "iconPathDark": dark if dark in copied else None,
        }.items() if v}
    with open(os.path.join(stage, "node-types.json"), "w", encoding="utf-8") as fh:
        json.dump({"types": types}, fh, ensure_ascii=False)
    for t in templates:
        for n in t["nodes"]:
            url = n.get("iconUrl")
            light = url.get("light") if isinstance(url, dict) else url
            dark = url.get("dark") if isinstance(url, dict) else None
            if light in copied:
                n["iconPath"] = light
            if dark in copied:
                n["iconPathDark"] = dark
    with open(os.path.join(stage, "catalog.json"), "w", encoding="utf-8") as fh:
        json.dump({"categories": categories, "templates": templates}, fh, ensure_ascii=False)

    # Swap in the new data: workflows first, catalog last (the server reloads on catalog change).
    os.makedirs(OUT, exist_ok=True)
    for sub_dir in ("workflows", "icons"):
        old = os.path.join(OUT, sub_dir)
        if os.path.isdir(old):
            shutil.rmtree(old)
        if os.path.isdir(os.path.join(stage, sub_dir)):
            os.replace(os.path.join(stage, sub_dir), old)
    os.replace(os.path.join(stage, "node-types.json"), os.path.join(OUT, "node-types.json"))
    os.replace(os.path.join(stage, "catalog.json"), os.path.join(OUT, "catalog.json"))
    shutil.rmtree(stage, ignore_errors=True)
    for dp, dirs, files in os.walk(OUT):
        os.chmod(dp, 0o755)
        for f in files:
            os.chmod(os.path.join(dp, f), 0o644)

    print(f"Built {len(templates)} templates in {len(categories)} categories from {export}")
    for c in categories:
        print(f"  {c['name']}: {sum(c['id'] in t['categoryIds'] for t in templates)}")
    print(f"  node metadata: {'from n8n' if meta else 'unavailable'}; icons copied: {len(copied)} of {len(wanted)}")


if __name__ == "__main__":
    main()
