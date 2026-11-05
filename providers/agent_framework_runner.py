"""Agent Office runner for a Microsoft Agent Framework team (providers/agent-framework.mjs starts it).

One process per office session. It builds the team from the start line, runs one workflow run per user message, and
writes the framework's events as JSON lines. It never runs a tool itself: every tool of a team member is a proxy that sends
the call to the office and waits for the answer, so the office rates it (risk.mjs), asks the user when it is risky, and runs
it inside the worktree. The model client is the local OpenAI-compatible server the office names (LM Studio or Ollama).

The protocol is in providers/agent-framework.mjs. `python agent_framework_runner.py --check` prints whether the framework
loads. Only the standard library and agent_framework are imported, and the office starts this file with a scrubbed
environment, so no cloud key reaches the framework.
"""
import asyncio
import inspect
import itertools
import json
import sys
import threading


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def error_text(e):
    return f"{type(e).__name__}: {e}"


def version_of(af):
    v = getattr(af, "__version__", None)
    if v:
        return str(v)
    try:
        from importlib.metadata import version

        return version("agent-framework-core")
    except Exception:
        return "unknown"


def check():
    try:
        import agent_framework as af
        from agent_framework.openai import OpenAIChatCompletionClient  # noqa: F401
        from agent_framework.orchestrations import HandoffBuilder, SequentialBuilder  # noqa: F401
    except Exception as e:
        out({"ok": False, "error": error_text(e)})
        return
    out({"ok": True, "version": version_of(af)})


def accepted(fn, kwargs):
    """The keyword arguments fn takes. The framework is young and renames options; an option it does not know is left out,
    and so is an option with no value."""
    kwargs = {k: v for k, v in kwargs.items() if v is not None}
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return kwargs
    if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return kwargs
    return {k: v for k, v in kwargs.items() if k in params}


def contents_of(items):
    """Text and token counts only. Tool calls reach the office as tool lines, and hand-offs as handoff_sent events."""
    out_list = []
    for c in items or []:
        t = getattr(c, "type", None)
        if t == "text" and getattr(c, "text", None):
            out_list.append({"type": "text", "text": str(c.text)})
        elif t == "usage":
            u = getattr(c, "usage_details", None) or {}
            get = u.get if hasattr(u, "get") else (lambda k, d=None: getattr(u, k, d))
            out_list.append({"type": "usage", "input_tokens": int(get("input_token_count") or 0), "output_tokens": int(get("output_token_count") or 0)})
    return out_list


class Runner:
    def __init__(self, loop):
        self.loop = loop
        self.inbox = asyncio.Queue()
        self.waiting = {}
        self.ids = itertools.count(1)
        self.task = None
        self.pending = []  # the team's open requests for user input (a handoff team waits for the user)
        self.queued = []  # messages that came while a run ran: each one is the next run
        self.start = None
        self.workflow = None
        self.af = None
        self.orch = None

    # ----- stdin: a thread, because asyncio cannot read a pipe on every platform -----
    def read_stdin(self):
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                m = json.loads(line)
            except ValueError:
                continue
            self.loop.call_soon_threadsafe(self.inbox.put_nowait, m)
        self.loop.call_soon_threadsafe(self.inbox.put_nowait, {"type": "close"})

    # ----- the team -----
    def proxy(self, agent, d):
        name = d["name"]

        async def call(**kwargs):
            rid = f"t{next(self.ids)}"
            fut = self.loop.create_future()
            self.waiting[rid] = fut
            out({"type": "tool", "id": rid, "agent": agent, "name": name, "input": kwargs})
            try:
                return await fut
            finally:
                self.waiting.pop(rid, None)

        call.__name__ = name
        # never_require: the office decides about approval (risk.mjs), the same way for every agent kind.
        return self.af.FunctionTool(**accepted(self.af.FunctionTool, {
            "name": name, "description": d.get("description", ""), "func": call,
            "input_model": d.get("parameters") or {"type": "object", "properties": {}}, "approval_mode": "never_require",
        }))

    def build(self):
        import agent_framework as af
        from agent_framework import orchestrations as orch
        from agent_framework.openai import OpenAIChatCompletionClient

        self.af, self.orch = af, orch
        s = self.start
        # An explicit key and address: the client never reads OPENAI_* or AZURE_* settings, so it talks to the local server only.
        client = OpenAIChatCompletionClient(**accepted(OpenAIChatCompletionClient, {"model": s["model"], "api_key": "agent-office-local", "base_url": s["base_url"]}))
        defs = {t["function"]["name"]: t["function"] for t in s.get("tools", [])}
        team = s["team"]
        agents = []
        for a in team["agents"]:
            tools = [self.proxy(a["name"], defs[n]) for n in a["tools"] if n in defs]
            agents.append(af.Agent(**accepted(af.Agent, {
                "client": client, "name": a["name"], "description": a.get("description") or None,
                "instructions": a["instructions"], "tools": tools or None,
                "require_per_service_call_history_persistence": True,
            })))
        if team["pattern"] == "sequential":
            # output_from="all": without it only the last agent's replies are workflow output, and the office never sees the
            # others (1.24 _sequential.py build: default_output_from=[participants[-1]]). ensure_trailing_user_turn: the next
            # agent gets a user turn after the one before it, because a chat server can answer an assistant-last prompt with
            # nothing.
            self.workflow = orch.SequentialBuilder(**accepted(orch.SequentialBuilder, {
                "participants": agents, "output_from": "all", "ensure_trailing_user_turn": True,
            })).build()
        else:
            lead = next(x for x in agents if x.name == team["start"])
            self.workflow = orch.HandoffBuilder(**accepted(orch.HandoffBuilder, {"name": team["name"], "participants": agents})).with_start_agent(lead).build()
        self.pending = []

    # ----- one run -----
    def relay(self, ev, streamed):
        """Writes one workflow event. Returns an error text when the run failed."""
        t = getattr(ev, "type", None)
        data = getattr(ev, "data", None)
        ex = getattr(ev, "executor_id", None)
        if t in ("output", "intermediate", "data"):
            if isinstance(data, list):
                return None  # the whole conversation at the end of a run: the updates showed it already
            if hasattr(data, "contents"):
                items = [data]
                streamed.add(ex or getattr(data, "author_name", None))
            elif hasattr(data, "messages") and (ex or getattr(data, "author_name", None)) not in streamed:
                items = list(data.messages or [])
            else:
                return None
            for u in items:
                cs = contents_of(getattr(u, "contents", None))
                if cs:
                    author = getattr(u, "author_name", None) or ex
                    rid = getattr(u, "response_id", None) or getattr(u, "message_id", None)
                    out({"type": "event", "event": "output", "executor_id": ex, "author": author, "response_id": rid, "contents": cs})
        elif t == "handoff_sent":
            out({"type": "event", "event": "handoff_sent", "source": str(getattr(data, "source", "") or ""), "target": str(getattr(data, "target", "") or "")})
        elif t in ("executor_invoked", "executor_completed"):
            out({"type": "event", "event": t, "executor_id": ex})
        elif t == "executor_failed":
            details = getattr(ev, "details", None) or data
            out({"type": "event", "event": t, "executor_id": ex, "error": str(getattr(details, "message", details) or "failed")})
        elif t == "request_info":
            if isinstance(data, getattr(self.orch, "HandoffAgentUserRequest", ())):
                self.pending.append((ev.request_id, data))
            else:
                return f"The team asked for input the office cannot give ({type(data).__name__})."
        elif t == "failed":
            details = getattr(ev, "details", None)
            return str(getattr(details, "message", None) or details or "The workflow failed.")
        return None

    async def turn(self, text):
        try:
            if self.pending:
                answer = self.orch.HandoffAgentUserRequest.create_response
                responses = {rid: answer(text) for rid, _ in self.pending}
                self.pending = []
                stream = self.workflow.run(responses=responses, stream=True)
            else:
                stream = self.workflow.run(text, stream=True)
            error, streamed = None, set()
            async for ev in stream:
                error = self.relay(ev, streamed) or error
            out({"type": "turn_end", **({"error": error} if error else {})})
        except asyncio.CancelledError:
            # A stopped run can leave the workflow half way: build it again (the team forgets this conversation).
            self.rebuild()
            out({"type": "turn_end", "stopped": True})
        except Exception as e:
            self.rebuild()
            out({"type": "turn_end", "error": error_text(e)})
        self.next_run()

    def next_run(self):
        """Starts the next kept message, if there is one. A stop drops the kept messages (the office drops its own too)."""
        if self.queued:
            self.task = asyncio.ensure_future(self.turn(self.queued.pop(0)))

    def rebuild(self):
        for fut in self.waiting.values():
            if not fut.done():
                fut.cancel()
        self.waiting.clear()
        try:
            self.build()
        except Exception as e:
            out({"type": "fatal", "error": error_text(e)})
            sys.stdout.flush()
            raise SystemExit(1)

    async def main(self):
        threading.Thread(target=self.read_stdin, daemon=True).start()
        first = await self.inbox.get()
        if first.get("type") != "start":
            out({"type": "fatal", "error": "The first line must be start."})
            return 1
        self.start = first
        try:
            self.build()
        except Exception as e:
            out({"type": "fatal", "error": error_text(e)})
            return 1
        out({"type": "ready", "version": version_of(self.af)})
        while True:
            m = await self.inbox.get()
            t = m.get("type")
            if t == "message":
                text = str(m.get("text", ""))
                if self.task and not self.task.done():
                    # The office sends a message on its way after turn_end (a Stop hook block); this run may not have ended
                    # yet. Keep it, so it is the next run: a dropped message would leave the office busy for ever.
                    self.queued.append(text)
                    continue
                self.task = asyncio.ensure_future(self.turn(text))
            elif t == "tool_result":
                fut = self.waiting.pop(str(m.get("id", "")), None)
                if fut and not fut.done():
                    fut.set_result(str(m.get("text", "")))
            elif t == "stop":
                self.queued.clear()
                if self.task and not self.task.done():
                    self.task.cancel()
            elif t == "close":
                if self.task and not self.task.done():
                    self.task.cancel()
                    await asyncio.wait([self.task], timeout=2)
                return 0


def main():
    if "--check" in sys.argv[1:]:
        check()
        return 0
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(Runner(loop).main())
    finally:
        loop.close()


if __name__ == "__main__":
    sys.exit(main() or 0)
