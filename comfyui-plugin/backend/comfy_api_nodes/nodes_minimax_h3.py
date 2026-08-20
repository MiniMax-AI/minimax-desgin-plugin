import json
import os
import time
from collections.abc import Iterator
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import torch
from typing_extensions import override

from comfy.cli_args import args
from comfy_api.latest import IO, ComfyExtension, Input
from comfy_api_nodes.apis.minimax_h3 import (
    GatewayUploadRequest,
    GatewayUploadResponse,
    H3ContextIRRequest,
    H3ContextIRSubmitResponse,
    H3ContextIRTaskResponse,
    H3VideoEnhancementRequest,
    H3VideoFileRetrieveResponse,
    H3VideoSubmitResponse,
    H3VideoTaskResponse,
)
from comfy_api_nodes.util import (
    ApiEndpoint,
    download_url_to_video_output,
    poll_op,
    sync_op,
    validate_string,
)
from comfy_api_nodes.util.conversions import (
    audio_to_base64_string,
    tensor_to_data_uri,
    video_to_base64_string,
)

GENERATE_PATH = "/api/v1/video/minimax-v3/h3-context-ir/generate"
TASKS_PATH = "/api/v1/video/minimax-v3/h3-context-ir/tasks"
UPLOAD_PATH = "/api/v1/files/upload"
ENHANCEMENT_GENERATE_PATH = "/api/v1/video/minimax-v3/enhancement/generate"
VIDEO_TASKS_PATH = "/api/v1/video/minimax-v3/tasks"
VIDEO_FILE_RETRIEVE_PATH = "/api/v1/video/minimax/files"

RATIO_OPTIONS = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]
MAX_REFERENCE_IMAGES = 9
MAX_REFERENCE_VIDEOS = 3
MAX_REFERENCE_AUDIOS = 3
MIN_ENHANCEMENT_PIXELS = 768 * 768
MAX_ENHANCEMENT_PIXELS = 768 * 1344
VIDEO_FAILED_STATUSES = ["failed", "fail", "cancelled", "expired"]


def _resolve_api_base() -> str:
    """Base URL of the MiniMax design gateway (host is configured separately)."""
    base = getattr(args, "minimax_design_api_base", None) or os.environ.get("MINIMAX_DESIGN_API_BASE")
    if not base:
        raise ValueError(
            "MiniMax H3 gateway is not configured. Set --minimax-design-api-base or the "
            "MINIMAX_DESIGN_API_BASE environment variable to the gateway base URL."
        )
    return base.rstrip("/")


def _resolve_auth_headers() -> dict[str, str]:
    """Cloud-gateway auth headers built from the Hub user's login token.

    Resolved fresh on every execution (the backend is a long-lived process while
    the token rotates), in priority order:

    1. ``MINIMAX_DESIGN_API_TOKEN`` env var (simplest, but fixed at backend start).
    2. A token file, kept up to date by the Hub side so it survives token refresh:
       ``MINIMAX_DESIGN_API_TOKEN_FILE`` if set, else ``<HUB_PLUGIN_DATA_DIR>/design-api-token``.

    Returns an empty dict when no token is configured (request goes out unauthenticated,
    so the gateway's own error surfaces instead of a confusing local failure).
    """
    token = (os.environ.get("MINIMAX_DESIGN_API_TOKEN") or "").strip()
    if not token:
        token_file = (os.environ.get("MINIMAX_DESIGN_API_TOKEN_FILE") or "").strip()
        if not token_file:
            data_dir = (os.environ.get("HUB_PLUGIN_DATA_DIR") or "").strip()
            if data_dir:
                token_file = os.path.join(data_dir, "design-api-token")
        if token_file and os.path.isfile(token_file):
            try:
                with open(token_file, encoding="utf-8") as f:
                    token = f.read().strip()
            except OSError:
                token = ""
    if not token:
        return {}
    headers = {"token": token, "Authorization": f"Bearer {token}"}
    group_id = (os.environ.get("MINIMAX_DESIGN_API_GROUP_ID") or "").strip()
    if group_id:
        headers["X-Group-Id"] = group_id
    return headers


def _resolve_common_params() -> dict[str, str]:
    """Client common params the cloud gateway requires (version_code, app_id,
    device_id, ...). The Hub gateway builds them (buildCloudCommonParams) and
    hands them down via MINIMAX_DESIGN_COMMON_PARAMS; ``unix`` is refreshed here
    because the backend is long-lived and the injected value goes stale."""
    params: dict[str, str] = {}
    raw = (os.environ.get("MINIMAX_DESIGN_COMMON_PARAMS") or "").strip()
    if raw:
        try:
            loaded = json.loads(raw)
        except ValueError:
            loaded = None
        if isinstance(loaded, dict):
            params = {str(k): str(v) for k, v in loaded.items()}
    params["unix"] = str(int(time.time() * 1000))
    return params


def _with_common_params(url: str) -> str:
    """Append the Hub client common params to a cloud-gateway URL as query."""
    params = _resolve_common_params()
    if not params:
        return url
    scheme, netloc, path, query, fragment = urlsplit(url)
    merged = dict(parse_qsl(query, keep_blank_values=True))
    merged.update(params)
    return urlunsplit((scheme, netloc, path, urlencode(merged), fragment))


def _iter_images(images: dict | None) -> Iterator[torch.Tensor]:
    """Flatten Autogrow image slots (each possibly a batch) into single images."""
    for tensor in (images or {}).values():
        if tensor is None:
            continue
        if len(tensor.shape) > 3:
            for i in range(tensor.shape[0]):
                yield tensor[i]
        else:
            yield tensor


def _first_image(tensor: torch.Tensor | None) -> torch.Tensor | None:
    if tensor is None:
        return None
    return tensor[0] if len(tensor.shape) > 3 else tensor


async def _upload_data_uri(
    cls: type[IO.ComfyNode],
    base: str,
    data_uri: str,
    file_prefix: str,
    wait_label: str,
    headers: dict[str, str] | None = None,
) -> str:
    resp = await sync_op(
        cls,
        ApiEndpoint(path=_with_common_params(f"{base}{UPLOAD_PATH}"), method="POST", headers=headers),
        response_model=GatewayUploadResponse,
        data=GatewayUploadRequest(file_data=data_uri, file_prefix=file_prefix),
        wait_label=wait_label,
        final_label_on_success=None,
    )
    return resp.url


async def _upload_image(
    cls, base: str, image: torch.Tensor, wait_label: str, headers: dict[str, str] | None = None
) -> str:
    return await _upload_data_uri(
        cls, base, tensor_to_data_uri(image, mime_type="image/png"), "image", wait_label, headers
    )


async def _upload_video(
    cls, base: str, video: Input.Video, wait_label: str, headers: dict[str, str] | None = None
) -> str:
    data_uri = f"data:video/mp4;base64,{video_to_base64_string(video)}"
    return await _upload_data_uri(cls, base, data_uri, "media", wait_label, headers)


async def _upload_audio(
    cls, base: str, audio: Input.Audio, wait_label: str, headers: dict[str, str] | None = None
) -> str:
    b64 = audio_to_base64_string(audio, container_format="mp3", codec_name="libmp3lame")
    return await _upload_data_uri(cls, base, f"data:audio/mpeg;base64,{b64}", "media", wait_label, headers)


class MinimaxH3PromptExpandNode(IO.ComfyNode):
    """Enhance a video prompt with the MiniMax-H3 H3-Context-IR endpoint.

    Deeply understands multimodal context (text / images / video / audio) and returns an
    enhanced video prompt. It does not generate a video.
    """

    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="MinimaxH3PromptExpandNode",
            display_name="MiniMax H3 Context IR",
            category="partner/video",
            description="Expand a video prompt using the MiniMax-H3 H3-Context-IR endpoint. "
            "Understands multimodal context (keyframes or reference images/videos/audio) and "
            "returns an enhanced video prompt (it does not generate a video). Keyframe images and "
            "reference media are mutually exclusive.",
            inputs=[
                IO.String.Input(
                    "prompt",
                    multiline=True,
                    default="",
                    tooltip="Text description to expand. Required.",
                ),
                IO.Combo.Input(
                    "ratio",
                    options=RATIO_OPTIONS,
                    default="16:9",
                    tooltip="Aspect ratio. For text-only requests it is required and must not be "
                    "'adaptive'.",
                ),
                IO.Int.Input(
                    "duration",
                    default=5,
                    min=4,
                    max=15,
                    step=1,
                    tooltip="Target video duration in seconds, range 4-15.",
                ),
                IO.Image.Input(
                    "first_frame_image",
                    optional=True,
                    tooltip="First-frame image. Mutually exclusive with reference media.",
                ),
                IO.Image.Input(
                    "last_frame_image",
                    optional=True,
                    tooltip="Last-frame image. Mutually exclusive with reference media.",
                ),
                IO.Autogrow.Input(
                    "reference_images",
                    template=IO.Autogrow.TemplateNames(
                        IO.Image.Input("reference_image"),
                        names=[f"image_{i}" for i in range(1, MAX_REFERENCE_IMAGES + 1)],
                        min=0,
                    ),
                    tooltip=f"Reference images, up to {MAX_REFERENCE_IMAGES}. Mutually exclusive "
                    "with keyframe images.",
                ),
                IO.Autogrow.Input(
                    "reference_videos",
                    template=IO.Autogrow.TemplateNames(
                        IO.Video.Input("reference_video"),
                        names=[f"video_{i}" for i in range(1, MAX_REFERENCE_VIDEOS + 1)],
                        min=0,
                    ),
                    tooltip=f"Reference videos, up to {MAX_REFERENCE_VIDEOS}. Mutually exclusive "
                    "with keyframe images.",
                ),
                IO.Autogrow.Input(
                    "reference_audios",
                    template=IO.Autogrow.TemplateNames(
                        IO.Audio.Input("reference_audio"),
                        names=[f"audio_{i}" for i in range(1, MAX_REFERENCE_AUDIOS + 1)],
                        min=0,
                    ),
                    tooltip=f"Reference audio clips, up to {MAX_REFERENCE_AUDIOS}. Mutually "
                    "exclusive with keyframe images.",
                ),
            ],
            outputs=[IO.String.Output(display_name="prompt")],
            hidden=[
                IO.Hidden.auth_token_comfy_org,
                IO.Hidden.api_key_comfy_org,
                IO.Hidden.unique_id,
            ],
            is_api_node=True,
            price_badge=IO.PriceBadge(
                expr='{"type":"text","text":"~3500 credits/1M tokens"}',
            ),
        )

    @classmethod
    async def execute(
        cls,
        prompt: str,
        ratio: str = "16:9",
        duration: int = 5,
        first_frame_image: torch.Tensor | None = None,
        last_frame_image: torch.Tensor | None = None,
        reference_images: dict | None = None,
        reference_videos: dict | None = None,
        reference_audios: dict | None = None,
    ) -> IO.NodeOutput:
        validate_string(prompt, field_name="prompt", strip_whitespace=True, min_length=1)

        ref_images = list(_iter_images(reference_images))
        ref_videos = [v for v in (reference_videos or {}).values() if v is not None]
        ref_audios = [a for a in (reference_audios or {}).values() if a is not None]

        has_keyframe = first_frame_image is not None or last_frame_image is not None
        has_reference = bool(ref_images) or bool(ref_videos) or bool(ref_audios)
        if has_keyframe and has_reference:
            raise ValueError(
                "Keyframe images (first/last frame) and reference media are mutually exclusive. "
                "Provide either keyframes or reference images/videos/audio, not both."
            )
        if not has_keyframe and not has_reference and (not ratio or ratio == "adaptive"):
            raise ValueError(
                "Text-only requests require an aspect ratio other than 'adaptive'. "
                "Choose a fixed ratio (e.g. 16:9) and retry."
            )
        if len(ref_images) > MAX_REFERENCE_IMAGES:
            raise ValueError(f"Up to {MAX_REFERENCE_IMAGES} reference images are supported.")
        if len(ref_videos) > MAX_REFERENCE_VIDEOS:
            raise ValueError(f"Up to {MAX_REFERENCE_VIDEOS} reference videos are supported.")
        if len(ref_audios) > MAX_REFERENCE_AUDIOS:
            raise ValueError(f"Up to {MAX_REFERENCE_AUDIOS} reference audio clips are supported.")

        base = _resolve_api_base()
        auth_headers = _resolve_auth_headers()

        request = H3ContextIRRequest(prompt=prompt, ratio=ratio, duration=duration)

        if has_keyframe:
            first = _first_image(first_frame_image)
            last = _first_image(last_frame_image)
            if first is not None:
                request.first_frame_image = await _upload_image(cls, base, first, "Uploading first frame", auth_headers)
            if last is not None:
                request.last_frame_image = await _upload_image(cls, base, last, "Uploading last frame", auth_headers)
        else:
            if ref_images:
                request.reference_images = [
                    await _upload_image(cls, base, img, f"Uploading image {i}", auth_headers)
                    for i, img in enumerate(ref_images, 1)
                ]
            if ref_videos:
                request.reference_videos = [
                    await _upload_video(cls, base, vid, f"Uploading video {i}", auth_headers)
                    for i, vid in enumerate(ref_videos, 1)
                ]
            if ref_audios:
                request.reference_audios = [
                    await _upload_audio(cls, base, aud, f"Uploading audio {i}", auth_headers)
                    for i, aud in enumerate(ref_audios, 1)
                ]

        submit = await sync_op(
            cls,
            ApiEndpoint(path=_with_common_params(f"{base}{GENERATE_PATH}"), method="POST", headers=auth_headers),
            response_model=H3ContextIRSubmitResponse,
            data=request,
        )
        if submit.base_resp and submit.base_resp.status_code not in (0, None):
            message = submit.base_resp.status_msg or submit.base_resp.user_message or "unknown error"
            raise Exception(f"MiniMax H3 prompt expansion submit failed: {message}")
        if not submit.task_id:
            raise Exception(f"MiniMax H3 prompt expansion submit failed: missing task_id ({submit.base_resp}).")

        result = await poll_op(
            cls,
            ApiEndpoint(path=_with_common_params(f"{base}{TASKS_PATH}/{submit.task_id}"), headers=auth_headers),
            response_model=H3ContextIRTaskResponse,
            status_extractor=lambda r: r.status,
        )
        if not result.prompt:
            raise Exception(
                "MiniMax H3 prompt expansion returned an empty prompt "
                f"(status={result.status}, base_resp={result.base_resp})."
            )
        return IO.NodeOutput(result.prompt)


class MinimaxH3VideoEnhancementNode(IO.ComfyNode):
    """Upscale an H3 source video to 2K while preserving its generation context."""

    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="MinimaxH3VideoEnhancementNode",
            display_name="MiniMax H3 2K Video Upscale",
            category="partner/video",
            description="Upscale a MiniMax H3 video to 2K. Connect the final 768P video and all "
            "materials used to generate it so the enhancement can preserve the original context. "
            "The source must contain between 768x768 and 768x1344 pixels.",
            inputs=[
                IO.Video.Input(
                    "video",
                    tooltip="Final generated video to upscale. Its pixel count must be between "
                    "768x768 and 768x1344.",
                ),
                IO.String.Input(
                    "prompt",
                    multiline=True,
                    default="",
                    tooltip="The final prompt used to generate the source video.",
                ),
                IO.Image.Input(
                    "first_frame_image",
                    optional=True,
                    tooltip="Original first-frame image, if used to generate the source video.",
                ),
                IO.Image.Input(
                    "last_frame_image",
                    optional=True,
                    tooltip="Original last-frame image, if used to generate the source video.",
                ),
                IO.Autogrow.Input(
                    "reference_images",
                    template=IO.Autogrow.TemplateNames(
                        IO.Image.Input("reference_image"),
                        names=[f"image_{i}" for i in range(1, MAX_REFERENCE_IMAGES + 1)],
                        min=0,
                    ),
                    tooltip=f"Original reference images, up to {MAX_REFERENCE_IMAGES}.",
                ),
                IO.Autogrow.Input(
                    "reference_videos",
                    template=IO.Autogrow.TemplateNames(
                        IO.Video.Input("reference_video"),
                        names=[f"video_{i}" for i in range(1, MAX_REFERENCE_VIDEOS + 1)],
                        min=0,
                    ),
                    tooltip=f"Original reference videos, up to {MAX_REFERENCE_VIDEOS}.",
                ),
                IO.Autogrow.Input(
                    "reference_audios",
                    template=IO.Autogrow.TemplateNames(
                        IO.Audio.Input("reference_audio"),
                        names=[f"audio_{i}" for i in range(1, MAX_REFERENCE_AUDIOS + 1)],
                        min=0,
                    ),
                    tooltip=f"Original reference audio clips, up to {MAX_REFERENCE_AUDIOS}.",
                ),
            ],
            outputs=[IO.Video.Output()],
            hidden=[
                IO.Hidden.auth_token_comfy_org,
                IO.Hidden.api_key_comfy_org,
                IO.Hidden.unique_id,
            ],
            is_api_node=True,
            price_badge=IO.PriceBadge(
                expr='{"type":"text","text":"50 credits/second"}',
            ),
        )

    @classmethod
    async def execute(
        cls,
        video: Input.Video,
        prompt: str = "",
        first_frame_image: torch.Tensor | None = None,
        last_frame_image: torch.Tensor | None = None,
        reference_images: dict | None = None,
        reference_videos: dict | None = None,
        reference_audios: dict | None = None,
    ) -> IO.NodeOutput:
        validate_string(prompt, field_name="prompt", strip_whitespace=True, min_length=1)

        width, height = video.get_dimensions()
        pixels = width * height
        if not MIN_ENHANCEMENT_PIXELS <= pixels <= MAX_ENHANCEMENT_PIXELS:
            raise ValueError(
                f"The source video is {width}x{height} ({pixels:,} pixels). MiniMax H3 2K "
                f"upscale requires between 768x768 ({MIN_ENHANCEMENT_PIXELS:,}) and "
                f"768x1344 ({MAX_ENHANCEMENT_PIXELS:,}) pixels."
            )

        duration = video.get_duration()
        if duration <= 0:
            raise ValueError("The source video duration must be positive.")

        ref_images = list(_iter_images(reference_images))
        ref_videos = [v for v in (reference_videos or {}).values() if v is not None]
        ref_audios = [a for a in (reference_audios or {}).values() if a is not None]
        if (first_frame_image is not None or last_frame_image is not None) and (
            ref_images or ref_videos or ref_audios
        ):
            raise ValueError(
                "Keyframe images (first/last frame) and reference media are mutually exclusive. "
                "Connect the same input mode that was used to generate the source video."
            )
        if len(ref_images) > MAX_REFERENCE_IMAGES:
            raise ValueError(f"Up to {MAX_REFERENCE_IMAGES} reference images are supported.")
        if len(ref_videos) > MAX_REFERENCE_VIDEOS:
            raise ValueError(f"Up to {MAX_REFERENCE_VIDEOS} reference videos are supported.")
        if len(ref_audios) > MAX_REFERENCE_AUDIOS:
            raise ValueError(f"Up to {MAX_REFERENCE_AUDIOS} reference audio clips are supported.")

        base = _resolve_api_base()
        auth_headers = _resolve_auth_headers()
        request = H3VideoEnhancementRequest(
            base_video=await _upload_video(cls, base, video, "Uploading source video", auth_headers),
            base_video_duration_ms=max(1, int(round(duration * 1000))),
            prompt=prompt.strip() or None,
        )

        first = _first_image(first_frame_image)
        last = _first_image(last_frame_image)
        if first is not None:
            request.first_frame_image = await _upload_image(
                cls, base, first, "Uploading first frame", auth_headers
            )
        if last is not None:
            request.last_frame_image = await _upload_image(
                cls, base, last, "Uploading last frame", auth_headers
            )
        if ref_images:
            request.reference_images = [
                await _upload_image(cls, base, image, f"Uploading image {i}", auth_headers)
                for i, image in enumerate(ref_images, 1)
            ]
        if ref_videos:
            request.reference_videos = [
                await _upload_video(cls, base, item, f"Uploading video {i}", auth_headers)
                for i, item in enumerate(ref_videos, 1)
            ]
        if ref_audios:
            request.reference_audios = [
                await _upload_audio(cls, base, item, f"Uploading audio {i}", auth_headers)
                for i, item in enumerate(ref_audios, 1)
            ]

        submit = await sync_op(
            cls,
            ApiEndpoint(
                path=_with_common_params(f"{base}{ENHANCEMENT_GENERATE_PATH}"),
                method="POST",
                headers=auth_headers,
            ),
            response_model=H3VideoSubmitResponse,
            data=request,
        )
        if submit.base_resp and submit.base_resp.status_code not in (0, None):
            message = submit.base_resp.status_msg or submit.base_resp.user_message or "unknown error"
            raise Exception(f"MiniMax H3 video enhancement submit failed: {message}")
        if not submit.task_id:
            raise Exception(f"MiniMax H3 video enhancement submit failed: missing task_id ({submit.base_resp}).")

        task_result = await poll_op(
            cls,
            ApiEndpoint(
                path=_with_common_params(f"{base}{VIDEO_TASKS_PATH}/{submit.task_id}"),
                headers=auth_headers,
            ),
            response_model=H3VideoTaskResponse,
            status_extractor=lambda result: result.status,
            failed_statuses=VIDEO_FAILED_STATUSES,
            poll_interval=15,
        )
        if not task_result.file_id:
            raise Exception(
                "MiniMax H3 video enhancement finished without a file id "
                f"(status={task_result.status}, base_resp={task_result.base_resp})."
            )

        file_result = await sync_op(
            cls,
            ApiEndpoint(
                path=_with_common_params(f"{base}{VIDEO_FILE_RETRIEVE_PATH}/{task_result.file_id}"),
                headers=auth_headers,
            ),
            response_model=H3VideoFileRetrieveResponse,
        )
        video_url = file_result.file.download_url if file_result.file else None
        if not video_url:
            raise Exception(f"No video URL in the file retrieve response: {file_result.model_dump()}")
        return IO.NodeOutput(await download_url_to_video_output(video_url))


class MinimaxH3Extension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[IO.ComfyNode]]:
        return [MinimaxH3PromptExpandNode, MinimaxH3VideoEnhancementNode]


async def comfy_entrypoint() -> MinimaxH3Extension:
    return MinimaxH3Extension()
