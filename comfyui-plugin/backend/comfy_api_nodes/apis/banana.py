from pydantic import BaseModel, Field


class BananaBaseResponse(BaseModel):
    code: int | None = None
    message: str | None = None
    user_message: str | None = None


class BananaGenerationRequest(BaseModel):
    prompt: str
    model_name: str
    image_paths: list[str] = Field(default_factory=list)
    aspect_ratio: str = "auto"
    resolution: str = "auto"


class BananaSubmitResponse(BaseModel):
    task_id: str | None = None
    status: int | str | None = None
    base: BananaBaseResponse | None = None


class BananaTaskResponse(BaseModel):
    task_id: str | None = None
    status: str
    image_url: str | None = None
    width: int | None = None
    height: int | None = None
    base: BananaBaseResponse | None = None
