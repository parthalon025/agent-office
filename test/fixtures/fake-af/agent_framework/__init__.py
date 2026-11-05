"""A stand-in for Microsoft Agent Framework, for test/agent-framework.test.mjs. Not the framework.

It has the names and shapes the office runner uses (Agent, FunctionTool, Content, AgentResponseUpdate, WorkflowEvent,
agent_framework.openai.OpenAIChatCompletionClient, agent_framework.orchestrations.HandoffBuilder), taken from the
framework's Python sources (1.24, python/packages/core). Its handoff workflow plays one scripted team run and calls the
team's tools, so the test sees the real runner talk to the office. No model, no network.
"""
__version__ = "0.0-fake"


class Content:
    def __init__(self, type, text=None, usage_details=None):
        self.type = type
        self.text = text
        self.usage_details = usage_details


class AgentResponseUpdate:
    def __init__(self, contents, author_name=None, response_id=None):
        self.contents = contents
        self.author_name = author_name
        self.response_id = response_id
        self.message_id = None


class WorkflowEvent:
    def __init__(self, type, data=None, executor_id=None, request_id=None, details=None):
        self.type = type
        self.data = data
        self.executor_id = executor_id
        self.request_id = request_id
        self.details = details


class FunctionTool:
    def __init__(self, *, name, description="", func=None, input_model=None, approval_mode=None):
        self.name = name
        self.description = description
        self.func = func
        self.input_model = input_model
        self.approval_mode = approval_mode

    async def invoke(self, **arguments):
        return await self.func(**arguments)


class Agent:
    def __init__(self, *, client, name, instructions, description=None, tools=None):
        self.client = client
        self.name = name
        self.instructions = instructions
        self.description = description
        self.tools = list(tools or [])

    def tool(self, name):
        return next(t for t in self.tools if t.name == name)
