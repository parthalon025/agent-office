"""Stand-in for agent_framework.orchestrations: a handoff workflow that plays one scripted team run.

Run 1 (a user message): the lead says it looks, lists the folder (LS), hands off to coder; coder runs Bash, reports its
tokens, finishes; the team asks the user for input (HandoffAgentUserRequest). Run 2 (the user's answer): the lead answers
with the text it got, the model client's address and model, and the run ends. A run that stays in a tool call is stopped
by the runner (cancel), as the office's Stop does.
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


class SequentialBuilder:
    def __init__(self, *, participants=()):
        self.participants = list(participants)

    def build(self):
        return Workflow(self.participants, self.participants[0])
