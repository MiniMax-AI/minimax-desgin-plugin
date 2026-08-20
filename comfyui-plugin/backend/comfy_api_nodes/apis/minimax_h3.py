from typing import Optional

from pydantic import BaseModel, Field


class MinimaxH3BaseResp(BaseModel):
    status_code: Optional[int] = Field(
        None,
        description="Upstream status code. 0 indicates success, other values indicate errors.",
    )
    status_msg: Optional[str] = Field(
        None, description="Upstream raw status message (for agent/ops decisions)."
    )
    user_message: Optional[str] = Field(
        None, description="Localized, user-facing message (for UI display)."
    )


class H3ContextIRRequest(BaseModel):
    model: str = Field("MiniMax-H3", description="Fixed model id. Defaults to MiniMax-H3.")
    prompt: str = Field(..., description="Text description. Required in every scenario.")
    first_frame_image: Optional[str] = Field(
        None, description="First-frame image URL (role=first_frame)."
    )
    last_frame_image: Optional[str] = Field(
        None, description="Last-frame image URL (role=last_frame)."
    )
    reference_images: Optional[list[str]] = Field(
        None, description="Reference image URLs, 0-9 items."
    )
    reference_videos: Optional[list[str]] = Field(
        None, description="Reference video URLs, 0-3 items."
    )
    reference_audios: Optional[list[str]] = Field(
        None, description="Reference audio URLs, 0-3 items."
    )
    ratio: Optional[str] = Field(
        None,
        description="Aspect ratio: adaptive / 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16. "
        "Required (and must not be 'adaptive') for text-only requests.",
    )
    duration: Optional[int] = Field(
        None, description="Target video duration in seconds, range [4, 15]."
    )


class H3ContextIRSubmitResponse(BaseModel):
    task_id: Optional[str] = Field(None, description="Encoded task id used to poll the result.")
    base_resp: Optional[MinimaxH3BaseResp] = None


class H3ContextIRTaskResponse(BaseModel):
    task_id: Optional[str] = Field(None, description="Encoded task id being queried.")
    provider_task_id: Optional[str] = Field(None, description="Upstream provider task id.")
    status: str = Field(
        ..., description="queueing / processing / success / failed. Poll until a terminal state."
    )
    prompt: Optional[str] = Field(
        None, description="Enhanced video prompt. Non-empty only when status=success."
    )
    total_tokens: Optional[int] = Field(None, description="Total tokens used (billing basis).")
    prompt_tokens: Optional[int] = Field(None, description="Prompt tokens used.")
    completion_tokens: Optional[int] = Field(None, description="Completion tokens used.")
    base_resp: Optional[MinimaxH3BaseResp] = None


class GatewayUploadRequest(BaseModel):
    file_data: str = Field(..., description="Data URI of the file: data:<mime>;base64,<...>.")
    file_prefix: str = Field("media", description="Object key prefix for the uploaded file.")


class GatewayUploadResponse(BaseModel):
    url: str = Field(..., description="Public CDN URL of the uploaded file.")


class H3VideoGenerationRequest(BaseModel):
    """Flat payload for the MiniMax design gateway video generation endpoint
    (/api/v1/video/minimax-v3/generate). Mirrors the Hub cloud-gateway contract:
    text-only, first/last frame, and reference (image/video/audio) modes all use
    the same body, differing only in which optional fields are populated."""

    model: str = Field("MiniMax-H3", description="Fixed model id. Defaults to MiniMax-H3.")
    prompt: str = Field(..., description="Text prompt. Required in every scenario.")
    generate_audio: Optional[bool] = Field(
        None, description="Whether to generate a synchronized audio track."
    )
    ratio: Optional[str] = Field(
        None,
        description="Aspect ratio: adaptive / 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16. "
        "First/last-frame mode uses 'adaptive'; text-only requires a fixed ratio.",
    )
    duration: Optional[int] = Field(
        None, description="Target video duration in seconds, range [5, 15]."
    )
    resolution: Optional[str] = Field(
        None, description="Output resolution, e.g. 768P or 2K."
    )
    first_frame_image: Optional[str] = Field(
        None, description="First-frame image URL (first/last-frame mode)."
    )
    last_frame_image: Optional[str] = Field(
        None, description="Last-frame image URL (first/last-frame mode)."
    )
    reference_images: Optional[list[str]] = Field(
        None, description="Reference image URLs, 0-9 items."
    )
    reference_videos: Optional[list[str]] = Field(
        None, description="Reference video URLs, 0-3 items."
    )
    reference_video_durations_ms: Optional[list[int]] = Field(
        None, description="Per-video duration in milliseconds, aligned with reference_videos."
    )
    reference_audios: Optional[list[str]] = Field(
        None, description="Reference audio URLs, 0-3 items."
    )


class H3VideoEnhancementRequest(BaseModel):
    """Payload for enhancing an H3 source video to 2K through the MiniMax
    design gateway. The original generation inputs are forwarded so the model
    can preserve their visual and audio context."""

    resolution: str = Field("2K", description="Fixed enhancement resolution.")
    base_video: str = Field(..., description="URL of the source video to enhance.")
    base_video_duration_ms: int = Field(
        ..., gt=0, description="Source video duration in milliseconds, used for billing."
    )
    prompt: Optional[str] = Field(None, description="Original final generation prompt.")
    first_frame_image: Optional[str] = Field(None, description="Original first-frame image URL.")
    last_frame_image: Optional[str] = Field(None, description="Original last-frame image URL.")
    reference_images: Optional[list[str]] = Field(None, description="Original reference image URLs.")
    reference_videos: Optional[list[str]] = Field(None, description="Original reference video URLs.")
    reference_audios: Optional[list[str]] = Field(None, description="Original reference audio URLs.")


class H3VideoSubmitResponse(BaseModel):
    task_id: Optional[str] = Field(None, description="Encoded task id used to poll the result.")
    base_resp: Optional[MinimaxH3BaseResp] = None


class H3VideoTaskResponse(BaseModel):
    task_id: Optional[str] = Field(None, description="Encoded task id being queried.")
    provider_task_id: Optional[str] = Field(None, description="Upstream provider task id.")
    status: str = Field(
        ..., description="queueing / processing / success / failed. Poll until a terminal state."
    )
    file_id: Optional[str] = Field(
        None, description="File id of the generated video. Present only when status=success."
    )
    estimated_remaining_wait_seconds: Optional[int] = Field(
        None, description="Upstream hint for the remaining wait time."
    )
    base_resp: Optional[MinimaxH3BaseResp] = None


class H3VideoFile(BaseModel):
    download_url: Optional[str] = Field(
        None, description="Public CDN URL to download the generated video."
    )


class H3VideoFileRetrieveResponse(BaseModel):
    file: Optional[H3VideoFile] = None
    base_resp: Optional[MinimaxH3BaseResp] = None
