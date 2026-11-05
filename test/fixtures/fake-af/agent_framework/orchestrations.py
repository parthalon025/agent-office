"""Stand-in for agent_framework.orchestrations: a handoff workflow that plays one scripted team run.

Run 1 (a user message): the lead says it looks, lists the folder (LS), hands off to coder; coder runs Bash, reports its
tokens, finishes; the team asks the user for input (HandoffAgentUserRequest). Run 2 (the user's answer): the lead answers
with the text it got, the model client's address and model, and the run ends. A run that stays in a tool call is stopped
by the runner (cancel), as the office's Stop does.

The sequential workflow runs each participant in turn: invoked, one reply, completed. Like the real SequentialBuilder
(1.24, `_sequential.py` build: `default_output_from=[participants[-1]]`), only the participants named by `output_from`
surface as `output` events, and without it only the last one does. `ensure_trailing_user_turn` is recorded, so a test can
see the runner asked for it.
"""
from . import AgentResponseUpdate, Content, WorkflowEvent


class HandoffAgentUserRequest:
    def __init__(self, text=""):
        self.text = text

    @staticmethod
    def create_response(text):
        return {"answer": text}


class HandoffSentEvent:
    def __init__(self, source, target):
        self.source = source
        self.target = target


def text(agent, rid, t):
    return WorkflowEvent("output", AgentResponseUpdate([Content("text", text=t)], author_name=agent, response_id=rid), executor_id=agent)


class Workflow:
    def __init__(self, participants, start):
        self.by = {a.name: a for a in participants}
        self.start = start

    async def run(self, message=None, *, responses=None, stream=False):
        lead, coder = self.start, self.by["coder"]
        if responses:
            answer = next(iter(responses.values()))["answer"]
            c = lead.client
            yield text(lead.name, "r3", f"Done. You said: {answer}. Model {c.model} at {c.base_url} with key {c.api_key}.")
            yield WorkflowEvent("status")
            return
        yield WorkflowEvent("executor_invoked", executor_id=lead.name)
        yield text(lead.name, "r1", "I look first. ")
        listing = await lead.tool("LS").invoke(path=".")
        yield text(lead.name, "r1", f"The folder has: {listing}")
        yield WorkflowEvent("executor_completed", executor_id=lead.name)
        yield WorkflowEvent("handoff_sent", HandoffSentEvent(lead.name, "coder"))
        yield WorkflowEvent("executor_invoked", executor_id="coder")
        yield text("coder", "r2", "Running the check.")
        ran = await coder.tool("Bash").invoke(command="echo checked")
        yield text("coder", "r2", f" Result: {ran}")
        usage = {"input_token_count": 120, "output_token_count": 30}
        yield WorkflowEvent("output", AgentResponseUpdate([Content("usage", usage_details=usage)], author_name="coder", response_id="r2"), executor_id="coder")
        yield WorkflowEvent("executor_completed", executor_id="coder")
        yield WorkflowEvent("output", [])  # the whole conversation: the runner skips it
        yield WorkflowEvent("request_info", HandoffAgentUserRequest(), executor_id="coder", request_id="req-1")


class HandoffBuilder:
    def __init__(self, *, name=None, participants=()):
        self.participants = list(participants)
        self.start = None

    def with_start_agent(self, agent):
        self.start = agent
        return self

    def build(self):
        return Workflow(self.participants, self.start)


class SequentialWorkflow:
    def __init__(self, participants, shown, trailing_user_turn):
        self.participants = participants
        self.shown = shown
        self.trailing_user_turn = trailing_user_turn

    async def run(self, message=None, *, responses=None, stream=False):
        for i, a in enumerate(self.participants):
            yield WorkflowEvent("executor_invoked", executor_id=a.name)
            if a.name in self.shown:
                trailing = " (user turn)" if self.trailing_user_turn and i else ""
                yield text(a.name, f"s{i}", f"{a.name} did its part{trailing}.")
            yield WorkflowEvent("executor_completed", executor_id=a.name)
        yield WorkflowEvent("output", [])  # the whole conversation: the runner skips it


class SequentialBuilder:
    def __init__(self, *, name=None, participants=(), checkpoint_storage=None, chain_only_agent_responses=False,
                 output_from=None, intermediate_output_from=None, ensure_trailing_user_turn=False):
        self.participants = list(participants)
        self.output_from = output_from
        self.ensure_trailing_user_turn = ensure_trailing_user_turn

    def build(self):
        names = [a.name for a in self.participants]
        if self.output_from == "all":
            shown = set(names)
        elif self.output_from:
            shown = {getattr(x, "name", x) for x in self.output_from}
        else:
            shown = {names[-1]}
        return SequentialWorkflow(self.participants, shown, self.ensure_trailing_user_turn)
