"""Stand-in for agent_framework.openai: the client keeps what it was given, so the scripted run can report it."""


class OpenAIChatCompletionClient:
    def __init__(self, model=None, *, api_key=None, base_url=None):
        self.model = model
        self.api_key = api_key
        self.base_url = base_url
