from typing import Optional

from pydantic import BaseModel, Field


class DesignGatewayBaseResponse(BaseModel):
    code: Optional[int] = None
    message: Optional[str] = None
    user_message: Optional[str] = None


class DesignGatewayUploadRequest(BaseModel):
    file_data: str
    file_prefix: str = "image"


class DesignGatewayUploadResponse(BaseModel):
    url: str


class GImage2GenerationRequest(BaseModel):
    prompt: str
    model: str = "gpt-image-2"
    size: str
    image_paths: list[str] = Field(default_factory=list)
    quality: str = "medium"
    n: int = Field(1, ge=1, le=4)


class GImage2SubmitResponse(BaseModel):
    task_id: Optional[str] = None
    status: Optional[int | str] = None
    base: Optional[DesignGatewayBaseResponse] = None


class GImage2TaskResponse(BaseModel):
    task_id: Optional[str] = None
    status: str
    image_url: Optional[str] = None
    image_urls: list[str] = Field(default_factory=list)
    width: Optional[int] = None
    height: Optional[int] = None
    base: Optional[DesignGatewayBaseResponse] = None
