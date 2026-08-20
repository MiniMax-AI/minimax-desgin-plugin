from typing import Optional

import torch
from typing_extensions import override

from comfy_api.latest import IO, ComfyExtension
from comfy_api_nodes.apis.minimax import (
    MinimaxFileRetrieveResponse,
    MiniMaxModel,
    MinimaxTaskResultResponse,
    MinimaxVideoGenerationRequest,
    MinimaxVideoGenerationResponse,
    SubjectReferenceItem,
)
from comfy_api_nodes.apis.minimax_h3 import (
    H3VideoFileRetrieveResponse,
    H3VideoGenerationRequest,
    H3VideoSubmitResponse,
    H3VideoTaskResponse,
)
from comfy_api_nodes.nodes_minimax_h3 import (
    _first_image,
    _resolve_api_base,
    _resolve_auth_headers,
    _upload_audio,
    _upload_image,
    _upload_video,
    _with_common_params,
)
from comfy_api_nodes.util import (
    ApiEndpoint,
    download_url_to_video_output,
    poll_op,
    sync_op,
    upload_images_to_comfyapi,
    validate_image_aspect_ratio,
    validate_image_dimensions,
    validate_string,
)

I2V_AVERAGE_DURATION = 114
T2V_AVERAGE_DURATION = 234


async def _generate_mm_video(
    cls: type[IO.ComfyNode],
    *,
    prompt_text: str,
    seed: int,
    model: str,
    image: Optional[torch.Tensor] = None,  # used for ImageToVideo
    subject: Optional[torch.Tensor] = None,  # used for SubjectToVideo
    average_duration: Optional[int] = None,
) -> IO.NodeOutput:
    if image is None:
        validate_string(prompt_text, field_name="prompt_text")
    image_url = None
    if image is not None:
        image_url = (await upload_images_to_comfyapi(cls, image, max_images=1))[0]

    # TODO: figure out how to deal with subject properly, API returns invalid params when using S2V-01 model
    subject_reference = None
    if subject is not None:
        subject_url = (await upload_images_to_comfyapi(cls, subject, max_images=1))[0]
        subject_reference = [SubjectReferenceItem(image=subject_url)]

    response = await sync_op(
        cls,
        ApiEndpoint(path="/proxy/minimax/video_generation", method="POST"),
        response_model=MinimaxVideoGenerationResponse,
        data=MinimaxVideoGenerationRequest(
            model=MiniMaxModel(model),
            prompt=prompt_text,
            callback_url=None,
            first_frame_image=image_url,
            subject_reference=subject_reference,
            prompt_optimizer=None,
        ),
    )

    task_id = response.task_id
    if not task_id:
        raise Exception(f"MiniMax generation failed: {response.base_resp}")

    task_result = await poll_op(
        cls,
        ApiEndpoint(path="/proxy/minimax/query/video_generation", query_params={"task_id": task_id}),
        response_model=MinimaxTaskResultResponse,
        status_extractor=lambda x: x.status.value,
        estimated_duration=average_duration,
    )

    file_id = task_result.file_id
    if file_id is None:
        raise Exception("Request was not successful. Missing file ID.")
    file_result = await sync_op(
        cls,
        ApiEndpoint(path="/proxy/minimax/files/retrieve", query_params={"file_id": int(file_id)}),
        response_model=MinimaxFileRetrieveResponse,
    )

    file_url = file_result.file.download_url
    if file_url is None:
        raise Exception(f"No video was found in the response. Full response: {file_result.model_dump()}")
    if file_result.file.backup_download_url:
        try:
            return IO.NodeOutput(await download_url_to_video_output(file_url, timeout=10, max_retries=2))
        except Exception:  # if we have a second URL to retrieve the result, try again using that one
            return IO.NodeOutput(
                await download_url_to_video_output(file_result.file.backup_download_url, max_retries=3)
            )
    return IO.NodeOutput(await download_url_to_video_output(file_url))


class MinimaxTextToVideoNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="MinimaxTextToVideoNode",
            display_name="MiniMax Text to Video",
            category="partner/video",
            description="Generates videos synchronously based on a prompt, and optional parameters.",
            inputs=[
                IO.String.Input(
                    "prompt_text",
                    multiline=True,
                    default="",
                    tooltip="Text prompt to guide the video generation",
                ),
                IO.Combo.Input(
                    "model",
                    options=["T2V-01", "T2V-01-Director"],
                    default="T2V-01",
                    tooltip="Model to use for video generation",
                ),
                IO.Int.Input(
                    "seed",
                    default=0,
                    min=0,
                    max=0xFFFFFFFFFFFFFFFF,
                    step=1,
                    control_after_generate=True,
                    tooltip="The random seed used for creating the noise.",
                    optional=True,
                ),
            ],
            outputs=[IO.Video.Output()],
            hidden=[
                IO.Hidden.unique_id,
            ],
            is_api_node=True,
            price_badge=IO.PriceBadge(
                expr="""{"type":"usd","usd":0.43}""",
            ),
        )

    @classmethod
    async def execute(
        cls,
        prompt_text: str,
        model: str = "T2V-01",
        seed: int = 0,
    ) -> IO.NodeOutput:
        return await _generate_mm_video(
            cls,
            prompt_text=prompt_text,
            seed=seed,
            model=model,
            image=None,
            subject=None,
            average_duration=T2V_AVERAGE_DURATION,
        )


class MinimaxImageToVideoNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="MinimaxImageToVideoNode",
            display_name="MiniMax Image to Video",
            category="partner/video",
            description="Generates videos synchronously based on an image and prompt, and optional parameters.",
            inputs=[
                IO.Image.Input(
                    "image",
                    tooltip="Image to use as first frame of video generation",
                ),
                IO.String.Input(
                    "prompt_text",
                    multiline=True,
                    default="",
                    tooltip="Text prompt to guide the video generation",
                ),
                IO.Combo.Input(
                    "model",
                    options=["I2V-01-Director", "I2V-01", "I2V-01-live"],
                    default="I2V-01",
                    tooltip="Model to use for video generation",
                ),
                IO.Int.Input(
                    "seed",
                    default=0,
                    min=0,
                    max=0xFFFFFFFFFFFFFFFF,
                    step=1,
                    control_after_generate=True,
                    tooltip="The random seed used for creating the noise.",
                    optional=True,
                ),
            ],
            outputs=[IO.Video.Output()],
            hidden=[
                IO.Hidden.unique_id,
            ],
            is_api_node=True,
            price_badge=IO.PriceBadge(
                expr="""{"type":"usd","usd":0.43}""",
            ),
        )

    @classmethod
    async def execute(
        cls,
        image: torch.Tensor,
        prompt_text: str,
        model: str = "I2V-01",
        seed: int = 0,
    ) -> IO.NodeOutput:
        return await _generate_mm_video(
            cls,
            prompt_text=prompt_text,
            seed=seed,
            model=model,
            image=image,
            subject=None,
            average_duration=I2V_AVERAGE_DURATION,
        )


class MinimaxSubjectToVideoNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="MinimaxSubjectToVideoNode",
            display_name="MiniMax Subject to Video",
            category="partner/video",
            description="Generates videos synchronously based on an image and prompt, and optional parameters.",
            inputs=[
                IO.Image.Input(
                    "subject",
                    tooltip="Image of subject to reference for video generation",
                ),
                IO.String.Input(
                    "prompt_text",
                    multiline=True,
                    default="",
                    tooltip="Text prompt to guide the video generation",
                ),
                IO.Combo.Input(
                    "model",
                    options=["S2V-01"],
                    default="S2V-01",
                    tooltip="Model to use for video generation",
                ),
                IO.Int.Input(
                    "seed",
                    default=0,
                    min=0,
                    max=0xFFFFFFFFFFFFFFFF,
                    step=1,
                    control_after_generate=True,
                    tooltip="The random seed used for creating the noise.",
                    optional=True,
                ),
            ],
            outputs=[IO.Video.Output()],
            hidden=[
                IO.Hidden.unique_id,
            ],
            is_api_node=True,
        )

    @classmethod
    async def execute(
        cls,
        subject: torch.Tensor,
        prompt_text: str,
        model: str = "S2V-01",
        seed: int = 0,
    ) -> IO.NodeOutput:
        return await _generate_mm_video(
            cls,
            prompt_text=prompt_text,
            seed=seed,
            model=model,
            image=None,
            subject=subject,
            average_duration=T2V_AVERAGE_DURATION,
        )


class MinimaxHailuoVideoNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls) -> IO.Schema:
        return IO.Schema(
            node_id="MinimaxHailuoVideoNode",
            display_name="MiniMax Hailuo 02 Video",
            category="partner/video",
            description="Generates videos from prompt, with optional start frame using the MiniMax Hailuo-02 model.",
            inputs=[
                IO.String.Input(
                    "prompt_text",
                    multiline=True,
                    default="",
                    tooltip="Text prompt to guide the video generation.",
                ),
                IO.Int.Input(
                    "seed",
                    default=0,
                    min=0,
                    max=0xFFFFFFFFFFFFFFFF,
                    step=1,
                    control_after_generate=True,
                    tooltip="The random seed used for creating the noise.",
                    optional=True,
                ),
                IO.Image.Input(
                    "first_frame_image",
                    tooltip="Optional image to use as the first frame to generate a video.",
                    optional=True,
                ),
                IO.Boolean.Input(
                    "prompt_optimizer",
                    default=True,
                    tooltip="Optimize prompt to improve generation quality when needed.",
                    optional=True,
                ),
                IO.Combo.Input(
                    "duration",
                    options=[6, 10],
                    default=6,
                    tooltip="The length of the output video in seconds.",
                    optional=True,
                ),
                IO.Combo.Input(
                    "resolution",
                    options=["768P", "1080P"],
                    default="768P",
                    tooltip="The dimensions of the video display. 1080p is 1920x1080, 768p is 1366x768.",
                    optional=True,
                ),
            ],
            outputs=[IO.Video.Output()],
            hidden=[
                IO.Hidden.unique_id,
            ],
            is_api_node=True,
            price_badge=IO.PriceBadge(
                depends_on=IO.PriceBadgeDepends(widgets=["resolution", "duration"]),
                expr="""
                (
                  $prices := {
                    "768p": {"6": 0.28, "10": 0.56},
                    "1080p": {"6": 0.49}
                  };
                  $resPrices := $lookup($prices, $lowercase(widgets.resolution));
                  $price := $lookup($resPrices, $string(widgets.duration));
                  {"type":"usd","usd": $price ? $price : 0.43}
                )
                """,
            ),
        )

    @classmethod
    async def execute(
        cls,
        prompt_text: str,
        seed: int = 0,
        first_frame_image: Optional[torch.Tensor] = None,  # used for ImageToVideo
        prompt_optimizer: bool = True,
        duration: int = 6,
        resolution: str = "768P",
        model: str = "MiniMax-Hailuo-02",
    ) -> IO.NodeOutput:
        if first_frame_image is None:
            validate_string(prompt_text, field_name="prompt_text")

        if model == "MiniMax-Hailuo-02" and resolution.upper() == "1080P" and duration != 6:
            raise Exception(
                "When model is MiniMax-Hailuo-02 and resolution is 1080P, duration is limited to 6 seconds."
            )

        # upload image, if passed in
        image_url = None
        if first_frame_image is not None:
            image_url = (await upload_images_to_comfyapi(cls, first_frame_image, max_images=1))[0]

        response = await sync_op(
            cls,
            ApiEndpoint(path="/proxy/minimax/video_generation", method="POST"),
            response_model=MinimaxVideoGenerationResponse,
            data=MinimaxVideoGenerationRequest(
                model=MiniMaxModel(model),
                prompt=prompt_text,
                callback_url=None,
                first_frame_image=image_url,
                prompt_optimizer=prompt_optimizer,
                duration=duration,
                resolution=resolution,
            ),
        )

        task_id = response.task_id
        if not task_id:
            raise Exception(f"MiniMax generation failed: {response.base_resp}")

        average_duration = 120 if resolution == "768P" else 240
        task_result = await poll_op(
            cls,
            ApiEndpoint(path="/proxy/minimax/query/video_generation", query_params={"task_id": task_id}),
            response_model=MinimaxTaskResultResponse,
            status_extractor=lambda x: x.status.value,
            estimated_duration=average_duration,
        )

        file_id = task_result.file_id
        if file_id is None:
            raise Exception("Request was not successful. Missing file ID.")
        file_result = await sync_op(
            cls,
            ApiEndpoint(path="/proxy/minimax/files/retrieve", query_params={"file_id": int(file_id)}),
            response_model=MinimaxFileRetrieveResponse,
        )

        file_url = file_result.file.download_url
        if file_url is None:
            raise Exception(f"No video was found in the response. Full response: {file_result.model_dump()}")

        if file_result.file.backup_download_url:
            try:
                return IO.NodeOutput(await download_url_to_video_output(file_url, timeout=10, max_retries=2))
            except Exception:  # if we have a second URL to retrieve the result, try again using that one
                return IO.NodeOutput(
                    await download_url_to_video_output(file_result.file.backup_download_url, max_retries=3)
                )
        return IO.NodeOutput(await download_url_to_video_output(file_url))


HAILUO_03_MODELS = {"MiniMax H3": "MiniMax-H3"}
HAILUO_03_FAILED_STATUSES = ["failed", "fail", "cancelled", "expired"]

# MiniMax design gateway (same host as the H3 Context IR node). H3 video
# generation is routed directly to the design API instead of the Comfy proxy
# host, matching the Hub cloud-gateway contract (flat payload, not a content
# array). Media is uploaded to the gateway first; the result is fetched via a
# task poll + file retrieve.
HAILUO_03_GENERATE_PATH = "/api/v1/video/minimax-v3/generate"
HAILUO_03_TASKS_PATH = "/api/v1/video/minimax-v3/tasks"  # + /{task_id}
HAILUO_03_FILE_RETRIEVE_PATH = "/api/v1/video/minimax/files"  # + /{file_id}


def _hailuo03_model_inputs(include_ratio: bool = True, allow_adaptive: bool = True):
    inputs = [
        IO.String.Input(
            "prompt",
            multiline=True,
            default="",
            tooltip="Text prompt for video generation.",
        ),
        IO.Combo.Input(
            "resolution",
            options=["768P", "2K"],
            tooltip="Resolution of the output video.",
        ),
    ]
    if include_ratio:
        ratio_options = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]
        if allow_adaptive:
            ratio_options.insert(0, "adaptive")
        inputs.append(
            IO.Combo.Input(
                "ratio",
                options=ratio_options,
                default=ratio_options[0],
                tooltip="Aspect ratio of the output video.",
            )
        )
    inputs.append(
        IO.Int.Input(
            "duration",
            default=5,
            min=5,
            max=15,
            step=1,
            tooltip="Duration of the output video in seconds (5-15).",
            display_mode=IO.NumberDisplay.slider,
        )
    )
    return inputs


async def _hailuo03_run_task(
    cls: type[IO.ComfyNode],
    *,
    request: H3VideoGenerationRequest,
    base: str | None = None,
    auth_headers: dict[str, str] | None = None,
) -> IO.NodeOutput:
    """Submit an H3 video generation request to the MiniMax design gateway, poll
    the task to completion, then resolve and download the result video.

    ``base``/``auth_headers`` may be passed in by callers that already resolved
    them for media uploads; otherwise they are resolved here.
    """
    if base is None:
        base = _resolve_api_base()
    if auth_headers is None:
        auth_headers = _resolve_auth_headers()

    submit = await sync_op(
        cls,
        ApiEndpoint(
            path=_with_common_params(f"{base}{HAILUO_03_GENERATE_PATH}"),
            method="POST",
            headers=auth_headers,
        ),
        response_model=H3VideoSubmitResponse,
        data=request,
    )
    if submit.base_resp and submit.base_resp.status_code not in (0, None):
        message = submit.base_resp.status_msg or submit.base_resp.user_message or "unknown error"
        raise Exception(f"MiniMax H3 video generation submit failed: {message}")
    if not submit.task_id:
        raise Exception(f"MiniMax H3 video generation submit failed: missing task_id ({submit.base_resp}).")

    task_result = await poll_op(
        cls,
        ApiEndpoint(
            path=_with_common_params(f"{base}{HAILUO_03_TASKS_PATH}/{submit.task_id}"),
            headers=auth_headers,
        ),
        response_model=H3VideoTaskResponse,
        status_extractor=lambda r: r.status,
        failed_statuses=HAILUO_03_FAILED_STATUSES,
        poll_interval=15,
    )
    if not task_result.file_id:
        raise Exception(
            "MiniMax H3 video task finished without a file id "
            f"(status={task_result.status}, base_resp={task_result.base_resp})."
        )

    file_result = await sync_op(
        cls,
        ApiEndpoint(
            path=_with_common_params(f"{base}{HAILUO_03_FILE_RETRIEVE_PATH}/{task_result.file_id}"),
            headers=auth_headers,
        ),
        response_model=H3VideoFileRetrieveResponse,
    )
    video_url = file_result.file.download_url if file_result.file else None
    if not video_url:
        raise Exception(f"No video URL in the file retrieve response: {file_result.model_dump()}")
    return IO.NodeOutput(await download_url_to_video_output(video_url))


class MinimaxHailuo03TextToVideoNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="MinimaxHailuo03TextToVideoNode",
            display_name="MiniMax H3 Text to Video",
            category="partner/video",
            description="Generate video from a text prompt using the MiniMax H3 model.",
            inputs=[
                IO.DynamicCombo.Input(
                    "model",
                    options=[IO.DynamicCombo.Option("MiniMax H3", _hailuo03_model_inputs(allow_adaptive=False))],
                    tooltip="Model to use for video generation.",
                ),
            ],
            outputs=[
                IO.Video.Output(),
            ],
            hidden=[
                IO.Hidden.unique_id,
            ],
            is_api_node=True,
            price_badge=IO.PriceBadge(
                depends_on=IO.PriceBadgeDepends(widgets=["model.resolution", "model.duration"]),
                expr="""
                (
                  $dur := $lookup(widgets, "model.duration");
                  $rate := $lookup(widgets, "model.resolution") = "768p" ? 70 : 120;
                  {"type": "text", "text": $string($dur * $rate) & " credits"}
                )
                """,
            ),
        )

    @classmethod
    async def execute(
        cls,
        model: dict,
    ) -> IO.NodeOutput:
        validate_string(model["prompt"], strip_whitespace=True, min_length=1)
        request = H3VideoGenerationRequest(
            model=HAILUO_03_MODELS[model["model"]],
            prompt=model["prompt"],
            generate_audio=True,
            ratio=model["ratio"],
            duration=model["duration"],
            resolution=model["resolution"],
        )
        return await _hailuo03_run_task(cls, request=request)


class MinimaxHailuo03FirstLastFrameNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="MinimaxHailuo03FirstLastFrameNode",
            display_name="MiniMax H3 First-Last-Frame to Video",
            category="partner/video",
            description="Generate video from a first frame image and an optional last frame image "
            "using the MiniMax H3 model. The aspect ratio of the video follows the supplied images.",
            inputs=[
                IO.DynamicCombo.Input(
                    "model",
                    options=[IO.DynamicCombo.Option("MiniMax H3", _hailuo03_model_inputs(include_ratio=False))],
                    tooltip="Model to use for video generation.",
                ),
                IO.Image.Input(
                    "first_frame",
                    tooltip="First frame image for the video.",
                ),
                IO.Image.Input(
                    "last_frame",
                    tooltip="Optional last frame image for the video.",
                    optional=True,
                ),
            ],
            outputs=[
                IO.Video.Output(),
            ],
            hidden=[
                IO.Hidden.unique_id,
            ],
            is_api_node=True,
            price_badge=IO.PriceBadge(
                depends_on=IO.PriceBadgeDepends(widgets=["model.resolution", "model.duration"]),
                expr="""
                (
                  $dur := $lookup(widgets, "model.duration");
                  $rate := $lookup(widgets, "model.resolution") = "768p" ? 70 : 120;
                  {"type": "text", "text": $string($dur * $rate) & " credits"}
                )
                """,
            ),
        )

    @classmethod
    async def execute(
        cls,
        model: dict,
        first_frame: torch.Tensor,
        last_frame: torch.Tensor | None = None,
    ) -> IO.NodeOutput:
        validate_string(model["prompt"], strip_whitespace=True, min_length=1)
        for frame in (first_frame, last_frame):
            if frame is not None:
                validate_image_aspect_ratio(frame, (2, 5), (5, 2), strict=False)  # 0.4 to 2.5
                validate_image_dimensions(frame, min_width=256, min_height=256)

        base = _resolve_api_base()
        auth_headers = _resolve_auth_headers()
        first_frame_image = await _upload_image(
            cls, base, _first_image(first_frame), "Uploading first frame", auth_headers
        )
        last_frame_image = None
        if last_frame is not None:
            last_frame_image = await _upload_image(
                cls, base, _first_image(last_frame), "Uploading last frame", auth_headers
            )

        request = H3VideoGenerationRequest(
            model=HAILUO_03_MODELS[model["model"]],
            prompt=model["prompt"],
            generate_audio=True,
            # First/last-frame mode adopts the aspect ratio of the supplied images.
            ratio="adaptive",
            duration=model["duration"],
            resolution=model["resolution"],
            first_frame_image=first_frame_image,
            last_frame_image=last_frame_image,
        )
        return await _hailuo03_run_task(cls, request=request, base=base, auth_headers=auth_headers)


class MinimaxHailuo03ReferenceNode(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        return IO.Schema(
            node_id="MinimaxHailuo03ReferenceNode",
            display_name="MiniMax H3 Reference to Video",
            category="partner/video",
            description="Generate video conditioned on reference images, videos, and audio using the "
            "MiniMax H3 model. Refer to the references in the prompt by their order: "
            "'Image 1', 'Image 2', 'Video 1', 'Audio 1', and so on.",
            inputs=[
                IO.DynamicCombo.Input(
                    "model",
                    options=[
                        IO.DynamicCombo.Option(
                            "MiniMax H3",
                            [
                                *_hailuo03_model_inputs(),
                                IO.Autogrow.Input(
                                    "reference_images",
                                    template=IO.Autogrow.TemplateNames(
                                        IO.Image.Input("reference_image"),
                                        names=[
                                            "image_1",
                                            "image_2",
                                            "image_3",
                                            "image_4",
                                            "image_5",
                                            "image_6",
                                            "image_7",
                                            "image_8",
                                            "image_9",
                                        ],
                                        min=0,
                                    ),
                                    tooltip="Subject or style reference images, referred to in the prompt "
                                    "as 'Image 1'..'Image 9' in connection order. Up to 9 images.",
                                ),
                                IO.Autogrow.Input(
                                    "reference_videos",
                                    template=IO.Autogrow.TemplateNames(
                                        IO.Video.Input("reference_video"),
                                        names=["video_1", "video_2", "video_3"],
                                        min=0,
                                    ),
                                    tooltip="Motion or scene reference videos, referred to in the prompt "
                                    "as 'Video 1'..'Video 3' in connection order. Up to 3 videos, "
                                    "2-15 seconds each, 15 seconds in total.",
                                ),
                                IO.Autogrow.Input(
                                    "reference_audios",
                                    template=IO.Autogrow.TemplateNames(
                                        IO.Audio.Input("reference_audio"),
                                        names=["audio_1", "audio_2", "audio_3"],
                                        min=0,
                                    ),
                                    tooltip="Audio references, referred to in the prompt as "
                                    "'Audio 1'..'Audio 3' in connection order. Up to 3 clips, "
                                    "2-15 seconds each, 15 seconds in total. Cannot be used without "
                                    "a reference image or video.",
                                ),
                            ],
                        )
                    ],
                    tooltip="Model to use for video generation.",
                ),
            ],
            outputs=[
                IO.Video.Output(),
            ],
            hidden=[
                IO.Hidden.unique_id,
            ],
            is_api_node=True,
            price_badge=IO.PriceBadge(
                depends_on=IO.PriceBadgeDepends(
                    widgets=["model.resolution", "model.duration"],
                    input_groups=["model.reference_images", "model.reference_videos"],
                ),
                expr="""
                (
                  $dur := $lookup(widgets, "model.duration");
                  $rate := $lookup(widgets, "model.resolution") = "768p" ? 70 : 120;
                  $imgsRaw := $lookup(inputGroups, "model.reference_images");
                  $imgs := $imgsRaw ? $imgsRaw : 0;
                  $vidsRaw := $lookup(inputGroups, "model.reference_videos");
                  $vids := $vidsRaw ? $vidsRaw : 0;
                  $imgCost := $imgs > 5 ? ($imgs - 5) * 30 : 0;
                  $base := $dur * $rate + $imgCost;
                  $vids > 0
                    ? {"type": "text",
                       "text": "~" & $string($base + $vids * 2 * $rate) & "-" & $string($base + 15 * $rate) & " credits"}
                    : {"type": "text", "text": $string($base) & " credits"}
                )
                """,
            ),
        )

    @classmethod
    async def execute(
        cls,
        model: dict,
    ) -> IO.NodeOutput:
        validate_string(model["prompt"], strip_whitespace=True, min_length=1)

        reference_images = model.get("reference_images", {})
        reference_videos = model.get("reference_videos", {})
        reference_audios = model.get("reference_audios", {})
        if not reference_images and not reference_videos:
            raise ValueError("At least one reference image or video is required.")

        for image in reference_images.values():
            validate_image_aspect_ratio(image, (2, 5), (5, 2), strict=False)  # 0.4 to 2.5
            validate_image_dimensions(image, min_width=256, min_height=256)

        video_durations_ms: list[int] = []
        total_video_duration = 0.0
        for i, video in enumerate(reference_videos.values(), 1):
            try:
                fps = float(video.get_frame_rate())
            except Exception:
                fps = 0.0
            if fps and not (23.9 <= fps <= 60.5):
                raise ValueError(f"Reference video {i} is {fps:.2f} FPS. Supported range is 23.976-60 FPS.")
            try:
                dur = video.get_duration()
            except Exception:
                dur = 0.0
            video_durations_ms.append(int(round(dur * 1000)))
            if dur and dur < 1.8:
                raise ValueError(f"Reference video {i} is too short: {dur:.1f}s. Minimum duration is 2 seconds.")
            total_video_duration += dur
        if total_video_duration > 15.1:
            raise ValueError(
                f"Total reference video duration is {total_video_duration:.1f}s. Maximum is 15 seconds."
            )

        total_audio_duration = 0.0
        for i, audio in enumerate(reference_audios.values(), 1):
            dur = int(audio["waveform"].shape[-1]) / int(audio["sample_rate"])
            if dur < 1.8:
                raise ValueError(f"Reference audio {i} is too short: {dur:.1f}s. Minimum duration is 2 seconds.")
            total_audio_duration += dur
        if total_audio_duration > 15.1:
            raise ValueError(
                f"Total reference audio duration is {total_audio_duration:.1f}s. Maximum is 15 seconds."
            )

        base = _resolve_api_base()
        auth_headers = _resolve_auth_headers()

        reference_image_urls: list[str] = []
        for i, image in enumerate(reference_images.values(), 1):
            reference_image_urls.append(
                await _upload_image(cls, base, _first_image(image), f"Uploading image {i}", auth_headers)
            )
        reference_video_urls: list[str] = []
        for i, video in enumerate(reference_videos.values(), 1):
            reference_video_urls.append(
                await _upload_video(cls, base, video, f"Uploading video {i}", auth_headers)
            )
        reference_audio_urls: list[str] = []
        for i, audio in enumerate(reference_audios.values(), 1):
            reference_audio_urls.append(
                await _upload_audio(cls, base, audio, f"Uploading audio {i}", auth_headers)
            )

        request = H3VideoGenerationRequest(
            model=HAILUO_03_MODELS[model["model"]],
            prompt=model["prompt"],
            generate_audio=True,
            ratio=model["ratio"],
            duration=model["duration"],
            resolution=model["resolution"],
            reference_images=reference_image_urls or None,
            reference_videos=reference_video_urls or None,
            reference_video_durations_ms=video_durations_ms or None,
            reference_audios=reference_audio_urls or None,
        )
        return await _hailuo03_run_task(cls, request=request, base=base, auth_headers=auth_headers)


class MinimaxExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[IO.ComfyNode]]:
        return [
            MinimaxTextToVideoNode,
            MinimaxImageToVideoNode,
            # MinimaxSubjectToVideoNode,
            MinimaxHailuoVideoNode,
            MinimaxHailuo03TextToVideoNode,
            MinimaxHailuo03FirstLastFrameNode,
            MinimaxHailuo03ReferenceNode,
        ]


async def comfy_entrypoint() -> MinimaxExtension:
    return MinimaxExtension()
