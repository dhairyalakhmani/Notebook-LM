import os
from dotenv import load_dotenv
from openai import OpenAI
load_dotenv()
GROQ_BASE_URL = "https://api.groq.com/openai/v1"
DEFAULT_MODEL = "openai/gpt-oss-120b"
class LLMClient:
    def __init__(self, model: str = DEFAULT_MODEL):
        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GROQ_API_KEY not found. Add it to a .env file in the project root."
            )
        self.client = OpenAI(api_key=api_key, base_url=GROQ_BASE_URL)
        self.model = model
    def generate(self, prompt: str, json_mode: bool = False) -> str:
        kwargs = {}
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            **kwargs,
        )
        return response.choices[0].message.content