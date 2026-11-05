"""Agent Office kit x1.6.6: checks for a page or an adapter built with the system.
Usage: python3 kit/check.py [files...] [--events log.jsonl]
Checks: no literal colors in CSS, only known tokens (DS tokens, and custom properties the checked files define) and icons, an x version mark in each title,
no emoji, and (with --events) each event against kit/schema.json. Exit code 1 on an error."""
import json, os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
S = json.load(open(os.path.join(here, "schema.json")))
TOK, ICONS = set(S["tokens"]), set(S["icons"])
# tokens defined in tokens.css (project/tokens.css, or next to the checked files) also count
for _d in (os.path.join(here, ".."), here, os.getcwd()):
    _p = os.path.join(_d, "tokens.css")
    if os.path.exists(_p): TOK |= set(re.findall(r"--([a-z0-9-]+)\s*:", open(_p, encoding="utf-8").read()))
STATES = {"working", "waiting", "error", "resting", "finished"}
errors, warns = [], []

def check_fields(obj, fields, pre="", closed=False):
    out = []
    for k, t in fields.items():
        opt = t.endswith("?"); t = t.rstrip("?"); v = obj.get(k)
        if v is None:
            if not opt: out.append("missing " + pre + k)
            continue
        if t in S.get("types", {}):
            if isinstance(v, dict): out += check_fields(v, S["types"][t]["fields"], pre + k + ".", True)
            else: out.append("%s%s must be %s" % (pre, k, t))
            continue
        if t in S.get("enums", {}):
            if v not in S["enums"][t]: out.append("%s%s must be one of %s" % (pre, k, ", ".join(S["enums"][t])))
            continue
        ok = {"string": isinstance(v, str), "number": isinstance(v, (int, float)) and not isinstance(v, bool),
              "boolean": isinstance(v, bool), "Status": isinstance(v, str) and v in STATES}.get(t, isinstance(v, list) if t.endswith("[]") else isinstance(v, dict))
        if not ok: out.append("%s%s must be %s" % (pre, k, t))
    if closed:   # a typed object: a field that is not listed is a typo (fields that start with _ belong to the engine)
        for k in obj:
            if k not in fields and not k.startswith("_"): out.append("unknown field " + pre + k)
    return out

def check_event(ev, kind="events"):
    sp = S[kind].get(ev.get("type"))
    if not sp: return ["unknown type: %s" % ev.get("type")]
    # common: fields every event can carry (seeded, at)
    fields = dict(S.get("common", {}).get("fields", {}), **sp["fields"]) if kind == "events" else sp["fields"]
    return check_fields(ev, fields)

args = sys.argv[1:]; events = None
if "--events" in args:
    i = args.index("--events"); events = args[i + 1]; args = args[:i] + args[i + 2:]
# DS rule: a custom property that a checked page defines itself also counts as a known token. It is defined in a checked
# CSS file or HTML style block (--name: value), or in a checked JS or HTML file with setProperty('--name', ...). Page-local tokens, such as a
# layout offset that script measures, need no entry in schema.json. A var(--name) that nothing defines is still an error.
for p in args:
    _t = open(p, encoding="utf-8").read()
    _d = _t if p.endswith(".css") else "\n".join(re.findall(r"<style[^>]*>(.*?)</style>", _t, re.S) + re.findall(r'style="([^"]*)"', _t)) if p.endswith(".html") else ""
    TOK |= set(re.findall(r"(?<![a-z0-9-])--([a-z0-9-]+)\s*:", _d))
    TOK |= set(re.findall(r"setProperty\(\s*['\"]--([a-z0-9-]+)", _t))
for p in args:
    s = open(p, encoding="utf-8").read(); n = os.path.basename(p)
    css = "\n".join(re.findall(r"<style[^>]*>(.*?)</style>", s, re.S)) if p.endswith(".html") else (s if p.endswith(".css") else "")
    css += "\n".join(re.findall(r'style="([^"]*)"', s))
    for m in re.finditer(r"#[0-9a-fA-F]{3,8}\b|rgba?\(", css): errors.append("%s: literal color %s (use a token)" % (n, m.group(0)))
    for m in re.finditer(r"var\(--([a-z0-9-]+)", s):
        # a name that ends in "-" is the start of a name built at run time ("var(--status-" + s): some token must start with it
        t = m.group(1)
        if not (any(k.startswith(t) for k in TOK) if t.endswith("-") else t in TOK): errors.append("%s: unknown token --%s" % (n, t))
    for m in re.finditer(r'(?:Icon,\s*\{\s*name:\s*|icon:\s*)"([a-z0-9-]+)"', s):
        t = m.group(1)   # a name that ends in "-" is the start of a name built at run time ("role-" + r)
        if not (any(k.startswith(t) for k in ICONS) if t.endswith("-") else t in ICONS): errors.append("%s: unknown icon %s" % (n, t))
    t = re.search(r"<title>(.*?)</title>", s)
    if t and not re.search(r"\bx\d+\.\d+\b|\b\d+\.\d+\b", t.group(1)): errors.append("%s: title has no version mark (for example x0.1)" % n)
    if re.search("[\U0001F300-\U0001FAFF☀-➿]", s): errors.append("%s: emoji or symbol glyph (use the icon set)" % n)
if events:
    for i, line in enumerate(open(events, encoding="utf-8")):
        line = line.strip()
        if not line: continue
        try: ev = json.loads(line)
        except ValueError: errors.append("%s:%d: not JSON" % (events, i + 1)); continue
        for e in check_event(ev): errors.append("%s:%d: %s: %s" % (events, i + 1, ev.get("type"), e))
for e in errors: print("ERROR", e)
for e in warns: print("WARN", e)
print("OK" if not errors else "%d error(s)" % len(errors))
sys.exit(1 if errors else 0)
